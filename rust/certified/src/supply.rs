//! Exact physical supply enumeration and fixed stock-plus-recurring-day prices.
//! Same documented model as shared/certifiedSupplyLaws.ts. All convolutions,
//! board draws/rerolls and cohort expectation arithmetic stay inside WASM.
use super::*;
use std::rc::Rc;
mod rates;
mod v3_gate;
mod convolve_grouping;
#[cfg(test)]
mod convolve_tests;
#[cfg(test)]
mod convolve_grouping_tests;

pub type Pieces = [u64; 3];
const MAX_SAFE_PIECES: u64 = 9_007_199_254_740_991;
fn checked_pieces_sum(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b)
        .filter(|&sum| sum <= MAX_SAFE_PIECES)
        .ok_or("certified_law_raw_pieces_invalid")
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LawRef {
    pub law_id: String,
    pub count: usize,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    pub day: usize,
    pub refs: Vec<LawRef>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Law {
    id: String,
    kind: String,
    // Legacy versions ignored this metadata; only v3 constrains its value.
    model_version: Option<Json>,
    outcomes: Option<Vec<Row>>,
    outcomes_by_cohort: Option<Vec<Vec<Row>>>,
}
#[derive(Clone, Deserialize)]
pub struct Class {
    weight: u32,
    keep: bool,
    raw: [usize; 5],
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    snapshot_version: String,
    pub events: Vec<Event>,
    laws: Vec<Law>,
    pub priors: Vec<WireQ>,
    population_prior: Vec<WireQ>,
    dispatch: Vec<LawRef>,
    shop: Vec<LawRef>,
    solo: Vec<LawRef>,
    cadence: WireQ,
    dispatch_expected: Vec<[WireQ; 3]>,
    classes: Vec<Class>,
}
#[derive(Clone)]
pub struct Outcome {
    pub pieces: Pieces,
    pub mass: Q,
}
pub type Dist = Rc<Vec<Outcome>>;
pub(super) type CohortSupports = Vec<Vec<Pieces>>;
struct IntegerConvolution {
    numerators: [Vec<BigUint>; 2],
    denominator: BigUint,
    grouping_bounds: convolve_grouping::Bounds,
}
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ConvolvePath {
    Fast,
    Rational,
}

// Bound retained payload for the pinned num-bigint/Vec/HashMap implementations,
// before allocating common denominators or scaled numerators. This is admission,
// not a reservation or an upper bound on transient library arithmetic scratch.
fn convolve_integer_bytes(bits: u64) -> Option<usize> {
    // Keep x2: num-bigint 0.4.8's BigDigits::normalize only shrinks below
    // half capacity, and Vec's append growth can retain nearly twice the
    // required length. These integers are fresh normalized products or
    // nondecreasing sums, not copies of arbitrary input capacities. Two
    // spare 64-bit words cover multiplication's extra limb, the odd-capacity
    // half threshold and minimum Vec capacity for either digit width.
    usize::try_from(bits.checked_add(63)? / 64)
        .ok()?
        .checked_add(2)?
        .checked_mul(8)?
        .checked_mul(2)
}

fn convolve_workspace_bytes(
    lengths: [usize; 2],
    limit: usize,
    denominator_bits: [u64; 2],
    excess_bits: [u64; 2],
) -> Option<usize> {
    let a_bits = denominator_bits[0].checked_add(excess_bits[0])?;
    let b_bits = denominator_bits[1].checked_add(excess_bits[1])?;
    // Each scaled numerator is < 2^a_bits or < 2^b_bits. There are at most
    // lengths[0] * lengths[1] nonnegative contributions to any output row.
    let mass_bits = a_bits
        .checked_add(b_bits)?
        .checked_add((usize::BITS - lengths[0].saturating_sub(1).leading_zeros()) as u64)?
        .checked_add((usize::BITS - lengths[1].saturating_sub(1).leading_zeros()) as u64)?;
    let a_bytes = convolve_integer_bytes(a_bits)?;
    let b_bytes = convolve_integer_bytes(b_bits)?;
    let mass_bytes = convolve_integer_bytes(mass_bits)?;
    let denominator_bytes =
        convolve_integer_bytes(denominator_bits[0].checked_add(denominator_bits[1])?)?;
    let rows = lengths[0].checked_mul(lengths[1])?.min(limit);
    let slots = rows.max(4).checked_next_power_of_two()?;
    let inputs = lengths[0]
        .checked_mul(std::mem::size_of::<BigUint>().checked_add(a_bytes)?)?
        .checked_add(
            lengths[1].checked_mul(std::mem::size_of::<BigUint>().checked_add(b_bytes)?)?,
        )?;
    let outputs = slots
        .checked_mul(std::mem::size_of::<(Pieces, BigUint)>())?
        .checked_add(rows.checked_mul(std::mem::size_of::<Outcome>())?)?
        .checked_add(rows.checked_mul(mass_bytes.checked_add(denominator_bytes)?)?)?;
    // A row vector grown by push needs at most next_power_of_two(max(rows,4))
    // slots. The pinned HashMap's 7/8 load bound needs at most twice that many
    // buckets, plus its control bytes and trailing group (at most 16 bytes).
    // Count both output vectors even though inputs/the map are dropped before
    // final conversion. Reallocation overlap and internal arithmetic scratch
    // are transient, and remain subject to the accounted allocator.
    let indices = slots
        .checked_mul(2)?
        .checked_mul(std::mem::size_of::<(Pieces, usize)>().checked_add(1)?)?
        .checked_add(16)?;
    inputs
        .checked_add(outputs)?
        .checked_add(indices)?
        .checked_add(mass_bytes)?
        .checked_add(denominator_bytes.checked_mul(6)?)
}

fn convolve_cap_volume(caps: Pieces) -> Option<usize> {
    caps.iter().try_fold(1usize, |volume, &cap| {
        volume.checked_mul(usize::try_from(cap.checked_add(1)?).ok()?)
    })
}

fn convolve_capped_workspace_bytes(
    lengths: [usize; 2],
    limit: usize,
    caps: Pieces,
    denominator_bits: [u64; 2],
    excess_bits: [u64; 2],
) -> Option<usize> {
    // A successful capped key lies in [0,caps[0]] x [0,caps[1]] x [0,caps[2]].
    // checked_add rejects the unbounded u64::MAX sentinel. Any conversion or
    // volume overflow retains the original bound; never use a partial product.
    let volume = convolve_cap_volume(caps);
    convolve_workspace_bytes(
        lengths,
        volume.map_or(limit, |volume| limit.min(volume)),
        denominator_bits,
        excess_bits,
    )
}

fn convolve_reachable_volume(minima: [Pieces; 2], maxima: [Pieces; 2], caps: Pieces) -> Option<usize> {
    (0..3).try_fold(1usize, |volume, axis| {
        // Unsafe raw extrema disable this refinement, even when capping would
        // hide them. Only the original pair loop may report a piece error.
        let lo = caps[axis].min(checked_pieces_sum(minima[0][axis], minima[1][axis]).ok()?);
        let hi = caps[axis].min(checked_pieces_sum(maxima[0][axis], maxima[1][axis]).ok()?);
        let width = usize::try_from(hi.checked_sub(lo)?.checked_add(1)?).ok()?;
        volume.checked_mul(width)
    })
}

pub struct Supply {
    pub model: Model,
    pub priors: Vec<Q>,
    population_prior: Vec<Q>,
    cache: HashMap<(String, usize, usize), Dist>,
    boxes: HashMap<(usize, usize), Dist>,
    support_cache: HashMap<(String, usize), Rc<CohortSupports>>,
    deadline: f64,
    ticks: usize,
    #[cfg(test)]
    pub(super) convolve_last_path: Option<ConvolvePath>,
    #[cfg(test)]
    pub(super) convolve_force_rational: bool,
    #[cfg(test)]
    pub(super) convolve_force_admission_failure: bool,
    #[cfg(test)]
    convolve_scratch_failure: Option<convolve_grouping::ForcedFailure>,
    #[cfg(test)]
    convolve_grouping_active: bool,
    #[cfg(test)]
    convolve_flush_trace: Option<Vec<(usize, usize, usize, usize)>>,
    #[cfg(test)]
    convolve_fail_check_at: Option<usize>,
}
impl Supply {
    pub fn new(model: Model, deadline: f64) -> Result<Self> {
        v3_gate::validate_laws(&model)?;
        let fixed_dispatch = model.snapshot_version == "certified-daily-v5";
        if model.population_prior.len() != if fixed_dispatch { 3 } else { 4 } {
            return Err("invalid_population_prior");
        }
        let population_prior = model
            .population_prior
            .iter()
            .map(WireQ::rational)
            .collect::<Result<Vec<_>>>()?;
        if population_prior.iter().any(|q| q < &Q::zero())
            || population_prior.iter().sum::<Q>() != Q::one()
            || !v3_gate::population_prior_is_allowed(&model.snapshot_version, &population_prior)
        {
            return Err("invalid_population_prior");
        }
        // Arity is versioned: v1 and v5 both have three entries. Never pad.
        if !matches!(model.priors.len(), 3 | 4)
            || (fixed_dispatch && model.priors.len() != 3)
            || model.dispatch_expected.len() != model.priors.len()
        {
            return Err("invalid_cohort_weights");
        }
        if model.laws.iter().any(|law| {
            law.outcomes_by_cohort
                .as_ref()
                .is_some_and(|rows| rows.len() != model.priors.len())
        }) {
            return Err("certified_snapshot_cohort_law_invalid");
        }
        let priors = model
            .priors
            .iter()
            .map(WireQ::rational)
            .collect::<Result<Vec<_>>>()?;
        if priors.iter().any(|q| q < &Q::zero()) || priors.iter().sum::<Q>() != Q::one() {
            return Err("invalid_cohort_weights");
        }
        if fixed_dispatch && priors != population_prior {
            return Err("invalid_cohort_weights");
        }
        Ok(Self {
            model,
            priors,
            population_prior,
            cache: HashMap::new(),
            boxes: HashMap::new(),
            support_cache: HashMap::new(),
            deadline,
            ticks: 0,
            #[cfg(test)]
            convolve_last_path: None,
            #[cfg(test)]
            convolve_force_rational: false,
            #[cfg(test)]
            convolve_force_admission_failure: false,
            #[cfg(test)]
            convolve_scratch_failure: None,
            #[cfg(test)]
            convolve_grouping_active: false,
            #[cfg(test)]
            convolve_flush_trace: None,
            #[cfg(test)]
            convolve_fail_check_at: None,
        })
    }
    fn check(&mut self) -> Result<()> {
        self.ticks += 1;
        #[cfg(test)]
        if self.ticks % 32 == 0 && self.convolve_fail_check_at == Some(self.ticks) {
            return Err("request_budget_exhausted");
        }
        if self.ticks % 32 == 0 && now() >= self.deadline {
            return Err("request_budget_exhausted");
        }
        Ok(())
    }
    pub fn singleton(stock: Pieces) -> Vec<Outcome> {
        vec![Outcome {
            pieces: stock,
            mass: Q::one(),
        }]
    }
    fn convolve_deadline(&self) -> Result<()> {
        if now() >= self.deadline {
            Err("request_budget_exhausted")
        } else {
            Ok(())
        }
    }
    fn convolve_admit(&self, bytes: Option<usize>) -> bool {
        #[cfg(test)]
        if self.convolve_force_admission_failure {
            return false;
        }
        let Some(bytes) = bytes else {
            return false;
        };
        #[cfg(target_arch = "wasm32")]
        {
            super::allocation::can_admit(bytes)
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            let _ = bytes;
            true
        }
    }
    fn prepare_convolve(
        &self,
        a: &[Outcome],
        b: &[Outcome],
        caps: Pieces,
        limit: usize,
    ) -> Result<Option<IntegerConvolution>> {
        let inputs = [a, b];
        let lengths = [a.len(), b.len()];
        let mut excess_bits = [0; 2];
        let mut minima = [[u64::MAX; 3]; 2];
        let mut maxima = [[0; 3]; 2];
        // Never interpret a signed numerator's magnitude as its probability.
        for (side, rows) in inputs.iter().enumerate() {
            for (i, row) in rows.iter().enumerate() {
                if i % 32 == 0 {
                    self.convolve_deadline()?;
                }
                if row.mass.numer() < &BigInt::zero() || row.mass.denom() <= &BigInt::zero() {
                    return Ok(None);
                }
                // Include left-zero rows (which can retain support) and every
                // right row. This piggybacks on the existing validation pass.
                for (axis, &pieces) in row.pieces.iter().enumerate() {
                    minima[side][axis] = minima[side][axis].min(pieces);
                    maxima[side][axis] = maxima[side][axis].max(pieces);
                }
                if !row.mass.is_zero() {
                    let Some(excess) = row
                        .mass
                        .numer()
                        .bits()
                        .saturating_sub(row.mass.denom().bits())
                        .checked_add(1)
                    else {
                        return Ok(None);
                    };
                    excess_bits[side] = excess_bits[side].max(excess);
                }
            }
            if !rows.is_empty() {
                self.convolve_deadline()?;
            }
        }
        // One call-wide bound for every admission gate; never replace the real
        // support limit or operand lengths. None retains the original estimate.
        let projection_limit =
            convolve_reachable_volume(minima, maxima, caps).map_or(limit, |volume| limit.min(volume));
        let mut denominator_bits = [1; 2];
        if !self.convolve_admit(convolve_capped_workspace_bytes(
            lengths,
            projection_limit,
            caps,
            denominator_bits,
            excess_bits,
        )) {
            return Ok(None);
        }
        let mut denominators = [BigUint::one(), BigUint::one()];
        for (side, rows) in inputs.iter().enumerate() {
            for (i, row) in rows.iter().enumerate() {
                if i % 32 == 0 {
                    self.convolve_deadline()?;
                }
                let d = row.mass.denom().magnitude();
                if d.is_one() || &denominators[side] == d {
                    continue;
                }
                let Some(candidate_bits) = denominator_bits[side].checked_add(d.bits()) else {
                    return Ok(None);
                };
                let mut projected_bits = denominator_bits;
                projected_bits[side] = candidate_bits;
                if !self.convolve_admit(convolve_capped_workspace_bytes(
                    lengths,
                    projection_limit,
                    caps,
                    projected_bits,
                    excess_bits,
                )) {
                    return Ok(None);
                }
                if (&denominators[side] % d).is_zero() {
                    continue;
                }
                // Q's reduction supplies d/gcd(D,d), without another dependency
                // or a second implementation of arbitrary-precision GCD.
                let reduced = Q::new(denominators[side].clone().into(), row.mass.denom().clone());
                denominators[side] *= reduced.denom().magnitude();
                denominator_bits[side] = denominators[side].bits();
            }
            if !rows.is_empty() {
                self.convolve_deadline()?;
            }
        }
        if !self.convolve_admit(convolve_capped_workspace_bytes(
            lengths,
            projection_limit,
            caps,
            denominator_bits,
            excess_bits,
        )) {
            return Ok(None);
        }
        let denominator = &denominators[0] * &denominators[1];
        let mut numerators: [Vec<BigUint>; 2] = std::array::from_fn(|_| Vec::new());
        for (side, rows) in inputs.iter().enumerate() {
            if numerators[side].try_reserve_exact(rows.len()).is_err() {
                return Ok(None);
            }
            for (i, row) in rows.iter().enumerate() {
                if i % 32 == 0 {
                    self.convolve_deadline()?;
                }
                let numerator = if row.mass.is_zero() {
                    BigUint::zero()
                } else {
                    row.mass.numer().magnitude()
                        * (&denominators[side] / row.mass.denom().magnitude())
                };
                numerators[side].push(numerator);
            }
            if !rows.is_empty() {
                self.convolve_deadline()?;
            }
        }
        Ok(Some(IntegerConvolution {
            numerators,
            denominator,
            // Metadata only: no E estimation, admission or reservation until
            // this entire original C preparation has returned successfully.
            grouping_bounds: convolve_grouping::Bounds {
                lengths,
                projection_limit,
                caps,
                denominator_bits,
                excess_bits,
            },
        }))
    }
    fn flush_convolve_groups(
        &mut self,
        scratch: &mut convolve_grouping::Scratch,
        left: &BigUint,
        right: &[BigUint],
        out: &mut [(Pieces, BigUint)],
        row: usize,
    ) {
        #[cfg(test)]
        let (m, g) = scratch.pending();
        scratch.flush(left, right, out);
        #[cfg(test)]
        if m != 0 {
            if let Some(trace) = &mut self.convolve_flush_trace {
                trace.push((self.ticks, row, m, g));
            }
        }
        #[cfg(not(test))]
        let _ = row;
    }
    /// With D_A/D_B the input denominator LCMs, scale masses to integers A_i/B_j
    /// and accumulate A_i*B_j over D_A*D_B, then normalize each final Q once.
    /// Signed/raw-invalid masses or failed admission use convolve_rational;
    /// preparation buffers are dropped before that exact fallback.
    /// Retained payload is bounded separately: scaled-numerator bit bounds and
    /// the pair count bound every nonnegative partial sum; distinct rows are at
    /// most min(|A|*|B|,limit,product(caps+1)). The cap bound is used only when all
    /// caps are finite and its checked product fits usize, otherwise it is
    /// omitted. The reachable box further bounds rows by product(hi-lo+1), with
    /// lo=min(cap,minA+minB), hi=min(cap,maxA+maxB) per axis over all input rows.
    /// Unsafe raw sums or usize overflow omit only this refinement.
    /// Integer capacity slack, row-vector slots, index-map buckets and
    /// normalized output denominators are included by convolve_workspace_bytes.
    /// This does not bound transient GCD/division/multiplication scratch or
    /// reallocation overlap: the accounted allocator enforces those allocations
    /// too. The projection is not a reservation or a promise of total heap fit.
    /// Keep first-insertion order, capped collisions, left-zero rows, checked
    /// piece sums and support errors in the original pair positions. Each pair
    /// calls self.check() exactly once, before skipping a right-zero mass.
    /// Sign, denominator, numerator and final-conversion loops check the clock
    /// directly before indices 0,32,64,... and after each nonempty loop. These
    /// checks never change ticks and only return request_budget_exhausted;
    /// individual big-integer operations remain non-preemptible.
    pub fn convolve(
        &mut self,
        a: &[Outcome],
        b: &[Outcome],
        caps: Pieces,
        limit: usize,
    ) -> Result<Vec<Outcome>> {
        let result = self.convolve_inner(a, b, caps, limit);
        result
    }
    fn convolve_inner(
        &mut self,
        a: &[Outcome],
        b: &[Outcome],
        caps: Pieces,
        limit: usize,
    ) -> Result<Vec<Outcome>> {
        #[cfg(test)]
        {
            self.convolve_last_path = None;
            self.convolve_grouping_active = false;
            if self.convolve_force_rational {
                self.convolve_last_path = Some(ConvolvePath::Rational);
                return self.convolve_rational(a, b, caps, limit);
            }
        }
        // The original empty product does not inspect masses or the deadline.
        let prepared = if a.is_empty() || b.is_empty() {
            None
        } else {
            self.prepare_convolve(a, b, caps, limit)?
        };
        let Some(IntegerConvolution {
            numerators,
            denominator,
            grouping_bounds,
        }) = prepared
        else {
            #[cfg(test)]
            {
                self.convolve_last_path = Some(ConvolvePath::Rational);
            }
            return self.convolve_rational(a, b, caps, limit);
        };
        // E rejection drops every scratch allocation, but retains C's prepared
        // numerators/denominator. It must never restart or select rational.
        let mut grouping = convolve_grouping::Scratch::prepare(self, grouping_bounds);
        #[cfg(test)]
        {
            self.convolve_last_path = Some(ConvolvePath::Fast);
            self.convolve_grouping_active = grouping.is_some();
        }
        let mut indices = HashMap::<Pieces, usize>::new();
        let mut out: Vec<(Pieces, BigUint)> = Vec::new();
        for (xi, x) in a.iter().enumerate() {
            for (yi, y) in b.iter().enumerate() {
                // Flush BEFORE the next existing clock-bearing check, including
                // when entry ticks are unaligned. The checked pair itself starts
                // the next window. No E clock reads or ticks are introduced.
                if self.ticks % 32 == 31 {
                    if let Some(scratch) = grouping.as_mut() {
                        self.flush_convolve_groups(
                            scratch, &numerators[0][xi], &numerators[1], &mut out, xi,
                        );
                    }
                }
                self.check()?;
                if y.mass.is_zero() {
                    continue;
                }
                let mut pieces = [0; 3];
                for k in 0..3 {
                    pieces[k] = caps[k].min(checked_pieces_sum(x.pieces[k], y.pieces[k])?);
                }
                if let Some(scratch) = grouping.as_mut() {
                    let slot = if let Some(&i) = indices.get(&pieces) {
                        i
                    } else {
                        if out.len() >= limit {
                            return Err("exact_support_limit");
                        }
                        let i = out.len();
                        indices.insert(pieces, i);
                        out.push((pieces, BigUint::zero()));
                        i
                    };
                    scratch.push(slot, yi, &numerators[1]);
                } else {
                    // Original C LCM loop, sharing every pair visit, tick,
                    // right-zero skip and checked raw/capped key computation.
                    let mass = &numerators[0][xi] * &numerators[1][yi];
                    if let Some(&i) = indices.get(&pieces) {
                        out[i].1 += mass;
                    } else {
                        if out.len() >= limit {
                            return Err("exact_support_limit");
                        }
                        indices.insert(pieces, out.len());
                        out.push((pieces, mass));
                    }
                }
            }
            if let Some(scratch) = grouping.as_mut() {
                self.flush_convolve_groups(
                    scratch, &numerators[0][xi], &numerators[1], &mut out, xi,
                );
            }
        }
        drop(grouping);
        drop(numerators);
        drop(indices);
        let length = out.len();
        let mut result = Vec::with_capacity(length);
        for (i, (pieces, numerator)) in out.into_iter().enumerate() {
            if i % 32 == 0 {
                self.convolve_deadline()?;
            }
            result.push(Outcome {
                pieces,
                mass: Q::new(numerator.into(), denominator.clone().into()),
            });
        }
        if length != 0 {
            self.convolve_deadline()?;
        }
        Ok(result)
    }
    pub(super) fn convolve_rational(
        &mut self,
        a: &[Outcome],
        b: &[Outcome],
        caps: Pieces,
        limit: usize,
    ) -> Result<Vec<Outcome>> {
        // Preserve first-insertion order: receipt selectors' exact tie-breaking
        // uses the source law's order, not HashMap iteration order.
        let mut indices = HashMap::<Pieces, usize>::new();
        let mut out: Vec<Outcome> = Vec::new();
        for x in a {
            for y in b {
                self.check()?;
                if y.mass.is_zero() {
                    continue;
                }
                let mut pieces = [0; 3];
                for k in 0..3 {
                    pieces[k] = caps[k].min(checked_pieces_sum(x.pieces[k], y.pieces[k])?);
                }
                let mass = &x.mass * &y.mass;
                if let Some(&i) = indices.get(&pieces) {
                    out[i].mass += mass;
                } else {
                    if out.len() >= limit {
                        return Err("exact_support_limit");
                    }
                    indices.insert(pieces, out.len());
                    out.push(Outcome { pieces, mass });
                }
            }
        }
        Ok(out)
    }
    fn boxes(&mut self, regular: usize, ii: usize) -> Result<Dist> {
        if let Some(v) = self.boxes.get(&(regular, ii)) {
            return Ok(v.clone());
        }
        let mut rows = Self::singleton([0; 3]);
        let regular_law = vec![
            Outcome {
                pieces: [3, 0, 0],
                mass: Q::new(4.into(), 5.into()),
            },
            Outcome {
                pieces: [0, 1, 0],
                mass: Q::new(1.into(), 5.into()),
            },
        ];
        let ii_law = vec![
            Outcome {
                pieces: [5, 0, 0],
                mass: Q::new(7.into(), 10.into()),
            },
            Outcome {
                pieces: [0, 2, 0],
                mass: Q::new(1.into(), 5.into()),
            },
            Outcome {
                pieces: [0, 0, 2],
                mass: Q::new(1.into(), 10.into()),
            },
        ];
        for _ in 0..regular {
            rows = self
                .convolve(&rows, &regular_law, [u64::MAX; 3], 25000)
                .map_err(law_limit)?;
        }
        for _ in 0..ii {
            rows = self
                .convolve(&rows, &ii_law, [u64::MAX; 3], 25000)
                .map_err(law_limit)?;
        }
        let rows = Rc::new(rows);
        self.boxes.insert((regular, ii), rows.clone());
        Ok(rows)
    }
    fn merge_board(
        rows: &mut Vec<(Vec<usize>, Q)>,
        map: &mut HashMap<Vec<usize>, usize>,
        counts: Vec<usize>,
        mass: Q,
    ) {
        if let Some(&i) = map.get(&counts) {
            rows[i].1 += mass;
        } else {
            map.insert(counts.clone(), rows.len());
            rows.push((counts, mass));
        }
    }
    fn dispatch(&mut self, cohort: usize) -> Result<Dist> {
        let classes = self.model.classes.clone();
        let mut kept = vec![(vec![0; classes.len()], Q::one())];
        for reroll in 0..=cohort {
            let mut buckets: Vec<Vec<(Vec<usize>, Q)>> = vec![Vec::new(); 5];
            let mut maps = vec![HashMap::new(); 5];
            for (counts, mass) in kept {
                let size: usize = counts.iter().sum();
                Self::merge_board(&mut buckets[size], &mut maps[size], counts, mass);
            }
            for size in 0..4 {
                for (counts, mass) in std::mem::take(&mut buckets[size]) {
                    self.check()?;
                    let total: usize = classes
                        .iter()
                        .enumerate()
                        .map(|(i, c)| (4 - counts[i]) * c.weight as usize)
                        .sum();
                    for (i, c) in classes.iter().enumerate() {
                        if counts[i] == 4 {
                            continue;
                        }
                        let probability =
                            Q::new(((4 - counts[i]) * c.weight as usize).into(), total.into());
                        let mut next = counts.clone();
                        next[i] += 1;
                        Self::merge_board(
                            &mut buckets[size + 1],
                            &mut maps[size + 1],
                            next,
                            &mass * probability,
                        );
                    }
                }
            }
            kept = Vec::new();
            let mut map = HashMap::new();
            if reroll < cohort {
                for (counts, mass) in std::mem::take(&mut buckets[4]) {
                    let counts = counts
                        .iter()
                        .enumerate()
                        .map(|(i, &v)| if classes[i].keep { v } else { 0 })
                        .collect();
                    Self::merge_board(&mut kept, &mut map, counts, mass);
                }
            } else {
                for (counts, mass) in std::mem::take(&mut buckets[4]) {
                    let raw = (0..5)
                        .map(|k| {
                            counts
                                .iter()
                                .enumerate()
                                .map(|(i, n)| n * classes[i].raw[k])
                                .sum()
                        })
                        .collect();
                    Self::merge_board(&mut kept, &mut map, raw, mass);
                }
                let mut rows: Vec<Outcome> = Vec::new();
                let mut indices = HashMap::<Pieces, usize>::new();
                for (raw, mass) in kept {
                    let boxes = self.boxes(raw[3], raw[4])?;
                    for b in boxes.iter() {
                        self.check()?;
                        let mut pieces = [0; 3];
                        for k in 0..3 {
                            pieces[k] = checked_pieces_sum(raw[k] as u64, b.pieces[k])?;
                        }
                        let probability = &mass * &b.mass;
                        if let Some(&i) = indices.get(&pieces) {
                            rows[i].mass += probability;
                        } else {
                            if rows.len() >= 25000 {
                                return Err("certified_supply_support_limit");
                            }
                            indices.insert(pieces, rows.len());
                            rows.push(Outcome {
                                pieces,
                                mass: probability,
                            });
                        }
                    }
                }
                if rows.iter().map(|r| &r.mass).sum::<Q>() != Q::one() {
                    return Err("certified_dispatch_mass_not_one");
                }
                return Ok(Rc::new(rows));
            }
        }
        Err("certified_dispatch_not_terminated")
    }
    fn finite_law(&self, id: &str) -> Option<&Law> {
        self.model
            .laws
            .iter()
            .find(|law| law.id == id && law.kind == "finite")
    }
    pub fn law(&mut self, reference: &LawRef, cohort: usize) -> Result<Dist> {
        self.check()?;
        if cohort >= self.priors.len() {
            return Err("certified_dispatch_cohort_invalid");
        }
        let key = (reference.law_id.clone(), reference.count, cohort);
        if let Some(v) = self.cache.get(&key) {
            return Ok(v.clone());
        }
        let id = reference.law_id.as_str();
        let result = if reference.count == 0 {
            Rc::new(Self::singleton([0; 3]))
        } else if id == "regular-box-v1" && self.finite_law(id).is_none() {
            self.boxes(reference.count, 0)?
        } else if id == "box-ii-v1" && self.finite_law(id).is_none() {
            self.boxes(0, reference.count)?
        } else if reference.count > 1 {
            let single = self.law(
                &LawRef {
                    law_id: id.to_string(),
                    count: 1,
                },
                cohort,
            )?;
            let mut rows = Self::singleton([0; 3]);
            for _ in 0..reference.count {
                rows = self
                    .convolve(&rows, &single, [u64::MAX; 3], 25000)
                    .map_err(law_limit)?;
            }
            Rc::new(rows)
        } else if let Some(law) = self.finite_law(id) {
            let rows = law
                .outcomes_by_cohort
                .as_ref()
                .map(|a| &a[cohort])
                .or(law.outcomes.as_ref())
                .ok_or("certified_law_unknown")?;
            if rows.len() > 25000 {
                return Err("certified_supply_support_limit");
            }
            let mut result = Vec::new();
            let mut total = Q::zero();
            for row in rows {
                if row.pieces.iter().any(|&n| n > MAX_SAFE_PIECES) {
                    return Err("certified_law_raw_pieces_invalid");
                }
                let mass = row.mass.rational()?;
                if mass < Q::zero() {
                    return Err("certified_law_negative_mass");
                }
                total += &mass;
                if !mass.is_zero() {
                    result.push(Outcome {
                        pieces: row.pieces,
                        mass,
                    });
                }
            }
            if total != Q::one() {
                return Err("certified_law_mass_not_one");
            }
            Rc::new(result)
        } else if id == "dispatch-board-v1" {
            self.dispatch(cohort)?
        } else if let Some(raw) = id.strip_prefix("deterministic:") {
            let pieces = raw
                .split(',')
                .map(|s| {
                    s.parse::<u64>()
                        .map_err(|_| "certified_law_raw_pieces_invalid")
                })
                .collect::<Result<Vec<_>>>()?;
            if pieces.iter().any(|&n| n > MAX_SAFE_PIECES) {
                return Err("certified_law_raw_pieces_invalid");
            }
            Rc::new(Self::singleton(
                pieces
                    .try_into()
                    .map_err(|_| "certified_law_raw_pieces_invalid")?,
            ))
        } else {
            return Err("certified_law_unknown");
        };
        self.cache.insert(key, result.clone());
        Ok(result)
    }
    pub fn supports(&mut self, reference: &LawRef) -> Result<Rc<CohortSupports>> {
        self.check()?;
        if self.priors.len() != 4 && self.model.snapshot_version != "certified-daily-v5" {
            return Err("minimum_wait_requires_four_cohorts");
        }
        let key = (reference.law_id.clone(), reference.count);
        if let Some(rows) = self.support_cache.get(&key) {
            return Ok(Rc::clone(rows));
        }
        let mut supports: CohortSupports = vec![Vec::new(); self.population_prior.len()];
        for (cohort, rows) in supports.iter_mut().enumerate() {
            let law = self.law(reference, cohort)?;
            *rows = law
                .iter()
                .filter(|row| row.mass > Q::zero())
                .map(|row| row.pieces)
                .collect();
            rows.sort_unstable();
            rows.dedup();
            if rows.is_empty() {
                return Err("minimum_wait_empty_support");
            }
        }
        let supports = Rc::new(supports);
        self.support_cache.insert(key, Rc::clone(&supports));
        Ok(supports)
    }
}
fn law_limit(reason: &'static str) -> &'static str {
    if reason == "exact_support_limit" {
        "certified_supply_support_limit"
    } else {
        reason
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDS: [&str; 6] = [
        "regular-box-v1",
        "box-ii-v1",
        "dispatch-board-v1",
        "deterministic:1,2,3",
        "deterministic:custom",
        "custom",
    ];

    pub(super) fn source(laws: Json) -> Supply {
        let model = serde_json::from_value(json!({
            "snapshotVersion": "certified-daily-v1",
            "events": [], "laws": laws,
            "priors": vec![wire(&Q::new(1.into(),3.into())); 3],
            "populationPrior": ([1, 2, 3, 1].map(|n| wire(&Q::new(n.into(), 7.into())))),
            "dispatch": [], "shop": [], "solo": [],
            "cadence": wire(&Q::from_integer(30.into())),
            "dispatchExpected": vec![vec![wire(&Q::one());3];3],
            "classes": []
        }))
        .unwrap();
        Supply::new(model, f64::MAX).unwrap()
    }
    pub(super) fn row(pieces: Pieces, numerator: i64, denominator: i64) -> Json {
        json!({"pieces":pieces,"mass":{"numerator":numerator.to_string(),"denominator":denominator.to_string()}})
    }
    pub(super) fn reference(id: &str, count: usize) -> LawRef {
        LawRef {
            law_id: id.to_string(),
            count,
        }
    }
    fn assert_rows(rows: Dist, expected: &[(Pieces, i64, i64)]) {
        assert_eq!(rows.len(), expected.len());
        for (actual, &(pieces, n, d)) in rows.iter().zip(expected) {
            assert_eq!(actual.pieces, pieces);
            assert_eq!(actual.mass, Q::new(n.into(), d.into()));
        }
    }

    #[test]
    fn capped_convolution_projection_uses_cap_volume_for_a_hard_shape() {
        let lengths = [1_100, 1_141];
        let bits = [11_000, 231];
        let uncapped = convolve_workspace_bytes(lengths, 25_000, bits, [1; 2]).unwrap();
        let capped =
            convolve_capped_workspace_bytes(lengths, 25_000, [10; 3], bits, [1; 2]).unwrap();
        let volume = 11usize.pow(3);
        assert_eq!(
            capped,
            convolve_workspace_bytes(lengths, volume, bits, [1; 2]).unwrap()
        );
        assert!(capped < uncapped);
        // Pure headroom arithmetic for the review's 154 MiB example, not a
        // claim about the live heap or fast-path selection of actual late days.
        assert!(capped < 154 * 1024 * 1024);
    }

    #[test]
    fn capped_convolution_projection_keeps_the_original_bound_on_volume_overflow() {
        let lengths = [1_100, 1_141];
        let original = convolve_workspace_bytes(lengths, 25_000, [11_000, 231], [1; 2]);
        // All caps are finite, but the product cannot fit either usize width.
        assert_eq!(
            convolve_capped_workspace_bytes(
                lengths,
                25_000,
                [u64::MAX - 1; 3],
                [11_000, 231],
                [1; 2],
            ),
            original
        );
    }

    #[test]
    fn capped_convolution_projection_treats_any_max_cap_as_unbounded() {
        let lengths = [1_100, 1_141];
        let original = convolve_workspace_bytes(lengths, 25_000, [11_000, 231], [1; 2]);
        for color in 0..3 {
            // The other dimensions must not turn a partial volume into a bound.
            let mut caps = [0; 3];
            caps[color] = u64::MAX;
            assert_eq!(
                convolve_capped_workspace_bytes(lengths, 25_000, caps, [11_000, 231], [1; 2]),
                original
            );
        }
    }

    #[test]
    fn capped_convolution_projection_is_monotone_in_each_bound() {
        let project = |lengths, limit, caps, bits, excess| {
            convolve_capped_workspace_bytes(lengths, limit, caps, bits, excess).unwrap()
        };
        let ascending = |values: Vec<usize>| {
            assert!(values.windows(2).all(|pair| pair[0] <= pair[1]));
        };
        for color in 0..3 {
            ascending(
                [0, 1, 3, 10, 100, u64::MAX - 1, u64::MAX]
                    .into_iter()
                    .map(|cap| {
                        let mut caps = [10; 3];
                        caps[color] = cap;
                        project([1_100, 1_141], 25_000, caps, [11_000, 231], [1; 2])
                    })
                    .collect(),
            );
        }
        ascending(
            [0, 1, 4, 7, 8, 1_331, 25_000]
                .into_iter()
                .map(|limit| project([1_100, 1_141], limit, [10; 3], [11_000, 231], [1; 2]))
                .collect(),
        );
        for side in 0..2 {
            ascending(
                [1, 2, 4, 8, 64, 1_141]
                    .into_iter()
                    .map(|length| {
                        let mut lengths = [1_100, 1_141];
                        lengths[side] = length;
                        project(lengths, 25_000, [10; 3], [11_000, 231], [1; 2])
                    })
                    .collect(),
            );
            ascending(
                [1, 31, 32, 63, 64, 65, 11_000]
                    .into_iter()
                    .map(|bits| {
                        let mut denominators = [11_000, 231];
                        denominators[side] = bits;
                        project([1_100, 1_141], 25_000, [10; 3], denominators, [1; 2])
                    })
                    .collect(),
            );
            ascending(
                [0, 1, 31, 32, 64, 128]
                    .into_iter()
                    .map(|bits| {
                        let mut excess = [1; 2];
                        excess[side] = bits;
                        project([1_100, 1_141], 25_000, [10; 3], [11_000, 231], excess)
                    })
                    .collect(),
            );
        }
    }

    #[test]
    fn four_cohort_model_prices_each_cohort_and_rejects_legacy_finite_arity() {
        let mut model = source(json!([])).model;
        model.priors = [1, 2, 3, 1]
            .into_iter()
            .map(|n| wire(&Q::new(n.into(), 7.into())))
            .collect();
        model
            .dispatch_expected
            .push(std::array::from_fn(|_| wire(&Q::one())));
        model.laws = serde_json::from_value(json!([{
            "id":"four","kind":"finite","outcomesByCohort":[
                [row([1,0,0],1,1)], [row([0,2,0],1,1)],
                [row([0,0,3],1,1)], [row([4,5,6],1,1)]
            ]
        }]))
        .unwrap();
        let mut supply = Supply::new(model, f64::MAX).unwrap();
        assert_rows(
            supply.law(&reference("four", 1), 3).unwrap(),
            &[([4, 5, 6], 1, 1)],
        );
        assert_eq!(
            supply
                .expected(&[reference("four", 1)], &supply.priors.clone())
                .unwrap(),
            [
                Q::new(5.into(), 7.into()),
                Q::new(9.into(), 7.into()),
                Q::new(15.into(), 7.into())
            ]
        );
        supply.model.laws[0]
            .outcomes_by_cohort
            .as_mut()
            .unwrap()
            .pop();
        assert!(matches!(
            Supply::new(supply.model, f64::MAX),
            Err("certified_snapshot_cohort_law_invalid")
        ));
    }

    #[test]
    fn finite_ids_override_builtins_and_deterministic_in_support_and_pricing() {
        for id in IDS {
            let mut supply =
                source(json!([{"id":id,"kind":"finite","outcomes":[row([99,0,0],2,2)]}]));
            for cohort in 0..3 {
                assert_rows(
                    supply.law(&reference(id, 1), cohort).unwrap(),
                    &[([99, 0, 0], 1, 1)],
                );
                assert_rows(
                    supply.law(&reference(id, 0), cohort).unwrap(),
                    &[([0, 0, 0], 1, 1)],
                );
            }
            assert_eq!(
                supply
                    .expected(&[reference(id, 1)], &supply.priors.clone())
                    .unwrap(),
                [Q::from_integer(99.into()), Q::zero(), Q::zero()]
            );
            supply.model.dispatch = vec![reference(id, 1)];
            let (rates, weights) = supply.pricing([1; 3], [0; 3], TERMINAL).unwrap();
            assert_eq!(rates, [Q::from_integer(99.into()), Q::zero(), Q::zero()]);
            assert_eq!(weights, [Q::new(1.into(), 100.into()), Q::one(), Q::one()]);
        }
    }

    #[test]
    fn finite_cohorts_order_zero_mass_and_independent_repetition_are_preserved() {
        for id in IDS {
            let mut supply = source(json!([{
                "id":id,"kind":"finite","outcomes":[row([99,0,0],1,1)],
                "outcomesByCohort":[
                    [row([9,0,0],0,1),row([2,0,0],1,2),row([0,0,0],1,2)],
                    [row([0,3,0],1,1)], [row([0,0,6],1,1)]
                ]
            }]));
            assert_rows(
                supply.law(&reference(id, 1), 0).unwrap(),
                &[([2, 0, 0], 1, 2), ([0, 0, 0], 1, 2)],
            );
            if id != "dispatch-board-v1" {
                assert_rows(
                    supply.law(&reference(id, 2), 0).unwrap(),
                    &[([4, 0, 0], 1, 4), ([2, 0, 0], 1, 2), ([0, 0, 0], 1, 4)],
                );
            }
            assert_rows(
                supply.law(&reference(id, 1), 1).unwrap(),
                &[([0, 3, 0], 1, 1)],
            );
            assert_rows(
                supply.law(&reference(id, 1), 2).unwrap(),
                &[([0, 0, 6], 1, 1)],
            );
            assert_eq!(
                supply
                    .expected(&[reference(id, 1)], &supply.priors.clone())
                    .unwrap(),
                [
                    Q::new(1.into(), 3.into()),
                    Q::one(),
                    Q::from_integer(2.into())
                ]
            );
        }
    }

    #[test]
    fn canonical_boxes_and_absent_finite_deterministic_keep_exact_values() {
        let mut supply = source(json!([
            {"id":"regular-box-v1","kind":"box"},
            {"id":"box-ii-v1","kind":"box"},
            {"id":"dispatch-board-v1","kind":"dispatch"}
        ]));
        for _ in 0..2 {
            assert_rows(
                supply.law(&reference("regular-box-v1", 1), 0).unwrap(),
                &[([3, 0, 0], 4, 5), ([0, 1, 0], 1, 5)],
            );
            assert_rows(
                supply.law(&reference("box-ii-v1", 1), 0).unwrap(),
                &[([5, 0, 0], 7, 10), ([0, 2, 0], 1, 5), ([0, 0, 2], 1, 10)],
            );
            assert_rows(
                supply.law(&reference("deterministic:1,2,3", 1), 0).unwrap(),
                &[([1, 2, 3], 1, 1)],
            );
        }
        assert_eq!(
            supply
                .expected(&[reference("regular-box-v1", 1)], &supply.priors.clone())
                .unwrap(),
            [
                Q::new(12.into(), 5.into()),
                Q::new(1.into(), 5.into()),
                Q::zero()
            ]
        );
        assert_eq!(
            supply
                .expected(&[reference("box-ii-v1", 1)], &supply.priors.clone())
                .unwrap(),
            [
                Q::new(7.into(), 2.into()),
                Q::new(2.into(), 5.into()),
                Q::new(1.into(), 5.into())
            ]
        );
        assert_eq!(
            supply
                .expected(&[reference("dispatch-board-v1", 1)], &supply.priors.clone())
                .unwrap(),
            [Q::one(), Q::one(), Q::one()]
        );
    }

    #[test]
    fn overrides_keep_finite_probability_piece_and_support_guards() {
        for (outcomes, error) in [
            (
                json!([row([1, 0, 0], -1, 1)]),
                "certified_law_negative_mass",
            ),
            (json!([row([1, 0, 0], 1, 2)]), "certified_law_mass_not_one"),
            (
                json!([row([MAX_SAFE_PIECES + 1, 0, 0], 1, 1)]),
                "certified_law_raw_pieces_invalid",
            ),
            (json!([row([1, 0, 0], 1, 0)]), "invalid_rational"),
            (
                json!(vec![row([0, 0, 0], 0, 1); 25001]),
                "certified_supply_support_limit",
            ),
        ] {
            let mut supply =
                source(json!([{"id":"regular-box-v1","kind":"finite","outcomes":outcomes}]));
            assert_rows(
                supply.law(&reference("regular-box-v1", 0), 0).unwrap(),
                &[([0, 0, 0], 1, 1)],
            );
            assert_eq!(
                supply.law(&reference("regular-box-v1", 1), 0).err(),
                Some(error)
            );
        }
        let mut supply = source(json!([{"id":"deterministic:custom","kind":"finite",
            "outcomes":[row([MAX_SAFE_PIECES,0,0],1,1)]}]));
        assert_rows(
            supply
                .law(&reference("deterministic:custom", 1), 0)
                .unwrap(),
            &[([MAX_SAFE_PIECES, 0, 0], 1, 1)],
        );
    }
}
