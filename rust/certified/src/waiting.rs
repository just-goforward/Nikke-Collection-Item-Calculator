//! H56 range-only certificates. Same ordered receipt selectors, exact endpoint
//! proofs and exhaustive-date/gap semantics as the independent TS oracle.
use super::*;
use crate::supply::{Dist, Event, Outcome, Pieces, Supply};

#[derive(Clone)]
struct Trajectory {
    stock: Pieces,
    receipts: Vec<Json>,
}
fn base(status: &str, reason: Option<&str>) -> Json {
    json!({ "status": status, "horizonDays":56, "recommendedDays":null,
        "rangeBoundary":false, "bestDayRange":null, "value":null,
        "evaluatedDays":[0], "successImprovementUpperBound":null,
        "successProbabilityInterval":null, "reason":reason, "evidence":[] })
}
impl Engine {
    fn compare_exact(&self, a: &Value, b: &Value) -> Ordering {
        let exponent = a.exponent.max(b.exponent);
        self.compare(&self.lift(a, exponent), &self.lift(b, exponent))
    }
    fn actual_view(&self, value: &Value) -> PublicValue {
        let mut view = self.view(value);
        view.b = wire(
            &(rational(&self.burden(value), &self.powers[value.exponent])
                / Q::from_integer(self.scale.clone().into())),
        );
        view
    }
    fn batch_for_kit(
        &mut self,
        sid: usize,
        stock: Units,
        limit: usize,
        kit: usize,
        root: &Value,
    ) -> minimum_wait::Batch {
        let mut batch = minimum_wait::Batch {
            kit,
            path: Vec::new(),
            guard: None,
        };
        let mut s = sid;
        let mut raw = stock;
        while batch.uses() < limit {
            let value = if batch.path.is_empty() {
                root.clone()
            } else {
                match self.get(s, std::array::from_fn(|j| raw[j] / 10), true) {
                    Ok(value) => value,
                    Err(reason) => {
                        batch.guard = Some(reason);
                        break;
                    }
                }
            };
            if value.mask & (1 << kit) == 0 {
                break;
            }
            if raw[kit] < 10 {
                batch.guard = Some("minimum_wait_batch_infeasible");
                break;
            }
            let edge = self.edges[s][kit];
            batch.path.push((s, edge));
            raw[kit] -= 10;
            let [per, _, normal] = edge;
            s = normal;
            let level = |state| {
                if state < 150 {
                    (0, state / 10)
                } else {
                    (1, (state - 150) / 30)
                }
            };
            if per == 1000 || s == TERMINAL || level(s) != level(sid) {
                break;
            }
        }
        batch
    }

    fn current_json(&self, sid: usize, root: &Value, batch: Option<&minimum_wait::Batch>) -> Json {
        let kit = batch.map(|batch| batch.kit);
        let uses = batch.map_or(0, |batch| batch.uses());
        json!({ "status": if sid == TERMINAL {"complete"} else if kit.is_some() {"use_certified"} else {"preserve"},
            "value": self.actual_view(root), "kit":kit.map(|k| ["blue","purple","yellow"][k]),
            "optimalActionMask":root.mask, "uses":uses, "pieces":uses*10,
            "certification":"exact_rational_finite_inventory_v1" })
    }

    pub fn current(&mut self, sid: usize, stock: Units, limit: usize) -> Result<Json> {
        self.current_root = None;
        self.current_request = None;
        self.current_choice = None;
        let units = std::array::from_fn(|k| stock[k] / 10);
        if units.iter().sum::<usize>() > 36 {
            self.ensure_guidance(sid, units);
        }
        let root = self.get(sid, units, true)?;
        let kit = (0..3).find(|k| root.mask & (1 << k) != 0);
        let batch = kit.map(|kit| self.batch_for_kit(sid, stock, limit, kit, &root));
        self.current_request = Some((sid, stock, limit));
        self.current_root = Some(root.clone());
        self.current_choice = batch.clone();
        self.arena = None;
        Ok(self.current_json(sid, &root, batch.as_ref()))
    }

    fn minimum_binding(
        &self,
        sid: usize,
        stock: Units,
    ) -> Result<(Value, Option<minimum_wait::Batch>, usize)> {
        let (state, previous, limit) = self
            .current_request
            .ok_or("minimum_wait_requires_current")?;
        if state != sid || previous != stock {
            return Err("minimum_wait_current_binding_mismatch");
        }
        Ok((
            self.current_root
                .clone()
                .ok_or("minimum_wait_requires_current")?,
            self.current_choice.clone(),
            limit,
        ))
    }

    fn minimum_response(
        &self,
        sid: usize,
        root: &Value,
        assessment: &minimum_wait::Assessment,
    ) -> Json {
        json!({"current":self.current_json(sid, root, Some(&assessment.batch)),
            "minimumWait":assessment.json()})
    }

    pub fn minimum_wait(
        &mut self,
        supply: &mut Supply,
        sid: usize,
        stock: Units,
        complete: bool,
    ) -> Result<Json> {
        let (root, base, limit) = self.minimum_binding(sid, stock)?;
        let Some(base) = base else {
            return Ok(json!({"current":self.current_json(sid, &root, None),
                "minimumWait":minimum_wait::inactive()}));
        };
        let selected = (|| -> Result<minimum_wait::Assessment> {
            if let Some(reason) = base.guard {
                return Err(reason);
            }
            let rates = supply.minimum_wait_rates()?;
            let mut candidates = Vec::new();
            // Candidates are the existing maximal optimal normal-prefix batches,
            // not arbitrary shortened batches manufactured to obtain a label.
            for kit in 0..3 {
                if root.mask & (1 << kit) == 0 {
                    continue;
                }
                let batch = if kit == base.kit {
                    base.clone()
                } else {
                    self.batch_for_kit(sid, stock, limit, kit, &root)
                };
                if let Some(reason) = batch.guard {
                    return Err(reason);
                }
                if minimum_wait::settlement_certificate(&batch, &rates) {
                    let assessment = self.assess_batch(supply, sid, stock, batch, complete, false);
                    if let Some(reason) = assessment.reason {
                        return Err(reason);
                    }
                    return Ok(assessment);
                }
                candidates.push(batch);
            }
            let mut best: Option<minimum_wait::Assessment> = None;
            for batch in candidates {
                let assessment = self.assess_batch(supply, sid, stock, batch, complete, false);
                if let Some(reason) = assessment.reason {
                    if assessment.batch.kit == base.kit {
                        return Ok(assessment);
                    }
                    return Err(reason);
                }
                if assessment.beyond {
                    return Ok(assessment);
                }
                if best
                    .as_ref()
                    .is_none_or(|old| assessment.rank() < old.rank())
                {
                    best = Some(assessment);
                }
            }
            best.ok_or("minimum_wait_no_candidate")
        })();
        let assessment = match selected {
            Ok(assessment) => assessment,
            Err(reason) => minimum_wait::Assessment::unknown(base.clone(), reason),
        };
        if assessment.rank().is_none()
            || (assessment.batch.kit == base.kit && assessment.batch.uses() == base.uses())
        {
            return Ok(self.minimum_response(sid, &root, &assessment));
        }
        let choice = self.forced_batch_value(&assessment.batch, stock.map(|pieces| pieces / 10));
        match choice {
            Ok(mut value) if self.compare_exact(&value, &root) == Ordering::Equal => {
                value.mask = root.mask;
                self.current_root = Some(value.clone());
                self.current_choice = Some(assessment.batch.clone());
                Ok(self.minimum_response(sid, &value, &assessment))
            }
            outcome => {
                let reason = outcome.err().unwrap_or("minimum_wait_batch_not_exact_tie");
                let unknown = minimum_wait::Assessment::unknown(base, reason);
                Ok(self.minimum_response(sid, &root, &unknown))
            }
        }
    }

    pub fn minimum_wait_probe(
        &mut self,
        supply: &mut Supply,
        sid: usize,
        stock: Units,
        kit: usize,
        uses: usize,
        complete: bool,
    ) -> Result<Json> {
        let (root, _, limit) = self.minimum_binding(sid, stock)?;
        if root.mask & (1 << kit) == 0 {
            return Err("minimum_wait_batch_not_optimal");
        }
        let mut batch = self.batch_for_kit(sid, stock, limit, kit, &root);
        if let Some(reason) = batch.guard {
            return Ok(minimum_wait::Assessment::unknown(batch, reason).probe_json(self.caps[sid]));
        }
        if uses == 0 || uses > batch.uses() {
            return Err("minimum_wait_batch_invalid");
        }
        batch.path.truncate(uses);
        Ok(self
            .assess_batch(supply, sid, stock, batch, complete, true)
            .probe_json(self.caps[sid]))
    }
    fn endpoint(&mut self, sid: usize, stock: Pieces) -> Result<Value> {
        self.kernel_calls += 1;
        let units = std::array::from_fn(|k| (stock[k] / 10).min(self.caps[sid][k] as u64) as usize);
        if units.iter().sum::<usize>() > 36 || self.arena.is_some() {
            self.ensure_guidance(sid, units);
        }
        self.get(sid, units, true)
    }
    fn expected_rows(
        &mut self,
        sid: usize,
        supports: &[Vec<Outcome>],
        priors: &[Q],
    ) -> Result<[Q; 4]> {
        if supports.len() != priors.len() {
            return Err("invalid_cohort_weights");
        }
        let mut sum = std::array::from_fn(|_| Q::zero());
        for cohort in 0..priors.len() {
            if priors[cohort].is_zero() {
                continue;
            }
            let mut indices = HashMap::<Units, usize>::new();
            let mut groups: Vec<(Units, Q)> = Vec::new();
            for row in &supports[cohort] {
                self.check()?;
                let units = std::array::from_fn(|k| {
                    (row.pieces[k] / 10).min(self.caps[sid][k] as u64) as usize
                });
                if let Some(&i) = indices.get(&units) {
                    groups[i].1 += &row.mass;
                } else {
                    indices.insert(units, groups.len());
                    groups.push((units, row.mass.clone()));
                }
            }
            // Group only this date's expectation, in first-seen order. Physical
            // supports retain their remainders for all later convolutions.
            for (units, group_mass) in groups {
                self.check()?;
                if units.iter().sum::<usize>() > 36 || self.arena.is_some() {
                    self.ensure_guidance(sid, units);
                }
                let v = self.get(sid, units, false)?;
                let mass = &priors[cohort] * &group_mass;
                sum[0] += &mass * rational(&v.p, &self.powers[v.exponent]);
                for k in 0..3 {
                    sum[k + 1] += &mass * rational(&v.c[k], &self.powers[v.exponent]);
                }
            }
        }
        Ok(sum)
    }
    fn qview(&self, v: &[Q; 4]) -> PublicValue {
        let b: Q = (0..3)
            .map(|k| &v[k + 1] * Q::from_integer(self.prices[k].clone().into()))
            .sum();
        PublicValue {
            p: wire(&v[0]),
            b: wire(&(b / Q::from_integer(self.scale.clone().into()))),
            c: wire(&(v[1].clone() + &v[2] + &v[3])),
            consumed: std::array::from_fn(|k| wire(&v[k + 1])),
            mask: 0,
        }
    }
    fn qcompare(&self, a: &[Q; 4], b: &[Q; 4]) -> Ordering {
        let cost = |v: &[Q; 4]| -> Q {
            (0..3)
                .map(|k| &v[k + 1] * Q::from_integer(self.prices[k].clone().into()))
                .sum()
        };
        a[0].cmp(&b[0])
            .then_with(|| cost(b).cmp(&cost(a)))
            .then_with(|| (b[1].clone() + &b[2] + &b[3]).cmp(&(a[1].clone() + &a[2] + &a[3])))
    }
    fn gap(result: &mut Json, lower: &Q) {
        result["successProbabilityInterval"] = json!({"lower":wire(lower),"upper":wire(&Q::one())});
        result["successImprovementUpperBound"] = json!(wire(&(Q::one() - lower)));
    }
    pub fn waiting(
        &mut self,
        supply: &mut Supply,
        sid: usize,
        stock: Units,
        complete: bool,
    ) -> Result<Json> {
        let current = self.current_root.clone().ok_or("current_not_completed")?;
        let p = rational(&current.p, &self.powers[current.exponent]);
        self.ensure_relaxed(sid)?;
        let equal = self.compare_exact(&current, &self.relaxed[sid].as_ref().unwrap().value)
            == Ordering::Equal;
        if equal
            || (complete
                && supply
                    .model
                    .events
                    .iter()
                    .all(|e| e.refs.iter().all(|r| r.count == 0)))
        {
            let mut result = base("certified", None);
            result["recommendedDays"] = json!(0);
            result["bestDayRange"] = json!([0, 0]);
            result["value"] = json!(self.actual_view(&current));
            result["successProbabilityInterval"] = json!({"lower":wire(&p),"upper":wire(&p)});
            result["successImprovementUpperBound"] = json!(wire(&(Q::one() - &p)));
            result["evidence"] = if equal {
                json!([
                    "exact_P_B_C_equal_feasible_unlimited_optimum",
                    "fixed_prices_all_dates",
                    "nonnegative_nonexpiring_inventory_coupling",
                    "range_only_no_deadline"
                ])
            } else {
                json!([
                    "no_random_and_no_deterministic_arrivals_in_complete_future_snapshot",
                    "exact_all_dates_same_inventory"
                ])
            };
            return Ok(result);
        }
        if !complete {
            let mut result = base("unresolved", Some("future_coverage_incomplete"));
            result["bestDayRange"] = json!([0, 56]);
            return Ok(result);
        }
        let events = supply.model.events.clone();
        let prior: Vec<_> = events.iter().filter(|e| e.day != 56).cloned().collect();
        let last: Vec<_> = events.iter().filter(|e| e.day == 56).cloned().collect();
        if !last.is_empty() {
            if let Some((cohort, before, after, bv, av)) =
                self.boundary(supply, sid, stock, &prior, &last)?
            {
                let mut result = base("certified", None);
                result["recommendedDays"] = json!(56);
                result["rangeBoundary"] = json!(true);
                result["bestDayRange"] = json!([56, 56]);
                Self::gap(&mut result, &p);
                result["evidence"] = json!([
                    "fixed_prices_all_dates",
                    "nonnegative_nonexpiring_inventory_coupling",
                    "single_latent_cohort_positive_prior",
                    "positive_mass_receipt_witness_strict_lex_day55_to56",
                    "all_prior_dates_bounded_by_day55",
                    "PH_lower_bound_from_exact_current_P_and_inventory_coupling",
                    "range_only_no_global_or_deadline_claim"
                ]);
                let mut receipts = before.receipts;
                receipts.extend(after.receipts);
                result["strictBoundaryWitness"] = json!({"cohort":cohort,"receipts":receipts,"beforeStock":before.stock,
                    "afterStock":after.stock,"beforeValue":self.actual_view(&bv),"afterValue":self.actual_view(&av)});
                return Ok(result);
            }
        }
        let caps = std::array::from_fn(|k| self.caps[sid][k] as u64 * 10);
        let initial = std::array::from_fn(|k| (stock[k] as u64).min(caps[k]));
        let mut supports: Vec<_> = supply
            .priors
            .iter()
            .map(|_| Supply::singleton(initial))
            .collect();
        self.support_peak = self.support_peak.max(1);
        let d = &self.powers[current.exponent];
        let first = [
            p,
            rational(&current.c[0], d),
            rational(&current.c[1], d),
            rational(&current.c[2], d),
        ];
        let mut values = vec![first];
        let mut evaluated = vec![0];
        let evaluation = (|| -> Result<()> {
            for day in 1..=56 {
                if now() >= self.deadline {
                    return Err("request_budget_exhausted");
                }
                let arrivals: Vec<_> = events.iter().filter(|e| e.day == day).collect();
                for cohort in 0..supply.priors.len() {
                    if supply.priors[cohort].is_zero() {
                        continue;
                    }
                    for event in &arrivals {
                        for reference in &event.refs {
                            let outcomes = supply.law(reference, cohort)?;
                            supports[cohort] = supply.convolve(
                                &supports[cohort],
                                &outcomes,
                                caps,
                                self.max_support,
                            )?;
                            self.support_peak = self.support_peak.max(supports[cohort].len());
                        }
                    }
                }
                let v = if arrivals.is_empty() {
                    values.last().unwrap().clone()
                } else {
                    self.expected_rows(sid, &supports, &supply.priors)?
                };
                if self.qcompare(&v, values.last().unwrap()) == Ordering::Less {
                    return Err("certified_inventory_monotonicity_failed");
                }
                values.push(v);
                evaluated.push(day);
            }
            Ok(())
        })();
        if let Err(reason) = evaluation {
            if ![
                "request_budget_exhausted",
                "exact_support_limit",
                "exact_memo_limit",
                "managed_payload_ceiling",
            ]
            .contains(&reason)
            {
                return Err(reason);
            }
            let mut result = base("unresolved", Some(reason));
            result["evaluatedDays"] = json!(evaluated);
            result["bestDayRange"] = json!([0, 56]);
            Self::gap(&mut result, &values.last().unwrap()[0]);
            result["evidence"] = json!([
                "PH_lower_bound_from_last_exact_completed_date_and_nonnegative_inventory_coupling",
                "UNKNOWN_is_not_equality_or_false"
            ]);
            return Ok(result);
        }
        let h = values.last().unwrap();
        let earliest = values
            .iter()
            .position(|v| self.qcompare(v, h) == Ordering::Equal)
            .unwrap();
        let mut result = base("certified", None);
        result["recommendedDays"] = json!(earliest);
        result["rangeBoundary"] = json!(earliest == 56);
        result["bestDayRange"] = json!([earliest, earliest]);
        result["value"] = json!(self.qview(h));
        result["evaluatedDays"] = json!(evaluated);
        result["successProbabilityInterval"] = json!({"lower":wire(&h[0]),"upper":wire(&h[0])});
        result["successImprovementUpperBound"] = json!(wire(&(Q::one() - &h[0])));
        result["evidence"] = json!([
            "exact_cohort_conditional_distributions_single_latent_cohort",
            "exact_rational_all_57_date_expectations",
            "fixed_prices_all_dates",
            "nonnegative_nonexpiring_inventory_coupling",
            if earliest == 0 {
                "exact_day0_tie"
            } else {
                "exact_previous_day_strict_lex_inequality"
            },
            "range_only_no_global_or_deadline_claim"
        ]);
        Ok(result)
    }
}

fn append(path: &mut Trajectory, event: &Event, index: usize, outcome: &Outcome) -> Result<()> {
    for k in 0..3 {
        path.stock[k] = path.stock[k]
            .checked_add(outcome.pieces[k])
            .ok_or("witness_stock_not_safe_integer")?;
        if path.stock[k] > 9_007_199_254_740_991 {
            return Err("witness_stock_not_safe_integer");
        }
    }
    path.receipts.push(json!({"eventId":event.id,"refIndex":index,"pieces":outcome.pieces,"mass":wire(&outcome.mass)}));
    Ok(())
}
fn trajectory(
    supply: &mut Supply,
    events: &[Event],
    cohort: usize,
    stock: Pieces,
    select: impl Fn(&Event, usize, &[Outcome]) -> usize,
) -> Result<Trajectory> {
    let mut path = Trajectory {
        stock,
        receipts: Vec::new(),
    };
    for event in events {
        for (index, reference) in event.refs.iter().enumerate() {
            let law = supply.law(reference, cohort)?;
            let chosen = select(event, index, &law);
            append(&mut path, event, index, &law[chosen])?;
        }
    }
    Ok(path)
}
fn maximal(rows: &[Outcome], color: usize) -> usize {
    let mut chosen = 0;
    for i in 1..rows.len() {
        if rows[i].pieces[color] > rows[chosen].pieces[color] {
            chosen = i;
        }
    }
    chosen
}
fn scarce(rows: &[Outcome], color: usize) -> usize {
    let mut chosen = 0;
    for i in 1..rows.len() {
        if rows[i].pieces[color] < rows[chosen].pieces[color]
            || (rows[i].pieces[color] == rows[chosen].pieces[color]
                && rows[i].pieces.iter().sum::<u64>() < rows[chosen].pieces.iter().sum::<u64>())
        {
            chosen = i;
        }
    }
    chosen
}
fn target(
    supply: &mut Supply,
    events: &[Event],
    cohort: usize,
    stock: Pieces,
    color: usize,
    target: u64,
    other: &[usize],
) -> Result<Option<Trajectory>> {
    if stock[color] > target {
        return Ok(None);
    }
    let needed = target - stock[color];
    let mut entries: Vec<(&Event, usize, Dist)> = Vec::new();
    for e in events {
        for (i, r) in e.refs.iter().enumerate() {
            entries.push((e, i, supply.law(r, cohort)?));
        }
    }
    let mut min = vec![0u64; entries.len() + 1];
    let mut max = min.clone();
    for i in (0..entries.len()).rev() {
        min[i] = (needed + 1).min(
            min[i + 1].saturating_add(
                entries[i]
                    .2
                    .iter()
                    .map(|r| r.pieces[color])
                    .min()
                    .ok_or("certified_empty_positive_law")?,
            ),
        );
        max[i] = (needed + 1).min(
            max[i + 1].saturating_add(entries[i].2.iter().map(|r| r.pieces[color]).max().unwrap()),
        );
    }
    if needed < min[0] || needed > max[0] {
        return Ok(None);
    }
    let mut remaining = needed;
    let mut path = Trajectory {
        stock,
        receipts: Vec::new(),
    };
    for (i, (event, index, law)) in entries.iter().enumerate() {
        let mut chosen: Option<&Outcome> = None;
        for row in law.iter() {
            if row.pieces[color] + max[i + 1] < remaining
                || row.pieces[color] + min[i + 1] > remaining
            {
                continue;
            }
            if chosen.map_or(true, |old| {
                row.pieces[color] > old.pieces[color]
                    || (row.pieces[color] == old.pieces[color]
                        && other.iter().map(|&k| row.pieces[k]).sum::<u64>()
                            > other.iter().map(|&k| old.pieces[k]).sum::<u64>())
            }) {
                chosen = Some(row);
            }
        }
        let Some(chosen) = chosen else {
            return Ok(None);
        };
        append(&mut path, event, *index, chosen)?;
        remaining -= chosen.pieces[color];
    }
    Ok(if remaining == 0 { Some(path) } else { None })
}
type Witness = (usize, Trajectory, Trajectory, Value, Value);
impl Engine {
    fn boundary(
        &mut self,
        supply: &mut Supply,
        sid: usize,
        stock: Units,
        prior: &[Event],
        last: &[Event],
    ) -> Result<Option<Witness>> {
        let stock: Pieces = std::array::from_fn(|k| stock[k] as u64);
        self.ensure_relaxed(sid)?;
        let bound = self.relaxed[sid].as_ref().unwrap().bound;
        let mut colors: Vec<_> = (0..3).filter(|&k| bound[k] > 0).collect();
        colors.sort_by_key(|&k| bound[k] as i64 * 10 - stock[k] as i64);
        for &color in &colors {
            let other: Vec<_> = colors.iter().copied().filter(|&k| k != color).collect();
            for cohort in 0..supply.priors.len() {
                if supply.priors[cohort].is_zero() {
                    continue;
                }
                if let Some(before) = target(
                    supply,
                    prior,
                    cohort,
                    stock,
                    color,
                    bound[color] as u64 * 10 - 10,
                    &other,
                )? {
                    let after = trajectory(supply, last, cohort, before.stock, |_, _, rows| {
                        maximal(rows, color)
                    })?;
                    let bv = self.endpoint(sid, before.stock)?;
                    let av = self.endpoint(sid, after.stock)?;
                    if self.compare_exact(&av, &bv) == Ordering::Greater {
                        return Ok(Some((cohort, before, after, bv, av)));
                    }
                }
            }
        }
        for cohort in 0..supply.priors.len() {
            if supply.priors[cohort].is_zero() {
                continue;
            }
            for color in 0..3 {
                let before = trajectory(supply, prior, cohort, stock, |_, _, rows| {
                    scarce(rows, color)
                })?;
                let bv = self.endpoint(sid, before.stock)?;
                for event in last {
                    for (index, reference) in event.refs.iter().enumerate() {
                        let law = supply.law(reference, cohort)?;
                        for candidate in 0..law.len() {
                            self.check()?;
                            let after =
                                trajectory(supply, last, cohort, before.stock, |e, i, _| {
                                    if e.id == event.id && i == index {
                                        candidate
                                    } else {
                                        0
                                    }
                                })?;
                            let av = self.endpoint(sid, after.stock)?;
                            if self.compare_exact(&av, &bv) == Ordering::Greater {
                                return Ok(Some((cohort, before, after, bv, av)));
                            }
                        }
                    }
                }
            }
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(n: i64, d: i64) -> Q {
        Q::new(n.into(), d.into())
    }
    fn point(pieces: Pieces, n: i64, d: i64) -> Outcome {
        Outcome {
            pieces,
            mass: q(n, d),
        }
    }
    fn engine(caps: Units) -> Engine {
        let mut edges: Vec<_> = (0..=600)
            .map(|s| [[1000, 600, (s + 1).min(600)]; 3])
            .collect();
        edges[598] = [[500, 600, 599], [250, 600, 599], [750, 600, 599]];
        Engine::new(Init {
            edges,
            caps: vec![caps; 601],
            weights: [wire(&q(1, 1)), wire(&q(2, 1)), wire(&q(3, 1))],
            deadline_at: f64::MAX,
            max_memo_entries: 250000,
            max_support_points: 25000,
        })
        .unwrap()
    }
    fn source(events: Json, laws: Json) -> Supply {
        let model = serde_json::from_value(json!({
            "events":events, "laws":laws,
            "priors":[wire(&q(1,1)),wire(&q(0,1)),wire(&q(0,1))],
            "dispatch":[], "shop":[], "solo":[], "cadence":wire(&q(30,1)),
            "dispatchExpected":vec![vec![wire(&q(1,1));3];3], "classes":[]
        }))
        .unwrap();
        Supply::new(model, f64::MAX).unwrap()
    }
    fn remainder_source() -> Supply {
        source(
            json!([
                {"id":"first","day":1,"refs":[{"lawId":"first","count":1}]},
                {"id":"second","day":2,"refs":[{"lawId":"deterministic:1,0,0","count":1}]}
            ]),
            json!([{"id":"first","kind":"finite","outcomes":[
                {"pieces":[10,0,0],"mass":wire(&q(1,4))},
                {"pieces":[19,0,0],"mass":wire(&q(1,4))},
                {"pieces":[9,0,0],"mass":wire(&q(1,2))}
            ]}]),
        )
    }

    #[test]
    fn fourth_cohort_support_is_not_dropped_or_treated_as_a_fourth_color() {
        let mut e = engine([1, 1, 1]);
        let supports = [vec![], vec![], vec![], vec![point([10, 0, 0], 1, 1)]];
        assert_eq!(
            e.expected_rows(598, &supports, &[q(0, 1), q(0, 1), q(0, 1), q(1, 1)])
                .unwrap(),
            [q(1, 2), q(10, 1), q(0, 1), q(0, 1)]
        );
    }

    #[test]
    fn duplicate_unit_points_keep_exact_probability_and_component_consumption() {
        let mut e = engine([2; 3]);
        let supports = [
            vec![
                point([10, 0, 0], 1, 6),
                point([0, 10, 0], 1, 4),
                point([19, 9, 9], 1, 3),
                point([0, 0, 19], 1, 8),
                point([9, 9, 9], 1, 8),
            ],
            vec![],
            vec![],
        ];
        // One unit succeeds with P=(1/2,1/4,3/4), consuming ten pieces
        // of its own color. The two blue physical points have total mass 1/2.
        let v = e
            .expected_rows(598, &supports, &[q(1, 1), q(0, 1), q(0, 1)])
            .unwrap();
        assert_eq!(v, [q(13, 32), q(5, 1), q(5, 2), q(5, 4)]);
        let view = serde_json::to_value(e.qview(&v)).unwrap();
        assert_eq!(
            view,
            json!({
                "p":wire(&q(13,32)), "b":wire(&q(55,4)), "c":wire(&q(35,4)),
                "consumed":[wire(&q(5,1)),wire(&q(5,2)),wire(&q(5,4))], "mask":0
            })
        );
    }

    #[test]
    fn cohorts_keep_distinct_masses_and_skip_zero_prior_admission() {
        let mut e = engine([2; 3]);
        e.max_memo = 2;
        let supports = [
            vec![point([10, 0, 0], 1, 2), point([19, 0, 0], 1, 2)],
            vec![point([0, 10, 0], 1, 4), point([0, 19, 0], 3, 4)],
            vec![point([0, 0, 10], 1, 1)],
        ];
        // The zero-prior yellow cohort must not consume a third memo entry.
        assert_eq!(
            e.expected_rows(598, &supports, &[q(1, 3), q(2, 3), q(0, 1)])
                .unwrap(),
            [q(1, 3), q(10, 3), q(20, 3), q(0, 1)]
        );
        assert_eq!(
            e.expected_rows(598, &supports, &[q(0, 1), q(0, 1), q(1, 1)])
                .unwrap_err(),
            "exact_memo_limit"
        );
    }

    #[test]
    fn grouped_units_apply_each_color_cap_before_evaluation() {
        let mut e = engine([1; 3]);
        let mut rows = Vec::new();
        for k in 0..3 {
            let mut low = [0; 3];
            low[k] = 10;
            let mut high = [9; 3];
            high[k] = 9_007_199_254_740_991;
            rows.push(point(low, 1, 6));
            rows.push(point(high, 1, 6));
        }
        // All physical amounts above ten are capped at one unit, not two
        // guaranteed attempts. Each color has exactly one third of the mass.
        assert_eq!(
            e.expected_rows(598, &[rows, vec![], vec![]], &[q(1, 1), q(0, 1), q(0, 1)])
                .unwrap(),
            [q(1, 2), q(10, 3), q(10, 3), q(10, 3)]
        );
    }

    #[test]
    fn expectation_keeps_physical_remainders_for_the_next_event() {
        let mut e = engine([2; 3]);
        let mut supply = remainder_source();
        let events = supply.model.events.clone();
        let first = supply.law(&events[0].refs[0], 0).unwrap();
        let rows = supply
            .convolve(&Supply::singleton([0; 3]), &first, [20; 3], 3)
            .unwrap();
        let mut supports = [rows, vec![], vec![]];
        assert_eq!(
            e.expected_rows(598, &supports, &supply.priors).unwrap(),
            [q(1, 4), q(5, 1), q(0, 1), q(0, 1)]
        );
        assert_eq!(
            supports[0].iter().map(|r| r.pieces).collect::<Vec<_>>(),
            vec![[10, 0, 0], [19, 0, 0], [9, 0, 0]]
        );
        let second = supply.law(&events[1].refs[0], 0).unwrap();
        supports[0] = supply.convolve(&supports[0], &second, [20; 3], 3).unwrap();
        // Adding one piece yields 11,20,10: only the old 19-piece point
        // reaches two attempts, with P=1 and expected consumption 10+10/2.
        assert_eq!(
            supports[0].iter().map(|r| r.pieces).collect::<Vec<_>>(),
            vec![[11, 0, 0], [20, 0, 0], [10, 0, 0]]
        );
        assert_eq!(
            e.expected_rows(598, &supports, &supply.priors).unwrap(),
            [q(5, 8), q(45, 4), q(0, 1), q(0, 1)]
        );
    }

    #[test]
    fn waiting_keeps_exact_dates_values_and_physical_support_peak() {
        let mut e = engine([2; 3]);
        let mut supply = remainder_source();
        e.current(598, [0; 3], 1).unwrap();
        let result = e.waiting(&mut supply, 598, [0; 3], true).unwrap();
        assert_eq!(result["status"], json!("certified"));
        assert_eq!(result["recommendedDays"], json!(2));
        assert_eq!(result["bestDayRange"], json!([2, 2]));
        assert_eq!(result["evaluatedDays"], json!((0..=56).collect::<Vec<_>>()));
        assert_eq!(
            result["value"],
            json!({
                "p":wire(&q(5,8)), "b":wire(&q(45,4)), "c":wire(&q(45,4)),
                "consumed":[wire(&q(45,4)),wire(&q(0,1)),wire(&q(0,1))], "mask":0
            })
        );
        assert_eq!(
            result["successProbabilityInterval"],
            json!({"lower":wire(&q(5,8)),"upper":wire(&q(5,8))})
        );
        assert_eq!(
            result["successImprovementUpperBound"],
            json!(wire(&q(3, 8)))
        );
        assert_eq!(e.support_peak, 3);
    }

    #[test]
    fn grouped_expectation_does_not_relax_physical_support_or_raw_addition_guards() {
        let mut e = engine([2; 3]);
        e.max_support = 2;
        let mut supply = remainder_source();
        e.current(598, [0; 3], 1).unwrap();
        let result = e.waiting(&mut supply, 598, [0; 3], true).unwrap();
        assert_eq!(result["status"], json!("unresolved"));
        assert_eq!(result["reason"], json!("exact_support_limit"));
        assert_eq!(result["evaluatedDays"], json!([0]));
        assert_eq!(result["value"], Json::Null);
        assert_eq!(result["bestDayRange"], json!([0, 56]));
        assert_eq!(
            result["successProbabilityInterval"],
            json!({"lower":wire(&q(0,1)),"upper":wire(&q(1,1))})
        );
        assert_eq!(e.support_peak, 1);
        assert_eq!(
            supply
                .convolve(
                    &[point([9_007_199_254_740_991, 0, 0], 1, 1)],
                    &[point([1, 0, 0], 1, 1)],
                    [20; 3],
                    2
                )
                .err(),
            Some("certified_law_raw_pieces_invalid")
        );
    }

    #[test]
    fn incomplete_grouped_date_keeps_the_last_completed_lower_bound() {
        let mut e = engine([2; 3]);
        e.max_memo = 1;
        let mut supply = source(
            json!([
                {"id":"first","day":1,"refs":[{"lawId":"deterministic:10,0,0","count":1}]},
                {"id":"second","day":2,"refs":[{"lawId":"deterministic:0,10,0","count":1}]}
            ]),
            json!([]),
        );
        e.current(598, [0; 3], 1).unwrap();
        let result = e.waiting(&mut supply, 598, [0; 3], true).unwrap();
        assert_eq!(result["status"], json!("unresolved"));
        assert_eq!(result["reason"], json!("exact_memo_limit"));
        assert_eq!(result["evaluatedDays"], json!([0, 1]));
        assert_eq!(result["recommendedDays"], Json::Null);
        assert_eq!(result["value"], Json::Null);
        assert_eq!(result["bestDayRange"], json!([0, 56]));
        assert_eq!(
            result["successProbabilityInterval"],
            json!({"lower":wire(&q(1,2)),"upper":wire(&q(1,1))})
        );
        assert_eq!(
            result["successImprovementUpperBound"],
            json!(wire(&q(1, 2)))
        );
    }

    #[test]
    fn grouped_evaluation_keeps_first_seen_memo_admission_order() {
        let mut e = engine([2; 3]);
        e.max_memo = 1;
        let supports = [
            vec![
                point([0, 10, 0], 1, 4),
                point([10, 0, 0], 1, 2),
                point([0, 19, 0], 1, 4),
            ],
            vec![],
            vec![],
        ];
        assert_eq!(
            e.expected_rows(598, &supports, &[q(1, 1), q(0, 1), q(0, 1)])
                .unwrap_err(),
            "exact_memo_limit"
        );
        let first = e.get(598, [0, 1, 0], false).unwrap();
        assert_eq!(rational(&first.p, &e.powers[first.exponent]), q(1, 4));
        assert_eq!(first.c[0], BigUint::zero());
        assert_eq!(rational(&first.c[1], &e.powers[first.exponent]), q(10, 1));
        assert_eq!(first.c[2], BigUint::zero());
        assert_eq!(e.get(598, [1, 0, 0], false).err(), Some("exact_memo_limit"));
    }

    #[test]
    fn physical_scan_and_group_evaluation_observe_deadline_budget() {
        let mut e = engine([2; 3]);
        e.deadline = -1.0;
        let supports = [
            (0..32)
                .map(|i| point([10 + i % 10, i / 10, 0], 1, 32))
                .collect(),
            vec![],
            vec![],
        ];
        assert_eq!(
            e.expected_rows(598, &supports, &[q(1, 1), q(0, 1), q(0, 1)])
                .unwrap_err(),
            "request_budget_exhausted"
        );
        let mut e = engine([2; 3]);
        e.deadline = -1.0;
        e.ticks = 30;
        assert_eq!(
            e.expected_rows(
                598,
                &[Supply::singleton([10, 0, 0]), vec![], vec![]],
                &[q(1, 1), q(0, 1), q(0, 1)]
            )
            .unwrap_err(),
            "request_budget_exhausted"
        );
    }
}
