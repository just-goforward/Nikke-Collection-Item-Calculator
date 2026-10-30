//! Opt-in experimental summaries of already evaluated waiting endpoints.
//! No receipt distribution, solver, or re-wait policy is constructed here.
use super::*;

pub(super) const HORIZON: usize = 14;
const DAYS: usize = HORIZON + 1;

pub(super) fn check_deadline(deadline: f64) -> Result<()> {
    if now() >= deadline {
        Err("request_budget_exhausted")
    } else {
        Ok(())
    }
}

pub(super) fn nonnegative_mass(mass: &Q) -> Result<()> {
    if mass < &Q::zero() {
        Err("invalid_risk_summary_mass")
    } else {
        Ok(())
    }
}

fn probability(q: &Q) -> Result<()> {
    if q < &Q::zero() || q > &Q::one() {
        Err("invalid_risk_summary_probability")
    } else {
        Ok(())
    }
}

pub(super) fn validate_priors(priors: &[Q], deadline: f64) -> Result<()> {
    let mut total = Q::zero();
    for prior in priors {
        check_deadline(deadline)?;
        nonnegative_mass(prior)?;
        total += prior;
    }
    if total != Q::one() {
        return Err("invalid_risk_summary_mass");
    }
    Ok(())
}

struct Thresholds {
    insufficient: [Q; DAYS],
    certified: Q,
}

impl Thresholds {
    fn new(p0: &Q) -> Result<Self> {
        probability(p0)?;
        Ok(Self {
            // q - P0 - day/400 <= 1/200, including exact equality.
            insufficient: std::array::from_fn(|day| {
                p0 + Q::new(BigInt::from(day + 2), BigInt::from(400))
            }),
            certified: Q::new(397.into(), 400.into()),
        })
    }
}

/// Scalar threshold totals, not a second endpoint/receipt distribution.
/// Precomputing all fifteen thresholds lets empty dates reuse the completed
/// support without re-solving endpoints, copying rows, or rescanning supports.
pub(super) struct Accumulator<'a> {
    thresholds: &'a Thresholds,
    total: Q,
    insufficient_deltas: [Q; DAYS],
    certified: Q,
}

impl<'a> Accumulator<'a> {
    fn new(thresholds: &'a Thresholds) -> Self {
        Self {
            thresholds,
            total: Q::zero(),
            insufficient_deltas: std::array::from_fn(|_| Q::zero()),
            certified: Q::zero(),
        }
    }

    pub(super) fn observe(&mut self, mass: &Q, q: &Q) -> Result<()> {
        nonnegative_mass(mass)?;
        // Zero mass does not exempt an evaluated endpoint from validation.
        probability(q)?;
        self.total += mass;
        let first = self.thresholds.insufficient.partition_point(|threshold| threshold < q);
        if first < DAYS {
            self.insufficient_deltas[first] += mass;
        }
        if q >= &self.thresholds.certified {
            self.certified += mass;
        }
        Ok(())
    }

    pub(super) fn finish(mut self, deadline: f64) -> Result<Masses> {
        check_deadline(deadline)?;
        if self.total != Q::one() {
            return Err("invalid_risk_summary_mass");
        }
        for day in 1..DAYS {
            let (before, after) = self.insufficient_deltas.split_at_mut(day);
            after[0] += &before[day - 1];
        }
        check_deadline(deadline)?;
        Ok(Masses {
            insufficient: self.insufficient_deltas,
            certified: self.certified,
        })
    }
}

pub(super) struct Masses {
    insufficient: [Q; DAYS],
    certified: Q,
}

pub(super) struct Summaries {
    thresholds: Thresholds,
    masses: Masses,
    records: Vec<Json>,
}

impl Summaries {
    pub(super) fn new(p0: &Q, deadline: f64) -> Result<Self> {
        check_deadline(deadline)?;
        let thresholds = Thresholds::new(p0)?;
        let mut accumulator = Accumulator::new(&thresholds);
        // D0 is the actual completed canonical current, a singleton of mass 1.
        accumulator.observe(&Q::one(), p0)?;
        let masses = accumulator.finish(deadline)?;
        let mut records = Vec::new();
        records
            .try_reserve_exact(DAYS)
            .map_err(|_| "managed_payload_ceiling")?;
        let mut result = Self { thresholds, masses, records };
        result.complete_date(0, p0, None, deadline)?;
        Ok(result)
    }

    pub(super) fn accumulator(&self) -> Accumulator<'_> {
        Accumulator::new(&self.thresholds)
    }

    pub(super) fn complete_date(
        &mut self,
        day: usize,
        mean: &Q,
        masses: Option<Masses>,
        deadline: f64,
    ) -> Result<()> {
        check_deadline(deadline)?;
        if day != self.records.len() || day > HORIZON {
            return Err("invalid_risk_summary_date");
        }
        probability(mean)?;
        let completed = masses.as_ref().unwrap_or(&self.masses);
        let record = json!({
            "day":day,
            "meanSuccessP":wire(mean),
            "insufficientGainMass":wire(&completed.insufficient[day]),
            "noFurtherWaitCertifiedMass":wire(&completed.certified),
            // This complement is only an upper bound, never actual re-wait.
            "renewedWaitUpperBound":wire(&(Q::one() - &completed.certified))
        });
        check_deadline(deadline)?;
        // Commit the whole date together, only after all validation/generation.
        if let Some(masses) = masses {
            self.masses = masses;
        }
        self.records.push(record);
        Ok(())
    }
}

pub(super) fn attach(
    mut result: Json,
    summaries: Option<Summaries>,
    deadline: f64,
) -> Result<Json> {
    if let Some(summaries) = summaries {
        check_deadline(deadline)?;
        result["riskSummaries"] = json!({
            "schemaVersion":1,
            "policyVersion":"experimental-w-selector-v1",
            "horizonDays":HORIZON,
            "records":[]
        });
        result["riskSummaries"]["records"] = Json::Array(summaries.records);
        check_deadline(deadline)?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(n: i64, d: i64) -> Q {
        Q::new(n.into(), d.into())
    }

    fn masses(p0: &Q, points: &[(Q, Q)]) -> Result<Masses> {
        let thresholds = Thresholds::new(p0)?;
        let mut accumulator = Accumulator::new(&thresholds);
        for (mass, p) in points {
            accumulator.observe(mass, p)?;
        }
        accumulator.finish(f64::MAX)
    }

    #[test]
    fn exact_inclusive_boundaries_for_every_day_and_certification_threshold() {
        let p0 = q(1, 2);
        for day in 0..=HORIZON {
            let threshold = &p0 + q(day as i64 + 2, 400);
            for (offset, expected) in [(-1, Q::one()), (0, Q::one()), (1, Q::zero())] {
                let result = masses(&p0, &[(Q::one(), &threshold + q(offset, 40000))]).unwrap();
                assert_eq!(result.insufficient[day], expected);
            }
        }
        for (n, expected) in [(39699, Q::zero()), (39700, Q::one()), (39701, Q::one())] {
            assert_eq!(
                masses(&Q::zero(), &[(Q::one(), q(n, 40000))]).unwrap().certified,
                expected
            );
        }
    }

    #[test]
    fn invalid_mass_probability_and_zero_mass_are_never_renormalized() {
        for points in [
            vec![],
            vec![(q(1, 2), Q::one())],
            vec![(q(3, 2), Q::one())],
            vec![(q(-1, 2), Q::zero()), (q(3, 2), Q::one())],
        ] {
            assert_eq!(masses(&Q::zero(), &points).err(), Some("invalid_risk_summary_mass"));
        }
        for p in [q(-1, 100), q(101, 100)] {
            for mass in [Q::zero(), Q::one()] {
                assert_eq!(
                    masses(&Q::zero(), &[(mass, p.clone())]).err(),
                    Some("invalid_risk_summary_probability")
                );
            }
            assert!(Thresholds::new(&p).is_err());
        }
        let valid = masses(
            &Q::zero(),
            &[(Q::zero(), Q::zero()), (Q::one(), Q::one()), (Q::zero(), Q::one())],
        ).unwrap();
        assert_eq!(valid.certified, Q::one());
        assert!(valid.insufficient.iter().all(Q::is_zero));
    }

    #[test]
    fn equal_means_do_not_imply_equal_risk_and_mean_one_is_not_unconditional() {
        let mixed = masses(&q(1, 2), &[(q(1, 2), Q::zero()), (q(1, 2), Q::one())]).unwrap();
        let constant = masses(&q(1, 2), &[(Q::one(), q(1, 2))]).unwrap();
        assert_eq!(mixed.insufficient[0], q(1, 2));
        assert_eq!(mixed.certified, q(1, 2));
        assert_eq!(constant.insufficient[0], Q::one());
        assert_eq!(constant.certified, Q::zero());
        // Mean one with W > delta gives both insufficiency and upper bound zero.
        let full = masses(&Q::zero(), &[(q(1, 3), Q::one()), (q(2, 3), Q::one())]).unwrap();
        assert!(full.insufficient.iter().all(Q::is_zero));
        assert_eq!(Q::one() - full.certified, Q::zero());
        // At D0 with P0=1, W=0; insufficiency must instead be one.
        assert_eq!(
            masses(&Q::one(), &[(Q::one(), Q::one())]).unwrap().insufficient[0],
            Q::one()
        );
    }

    #[test]
    fn unchanged_support_uses_each_dates_threshold_without_rescanning() {
        let mut summary = Summaries::new(&q(49, 100), f64::MAX).unwrap();
        let mut accumulator = summary.accumulator();
        accumulator.observe(&Q::one(), &q(1, 2)).unwrap();
        let mass = accumulator.finish(f64::MAX).unwrap();
        summary.complete_date(1, &q(1, 2), Some(mass), f64::MAX).unwrap();
        summary.complete_date(2, &q(1, 2), None, f64::MAX).unwrap();
        assert_eq!(summary.records[1]["insufficientGainMass"], json!(wire(&Q::zero())));
        assert_eq!(summary.records[2]["insufficientGainMass"], json!(wire(&Q::one())));
    }

    #[test]
    fn interruption_before_summary_commit_keeps_prior_records_and_no_failed_date() {
        let mut summary = Summaries::new(&Q::zero(), f64::MAX).unwrap();
        let prior = summary.records.clone();
        let mut accumulator = summary.accumulator();
        accumulator.observe(&Q::one(), &Q::one()).unwrap();
        assert_eq!(accumulator.finish(-1.0).err(), Some("request_budget_exhausted"));
        assert_eq!(
            summary.complete_date(1, &Q::one(), None, -1.0),
            Err("request_budget_exhausted")
        );
        assert_eq!(summary.records, prior);
        assert!(Summaries::new(&Q::zero(), -1.0).is_err());
        assert!(attach(json!({}), Some(summary), -1.0).is_err());
    }
}
