//! Request-owned, persistent-cohort spectral prior mixture (JQS2).
//! Exact physical atoms -> integer Q63 grid -> certified FFT -> floor fold.
use super::*;
use super::spectral::{self, Category, Complex, Ledger, HALF, RAW, SMALL, UNIT};
use num_traits::ToPrimitive;

const ALGORITHM: &str = "joint-spectral-mixture-v3";
const M: u64 = 1u64 << 63;
const MASS_SCALE: f64 = 1.0 / 9_223_372_036_854_775_808.0;
// Ordering hint only, NOT certificate authority or a native pruning budget.
// Every atom is still emitted; the host independently enforces its own bound.
// Changing this hint can change locality, never the emitted distribution.
const ADVISORY_ORDERING_HINT: f64 = 1e-6;
const SAFE: u64 = 9_007_199_254_740_991;
const ROWS: usize = 1_000_000;
const BYTES: usize = 160 * 1024 * 1024;
const CHUNK: usize = 32;
const NONE: u32 = u32::MAX;
// Stack FFT recursion, root/filter arrays, packet and JSON metadata coexist.
const SCRATCH: usize = 384 * 1024;
const PHYSICAL_SCRATCH: usize = 48 * 1024 * 1024;
type Pieces = [u64; 3];
type Atom = (Pieces, u64);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Begin {
    algorithm: String, source_identity: String, source_key: String, projection_key: String,
    sid: usize, stock: Pieces, windows: [[i64; 3]; 14],
    source_error_bounds: [f64; 14], host_performed_work: u64,
}
#[derive(Clone, Copy, Debug)]
struct Projected { units: [u32; 3], weight: u64 }
#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase { Date, Mixture, Rows, MixtureEnd, DateEnd, Ack, Done }
#[derive(Default)]
struct Work {
    ledger: Ledger, host: u64, live: usize, rows: usize,
    peak_rows: usize, peak_bytes: usize, transform_coeffs: usize, max_exact_rows: usize,
    coefficients_live: usize,
    #[cfg(test)] byte_limit: Option<usize>,
}
fn check(deadline: f64) -> Result<()> {
    if !deadline.is_finite() || now() >= deadline { Err("request_budget_exhausted") } else { Ok(()) }
}
fn add(a: usize, b: usize) -> Result<usize> { a.checked_add(b).ok_or("joint_source_memory_limit") }
fn bytes<T>(n: usize) -> Result<usize> { n.checked_mul(std::mem::size_of::<T>()).ok_or("joint_source_memory_limit") }
impl Work {
    fn host_debit(raw: u64) -> Self {
        let mut work = Self::default();
        work.host = raw;
        work.ledger.total = raw;
        work.ledger.scalar[Category::Physical as usize] = raw;
        work
    }
    fn admit(&mut self, extra: usize, rows: usize, deadline: f64) -> Result<()> {
        check(deadline)?;
        let live = add(add(self.live, extra)?, SCRATCH)?;
        let atoms = add(self.rows, rows)?;
        self.peak_bytes = self.peak_bytes.max(live);
        self.peak_rows = self.peak_rows.max(atoms);
        let limit = BYTES;
        #[cfg(test)] let limit = self.byte_limit.unwrap_or(limit);
        if live > limit || atoms > ROWS { return Err("joint_source_memory_limit"); }
        #[cfg(target_arch = "wasm32")]
        if !allocation::can_admit(add(extra, SCRATCH)?) { return Err("managed_payload_ceiling"); }
        Ok(())
    }
    fn vector<T>(&mut self, n: usize, atoms: bool, deadline: f64) -> Result<Vec<T>> {
        self.admit(bytes::<T>(n)?, if atoms { n } else { 0 }, deadline)?;
        let mut out = Vec::new();
        out.try_reserve_exact(n).map_err(|_| "joint_source_memory_limit")?;
        let backing = bytes::<T>(out.capacity())?;
        self.live = add(self.live, backing)?;
        if atoms { self.rows = add(self.rows, out.capacity())?; }
        self.admit(0, 0, deadline)?;
        Ok(out)
    }
    fn release<T>(&mut self, out: Vec<T>, atoms: usize) {
        self.live -= out.capacity() * std::mem::size_of::<T>();
        self.rows -= atoms;
        drop(out);
    }
    fn complex(&mut self, n: usize, deadline: f64) -> Result<Vec<Complex>> {
        let mut out = self.vector(n, false, deadline)?;
        out.resize(n, Complex::ZERO);
        self.coefficients_live = add(self.coefficients_live, out.capacity())?;
        // Includes fixed roots, dated filters and maximum FFT stack scratch.
        self.transform_coeffs = self.transform_coeffs.max(add(self.coefficients_live, 16_000)?);
        Ok(out)
    }
    fn release_complex(&mut self, out: Vec<Complex>) {
        self.coefficients_live -= out.capacity();
        self.release(out, 0);
    }
    fn power_steps(&mut self, builder: &spectral::PowerBuilder, deadline: f64) -> Result<Vec<spectral::PowerStep>> {
        if builder.steps().len() == 1 { return Ok(Vec::new()); }
        let mut steps = self.vector(builder.steps().len(), false, deadline)?;
        steps.extend_from_slice(builder.steps());
        Ok(steps)
    }
}
struct Law {
    counts: [usize; 14], atoms: Vec<Atom>, masses: [f64; 5], spectrum: Vec<Complex>,
    z_prefix: usize,
    powers: Vec<spectral::PowerStep>, power_result: usize, group: usize, first: bool,
}
struct Product {
    schedule: [usize; 14], powers: Vec<spectral::PowerStep>,
    outputs: [usize; 14], offset: usize,
}
struct Request {
    supply: supply::Supply, stock: Pieces, caps: Units, windows: [[i64; 3]; 14],
    minima: [Pieces; 14], maxima: [Pieces; 14],
    spectra: Vec<Complex>, points: Vec<Projected>, projected: Vec<Projected>,
    deadline: f64, row_limit: usize, day: usize, offset: usize, last_acked: usize,
    phase: Phase, prepared: bool, point_only: bool, work: Work,
}
impl Request {
    fn new(mut supply: supply::Supply, input: Begin, caps: Units, deadline: f64, row_limit: usize, work: &mut Work) -> Result<Self> {
        check(deadline)?;
        let expected = match supply.model.snapshot_version.as_str() {
            "certified-daily-v1" | "certified-daily-v5" => 3,
            "certified-daily-v2" | "certified-daily-v3" | "certified-daily-v4" => 4,
            _ => return Err("joint_source_contract"),
        };
        if supply.priors.len() != expected || input.stock.iter().any(|&n| n > SAFE) ||
            supply.model.events.iter().any(|e| !(1..=14).contains(&e.day)) ||
            supply.model.events.windows(2).any(|w| w[0].day > w[1].day) ||
            input.source_error_bounds.iter().any(|e| !e.is_finite() || *e < 0.0 || *e > 2.0) {
            return Err("joint_source_contract");
        }
        for window in input.windows {
            for k in 0..3 {
                if window[k].unsigned_abs() > SAFE || (i128::from(window[k]) + i128::from(input.stock[k])) % 10 != 0 {
                    return Err("joint_source_contract");
                }
            }
        }
        // The caller owns the ledger until construction succeeds. Admission
        // errors must retain native debits and refused peaks in that owner.
        if work.host != input.host_performed_work { return Err("joint_source_contract"); }
        work.ledger.charge(Category::Physical, 0)?;
        supply.clear_source_memos();
        let (model_bytes, model_rows) = supply.source_model_footprint()?;
        work.ledger.charge(Category::Physical, (model_bytes / 4 + 256) as u64)?;
        work.live = add(model_bytes, std::mem::size_of::<Self>())?;
        work.rows = model_rows;
        work.admit(0, 0, deadline)?;
        Ok(Self { supply, stock: input.stock, caps, windows: input.windows,
            minima: [[SAFE; 3]; 14], maxima: [[0; 3]; 14], spectra: Vec::new(), points: Vec::new(), projected: Vec::new(),
            deadline, row_limit, day: 1, offset: 0, last_acked: 0, phase: Phase::Date, prepared: false,
            point_only: true, work: std::mem::take(work) })
    }
    fn admit_prior(&mut self, cohort: usize) -> Result<()> {
        let prior = &self.supply.priors[cohort];
        self.work.ledger.charge(Category::Conversion, 6)?;
        let bits = prior.numer().bits().checked_add(prior.denom().bits()).ok_or("joint_source_integer_limit")?;
        let bytes = usize::try_from(bits.div_ceil(8)).map_err(|_| "joint_source_integer_limit")?;
        let scratch = bytes.checked_mul(8).and_then(|n| n.checked_add(8192)).ok_or("joint_source_integer_limit")?;
        if scratch > 64 * 1024 * 1024 { return Err("joint_source_integer_limit"); }
        self.work.admit(scratch, 0, self.deadline)
    }
    fn physical(&mut self, id: &str, cohort: usize) -> Result<(Vec<Atom>, Pieces, Pieces)> {
        self.supply.clear_source_memos();
        let physical_rows = self.supply.source_physical_rows(id)?;
        self.work.ledger.charge(Category::Physical, (physical_rows / 4 + id.len() + 64) as u64)?;
        self.work.admit(PHYSICAL_SCRATCH, physical_rows, self.deadline)?;
        // Source mode charges physical enumeration into the SAME ledger, even
        // on error, and admits its exact-integer/cache scratch before allocation.
        self.supply.source_start(std::mem::take(&mut self.work.ledger));
        let result = self.supply.law(&supply::LawRef { law_id: id.to_owned(), count: 1 }, cohort);
        self.work.ledger = self.supply.source_finish();
        #[cfg(target_arch = "wasm32")]
        { self.work.peak_bytes = self.work.peak_bytes.max(allocation::certified_heap_peak()); }
        let law = result?;
        if law.len() > self.row_limit { return Err("certified_supply_support_limit"); }
        self.work.max_exact_rows = self.work.max_exact_rows.max(law.len());
        let cache = self.supply.source_cache_bytes()?;
        let cache_rows = self.supply.source_cache_rows()?;
        self.work.live = add(self.work.live, cache)?;
        self.work.rows = add(self.work.rows, cache_rows)?;
        self.work.admit(0, 0, self.deadline)?;
        let mut atoms = self.work.vector::<Atom>(law.len(), true, self.deadline)?;
        let mut lo = [SAFE; 3];
        let mut hi = [0; 3];
        let mut total = 0u64;
        let mut integers = 0usize;
        for row in law.iter() {
            check(self.deadline)?;
            self.work.ledger.charge(Category::Physical, 16)?;
            if row.mass.numer().bits() > 2048 || row.mass.denom().bits() > 2048 {
                return Err("joint_source_integer_limit");
            }
            integers = add(integers, 128 + ((row.mass.numer().bits() + row.mass.denom().bits()).div_ceil(8) as usize))?;
            if integers > 64 * 1024 * 1024 { return Err("joint_source_integer_limit"); }
            if row.mass.numer().sign() != num_bigint::Sign::Plus || row.mass.numer() > row.mass.denom() { return Err("joint_source_contract"); }
            for k in 0..3 {
                if row.pieces[k] > SAFE { return Err("certified_law_raw_pieces_invalid"); }
                lo[k] = lo[k].min(row.pieces[k]); hi[k] = hi[k].max(row.pieces[k]);
            }
            let weight = ((row.mass.numer() << 63usize) / row.mass.denom()).to_u64().ok_or("joint_source_contract")?;
            total = total.checked_add(weight).filter(|&n| n <= M).ok_or("joint_source_contract")?;
            atoms.push((row.pieces, weight));
        }
        drop(law);
        self.supply.clear_source_memos();
        self.work.live -= cache;
        self.work.rows -= cache_rows;
        if atoms.is_empty() { return Err("joint_source_contract"); }
        Ok((atoms, lo, hi))
    }
    /// Universally saturated axes may be marginalized exactly. Use only
    /// guaranteed nonnegative gain: deterministic references are resolved
    /// through the REAL law path in every positive-prior cohort, so finite
    /// overrides (including stochastic ones) cannot forge a lower bound.
    fn marginal_stops(&mut self, ids: &[(usize, usize)]) -> Result<[usize; 3]> {
        let mut lower = [[0u64; 3]; 14];
        for &(event, reference) in ids {
            check(self.deadline)?;
            self.work.ledger.charge(Category::Physical, 1)?;
            let id = &self.supply.model.events[event].refs[reference].law_id;
            if !id.starts_with("deterministic:") { continue; }
            self.work.admit(id.len().checked_mul(3).ok_or("joint_source_memory_limit")?, 0, self.deadline)?;
            let id = id.clone();
            let mut minimum = [SAFE; 3];
            for cohort in 0..self.supply.priors.len() {
                if self.supply.priors[cohort].is_zero() { continue; }
                let (atoms, lo, _) = self.physical(&id, cohort)?;
                self.work.ledger.charge(Category::Physical, 3)?;
                for k in 0..3 { minimum[k] = minimum[k].min(lo[k]); }
                let capacity = atoms.capacity();
                self.work.release(atoms, capacity);
            }
            for event in &self.supply.model.events {
                check(self.deadline)?;
                for reference in &event.refs {
                    self.work.ledger.charge(Category::Physical, 1)?;
                    if reference.law_id != id { continue; }
                    for total in &mut lower[event.day-1..] {
                        self.work.ledger.charge(Category::Physical, 6)?;
                        *total = checked_scaled(*total, minimum, reference.count)?;
                    }
                }
            }
        }
        let mut stops = [14usize; 3];
        for (day, gain) in lower.into_iter().enumerate() {
            self.work.ledger.charge(Category::Physical, 12)?;
            let absolute = checked_scaled(self.stock, gain, 1)?;
            for k in 0..3 {
                if stops[k] == 14 && absolute[k] / 10 >= self.caps[k] as u64 { stops[k] = day; }
            }
        }
        Ok(stops)
    }

    fn prepare(&mut self) -> Result<()> {
        if self.prepared { return Ok(()); }
        let deadline = self.deadline;
        self.work.ledger.charge(Category::Physical, 3)?;
        // Gains are nonnegative. If stock already saturates every axis, every
        // physical outcome projects to exactly the same capped unit point.
        // Still enumerate ALL laws and check their unwrapped positive extrema.
        let capped_point = (0..3).all(|k| self.stock[k] / 10 >= self.caps[k] as u64);
        // Borrowed calendar IDs need no duplicate strings. Index pairs remain
        // valid because Supply never mutates its model during law enumeration.
        let count = self.supply.model.events.iter().map(|e| e.refs.len()).sum::<usize>();
        let mut ids = self.work.vector::<(usize, usize)>(count, false, deadline)?;
        for (e, event) in self.supply.model.events.iter().enumerate() {
            for (r, reference) in event.refs.iter().enumerate() {
                self.work.ledger.charge(Category::Physical, (ids.len() + 1) as u64)?;
                if reference.count > 0 && !ids.iter().any(|&(a,b)| self.supply.model.events[a].refs[b].law_id == reference.law_id) {
                    ids.push((e,r));
                }
            }
        }
        let marginal_stops = if capped_point { [0; 3] } else { self.marginal_stops(&ids)? };
        let mut raw_roots = [[Complex::ZERO; 300]; 3];
        let mut small_roots = [[Complex::ZERO; 30]; 3];
        let mut roots_ready = false;
        let mut power_builder = spectral::PowerBuilder::new();
        for cohort in 0..self.supply.priors.len() {
            if self.supply.priors[cohort].is_zero() { continue; }
            check(deadline)?;
            let mut laws = self.work.vector::<Law>(ids.len(), false, deadline)?;
            let mut shifts = [[0u64; 3]; 14];
            let mut low = [[0u64; 3]; 14];
            let mut high = [[0u64; 3]; 14];
            for &(e, r) in &ids {
                self.work.admit(self.supply.model.events[e].refs[r].law_id.len().checked_mul(3).ok_or("joint_source_memory_limit")?, 0, deadline)?;
                let id = self.supply.model.events[e].refs[r].law_id.clone();
                let mut counts = [0usize; 14];
                for event in &self.supply.model.events {
                    for reference in &event.refs {
                        self.work.ledger.charge(Category::Physical, 1)?;
                        if reference.law_id == id {
                            counts[event.day - 1] = counts[event.day - 1].checked_add(reference.count).ok_or("joint_source_work_limit")?;
                        }
                    }
                }
                for d in 1..14 { counts[d] = counts[d].checked_add(counts[d-1]).ok_or("joint_source_work_limit")?; }
                let (mut atoms, min, max) = self.physical(&id, cohort)?;
                for d in 0..14 {
                    self.work.ledger.charge(Category::Physical, 24)?;
                    low[d] = checked_scaled(low[d], min, counts[d])?;
                    high[d] = checked_scaled(high[d], max, counts[d])?;
                    checked_scaled(self.stock, high[d], 1)?;
                }
                if min == max || capped_point {
                    self.work.ledger.charge(Category::Physical, 14 * 6)?;
                    for d in 0..14 { shifts[d] = checked_scaled(shifts[d], min, counts[d])?; }
                    let n = atoms.capacity(); // reservation used original exact row count
                    self.work.release(atoms, n);
                    continue;
                }
                if !roots_ready {
                    for k in 0..3 {
                        super::spectral_roots::fill(&mut raw_roots[k][..RAW[k]], &mut self.work.ledger)?;
                        super::spectral_roots::fill(&mut small_roots[k][..UNIT[k]], &mut self.work.ledger)?;
                    }
                    roots_ready = true;
                }
                self.point_only = false;
                if self.spectra.is_empty() { self.spectra = self.work.complex(14 * SMALL, deadline)?; }
                // Coalesce every raw periodic grid cell in integers BEFORE any
                // floating conversion, including finite-law duplicate residues.
                self.work.ledger.charge(Category::Conversion, (atoms.len() as u64) * 8)?;
                for atom in &mut atoms { for k in 0..3 { atom.0[k] %= RAW[k] as u64; } }
                sort_rows(&mut atoms, |a| [a.0[2], a.0[1], a.0[0]], &mut self.work.ledger, chunk_clock(deadline))?;
                let mut end = 0;
                for i in 0..atoms.len() {
                    if atoms[i].1 == 0 { continue; }
                    if end > 0 && atoms[end-1].0 == atoms[i].0 {
                        atoms[end-1].1 = atoms[end-1].1.checked_add(atoms[i].1).filter(|&n| n <= M).ok_or("joint_source_contract")?;
                    } else { atoms[end] = atoms[i]; end += 1; }
                }
                atoms.truncate(end);
                let spectrum = if atoms.len() > 5 {
                    let mut spectrum = self.work.complex(HALF, deadline)?;
                    spectral::forward_half(&atoms, &mut spectrum, [&raw_roots[0][..300], &raw_roots[1][..120], &raw_roots[2][..80]],
                        &mut self.work.ledger, || check(deadline))?;
                    spectrum
                } else { Vec::new() };
                let mut masses = [0.0; 5];
                if spectrum.is_empty() {
                    for (j, atom) in atoms.iter().enumerate() {
                        self.work.ledger.charge(Category::Conversion, 2)?;
                        masses[j] = (atom.1 as f64) * MASS_SCALE;
                    }
                } else {
                    let n = atoms.capacity();
                    self.work.release(atoms, n);
                    atoms = Vec::new();
                }
                let z_prefix = atoms.iter().take_while(|(p,_)| p[2] == 0).count();
                laws.push(Law { counts, atoms, masses, spectrum, z_prefix, powers: Vec::new(), power_result: 0, group: 0, first: false });
            }
            for d in 0..14 { for k in 0..3 { self.minima[d][k] = self.minima[d][k].min(low[d][k]); self.maxima[d][k] = self.maxima[d][k].max(high[d][k]); } }
            if laws.is_empty() {
                if self.points.capacity() == 0 {
                    self.points = self.work.vector::<Projected>(14 * self.supply.priors.len(), true, deadline)?;
                }
                self.admit_prior(cohort)?;
                let prior = &self.supply.priors[cohort];
                self.work.ledger.charge(Category::Conversion, 4)?;
                let weight = ((prior.numer() << 63usize) / prior.denom()).to_u64().ok_or("joint_source_contract")?;
                for shift in shifts {
                    self.work.ledger.charge(Category::Conversion, 12)?;
                    let raw = checked_scaled(self.stock, shift, 1)?;
                    self.points.push(Projected { units: std::array::from_fn(|k| (raw[k] / 10).min(self.caps[k] as u64) as u32), weight });
                }
            } else {
                let mut local = self.work.complex(14 * SMALL, deadline)?;
                // Proportional schedules share one conditional daily factor:
                // product_j(phi_j^g_j), then its dated cumulative exponent.
                // This is algebraic reuse WITHIN a cohort, never a daily prior
                // mixture. It removes redundant per-law fourteen-date CMULs.
                let mut products = self.work.vector::<Product>(laws.len(), false, deadline)?;
                for law in &mut laws {
                    let mut divisor = 0usize;
                    for &count in &law.counts {
                        let mut b = count;
                        while b != 0 {
                            self.work.ledger.charge(Category::Powers, 1)?;
                            let remainder = divisor % b; divisor = b; b = remainder;
                        }
                    }
                    if divisor == 0 { return Err("joint_source_contract"); }
                    self.work.ledger.charge(Category::Powers, 14)?;
                    let schedule = law.counts.map(|n| n / divisor);
                    power_builder.compile(&[divisor], &mut self.work.ledger, || check(deadline))?;
                    law.powers = self.work.power_steps(&power_builder, deadline)?;
                    law.power_result = power_builder.outputs[0];
                    law.group = match products.iter().position(|p| p.schedule == schedule) {
                        Some(group) => group,
                        None => {
                            law.first = true;
                            products.push(Product { schedule, powers: Vec::new(), outputs: [spectral::NO_POWER; 14], offset: 0 });
                            products.len()-1
                        }
                    };
                }
                // Dates with equal piece residues share a weighted recurrence.
                // Whole-unit shifts are applied only on the SMALL spectra.
                let residues: [[u64; 3]; 14] = std::array::from_fn(|d| std::array::from_fn(|k| (self.stock[k] + shifts[d][k]) % 10));
                let mut groups = [0usize; 14];
                let mut group_count = 0;
                for d in 0..14 {
                    if !(0..d).any(|p| residues[p] == residues[d]) { groups[group_count] = d; group_count += 1; }
                }
                // Ascending dates of each residue: enumerate only the active
                // members in the hot loop, without re-comparing three residues.
                let mut date_bits = [0u16; 14];
                for &g in &groups[..group_count] {
                    for d in g..14 {
                        if residues[d] == residues[g] { date_bits[g] |= 1 << d; }
                    }
                }
                // Compile each date's delta from the previous date with this
                // residue. The same exponent nodes are shared across all
                // dates, and their integer arithmetic is performed only here.
                let mut product_slots = 0usize;
                for product in &mut products {
                    let mut targets = [0usize; 14];
                    for d in 0..14 {
                        let previous = (0..d).rev().find(|&p| residues[p] == residues[d]);
                        self.work.ledger.charge(Category::Powers, 1)?;
                        targets[d] = product.schedule[d] - previous.map_or(0, |p| product.schedule[p]);
                    }
                    power_builder.compile(&targets, &mut self.work.ledger, || check(deadline))?;
                    product.powers = self.work.power_steps(&power_builder, deadline)?;
                    product.outputs = power_builder.outputs;
                    product.offset = product_slots;
                    product_slots = add(product_slots, product.powers.len().max(1))?;
                }
                let law_slots = laws.iter().map(|law| law.powers.len()).max().unwrap_or(0).max(1);
                let mut power_values = self.work.complex(add(product_slots, law_slots)?, deadline)?;
                let mut filters = [[[Complex::ZERO; 300]; 3]; 14];
                for &g in &groups[..group_count] {
                    for k in 0..3 { spectral::axis_filter(&raw_roots[k][..RAW[k]], residues[g][k], &mut filters[g][k][..RAW[k]], &mut self.work.ledger)?; }
                }
                let mut coefficients = self.work.vector::<Complex>(products.len(), false, deadline)?;
                coefficients.resize(products.len(), Complex::ZERO);
                let mut xy = self.work.vector::<[Complex; 5]>(laws.len(), false, deadline)?;
                xy.resize(laws.len(), [Complex::ZERO; 5]);
                self.work.transform_coeffs = self.work.transform_coeffs.max(add(add(self.work.coefficients_live, 16_000)?, laws.len().checked_mul(6).ok_or("joint_source_memory_limit")?)?);
                // Flatten active factors in unchanged date and product order.
                let mut ends = [0usize; 15];
                for d in 0..14 {
                    ends[d+1] = add(ends[d], products.iter().filter(|p| p.outputs[d] != spectral::NO_POWER).count())?;
                }
                let mut slots = self.work.vector::<usize>(ends[14], false, deadline)?;
                for d in 0..14 {
                    for p in &products {
                        if p.outputs[d] != spectral::NO_POWER { slots.push(p.offset + p.outputs[d]); }
                    }
                }
                // The bounded z sweep has one zero mode and 70 nonzero
                // modes. Operation counts depend on schedules and sparse atom
                // exponents, not on the complex coefficients.
                let static_powers = 6 * (laws.iter().map(|l| l.powers.len().saturating_sub(1) + usize::from(!l.first)).sum::<usize>()
                    + products.iter().map(|p| p.powers.len().saturating_sub(1)).sum::<usize>()) as u64;
                let mut fwd = [0u64; 2];
                let sparse_atoms = laws.iter().map(|l| l.atoms.len() as u64).sum::<u64>();
                let mut prepaid_indices = 2 * sparse_atoms * if marginal_stops[2] == 0 { 1 } else { 71 };
                self.work.ledger.charge(Category::Forward, prepaid_indices)?;
                let mut zkeys = self.work.vector::<[[u8; 5]; 80]>(laws.len(), false, deadline)?;
                for law in &laws {
                    let mut keys = [[0u8; 5]; 80];
                    for z in 0..80 {
                        if z != 0 && (z % 8 == 0 || marginal_stops[2] == 0) { continue; }
                        for (j, &(p, _)) in law.atoms.iter().enumerate() {
                            let index = (z * p[2] as usize) % 80;
                            keys[z][j] = index as u8;
                            fwd[usize::from(z != 0)] += 2 + 2*u64::from(j != 0) + 6*u64::from(index != 0);
                        }
                    }
                    zkeys.push(keys);
                }
                for x in 0..151 {
                    if x != 0 && x % 30 == 0 { continue; }
                    let x_until = if x == 0 { 14 } else { marginal_stops[0] };
                    if x_until == 0 { continue; }
                    for y in 0..120 {
                        if y != 0 && y % 12 == 0 { continue; }
                        self.work.ledger.charge(Category::Fold, 1)?;
                        let xy_until = x_until.min(if y == 0 { 14 } else { marginal_stops[1] });
                        if xy_until == 0 { continue; }
                        check(deadline)?;
                        for (i, law) in laws.iter().enumerate() {
                            if !law.spectrum.is_empty() { continue; }
                            for (j, &(p, _)) in law.atoms.iter().enumerate() {
                                self.work.ledger.charge(Category::Forward, 4)?;
                                let a = raw_roots[0][(x * p[0] as usize) % 300];
                                let b = raw_roots[1][(y * p[1] as usize) % 120];
                                let value = self.work.ledger.multiply(a, b, Category::Forward)?;
                                self.work.ledger.charge(Category::Conversion, 2)?;
                                let mass = law.masses[j];
                                xy[i][j] = Complex { re: value.re * mass, im: value.im * mass };
                            }
                        }
                        let mut filter_xy = [Complex::ZERO; 14];
                        for &g in &groups[..group_count] {
                            if g < xy_until { filter_xy[g] = self.work.ledger.multiply(filters[g][0][x], filters[g][1][y], Category::Filters)?; }
                        }
                        let mirror = x != 0 && x != 150;
                        let other = xy_until.min(marginal_stops[2]);
                        let modes = if other == 0 { 1 } else { 71 };
                        self.work.ledger.charge(Category::Fold, 71 + (xy_until + 70*other) as u64 * if mirror {4} else {2})?;
                        self.work.ledger.charge(Category::Powers, static_powers * modes + 6*(ends[xy_until] + 70*ends[other]) as u64)?;
                        // The first (x,y)=(0,0) sweep uses all admitted z keys.
                        self.work.ledger.charge(Category::Forward, fwd[0] + if other == 0 { 0 } else { fwd[1] } - prepaid_indices)?;
                        prepaid_indices = 0;
                        // Raw-period atoms are ordered by z. The leading
                        // zero-plane sum is bitwise identical at every z;
                        // its first term is assigned, never added to +0.
                        for (i, law) in laws.iter().enumerate() {
                            if law.z_prefix == 0 { continue; }
                            let mut sum = xy[i][0];
                            for &term in &xy[i][1..law.z_prefix] {
                                sum.re += term.re; sum.im += term.im;
                            }
                            if law.z_prefix == law.atoms.len() && !law.powers.is_empty() {
                                spectral::evaluate_prepaid(&law.powers, sum, &mut power_values[product_slots..]);
                                sum = power_values[product_slots + law.power_result];
                            }
                            xy[i][0] = sum;
                        }
                        for z in 0..80 {
                            if z != 0 && z % 8 == 0 { continue; }
                            let until = xy_until.min(if z == 0 { 14 } else { marginal_stops[2] });
                            if until == 0 { continue; }
                            for (i, law) in laws.iter().enumerate() {
                                let value = if !law.spectrum.is_empty() {
                                    law.spectrum[(x * 120 + y) * 80 + z]
                                } else {
                                    let mut sum = xy[i][0];
                                    for j in law.z_prefix..law.atoms.len() {
                                        let index = zkeys[i][z][j] as usize;
                                        let term = if index == 0 { xy[i][j] } else { xy[i][j].times(raw_roots[2][index]) };
                                        if j == 0 { sum = term; } else { sum.re += term.re; sum.im += term.im; }
                                    }
                                    sum
                                };
                                let prepaid_value = law.z_prefix != 0 && law.z_prefix == law.atoms.len();
                                let value = if prepaid_value || law.powers.is_empty() { value } else {
                                    spectral::evaluate_prepaid(&law.powers, value, &mut power_values[product_slots..]);
                                    power_values[product_slots + law.power_result]
                                };
                                if law.first { coefficients[law.group] = value; }
                                else { coefficients[law.group] = coefficients[law.group].times(value); }
                            }
                            for (i, product) in products.iter().enumerate() {
                                let end = product.offset + product.powers.len().max(1);
                                spectral::evaluate_prepaid(&product.powers, coefficients[i], &mut power_values[product.offset..end]);
                            }
                            let pos = ((x % 30) * 12 + y % 12) * 8 + z % 8;
                            let neg = (((300-x) % 30) * 12 + (120-y) % 12) * 8 + (80-z) % 8;
                            for &g in &groups[..group_count] {
                                if g >= until { continue; }
                                let mut weighted = self.work.ledger.multiply(filter_xy[g], filters[g][2][z], Category::Filters)?;
                                // Nonzero modes stop when an axis universally
                                // caps. Its zero mode is the true marginal;
                                // inverse uniform spreading on that axis is
                                // collapsed by the existing full-support clamp.
                                // This is a positive L1-contractive channel,
                                // not probability truncation or colour splitting.
                                let mut dates = date_bits[g] & ((1 << until) - 1);
                                while dates != 0 {
                                    let d = dates.trailing_zeros() as usize;
                                    dates &= dates - 1;
                                    for &slot in &slots[ends[d]..ends[d+1]] {
                                        weighted = weighted.times(power_values[slot]);
                                    }
                                    // The frequency sweep updates all dates for
                                    // a given bin; store them in adjacent slots.
                                    let cell = &mut local[pos*14 + d];
                                    cell.re += weighted.re;
                                    cell.im += weighted.im;
                                    if mirror {
                                        let cell = &mut local[neg*14 + d];
                                        cell.re += weighted.re;
                                        cell.im += -weighted.im;
                                    }
                                }
                            }
                        }
                    }
                }
                self.work.release(zkeys, 0);
                self.work.release(slots, 0);
                self.work.release(coefficients, 0); self.work.release(xy, 0);
                self.work.release_complex(power_values);
                for product in products.drain(..) { self.work.release(product.powers, 0); }
                self.work.release(products, 0);
                self.admit_prior(cohort)?;
                let prior = self.supply.priors[cohort].to_f64().ok_or("joint_source_contract")?;
                self.work.ledger.charge(Category::Conversion, 3)?;
                for d in 0..14 {
                    self.work.ledger.charge(Category::Filters, 9)?;
                    let shift: [usize; 3] = std::array::from_fn(|k| (((self.stock[k] + shifts[d][k]) / 10) % UNIT[k] as u64) as usize);
                    for x in 0..30 { for y in 0..12 {
                        check(deadline)?;
                        self.work.ledger.charge(Category::Filters, 4)?;
                        let phase_xy = self.work.ledger.multiply(small_roots[0][(x*shift[0])%30], small_roots[1][(y*shift[1])%12], Category::Filters)?;
                        for z in 0..8 {
                            self.work.ledger.charge(Category::Filters, 2)?;
                            let phase = self.work.ledger.multiply(phase_xy, small_roots[2][(z*shift[2])%8], Category::Filters)?;
                            let bin = (x*12+y)*8+z;
                            let index = d*SMALL + bin;
                            let value = self.work.ledger.multiply(local[bin*14+d], phase, Category::Filters)?;
                            self.work.ledger.charge(Category::Fold, 2)?;
                            self.work.ledger.accumulate(&mut self.spectra[index], Complex { re: value.re*prior, im: value.im*prior }, Category::Fold)?;
                        }
                    }}
                }
                self.work.release_complex(local);
            }
            for law in laws.drain(..) {
                let n = law.atoms.capacity();
                self.work.release(law.atoms, n); self.work.release_complex(law.spectrum);
                self.work.release(law.powers, 0);
            }
            self.work.release(laws, 0);
        }
        self.work.release(ids, 0);
        if !self.point_only {
            for d in 0..14 {
                spectral::inverse_small(&mut self.spectra[d*SMALL..(d+1)*SMALL], [&small_roots[0][..30], &small_roots[1][..12], &small_roots[2][..8]],
                    &mut self.work.ledger, || check(deadline))?;
            }
        }
        self.prepared = true;
        Ok(())
    }
    fn project(&mut self) -> Result<()> {
        self.prepare()?;
        let d = self.day - 1;
        let capacity = self.supply.priors.len() + if self.point_only { 0 } else { SMALL };
        self.projected = self.work.vector::<Projected>(capacity, true, self.deadline)?;
        let mut remaining = M;
        // Point cohorts retain exact Q63 priors, not Fourier noise. Each block
        // contains all fourteen dates in their original order.
        for block in self.points.chunks_exact(14) {
            self.work.ledger.charge(Category::Conversion, 1)?;
            let mut row = block[d]; row.weight = row.weight.min(remaining); remaining -= row.weight;
            if row.weight != 0 { self.projected.push(row); }
        }
        if !self.point_only {
            for index in 0..SMALL {
                if index % 64 == 0 { check(self.deadline)?; }
                self.work.ledger.charge(Category::Conversion, 48)?;
                let q = self.spectra[d*SMALL+index].re;
                if !q.is_finite() || q.abs() > 2.0 { return Err("joint_source_contract"); }
                if q <= 0.0 { continue; }
                // Positive clipping is nonexpansive. Integer global excess
                // trimming (never normalization) costs <= the numeric envelope.
                let weight = ((q * M as f64) as u64).min(remaining);
                remaining -= weight;
                if weight == 0 { continue; }
                let periodic = [index / 96, (index / 8) % 12, index % 8];
                let units = std::array::from_fn(|k| {
                    let base = (i128::from(self.stock[k]) + i128::from(self.windows[d][k])) / 10;
                    let unit = base + (periodic[k] as i128 - base).rem_euclid(UNIT[k] as i128);
                    let lo = ((self.stock[k] + self.minima[d][k]) / 10) as i128;
                    let hi = ((self.stock[k] + self.maxima[d][k]) / 10) as i128;
                    unit.max(lo).min(hi).min(self.caps[k] as i128) as u32
                });
                self.projected.push(Projected { units, weight });
            }
        }
        let deadline = self.deadline;
        sort_rows(&mut self.projected, |row| row.units.map(u64::from), &mut self.work.ledger, chunk_clock(deadline))?;
        let mut end = 0;
        for i in 0..self.projected.len() {
            if end > 0 && self.projected[end-1].units == self.projected[i].units {
                self.projected[end-1].weight = self.projected[end-1].weight.checked_add(self.projected[i].weight).filter(|&n| n <= M).ok_or("joint_source_contract")?;
            } else { self.projected[end] = self.projected[i]; end += 1; }
        }
        self.projected.truncate(end);
        if end > self.row_limit { return Err("certified_supply_support_limit"); }
        // Reorder only after Q63 excess trimming and exact duplicate merging.
        // Tiny atoms lead; retained endpoints then have canonical locality.
        order_rows(&mut self.projected, &mut self.work.ledger, chunk_clock(deadline))?;
        check(deadline)?;
        self.offset = 0;
        Ok(())
    }
    fn next(&mut self) -> Result<Vec<u8>> {
        self.work.admit(0, 0, self.deadline)?;
        let day = self.day as u32;
        match self.phase {
            Phase::Date => { self.phase = Phase::Mixture; packet(1, day, &[], Json::Null) }
            Phase::Mixture => { self.project()?; self.phase = Phase::Rows; packet(2, day, &[], json!({"rowCount": self.projected.len()})) }
            Phase::Rows => {
                if self.offset == self.projected.len() { self.phase = Phase::MixtureEnd; return self.next(); }
                let end = (self.offset + CHUNK).min(self.projected.len());
                self.work.ledger.charge(Category::Conversion, (2*(end-self.offset)) as u64)?;
                let result = packet(3, day, &self.projected[self.offset..end], Json::Null)?;
                self.offset = end; Ok(result)
            }
            Phase::MixtureEnd => {
                let rows = std::mem::take(&mut self.projected);
                let n = rows.capacity();
                self.work.release(rows, n);
                self.phase = Phase::DateEnd; packet(4, day, &[], Json::Null)
            }
            Phase::DateEnd => { self.phase = Phase::Ack; packet(5, day, &[], Json::Null) }
            Phase::Ack => Err("joint_source_lifecycle"),
            Phase::Done => packet(6, 14, &[], Json::Null),
        }
    }
    fn ack(&mut self, day: usize) -> Result<()> {
        check(self.deadline)?;
        if self.phase != Phase::Ack || day != self.day || day != self.last_acked + 1 { return Err("joint_source_lifecycle"); }
        self.last_acked = day; self.day += 1;
        self.phase = if day == 14 { Phase::Done } else { Phase::Date };
        Ok(())
    }
}
fn mass_key(row: &Projected) -> [u64; 4] {
    [row.weight, u64::from(row.units[0]), u64::from(row.units[1]), u64::from(row.units[2])]
}
fn order_rows(rows: &mut [Projected], ledger: &mut Ledger,
    mut poll: impl FnMut() -> Result<()>) -> Result<usize> {
    sort_rows(rows, mass_key, ledger, &mut poll)?;
    let mut prelude = 0;
    let mut sum = 0.0;
    loop {
        poll()?;
        ledger.charge(Category::Conversion, 1)?;
        if prelude == rows.len() { break; }
        // Access/bounds, u64->f64, scaling, addition, nextUp bit conversion
        // and increment, and comparison. Match packet's binary64 mass exactly.
        ledger.charge(Category::Conversion, 9)?;
        let mass = (rows[prelude].weight as f64) * MASS_SCALE;
        // Projected weights are positive and <= M; this probe is finite and
        // positive, so incrementing its binary64 encoding is exactly nextUp.
        let next = f64::from_bits((sum + mass).to_bits() + 1);
        if next > ADVISORY_ORDERING_HINT { break; }
        ledger.charge(Category::Conversion, 1)?;
        sum = next;
        prelude += 1;
    }
    // All suffix masses are >= the first nonfitting mass. With an aligned
    // host hint none can fit its remaining allowance, regardless of this
    // canonical reordering. With a different host budget soundness is still
    // entirely the host's responsibility: we drop or normalize nothing.
    ledger.charge(Category::Conversion, 2)?;
    sort_rows(&mut rows[prelude..], |row| row.units.map(u64::from), ledger, &mut poll)?;
    Ok(prelude)
}
// Fallible, allocation-free heapsort: O(n log n) work, O(1) scratch.
// Keys have a fixed scalar width (three coordinates, or mass + coordinates).
// Sorting/ordering calls this at each bounded heap step or scan checkpoint.
// Always sample at entry and at least once per 32 checkpoints.
fn chunk_clock(deadline: f64) -> impl FnMut() -> Result<()> {
    let mut step = 0u8;
    move || {
        let sample = step == 0;
        step = (step + 1) & 31;
        if sample { check(deadline) } else { Ok(()) }
    }
}
// Charge before each performed comparison/index/heap step, including bounds
// checks; never hide tuple/array Ord work or change ordering after a refusal.
// Poll at each heap step, with only a bounded fixed-width comparison between
// polls. A refusal may leave a permutation, but no current-date rows escape.
fn sort_rows<T: Copy, const N: usize>(rows: &mut [T], key: impl Fn(&T) -> [u64; N],
    ledger: &mut Ledger, mut poll: impl FnMut() -> Result<()>) -> Result<()> {
    fn less<T, const N: usize>(rows: &[T], a: usize, b: usize, key: &impl Fn(&T) -> [u64; N],
        ledger: &mut Ledger) -> Result<bool> {
        // Two row accesses/bounds checks and the fixed-width key reads/casts.
        ledger.charge(Category::Conversion, 4 + 6 * N as u64)?;
        let a = key(&rows[a]);
        let b = key(&rows[b]);
        let mut k = 0;
        loop {
            ledger.charge(Category::Conversion, 1)?;
            if k == N { return Ok(false); }
            // Two key accesses/bounds checks and one scalar comparison.
            ledger.charge(Category::Conversion, 5)?;
            match a[k].cmp(&b[k]) {
                std::cmp::Ordering::Less => return Ok(true),
                std::cmp::Ordering::Greater => return Ok(false),
                std::cmp::Ordering::Equal => {}
            }
            ledger.charge(Category::Conversion, 1)?;
            k += 1;
        }
    }
    fn sift<T: Copy, const N: usize>(rows: &mut [T], mut root: usize, end: usize,
        key: &impl Fn(&T) -> [u64; N], ledger: &mut Ledger,
        poll: &mut impl FnMut() -> Result<()>) -> Result<()> {
        loop {
            poll()?;
            ledger.charge(Category::Conversion, 2)?;
            // This guard also proves 2*root+1 < end, so child arithmetic
            // cannot overflow even at the largest representable slice length.
            if root >= end / 2 { return Ok(()); }
            ledger.charge(Category::Conversion, 4)?;
            let mut child = 2 * root + 1;
            let right = child + 1;
            if right < end && less(rows, child, right, key, ledger)? {
                child = right;
            }
            if !less(rows, root, child, key, ledger)? { return Ok(()); }
            ledger.charge(Category::Conversion, 8)?;
            rows.swap(root, child);
            root = child;
        }
    }
    poll()?;
    ledger.charge(Category::Conversion, 1)?;
    let len = rows.len();
    let mut root = len / 2;
    loop {
        poll()?;
        ledger.charge(Category::Conversion, 1)?;
        if root == 0 { break; }
        ledger.charge(Category::Conversion, 1)?;
        root -= 1;
        sift(rows, root, len, &key, ledger, &mut poll)?;
    }
    let mut end = len;
    loop {
        poll()?;
        ledger.charge(Category::Conversion, 1)?;
        if end <= 1 { break; }
        ledger.charge(Category::Conversion, 9)?;
        end -= 1;
        rows.swap(0, end);
        sift(rows, 0, end, &key, ledger, &mut poll)?;
    }
    Ok(())
}
fn checked_scaled(a: Pieces, b: Pieces, count: usize) -> Result<Pieces> {
    let mut out = [0;3];
    for k in 0..3 {
        let n = (b[k] as u128).checked_mul(count as u128).and_then(|v| v.checked_add(a[k] as u128)).filter(|&v| v <= SAFE as u128).ok_or("certified_law_raw_pieces_invalid")?;
        out[k] = n as u64;
    }
    Ok(out)
}
fn packet(kind: u32, day: u32, rows: &[Projected], meta: Json) -> Result<Vec<u8>> {
    if rows.len() > CHUNK || (kind != 3 && !rows.is_empty()) { return Err("joint_source_contract"); }
    let metadata = if meta.is_null() { Vec::new() } else { serde_json::to_vec(&meta).map_err(|_| "joint_source_contract")? };
    if metadata.len() > 4096 { return Err("joint_source_contract"); }
    let mut out = Vec::new();
    out.try_reserve_exact(24 + 20*rows.len() + metadata.len()).map_err(|_| "joint_source_memory_limit")?;
    out.extend_from_slice(b"JQS2");
    for word in [kind, day, NONE, rows.len() as u32, metadata.len() as u32] { out.extend_from_slice(&word.to_le_bytes()); }
    for row in rows {
        for n in row.units { out.extend_from_slice(&n.to_le_bytes()); }
        out.extend_from_slice(&((row.weight as f64) * MASS_SCALE).to_le_bytes());
    }
    out.extend_from_slice(&metadata); Ok(out)
}
fn normal(reason: &str) -> bool {
    matches!(reason, "request_budget_exhausted" | "joint_source_work_limit" | "joint_source_memory_limit" |
        "joint_source_integer_limit" | "managed_payload_ceiling" | "certified_supply_support_limit" | "exact_support_limit")
}
enum Session { Live(Request), Failed { last_acked: usize, work: Work } }
impl Session {
    fn failed(self) -> Self { match self { Self::Live(r) => Self::Failed { last_acked: r.last_acked, work: r.work }, failed => failed } }
}
static mut SESSION: Option<Session> = None;
/// Allocation-free telemetry: 0 combined raw, 1 probability row peak,
/// 2 source byte peak, 3 exact-law row peak, 4 transform complex-slot peak,
/// 5 host raw, 6 ceil(combined raw/8), 7 last acknowledged day.
/// 8..15 native raw Roots/Forward/Powers/Filters/Fold/Inverse/Conversion/Physical.
#[no_mangle]
pub unsafe extern "C" fn certified_joint_diagnostic(index: u32) -> usize {
    let (w, acked) = match SESSION.as_ref() { Some(Session::Live(r)) => (&r.work, r.last_acked), Some(Session::Failed { work, last_acked }) => (work, *last_acked), None => return 0 };
    match index {
        0 => w.ledger.total as usize, 1 => w.peak_rows, 2 => w.peak_bytes, 3 => w.max_exact_rows,
        4 => w.transform_coeffs, 5 => w.host as usize, 6 => w.ledger.mac_equivalent() as usize, 7 => acked,
        8..=14 => w.ledger.scalar[(index-8) as usize] as usize,
        15 => w.ledger.scalar[Category::Physical as usize].saturating_sub(w.host) as usize,
        _ => 0,
    }
}
pub(crate) fn version() -> u32 { 2 }
pub(crate) unsafe fn clear() { SESSION = None; }
unsafe fn failure(reason: &'static str) -> u32 {
    let failed = SESSION.take().unwrap_or_else(|| Session::Failed { last_acked: 0, work: Work::default() }).failed();
    let last = match &failed { Session::Failed { last_acked, .. } => *last_acked, _ => unreachable!() };
    SESSION = Some(failed);
    let reason = if normal(reason) || matches!(reason, "joint_source_contract" | "joint_source_lifecycle" | "certified_law_raw_pieces_invalid") { reason } else { "joint_source_contract" };
    OUTPUT = packet(7, last as u32, &[], json!({"reason": reason, "lastAckedDay": last})).expect("bounded joint source error packet");
    if normal(reason) { 1 } else { 2 }
}
pub(crate) unsafe fn begin() -> u32 {
    let run = || -> Result<Request> {
        if SESSION.is_some() { return Err("joint_source_lifecycle"); }
        if INPUT.len() > 4096 { return Err("joint_source_contract"); }
        let input: Begin = serde_json::from_slice(&INPUT).map_err(|_| "joint_source_contract")?;
        let hash = |s: &str| s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if input.algorithm != ALGORITHM || !hash(&input.source_identity) || !hash(&input.source_key) || !hash(&input.projection_key) { return Err("joint_source_contract"); }
        SESSION = Some(Session::Failed { last_acked: 0, work: Work::host_debit(input.host_performed_work) });
        let engine = ENGINE.as_mut().ok_or("joint_source_lifecycle")?;
        let stock: Units = [usize::try_from(input.stock[0]).map_err(|_| "joint_source_contract")?, usize::try_from(input.stock[1]).map_err(|_| "joint_source_contract")?, usize::try_from(input.stock[2]).map_err(|_| "joint_source_contract")?];
        if engine.configured_source_root != Some((input.sid, stock)) || !engine.current_request.is_some_and(|(sid, actual, _)| sid == input.sid && actual == stock) { return Err("joint_source_contract"); }
        let caps = *engine.caps.get(input.sid).ok_or("joint_source_contract")?;
        let deadline = engine.deadline;
        let row_limit = if engine.max_support < 25_000 { engine.max_support } else { ROWS };
        // Reusable exact memo is not authority. Preserve Current, primary
        // witnesses and every cumulative counter while releasing its backing.
        engine.memo = HashMap::new();
        let supply = SUPPLY.take().ok_or("joint_source_lifecycle")?;
        let work = match SESSION.as_mut() {
            Some(Session::Failed { work, .. }) => work,
            _ => return Err("joint_source_lifecycle"),
        };
        Request::new(supply, input, caps, deadline, row_limit, work)
    };
    match run() {
        Ok(r) => { SESSION = Some(Session::Live(r)); match packet(0,0,&[],Json::Null) { Ok(b) => { OUTPUT=b; 0 }, Err(e) => failure(e) } }
        Err(e) => failure(e),
    }
}
pub(crate) unsafe fn next() -> u32 {
    let result = match SESSION.as_mut() { Some(Session::Live(r)) => r.next(), _ => Err("joint_source_lifecycle") };
    match result { Ok(b) => { OUTPUT=b; 0 }, Err(e) => failure(e) }
}
pub(crate) unsafe fn ack(day: u32) -> u32 {
    let result = match SESSION.as_mut() { Some(Session::Live(r)) => r.ack(day as usize), _ => Err("joint_source_lifecycle") };
    match result { Ok(()) => 0, Err(e) => failure(e) }
}
#[cfg(test)]
#[path = "joint_source_tests.rs"]
mod tests;
