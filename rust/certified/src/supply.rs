//! Exact physical supply enumeration and fixed stock-plus-recurring-day prices.
//! Same documented model as shared/certifiedSupplyLaws.ts. All convolutions,
//! board draws/rerolls and cohort expectation arithmetic stay inside WASM.
use super::*;
use std::rc::Rc;
pub type Pieces = [u64;3];
const MAX_SAFE_PIECES: u64 = 9_007_199_254_740_991;
fn checked_pieces_sum(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b).filter(|&sum| sum <= MAX_SAFE_PIECES)
        .ok_or("certified_law_raw_pieces_invalid")
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LawRef { pub law_id: String, pub count: usize }
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event { pub id: String, pub day: usize, pub refs: Vec<LawRef> }
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Law {
    id: String, kind: String, outcomes: Option<Vec<Row>>, outcomes_by_cohort: Option<[Vec<Row>;3]>,
}
#[derive(Clone, Deserialize)]
pub struct Class { weight: u32, keep: bool, raw: [usize;5] }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub events: Vec<Event>,
    laws: Vec<Law>,
    pub priors: [WireQ;3],
    dispatch: Vec<LawRef>, shop: Vec<LawRef>, solo: Vec<LawRef>,
    cadence: WireQ,
    dispatch_expected: [[WireQ;3];3],
    classes: Vec<Class>,
}
#[derive(Clone)]
pub struct Outcome { pub pieces: Pieces, pub mass: Q }
pub type Dist = Rc<Vec<Outcome>>;
pub struct Supply {
    pub model: Model,
    pub priors: [Q;3],
    cache: HashMap<(String,usize,usize), Dist>,
    boxes: HashMap<(usize,usize), Dist>,
    deadline: f64,
    ticks: usize,
}
impl Supply {
    pub fn new(model: Model, deadline: f64) -> Result<Self> {
        let priors = [model.priors[0].rational()?, model.priors[1].rational()?, model.priors[2].rational()?];
        if priors.iter().any(|q| q < &Q::zero()) || priors.iter().sum::<Q>() != Q::one() { return Err("invalid_cohort_weights"); }
        Ok(Self { model, priors, cache: HashMap::new(), boxes: HashMap::new(), deadline, ticks: 0 })
    }
    fn check(&mut self) -> Result<()> {
        self.ticks += 1;
        if self.ticks % 32 == 0 && now() >= self.deadline { return Err("request_budget_exhausted"); }
        Ok(())
    }
    pub fn singleton(stock: Pieces) -> Vec<Outcome> { vec![Outcome { pieces: stock, mass: Q::one() }] }
    pub fn convolve(&mut self, a: &[Outcome], b: &[Outcome], caps: Pieces, limit: usize) -> Result<Vec<Outcome>> {
        // Preserve first-insertion order: receipt selectors' exact tie-breaking
        // uses the source law's order, not HashMap iteration order.
        let mut indices = HashMap::<Pieces,usize>::new();
        let mut out: Vec<Outcome> = Vec::new();
        for x in a {
            for y in b {
                self.check()?;
                if y.mass.is_zero() { continue; }
                let mut pieces = [0;3];
                for k in 0..3 {
                    pieces[k] = caps[k].min(checked_pieces_sum(x.pieces[k],y.pieces[k])?);
                }
                let mass = &x.mass * &y.mass;
                if let Some(&i) = indices.get(&pieces) { out[i].mass += mass; }
                else {
                    if out.len() >= limit { return Err("exact_support_limit"); }
                    indices.insert(pieces, out.len());
                    out.push(Outcome { pieces, mass });
                }
            }
        }
        Ok(out)
    }
    fn boxes(&mut self, regular: usize, ii: usize) -> Result<Dist> {
        if let Some(v) = self.boxes.get(&(regular,ii)) { return Ok(v.clone()); }
        let mut rows = Self::singleton([0;3]);
        let regular_law = vec![Outcome { pieces: [3,0,0], mass: Q::new(4.into(),5.into()) }, Outcome { pieces: [0,1,0], mass: Q::new(1.into(),5.into()) }];
        let ii_law = vec![Outcome { pieces: [5,0,0], mass: Q::new(7.into(),10.into()) }, Outcome { pieces: [0,2,0], mass: Q::new(1.into(),5.into()) }, Outcome { pieces: [0,0,2], mass: Q::new(1.into(),10.into()) }];
        for _ in 0..regular { rows = self.convolve(&rows, &regular_law, [u64::MAX;3], 25000).map_err(law_limit)?; }
        for _ in 0..ii { rows = self.convolve(&rows, &ii_law, [u64::MAX;3], 25000).map_err(law_limit)?; }
        let rows = Rc::new(rows);
        self.boxes.insert((regular,ii), rows.clone());
        Ok(rows)
    }
    fn merge_board(rows: &mut Vec<(Vec<usize>,Q)>, map: &mut HashMap<Vec<usize>,usize>, counts: Vec<usize>, mass: Q) {
        if let Some(&i) = map.get(&counts) { rows[i].1 += mass; }
        else { map.insert(counts.clone(), rows.len()); rows.push((counts,mass)); }
    }
    fn dispatch(&mut self, cohort: usize) -> Result<Dist> {
        let classes = self.model.classes.clone();
        let mut kept = vec![(vec![0;classes.len()], Q::one())];
        for reroll in 0..=cohort {
            let mut buckets: Vec<Vec<(Vec<usize>,Q)>> = vec![Vec::new();5];
            let mut maps = vec![HashMap::new();5];
            for (counts,mass) in kept {
                let size: usize = counts.iter().sum();
                Self::merge_board(&mut buckets[size], &mut maps[size], counts, mass);
            }
            for size in 0..4 {
                for (counts,mass) in std::mem::take(&mut buckets[size]) {
                    self.check()?;
                    let total: usize = classes.iter().enumerate().map(|(i,c)| (4-counts[i])*c.weight as usize).sum();
                    for (i,c) in classes.iter().enumerate() {
                        if counts[i] == 4 { continue; }
                        let probability = Q::new(((4-counts[i])*c.weight as usize).into(), total.into());
                        let mut next = counts.clone(); next[i] += 1;
                        Self::merge_board(&mut buckets[size+1], &mut maps[size+1], next, &mass * probability);
                    }
                }
            }
            kept = Vec::new();
            let mut map = HashMap::new();
            if reroll < cohort {
                for (counts,mass) in std::mem::take(&mut buckets[4]) {
                    let counts = counts.iter().enumerate().map(|(i,&v)| if classes[i].keep {v} else {0}).collect();
                    Self::merge_board(&mut kept, &mut map, counts, mass);
                }
            } else {
                for (counts,mass) in std::mem::take(&mut buckets[4]) {
                    let raw = (0..5).map(|k| counts.iter().enumerate().map(|(i,n)| n * classes[i].raw[k]).sum()).collect();
                    Self::merge_board(&mut kept, &mut map, raw, mass);
                }
                let mut rows: Vec<Outcome> = Vec::new();
                let mut indices = HashMap::<Pieces,usize>::new();
                for (raw,mass) in kept {
                    let boxes = self.boxes(raw[3],raw[4])?;
                    for b in boxes.iter() {
                        self.check()?;
                        let mut pieces = [0;3];
                        for k in 0..3 {
                            pieces[k] = checked_pieces_sum(raw[k] as u64,b.pieces[k])?;
                        }
                        let probability = &mass * &b.mass;
                        if let Some(&i) = indices.get(&pieces) { rows[i].mass += probability; }
                        else {
                            if rows.len() >= 25000 { return Err("certified_supply_support_limit"); }
                            indices.insert(pieces, rows.len());
                            rows.push(Outcome { pieces, mass: probability });
                        }
                    }
                }
                if rows.iter().map(|r| &r.mass).sum::<Q>() != Q::one() { return Err("certified_dispatch_mass_not_one"); }
                return Ok(Rc::new(rows));
            }
        }
        Err("certified_dispatch_not_terminated")
    }
    pub fn law(&mut self, reference: &LawRef, cohort: usize) -> Result<Dist> {
        self.check()?;
        let key = (reference.law_id.clone(), reference.count, cohort);
        if let Some(v) = self.cache.get(&key) { return Ok(v.clone()); }
        let id = reference.law_id.as_str();
        let result = if reference.count == 0 { Rc::new(Self::singleton([0;3])) }
        else if id == "regular-box-v1" { self.boxes(reference.count,0)? }
        else if id == "box-ii-v1" { self.boxes(0,reference.count)? }
        else if reference.count > 1 {
            let single = self.law(&LawRef { law_id: id.to_string(), count: 1 }, cohort)?;
            let mut rows = Self::singleton([0;3]);
            for _ in 0..reference.count { rows = self.convolve(&rows, &single, [u64::MAX;3], 25000).map_err(law_limit)?; }
            Rc::new(rows)
        } else if id == "dispatch-board-v1" { self.dispatch(cohort)? }
        else if let Some(raw) = id.strip_prefix("deterministic:") {
            let pieces = raw.split(',').map(|s| s.parse::<u64>().map_err(|_| "certified_law_raw_pieces_invalid")).collect::<Result<Vec<_>>>()?;
            if pieces.iter().any(|&n| n > MAX_SAFE_PIECES) { return Err("certified_law_raw_pieces_invalid"); }
            Rc::new(Self::singleton(pieces.try_into().map_err(|_| "certified_law_raw_pieces_invalid")?))
        } else {
            let law = self.model.laws.iter().find(|l| l.id == id && l.kind == "finite").ok_or("certified_law_unknown")?;
            let rows = law.outcomes_by_cohort.as_ref().map(|a| &a[cohort]).or(law.outcomes.as_ref()).ok_or("certified_law_unknown")?;
            if rows.len() > 25000 { return Err("certified_supply_support_limit"); }
            let mut result = Vec::new();
            let mut total = Q::zero();
            for row in rows {
                if row.pieces.iter().any(|&n| n > MAX_SAFE_PIECES) { return Err("certified_law_raw_pieces_invalid"); }
                let mass = row.mass.rational()?;
                if mass < Q::zero() { return Err("certified_law_negative_mass"); }
                total += &mass;
                if !mass.is_zero() { result.push(Outcome { pieces: row.pieces, mass }); }
            }
            if total != Q::one() { return Err("certified_law_mass_not_one"); }
            Rc::new(result)
        };
        self.cache.insert(key,result.clone());
        Ok(result)
    }
    fn expected(&mut self, refs: &[LawRef]) -> Result<[Q;3]> {
        let mut gain = std::array::from_fn(|_| Q::zero());
        for r in refs {
            if r.count == 0 { continue; }
            for cohort in 0..3 {
                self.check()?;
                if self.priors[cohort].is_zero() { continue; }
                let values = if r.law_id == "dispatch-board-v1" {
                    let row = &self.model.dispatch_expected[cohort];
                    [row[0].rational()?, row[1].rational()?, row[2].rational()?]
                } else {
                    let rows = self.law(&LawRef { law_id: r.law_id.clone(), count: 1 }, cohort)?;
                    std::array::from_fn(|k| rows.iter().map(|o| &o.mass * Q::from_integer(o.pieces[k].into())).sum())
                };
                for k in 0..3 { gain[k] += &self.priors[cohort] * &values[k] * Q::from_integer(r.count.into()); }
            }
        }
        Ok(gain)
    }
    pub fn pricing(&mut self, basis: Units, stock: Units, sid: usize) -> Result<([Q;3],[Q;3])> {
        let dispatch = self.expected(&self.model.dispatch.clone())?;
        let shop = self.expected(&self.model.shop.clone())?;
        let solo = self.expected(&self.model.solo.clone())?;
        let cadence = self.model.cadence.rational()?;
        if cadence <= Q::zero() { return Err("invalid_cadence"); }
        let rates: [Q;3] = std::array::from_fn(|k| &dispatch[k] + &shop[k] / Q::from_integer(7.into()) + &solo[k] / &cadence);
        let mut weights = std::array::from_fn(|_| Q::zero());
        for k in 0..3 {
            let denominator = &rates[k] + Q::from_integer(basis[k].into());
            if denominator.is_zero() {
                let mut usable = sid < TERMINAL && stock[k] >= 10;
                if sid < TERMINAL && !usable {
                    for cohort in 0..3 {
                        if self.priors[cohort].is_zero() { continue; }
                        let mut reachable = stock[k] as u64;
                        for event in self.model.events.clone() {
                            for r in event.refs {
                                let law = self.law(&r,cohort)?;
                                reachable = reachable.saturating_add(law.iter().filter(|r| r.mass > Q::zero()).map(|r| r.pieces[k]).max().unwrap_or(0));
                                if reachable >= 10 { usable = true; break; }
                            }
                            if usable { break; }
                        }
                        if usable { break; }
                    }
                }
                if usable { return Err(["zero_basis_future_usable_blue","zero_basis_future_usable_purple","zero_basis_future_usable_yellow"][k]); }
            } else { weights[k] = denominator.recip(); }
        }
        Ok((rates,weights))
    }
}
fn law_limit(reason: &'static str) -> &'static str {
    if reason == "exact_support_limit" {"certified_supply_support_limit"} else {reason}
}
