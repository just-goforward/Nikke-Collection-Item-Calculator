use super::*;

impl Supply {
    pub(super) fn expected(&mut self, refs: &[LawRef], priors: &[Q]) -> Result<[Q; 3]> {
        let mut gain = std::array::from_fn(|_| Q::zero());
        for r in refs {
            if r.count == 0 {
                continue;
            }
            for (cohort, prior) in priors.iter().enumerate() {
                self.check()?;
                if prior.is_zero() {
                    continue;
                }
                let values =
                    if r.law_id == "dispatch-board-v1" && self.finite_law(&r.law_id).is_none() {
                        let row = &self.model.dispatch_expected[cohort];
                        [row[0].rational()?, row[1].rational()?, row[2].rational()?]
                    } else {
                        let rows = self.law(
                            &LawRef {
                                law_id: r.law_id.clone(),
                                count: 1,
                            },
                            cohort,
                        )?;
                        std::array::from_fn(|k| {
                            rows.iter()
                                .map(|o| &o.mass * Q::from_integer(o.pieces[k].into()))
                                .sum()
                        })
                    };
                for k in 0..3 {
                    gain[k] += prior * &values[k] * Q::from_integer(r.count.into());
                }
            }
        }
        Ok(gain)
    }
    fn recurring_rates(&mut self, priors: &[Q]) -> Result<[Q; 3]> {
        let dispatch = self.expected(&self.model.dispatch.clone(), priors)?;
        let shop = self.expected(&self.model.shop.clone(), priors)?;
        let solo = self.expected(&self.model.solo.clone(), priors)?;
        let cadence = self.model.cadence.rational()?;
        if cadence <= Q::zero() {
            return Err("invalid_cadence");
        }
        Ok(std::array::from_fn(|k| {
            &dispatch[k] + &shop[k] / Q::from_integer(7.into()) + &solo[k] / &cadence
        }))
    }

    pub fn minimum_wait_rates(&mut self) -> Result<[Q; 3]> {
        if self.priors.len() != 4 {
            return Err("minimum_wait_requires_four_cohorts");
        }
        self.recurring_rates(&self.population_prior.clone())
    }

    pub fn pricing(&mut self, basis: Units, stock: Units, sid: usize) -> Result<([Q; 3], [Q; 3])> {
        let rates = self.recurring_rates(&self.priors.clone())?;
        let mut weights = std::array::from_fn(|_| Q::zero());
        for k in 0..3 {
            let denominator = &rates[k] + Q::from_integer(basis[k].into());
            if denominator.is_zero() {
                let mut usable = sid < TERMINAL && stock[k] >= 10;
                if sid < TERMINAL && !usable {
                    for cohort in 0..self.priors.len() {
                        if self.priors[cohort].is_zero() {
                            continue;
                        }
                        let mut reachable = stock[k] as u64;
                        for event in self.model.events.clone() {
                            for r in event.refs {
                                let law = self.law(&r, cohort)?;
                                reachable = reachable.saturating_add(
                                    law.iter()
                                        .filter(|r| r.mass > Q::zero())
                                        .map(|r| r.pieces[k])
                                        .max()
                                        .unwrap_or(0),
                                );
                                if reachable >= 10 {
                                    usable = true;
                                    break;
                                }
                            }
                            if usable {
                                break;
                            }
                        }
                        if usable {
                            break;
                        }
                    }
                }
                if usable {
                    return Err([
                        "zero_basis_future_usable_blue",
                        "zero_basis_future_usable_purple",
                        "zero_basis_future_usable_yellow",
                    ][k]);
                }
            } else {
                weights[k] = denominator.recip();
            }
        }
        Ok((rates, weights))
    }
}
