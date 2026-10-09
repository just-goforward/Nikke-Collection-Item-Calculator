//! H56 range-only certificates. Same ordered receipt selectors, exact endpoint
//! proofs and exhaustive-date/gap semantics as the independent TS oracle.
use super::*;
use crate::supply::{Dist, Event, Outcome, Pieces, Supply};

#[derive(Clone)]
struct Trajectory { stock: Pieces, receipts: Vec<Json> }
fn base(status: &str, reason: Option<&str>) -> Json {
    json!({ "status": status, "horizonDays":56, "recommendedDays":null,
        "rangeBoundary":false, "bestDayRange":null, "value":null,
        "evaluatedDays":[0], "successImprovementUpperBound":null,
        "successProbabilityInterval":null, "reason":reason, "evidence":[] })
}
impl Engine {
    fn compare_exact(&self, a: &Value, b: &Value) -> Ordering {
        let exponent = a.exponent.max(b.exponent);
        self.compare(&self.lift(a,exponent), &self.lift(b,exponent))
    }
    fn actual_view(&self, value: &Value) -> PublicValue {
        let mut view = self.view(value);
        view.b = wire(&(rational(&self.burden(value), &self.powers[value.exponent]) /
            Q::from_integer(self.scale.clone().into())));
        view
    }
    pub fn current(&mut self, sid: usize, stock: Units, batch: usize) -> Result<Json> {
        let units=std::array::from_fn(|k| stock[k]/10);
        if units.iter().sum::<usize>()>36 {self.ensure_guidance(sid,units);}
        let root = self.get(sid, std::array::from_fn(|k| stock[k]/10), true)?;
        self.current_root = Some(root.clone());
        let kit = (0..3).find(|k| root.mask & (1 << k) != 0);
        let mut uses = 0;
        if let Some(k) = kit {
            let mut s = sid;
            let mut raw = stock;
            while uses < batch {
                let v = if uses == 0 { root.clone() } else {
                    match self.get(s, std::array::from_fn(|j| raw[j]/10), true) { Ok(v) => v, Err(_) => break }
                };
                if v.mask & (1<<k) == 0 { break; }
                uses += 1;
                raw[k] -= 10;
                let [p,_,n] = self.edges[s][k];
                s = n;
                let state = |s| if s < 150 { (0,s/10) } else { (1,(s-150)/30) };
                if p == 1000 || s == TERMINAL || state(s) != state(sid) { break; }
            }
        }
        self.arena=None;
        Ok(json!({ "status": if sid == TERMINAL {"complete"} else if kit.is_some() {"use_certified"} else {"preserve"},
            "value": self.actual_view(&root), "kit":kit.map(|k| ["blue","purple","yellow"][k]),
            "optimalActionMask":root.mask, "uses":uses, "pieces":uses*10,
            "certification":"exact_rational_finite_inventory_v1" }))
    }
    fn endpoint(&mut self, sid: usize, stock: Pieces) -> Result<Value> {
        self.kernel_calls += 1;
        let units=std::array::from_fn(|k| (stock[k]/10).min(self.caps[sid][k] as u64) as usize);
        if units.iter().sum::<usize>()>36 || self.arena.is_some() {self.ensure_guidance(sid,units);}
        self.get(sid,units,true)
    }
    fn expected_rows(&mut self, sid: usize, supports: &[Vec<Outcome>;3], priors: &[Q;3]) -> Result<[Q;4]> {
        let mut sum = std::array::from_fn(|_| Q::zero());
        for cohort in 0..3 {
            if priors[cohort].is_zero() { continue; }
            for row in &supports[cohort] {
                self.check()?;
                let units=std::array::from_fn(|k| (row.pieces[k]/10).min(self.caps[sid][k] as u64) as usize);
                if units.iter().sum::<usize>()>36 || self.arena.is_some() {self.ensure_guidance(sid,units);}
                let v = self.get(sid,units,false)?;
                let mass = &priors[cohort] * &row.mass;
                sum[0] += &mass * rational(&v.p,&self.powers[v.exponent]);
                for k in 0..3 { sum[k+1] += &mass * rational(&v.c[k],&self.powers[v.exponent]); }
            }
        }
        Ok(sum)
    }
    fn qview(&self, v: &[Q;4]) -> PublicValue {
        let b: Q = (0..3).map(|k| &v[k+1] * Q::from_integer(self.prices[k].clone().into())).sum();
        PublicValue { p:wire(&v[0]), b:wire(&(b / Q::from_integer(self.scale.clone().into()))),
            c:wire(&(v[1].clone()+&v[2]+&v[3])), consumed:std::array::from_fn(|k| wire(&v[k+1])), mask:0 }
    }
    fn qcompare(&self, a: &[Q;4], b: &[Q;4]) -> Ordering {
        let cost = |v: &[Q;4]| -> Q { (0..3).map(|k| &v[k+1]*Q::from_integer(self.prices[k].clone().into())).sum() };
        a[0].cmp(&b[0]).then_with(|| cost(b).cmp(&cost(a)))
            .then_with(|| (b[1].clone()+&b[2]+&b[3]).cmp(&(a[1].clone()+&a[2]+&a[3])))
    }
    fn gap(result: &mut Json, lower: &Q) {
        result["successProbabilityInterval"] = json!({"lower":wire(lower),"upper":wire(&Q::one())});
        result["successImprovementUpperBound"] = json!(wire(&(Q::one()-lower)));
    }
    pub fn waiting(&mut self, supply: &mut Supply, sid: usize, stock: Units, complete: bool) -> Result<Json> {
        let current = self.current_root.clone().ok_or("current_not_completed")?;
        let p = rational(&current.p,&self.powers[current.exponent]);
        let unlimited = self.unlimited(sid)?;
        let equal = self.compare_exact(&current,&unlimited.value) == Ordering::Equal;
        if equal || (complete && supply.model.events.iter().all(|e| e.refs.iter().all(|r| r.count == 0))) {
            let mut result = base("certified",None);
            result["recommendedDays"] = json!(0);
            result["bestDayRange"] = json!([0,0]);
            result["value"] = json!(self.actual_view(&current));
            result["successProbabilityInterval"] = json!({"lower":wire(&p),"upper":wire(&p)});
            result["successImprovementUpperBound"] = json!(wire(&(Q::one()-&p)));
            result["evidence"] = if equal {
                json!(["exact_P_B_C_equal_feasible_unlimited_optimum","fixed_prices_all_dates","nonnegative_nonexpiring_inventory_coupling","range_only_no_deadline"])
            } else { json!(["no_random_and_no_deterministic_arrivals_in_complete_future_snapshot","exact_all_dates_same_inventory"]) };
            return Ok(result);
        }
        if !complete {
            let mut result = base("unresolved",Some("future_coverage_incomplete"));
            result["bestDayRange"] = json!([0,56]);
            return Ok(result);
        }
        let events = supply.model.events.clone();
        let prior: Vec<_> = events.iter().filter(|e| e.day != 56).cloned().collect();
        let last: Vec<_> = events.iter().filter(|e| e.day == 56).cloned().collect();
        if !last.is_empty() {
            if let Some((cohort,before,after,bv,av)) = self.boundary(supply,sid,stock,&prior,&last)? {
                let mut result = base("certified",None);
                result["recommendedDays"] = json!(56);
                result["rangeBoundary"] = json!(true);
                result["bestDayRange"] = json!([56,56]);
                Self::gap(&mut result,&p);
                result["evidence"] = json!(["fixed_prices_all_dates","nonnegative_nonexpiring_inventory_coupling",
                    "single_latent_cohort_positive_prior","positive_mass_receipt_witness_strict_lex_day55_to56",
                    "all_prior_dates_bounded_by_day55","PH_lower_bound_from_exact_current_P_and_inventory_coupling",
                    "range_only_no_global_or_deadline_claim"]);
                let mut receipts = before.receipts; receipts.extend(after.receipts);
                result["strictBoundaryWitness"] = json!({"cohort":cohort,"receipts":receipts,"beforeStock":before.stock,
                    "afterStock":after.stock,"beforeValue":self.actual_view(&bv),"afterValue":self.actual_view(&av)});
                return Ok(result);
            }
        }
        let caps = std::array::from_fn(|k| self.caps[sid][k] as u64*10);
        let initial = std::array::from_fn(|k| (stock[k] as u64).min(caps[k]));
        let mut supports = std::array::from_fn(|_| Supply::singleton(initial));
        self.support_peak = self.support_peak.max(1);
        let d = &self.powers[current.exponent];
        let first = [p, rational(&current.c[0],d), rational(&current.c[1],d), rational(&current.c[2],d)];
        let mut values = vec![first];
        let mut evaluated = vec![0];
        let evaluation = (|| -> Result<()> {
            for day in 1..=56 {
                if now() >= self.deadline { return Err("request_budget_exhausted"); }
                let arrivals: Vec<_> = events.iter().filter(|e| e.day == day).collect();
                for cohort in 0..3 {
                    if supply.priors[cohort].is_zero() { continue; }
                    for event in &arrivals {
                        for reference in &event.refs {
                            let outcomes = supply.law(reference,cohort)?;
                            supports[cohort] = supply.convolve(&supports[cohort],&outcomes,caps,self.max_support)?;
                            self.support_peak = self.support_peak.max(supports[cohort].len());
                        }
                    }
                }
                let v = if arrivals.is_empty() { values.last().unwrap().clone() } else { self.expected_rows(sid,&supports,&supply.priors)? };
                if self.qcompare(&v,values.last().unwrap()) == Ordering::Less { return Err("certified_inventory_monotonicity_failed"); }
                values.push(v); evaluated.push(day);
            }
            Ok(())
        })();
        if let Err(reason) = evaluation {
            if !["request_budget_exhausted","exact_support_limit","exact_memo_limit","managed_payload_ceiling"].contains(&reason) {
                return Err(reason);
            }
            let mut result = base("unresolved",Some(reason));
            result["evaluatedDays"] = json!(evaluated);
            result["bestDayRange"] = json!([0,56]);
            Self::gap(&mut result,&values.last().unwrap()[0]);
            result["evidence"] = json!(["PH_lower_bound_from_last_exact_completed_date_and_nonnegative_inventory_coupling","UNKNOWN_is_not_equality_or_false"]);
            return Ok(result);
        }
        let h = values.last().unwrap();
        let earliest = values.iter().position(|v| self.qcompare(v,h) == Ordering::Equal).unwrap();
        let mut result = base("certified",None);
        result["recommendedDays"] = json!(earliest);
        result["rangeBoundary"] = json!(earliest == 56);
        result["bestDayRange"] = json!([earliest,earliest]);
        result["value"] = json!(self.qview(h));
        result["evaluatedDays"] = json!(evaluated);
        result["successProbabilityInterval"] = json!({"lower":wire(&h[0]),"upper":wire(&h[0])});
        result["successImprovementUpperBound"] = json!(wire(&(Q::one()-&h[0])));
        result["evidence"] = json!(["exact_cohort_conditional_distributions_single_latent_cohort",
            "exact_rational_all_57_date_expectations","fixed_prices_all_dates","nonnegative_nonexpiring_inventory_coupling",
            if earliest == 0 {"exact_day0_tie"} else {"exact_previous_day_strict_lex_inequality"},"range_only_no_global_or_deadline_claim"]);
        Ok(result)
    }
}

fn append(path: &mut Trajectory, event: &Event, index: usize, outcome: &Outcome) -> Result<()> {
    for k in 0..3 {
        path.stock[k] = path.stock[k].checked_add(outcome.pieces[k]).ok_or("witness_stock_not_safe_integer")?;
        if path.stock[k] > 9_007_199_254_740_991 { return Err("witness_stock_not_safe_integer"); }
    }
    path.receipts.push(json!({"eventId":event.id,"refIndex":index,"pieces":outcome.pieces,"mass":wire(&outcome.mass)}));
    Ok(())
}
fn trajectory(supply: &mut Supply, events: &[Event], cohort: usize, stock: Pieces,
    select: impl Fn(&Event,usize,&[Outcome]) -> usize) -> Result<Trajectory> {
    let mut path = Trajectory { stock, receipts: Vec::new() };
    for event in events {
        for (index,reference) in event.refs.iter().enumerate() {
            let law = supply.law(reference,cohort)?;
            let chosen = select(event,index,&law);
            append(&mut path,event,index,&law[chosen])?;
        }
    }
    Ok(path)
}
fn maximal(rows: &[Outcome], color: usize) -> usize {
    let mut chosen = 0;
    for i in 1..rows.len() { if rows[i].pieces[color] > rows[chosen].pieces[color] { chosen = i; } }
    chosen
}
fn scarce(rows: &[Outcome], color: usize) -> usize {
    let mut chosen = 0;
    for i in 1..rows.len() {
        if rows[i].pieces[color] < rows[chosen].pieces[color] ||
            (rows[i].pieces[color] == rows[chosen].pieces[color] && rows[i].pieces.iter().sum::<u64>() < rows[chosen].pieces.iter().sum::<u64>()) {
            chosen = i;
        }
    }
    chosen
}
fn target(supply: &mut Supply, events: &[Event], cohort: usize, stock: Pieces,
    color: usize, target: u64, other: &[usize]) -> Result<Option<Trajectory>> {
    if stock[color] > target { return Ok(None); }
    let needed = target-stock[color];
    let mut entries: Vec<(&Event,usize,Dist)> = Vec::new();
    for e in events { for (i,r) in e.refs.iter().enumerate() { entries.push((e,i,supply.law(r,cohort)?)); } }
    let mut min = vec![0u64;entries.len()+1]; let mut max = min.clone();
    for i in (0..entries.len()).rev() {
        min[i] = (needed+1).min(min[i+1].saturating_add(entries[i].2.iter().map(|r| r.pieces[color]).min().ok_or("certified_empty_positive_law")?));
        max[i] = (needed+1).min(max[i+1].saturating_add(entries[i].2.iter().map(|r| r.pieces[color]).max().unwrap()));
    }
    if needed < min[0] || needed > max[0] { return Ok(None); }
    let mut remaining = needed;
    let mut path = Trajectory { stock, receipts:Vec::new() };
    for (i,(event,index,law)) in entries.iter().enumerate() {
        let mut chosen: Option<&Outcome> = None;
        for row in law.iter() {
            if row.pieces[color] + max[i+1] < remaining || row.pieces[color] + min[i+1] > remaining { continue; }
            if chosen.map_or(true, |old| row.pieces[color] > old.pieces[color] ||
                (row.pieces[color] == old.pieces[color] && other.iter().map(|&k| row.pieces[k]).sum::<u64>() > other.iter().map(|&k| old.pieces[k]).sum::<u64>())) {
                chosen = Some(row);
            }
        }
        let Some(chosen) = chosen else { return Ok(None); };
        append(&mut path,event,*index,chosen)?;
        remaining -= chosen.pieces[color];
    }
    Ok(if remaining == 0 { Some(path) } else { None })
}
type Witness = (usize,Trajectory,Trajectory,Value,Value);
impl Engine {
    fn boundary(&mut self, supply: &mut Supply, sid: usize, stock: Units, prior: &[Event], last: &[Event]) -> Result<Option<Witness>> {
        let stock: Pieces=std::array::from_fn(|k| stock[k] as u64);
        let bound = self.unlimited(sid)?.bound;
        let mut colors: Vec<_> = (0..3).filter(|&k| bound[k]>0).collect();
        colors.sort_by_key(|&k| bound[k] as i64*10-stock[k] as i64);
        for &color in &colors {
            let other: Vec<_> = colors.iter().copied().filter(|&k| k!=color).collect();
            for cohort in 0..3 {
                if supply.priors[cohort].is_zero() { continue; }
                if let Some(before) = target(supply,prior,cohort,stock,color,bound[color] as u64*10-10,&other)? {
                    let after = trajectory(supply,last,cohort,before.stock,|_,_,rows| maximal(rows,color))?;
                    let bv = self.endpoint(sid,before.stock)?; let av = self.endpoint(sid,after.stock)?;
                    if self.compare_exact(&av,&bv) == Ordering::Greater { return Ok(Some((cohort,before,after,bv,av))); }
                }
            }
        }
        for cohort in 0..3 {
            if supply.priors[cohort].is_zero() { continue; }
            for color in 0..3 {
                let before = trajectory(supply,prior,cohort,stock,|_,_,rows| scarce(rows,color))?;
                let bv = self.endpoint(sid,before.stock)?;
                for event in last {
                    for (index,reference) in event.refs.iter().enumerate() {
                        let law = supply.law(reference,cohort)?;
                        for candidate in 0..law.len() {
                            self.check()?;
                            let after = trajectory(supply,last,cohort,before.stock,|e,i,_| if e.id==event.id && i==index {candidate} else {0})?;
                            let av = self.endpoint(sid,after.stock)?;
                            if self.compare_exact(&av,&bv) == Ordering::Greater { return Ok(Some((cohort,before,after,bv,av))); }
                        }
                    }
                }
            }
        }
        Ok(None)
    }
}
