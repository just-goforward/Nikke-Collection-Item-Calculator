//! Batch-valued endpoint classifier. The loss unit is one day of the fixed
//! 1:2:3:1 mixed recurring supply, not the user's posterior or initial stock.
//! Only exact primary success probabilities enter this classifier.
use super::reachability::Reachability;
use super::supply::Supply;
use super::*;
use num_traits::ToPrimitive;

pub(super) const HORIZON: usize = 7;
pub(super) const VERSION: &str = "certified-minimum-wait-v1";
const KITS: [&str; 3] = ["blue", "purple", "yellow"];

#[derive(Clone)]
pub(super) struct Batch {
    pub kit: usize,
    pub path: Vec<(usize, Edge)>,
    pub guard: Option<&'static str>,
}

impl Batch {
    pub fn uses(&self) -> usize {
        self.path.len()
    }
}

pub(super) fn settlement_certificate(batch: &Batch, rates: &[Q; 3]) -> bool {
    rates[batch.kit] >= Q::from_integer((10 * batch.uses()).into())
}

pub(super) struct Day {
    day: usize,
    units: Vec<Units>,
    crossing: Vec<Units>,
}

pub(super) struct Assessment {
    pub batch: Batch,
    pub first_day: Option<usize>,
    pub beyond: bool,
    pub earliest: usize,
    pub reason: Option<&'static str>,
    evaluated: Vec<usize>,
    rates: Option<[Q; 3]>,
    certificate: bool,
    days: Vec<Day>,
}

impl Assessment {
    pub fn unknown(batch: Batch, reason: &'static str) -> Self {
        Self {
            batch,
            first_day: None,
            beyond: false,
            earliest: 1,
            reason: Some(reason),
            evaluated: Vec::new(),
            rates: None,
            certificate: false,
            days: Vec::new(),
        }
    }

    /// Proved 7+ is the preferred tie class; finite exact days follow ascending.
    /// UNKNOWN has no rank and must never win a tie by an assumed bound.
    pub fn rank(&self) -> Option<usize> {
        if self.reason.is_some() {
            None
        } else if self.beyond {
            Some(0)
        } else {
            self.first_day
        }
    }

    pub fn json(&self) -> Json {
        let status = if self.reason.is_some() {
            "unknown"
        } else if self.beyond {
            "beyond_horizon"
        } else {
            "certified"
        };
        json!({
            "version":VERSION,"status":status,"kit":KITS[self.batch.kit],
            "uses":self.batch.uses(),"pieces":10*self.batch.uses(),
            "thresholdDays":wire(&Q::one()),"horizonDays":HORIZON,
            "minimumDays":if self.reason.is_none() {self.first_day} else {None},
            "earliestPossibleDay":self.earliest,
            "latestPossibleDay":self.first_day,
            "evaluatedDays":self.evaluated,"reason":self.reason,
            "mixedDailyRate":self.rates.as_ref().map(|rates|rates.iter().map(wire).collect::<Vec<_>>()),
            "evidence":if self.certificate {vec!["batch_settlement_bound_theta_rate_ge_10n"]}
                else {vec!["exact_P_only_batch_endpoints","positive_support_union_all_four_latent_cohorts"]},
        })
    }

    pub fn probe_json(&self, caps: Units) -> Json {
        json!({
            "version":"certified-minimum-wait-probe-v1",
            "minimumWait":self.json(),
            "status":if self.reason.is_none() && self.days.len()==HORIZON {"EXACT"} else {"NOTRUN"},
            "recommendation":{"kit":KITS[self.batch.kit],"uses":self.batch.uses()},
            "label":if self.reason.is_some() {json!("unknown")}
                else if let Some(day)=self.first_day {json!(day)} else {json!("7+")},
            "certificateApplies":self.certificate,
            "certificateShortcutUsed":self.certificate,
            "classifierCaps":caps,"supportUnitsCapped":false,
            "reason":self.reason,
            "complete":self.reason.is_none() && self.days.len()==HORIZON,
            "perDay":self.days.iter().map(|day|json!({
                "day":day.day,"crossing":!day.crossing.is_empty(),"supportUnits":day.units,
                "crossingUnits":day.crossing,
            })).collect::<Vec<_>>(),
        })
    }
}

pub(super) fn inactive() -> Json {
    json!({
        "version":VERSION,"status":"not_applicable","kit":null,"uses":0,"pieces":0,
        "thresholdDays":wire(&Q::one()),"horizonDays":HORIZON,"minimumDays":null,
        "earliestPossibleDay":null,"latestPossibleDay":null,"evaluatedDays":[],
        "reason":"no_recommended_batch","mixedDailyRate":null,"evidence":[],
    })
}

impl Engine {
    fn batch_units(&self, batch: &Batch, mut units: Units) -> Result<Vec<Units>> {
        let mut remaining = Vec::with_capacity(batch.uses());
        for &(sid, _) in &batch.path {
            units = std::array::from_fn(|axis| units[axis].min(self.caps[sid][axis]));
            if units[batch.kit] == 0 {
                return Err("minimum_wait_batch_infeasible");
            }
            units[batch.kit] -= 1;
            remaining.push(units);
        }
        Ok(remaining)
    }

    fn batch_probability(&mut self, batch: &Batch, units: Units) -> Result<Q> {
        let remaining = self.batch_units(batch, units)?;
        let mut tail = None;
        for ((_, [per, great, normal]), rest) in batch.path.iter().zip(remaining).rev() {
            self.check()?;
            let great = self.primary_probability(*great, rest)?;
            tail = Some(if *per == 1000 {
                great
            } else {
                let normal = match tail {
                    Some(value) => value,
                    None => self.primary_probability(*normal, rest)?,
                };
                let probability = Q::new((*per).into(), 1000.into());
                &probability * great + (Q::one() - probability) * normal
            });
        }
        tail.ok_or("minimum_wait_empty_batch")
    }

    pub(super) fn forced_batch_value(&mut self, batch: &Batch, mut units: Units) -> Result<Value> {
        let remaining = self.batch_units(batch, units)?;
        let mut exponents = Vec::with_capacity(batch.uses());
        for &(sid, _) in &batch.path {
            units = std::array::from_fn(|axis| units[axis].min(self.caps[sid][axis]));
            exponents.push(units.iter().sum::<usize>().min(self.depth[sid]));
            units[batch.kit] -= 1;
        }
        let mut tail = None;
        for (((_, [per, great, normal]), rest), exponent) in
            batch.path.iter().zip(remaining).zip(exponents).rev()
        {
            let great = self.get(*great, rest, false)?;
            let normal = if *per == 1000 {
                Value::zero()
            } else {
                match tail {
                    Some(value) => value,
                    None => self.get(*normal, rest, false)?,
                }
            };
            tail = Some(self.combine(*per, &great, &normal, exponent, batch.kit)?);
        }
        tail.ok_or("minimum_wait_empty_batch")
    }

    fn crossing(
        &mut self,
        sid: usize,
        batch: &Batch,
        units: Units,
        compensation: Units,
    ) -> Result<bool> {
        let target = self.primary_probability(sid, units)?;
        let mut endpoints = vec![units];
        for (axis, amount) in compensation.into_iter().enumerate() {
            let mut endpoint = units;
            endpoint[axis] = endpoint[axis]
                .saturating_add(amount)
                .min(self.caps[sid][axis]);
            if !endpoints.contains(&endpoint) {
                endpoints.push(endpoint);
            }
        }
        for endpoint in endpoints {
            if self.batch_probability(batch, endpoint)? >= target {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub(super) fn assess_batch(
        &mut self,
        supply: &mut Supply,
        sid: usize,
        stock: Units,
        batch: Batch,
        complete: bool,
        all_days: bool,
    ) -> Assessment {
        let mut result = Assessment::unknown(batch, "minimum_wait_in_progress");
        let evaluation = (|| -> Result<()> {
            if now() >= self.deadline {
                return Err("request_budget_exhausted");
            }
            if let Some(reason) = result.batch.guard {
                return Err(reason);
            }
            let rates = supply.minimum_wait_rates()?;
            if rates.iter().any(|rate| rate < &Q::zero()) {
                return Err("negative_recurring_rate");
            }
            result.certificate = settlement_certificate(&result.batch, &rates);
            let mut compensation = [0; 3];
            for (axis, amount) in compensation.iter_mut().enumerate() {
                let units = (&rates[axis] / Q::from_integer(10.into())).to_integer();
                *amount = if units >= BigInt::from(self.caps[sid][axis]) {
                    self.caps[sid][axis]
                } else {
                    units
                        .to_usize()
                        .ok_or("minimum_wait_compensation_invalid")?
                };
            }
            result.rates = Some(rates);
            if result.certificate && !all_days {
                result.beyond = true;
                result.earliest = HORIZON + 1;
                return Ok(());
            }
            if !complete {
                return Err("minimum_wait_future_coverage_incomplete");
            }
            let mut caps = [0; 3];
            for (cap, units) in caps.iter_mut().zip(self.caps[sid]) {
                *cap = units.checked_mul(10).ok_or("minimum_wait_grid_overflow")?;
            }
            if all_days {
                // The comparison protocol reports uncapped support units. Only
                // P lookups are canonicalized by the exact finite-game caps.
                caps = [usize::MAX; 3];
            }
            let mut reach = Reachability::new(stock, caps)?;
            let mut answers = HashMap::new();
            for day in 1..=HORIZON {
                if now() >= self.deadline {
                    return Err("request_budget_exhausted");
                }
                let refs: Vec<_> = supply
                    .model
                    .events
                    .iter()
                    .filter(|event| event.day == day)
                    .flat_map(|event| event.refs.clone())
                    .collect();
                for reference in refs {
                    let supports = supply.supports(&reference)?;
                    reach.advance(&supports, &mut || self.check())?;
                }
                let units = reach.units(self.max_support, &mut || self.check())?;
                self.support_peak = self.support_peak.max(units.len());
                let maximum = std::array::from_fn(|axis| {
                    units
                        .iter()
                        .map(|u| u[axis])
                        .max()
                        .unwrap_or(0)
                        .saturating_add(compensation[axis])
                        .min(self.caps[sid][axis])
                });
                self.ensure_guidance(sid, maximum);
                let mut crossing = Vec::new();
                for &point in &units {
                    self.check()?;
                    let canonical =
                        std::array::from_fn(|axis| point[axis].min(self.caps[sid][axis]));
                    let hit = if result.certificate {
                        false
                    } else if let Some(&hit) = answers.get(&canonical) {
                        hit
                    } else {
                        let hit = self.crossing(sid, &result.batch, canonical, compensation)?;
                        answers
                            .try_reserve(1)
                            .map_err(|_| "managed_payload_ceiling")?;
                        answers.insert(canonical, hit);
                        hit
                    };
                    if hit {
                        result.first_day.get_or_insert(day);
                        crossing.push(point);
                        if !all_days {
                            result.evaluated.push(day);
                            return Ok(());
                        }
                    }
                }
                result.evaluated.push(day);
                if result.first_day.is_none() {
                    result.earliest = day + 1;
                }
                if all_days {
                    result.days.push(Day {
                        day,
                        units,
                        crossing,
                    });
                }
            }
            result.beyond = result.first_day.is_none();
            Ok(())
        })();
        result.reason = evaluation.err();
        if result.reason.is_some() {
            result.beyond = false;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(n: i64, d: i64) -> Q {
        Q::new(n.into(), d.into())
    }

    fn engine(weights: [Q; 3]) -> Engine {
        let mut edges: Vec<_> = (0..=600)
            .map(|state| [[1000, 600, (state + 1).min(600)]; 3])
            .collect();
        edges[597] = [[1000, 598, 598], [1000, 600, 600], [500, 600, 598]];
        edges[598] = [[1, 600, 599], [1000, 600, 600], [1000, 600, 600]];
        Engine::new(Init {
            edges,
            caps: vec![[3; 3]; 601],
            weights: weights.map(|weight| wire(&weight)),
            deadline_at: f64::MAX,
            max_memo_entries: 10_000,
            max_support_points: 25_000,
        })
        .unwrap()
    }

    fn source(dispatch: &str, events: Json, laws: Json) -> Supply {
        let model = serde_json::from_value(json!({
            "events":events,"laws":laws,
            "priors":[wire(&q(1,1)),wire(&q(0,1)),wire(&q(0,1)),wire(&q(0,1))],
            "dispatch":[{"lawId":dispatch,"count":1}],"shop":[],"solo":[],
            "cadence":wire(&q(30,1)),
            "dispatchExpected":vec![vec![wire(&q(0,1));3];4],"classes":[],
        }))
        .unwrap();
        Supply::new(model, f64::MAX).unwrap()
    }

    fn arrival(day: usize, id: &str) -> Json {
        json!([{"id":"arrival","day":day,"refs":[{"lawId":id,"count":1}]}])
    }

    #[test]
    fn primary_queries_are_exact_and_do_not_populate_cost_values() {
        let mut e = engine([q(1, 1), q(1, 1), q(1, 1)]);
        assert_eq!(e.primary_probability(597, [0, 0, 1]).unwrap(), q(1, 2));
        assert!(e.memo.is_empty());
        let size = e.primary.len();
        assert!(size > 0);
        assert_eq!(e.primary_probability(597, [0, 0, 1]).unwrap(), q(1, 2));
        assert_eq!(e.primary.len(), size);
        let value = e.get(597, [0, 0, 1], true).unwrap();
        assert_eq!(rational(&value.p, &e.powers[value.exponent]), q(1, 2));
    }

    #[test]
    fn certificate_accounts_for_every_ten_piece_settlement_in_the_batch() {
        let mut batch = Batch {
            kit: 0,
            path: vec![(597, [1000, 598, 598])],
            guard: None,
        };
        assert!(settlement_certificate(
            &batch,
            &[q(15, 1), q(0, 1), q(0, 1)]
        ));
        batch.path.push((598, [1, 600, 599]));
        assert!(!settlement_certificate(
            &batch,
            &[q(1999, 100), q(0, 1), q(0, 1)]
        ));
        assert!(settlement_certificate(
            &batch,
            &[q(20, 1), q(0, 1), q(0, 1)]
        ));
    }

    #[test]
    fn exact_endpoint_crossing_starts_on_day_three_and_uses_all_four_cohorts() {
        let mut e = engine([q(1, 1), q(1, 1), q(1, 1)]);
        let laws = json!([{"id":"latent","kind":"finite","outcomesByCohort":[
            [{"pieces":[0,0,0],"mass":wire(&q(1,1))}],
            [{"pieces":[10,0,0],"mass":wire(&q(1,1))}],
            [{"pieces":[0,0,0],"mass":wire(&q(1,1))}],
            [{"pieces":[0,0,0],"mass":wire(&q(1,1))}]
        ]}]);
        let mut s = source("deterministic:1,0,0", arrival(3, "latent"), laws);
        e.current(597, [0, 0, 10], 10).unwrap();
        let result = e
            .minimum_wait_probe(&mut s, 597, [0, 0, 10], 2, 1, true)
            .unwrap();
        assert_eq!(result["status"], "EXACT");
        assert_eq!(result["label"], 3);
        assert_eq!(result["certificateApplies"], false);
        for day in 0..7 {
            assert_eq!(result["perDay"][day]["crossing"], day >= 2);
        }
        assert_eq!(result["perDay"][2]["crossingUnits"], json!([[1, 0, 1]]));
        assert_eq!(
            result["perDay"][2]["supportUnits"],
            json!([[0, 0, 1], [1, 0, 1]])
        );
    }

    #[test]
    fn compensation_is_floored_and_probability_equality_is_not_a_crossing() {
        let mut e = engine([q(1, 1), q(1, 1), q(1, 1)]);
        let laws = json!([{"id":"rate","kind":"finite","outcomes":[
            {"pieces":[9,0,0],"mass":wire(&q(1,2))},
            {"pieces":[10,0,0],"mass":wire(&q(1,2))}
        ]}]);
        let mut s = source("rate", arrival(3, "deterministic:10,0,0"), laws);
        e.current(597, [0, 0, 10], 10).unwrap();
        let first = e
            .minimum_wait_probe(&mut s, 597, [0, 0, 10], 2, 1, true)
            .unwrap();
        assert_eq!(first["label"], 3);
        let mut enough = source(
            "deterministic:10,0,0",
            arrival(3, "deterministic:10,0,0"),
            json!([]),
        );
        let second = e
            .minimum_wait_probe(&mut enough, 597, [0, 0, 10], 2, 1, true)
            .unwrap();
        assert_eq!(second["label"], "7+");
    }

    #[test]
    fn diagnostic_supports_are_uncapped_and_bound_to_the_current_request() {
        let mut e = engine([q(1, 1), q(1, 1), q(1, 1)]);
        let mut s = source(
            "deterministic:1,0,0",
            arrival(1, "deterministic:40,0,0"),
            json!([]),
        );
        e.current(597, [0, 0, 10], 10).unwrap();
        assert_eq!(
            e.minimum_wait_probe(&mut s, 597, [10, 0, 10], 2, 1, true)
                .err(),
            Some("minimum_wait_current_binding_mismatch")
        );
        let result = e
            .minimum_wait_probe(&mut s, 597, [0, 0, 10], 2, 1, true)
            .unwrap();
        assert_eq!(result["status"], "EXACT");
        assert_eq!(result["classifierCaps"], json!([3, 3, 3]));
        assert_eq!(result["supportUnitsCapped"], false);
        assert_eq!(result["perDay"][0]["supportUnits"], json!([[4, 0, 1]]));
    }

    #[test]
    fn support_and_deadline_guards_produce_unknown_not_beyond_horizon() {
        let mut e = engine([q(1, 1), q(1, 1), q(1, 1)]);
        e.current(597, [0, 0, 10], 10).unwrap();
        e.max_support = 1;
        let laws = json!([{"id":"two","kind":"finite","outcomes":[
            {"pieces":[0,0,0],"mass":wire(&q(1,2))},
            {"pieces":[10,0,0],"mass":wire(&q(1,2))}
        ]}]);
        let mut s = source("deterministic:1,0,0", arrival(2, "two"), laws);
        let result = e.minimum_wait(&mut s, 597, [0, 0, 10], true).unwrap();
        assert_eq!(result["minimumWait"]["status"], "unknown");
        assert_eq!(result["minimumWait"]["reason"], "exact_support_limit");
        assert_eq!(result["minimumWait"]["earliestPossibleDay"], 2);
        assert!(result["minimumWait"]["minimumDays"].is_null());
        e.deadline = 0.0;
        let result = e.minimum_wait(&mut s, 597, [0, 0, 10], true).unwrap();
        assert_eq!(result["minimumWait"]["status"], "unknown");
    }

    #[test]
    fn mixed_loss_rate_ignores_the_personal_posterior() {
        let law = json!([{"id":"rate","kind":"finite","outcomesByCohort":[
            [{"pieces":[7,0,0],"mass":wire(&q(1,1))}],
            [{"pieces":[14,0,0],"mass":wire(&q(1,1))}],
            [{"pieces":[21,0,0],"mass":wire(&q(1,1))}],
            [{"pieces":[28,0,0],"mass":wire(&q(1,1))}]
        ]}]);
        let mut s = source("rate", json!([]), law);
        assert_eq!(
            s.pricing([1; 3], [0; 3], TERMINAL).unwrap().0,
            [q(7, 1), q(0, 1), q(0, 1)]
        );
        assert_eq!(
            s.minimum_wait_rates().unwrap(),
            [q(18, 1), q(0, 1), q(0, 1)]
        );
    }

    #[test]
    fn wait_tie_selection_requires_exact_p_b_c_and_updates_the_selected_vector() {
        let mut e = engine([q(1, 1), q(1, 1), q(1, 1)]);
        let before = e.current(599, [10, 10, 0], 10).unwrap();
        assert_eq!(before["kit"], "blue");
        assert_eq!(before["optimalActionMask"], 3);
        let mut s = source("deterministic:0,10,0", json!([]), json!([]));
        let after = e.minimum_wait(&mut s, 599, [10, 10, 0], true).unwrap();
        assert_eq!(after["current"]["kit"], "purple");
        assert_eq!(after["minimumWait"]["status"], "beyond_horizon");
        assert_eq!(
            after["current"]["value"]["consumed"][1],
            json!(wire(&q(10, 1)))
        );
        for field in ["p", "b", "c"] {
            assert_eq!(after["current"]["value"][field], before["value"][field]);
        }
        let mut different = engine([q(1, 1), q(2, 1), q(1, 1)]);
        different.current(599, [10, 10, 0], 10).unwrap();
        let chosen = different
            .minimum_wait(&mut s, 599, [10, 10, 0], true)
            .unwrap();
        assert_eq!(chosen["current"]["kit"], "blue");
    }

    #[test]
    fn equal_probability_and_burden_do_not_override_a_strict_consumption_order() {
        let original = engine([q(1, 1), q(2, 1), q(1, 1)]);
        let mut edges = original.edges;
        edges[598][0] = [1000, 600, 600];
        let mut e = Engine::new(Init {
            edges,
            caps: original.caps,
            weights: [wire(&q(1, 1)), wire(&q(2, 1)), wire(&q(1, 1))],
            deadline_at: f64::MAX,
            max_memo_entries: 10_000,
            max_support_points: 25_000,
        })
        .unwrap();
        let before = e.current(597, [20, 10, 0], 10).unwrap();
        assert_eq!(before["kit"], "purple");
        assert_eq!(before["optimalActionMask"], 2);
        let mut supply = source("deterministic:20,0,0", json!([]), json!([]));
        let after = e.minimum_wait(&mut supply, 597, [20, 10, 0], true).unwrap();
        assert_eq!(after["current"]["kit"], "purple");
    }
}
