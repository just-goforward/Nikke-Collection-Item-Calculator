//! Exact support reachability for the seven-day minimum-wait classifier.
//! Port of the approved research bitset shift/union. Cohorts stay separate
//! across receipts; only their final supports are unioned. Probabilities are
//! irrelevant here, but zero-mass outcomes must have been removed by Supply.
use super::{supply::Pieces, Result, Units};
use std::rc::Rc;

struct Grid {
    max: Units,
    words_z: usize,
    bits: Vec<u64>,
}

impl Grid {
    fn new(max: Units) -> Result<Self> {
        let words_z = max[2].checked_add(64).ok_or("minimum_wait_grid_overflow")? / 64;
        let words = max[0]
            .checked_add(1)
            .and_then(|x| max[1].checked_add(1).and_then(|y| x.checked_mul(y)))
            .and_then(|xy| xy.checked_mul(words_z))
            .ok_or("minimum_wait_grid_overflow")?;
        let bytes = words
            .checked_mul(std::mem::size_of::<u64>())
            .ok_or("minimum_wait_grid_overflow")?;
        #[cfg(target_arch = "wasm32")]
        if !super::allocation::can_admit(bytes) {
            return Err("managed_payload_ceiling");
        }
        // try_reserve converts an allocator refusal to UNKNOWN at the caller,
        // rather than allowing a guessed result or an unchecked allocation.
        let mut bits = Vec::new();
        bits.try_reserve_exact(bytes / std::mem::size_of::<u64>())
            .map_err(|_| "managed_payload_ceiling")?;
        bits.resize(words, 0);
        Ok(Self { max, words_z, bits })
    }

    fn row(&self, x: usize, y: usize) -> usize {
        (x * (self.max[1] + 1) + y) * self.words_z
    }

    fn set(&mut self, point: Units) {
        let offset = self.row(point[0], point[1]) + point[2] / 64;
        self.bits[offset] |= 1u64 << (point[2] % 64);
    }

    fn shift_union(
        &self,
        law: &[Pieces],
        cap: Units,
        check: &mut impl FnMut() -> Result<()>,
    ) -> Result<Self> {
        let mut max = self.max;
        for (axis, bound) in max.iter_mut().enumerate() {
            let gain = law
                .iter()
                .map(|p| p[axis])
                .max()
                .ok_or("minimum_wait_empty_support")?;
            *bound = bound
                .saturating_add(gain.min(cap[axis] as u64) as usize)
                .min(cap[axis]);
        }
        let mut out = Self::new(max)?;
        for gain in law {
            let gain: Units = std::array::from_fn(|axis| gain[axis].min(cap[axis] as u64) as usize);
            for x in 0..=self.max[0] {
                check()?;
                let dx = x.saturating_add(gain[0]).min(max[0]);
                for y in 0..=self.max[1] {
                    let source = self.row(x, y);
                    let destination = out.row(dx, y.saturating_add(gain[1]).min(max[1]));
                    for z in 0..self.words_z {
                        let value = self.bits[source + z];
                        if value == 0 {
                            continue;
                        }
                        let at = z + gain[2] / 64;
                        let shift = gain[2] % 64;
                        if at < out.words_z {
                            out.bits[destination + at] |= value << shift;
                        }
                        if shift > 0 && at + 1 < out.words_z {
                            out.bits[destination + at + 1] |= value >> (64 - shift);
                        }
                        let threshold = match max[2]
                            .checked_sub(z * 64)
                            .and_then(|n| n.checked_sub(gain[2]))
                        {
                            Some(remaining) if remaining < 63 => remaining + 1,
                            Some(_) => 64,
                            None => 0,
                        };
                        if threshold < 64 && value >> threshold != 0 {
                            out.bits[destination + max[2] / 64] |= 1u64 << (max[2] % 64);
                        }
                    }
                }
            }
        }
        let valid = (max[2] + 1) % 64;
        if valid != 0 {
            let mask = (1u64 << valid) - 1;
            for row in out.bits.chunks_exact_mut(out.words_z) {
                row[out.words_z - 1] &= mask;
            }
        }
        Ok(out)
    }

    fn visit(
        &self,
        check: &mut impl FnMut() -> Result<()>,
        mut visit: impl FnMut(Units),
    ) -> Result<()> {
        for (offset, &word) in self.bits.iter().enumerate() {
            check()?;
            let row = offset / self.words_z;
            let x = row / (self.max[1] + 1);
            let y = row % (self.max[1] + 1);
            let z = (offset % self.words_z) * 64;
            let mut bits = word;
            while bits != 0 {
                visit([x, y, z + bits.trailing_zeros() as usize]);
                bits &= bits - 1;
            }
        }
        Ok(())
    }
}

pub(super) struct Reachability {
    stock: Units,
    remaining: Units,
    layers: [Rc<Grid>; 4],
}

impl Reachability {
    pub fn new(stock: Units, caps: Units) -> Result<Self> {
        let stock = std::array::from_fn(|axis| stock[axis].min(caps[axis]));
        // Saturating stock+receipts equals stock plus receipts saturated at the
        // remaining cap. Keeping stock as an offset avoids allocating empty
        // grid prefixes, without dropping remainders or changing any support.
        let remaining = std::array::from_fn(|axis| caps[axis] - stock[axis]);
        let mut initial = Grid::new([0; 3])?;
        initial.set([0; 3]);
        let initial = Rc::new(initial);
        Ok(Self {
            stock,
            remaining,
            layers: std::array::from_fn(|_| Rc::clone(&initial)),
        })
    }

    pub fn advance(
        &mut self,
        supports: &[Vec<Pieces>; 4],
        check: &mut impl FnMut() -> Result<()>,
    ) -> Result<()> {
        let previous = self.layers.clone();
        let mut next = previous.clone();
        for (cohort, layer) in previous.iter().enumerate() {
            check()?;
            let equal = (0..cohort).find(|&other| {
                Rc::ptr_eq(layer, &previous[other]) && supports[cohort] == supports[other]
            });
            next[cohort] = if let Some(other) = equal {
                Rc::clone(&next[other])
            } else {
                Rc::new(layer.shift_union(&supports[cohort], self.remaining, check)?)
            };
        }
        self.layers = next;
        Ok(())
    }

    pub fn units(
        &self,
        limit: usize,
        check: &mut impl FnMut() -> Result<()>,
    ) -> Result<Vec<Units>> {
        let max = std::array::from_fn(|axis| {
            (self.stock[axis]
                + self
                    .layers
                    .iter()
                    .map(|layer| layer.max[axis])
                    .max()
                    .unwrap())
                / 10
        });
        let mut union = Grid::new(max)?;
        for (cohort, layer) in self.layers.iter().enumerate() {
            if self.layers[..cohort]
                .iter()
                .any(|other| Rc::ptr_eq(layer, other))
            {
                continue;
            }
            layer.visit(check, |point| {
                union.set(std::array::from_fn(|axis| {
                    (self.stock[axis] + point[axis]) / 10
                }));
            })?;
        }
        let count: usize = union
            .bits
            .iter()
            .map(|word| word.count_ones() as usize)
            .sum();
        if count > limit {
            return Err("exact_support_limit");
        }
        let mut rows = Vec::new();
        rows.try_reserve_exact(count)
            .map_err(|_| "managed_payload_ceiling")?;
        union.visit(check, |point| rows.push(point))?;
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn shifts_match_explicit_saturating_support_at_word_edges() {
        for cap in [[3, 4, 5], [2, 2, 63], [2, 2, 64], [2, 2, 65], [3, 3, 127]] {
            let law = vec![[0, 0, 0], [1, 2, 1], [0, 1, 63], [2, 0, 65]];
            let mut expected = BTreeSet::from([[0; 3]]);
            let mut grid = Grid::new([0; 3]).unwrap();
            grid.set([0; 3]);
            for _ in 0..3 {
                expected = expected
                    .iter()
                    .flat_map(|point| {
                        law.iter().map(move |gain| {
                            std::array::from_fn(|axis| {
                                (point[axis] + gain[axis] as usize).min(cap[axis])
                            })
                        })
                    })
                    .collect();
                grid = grid.shift_union(&law, cap, &mut || Ok(())).unwrap();
                let mut actual = BTreeSet::new();
                grid.visit(&mut || Ok(()), |point| {
                    actual.insert(point);
                })
                .unwrap();
                assert_eq!(actual, expected);
            }
        }
    }

    #[test]
    fn keeps_latent_cohorts_separate_across_receipts() {
        let mut reach = Reachability::new([9, 0, 0], [30, 30, 30]).unwrap();
        let supports = [
            vec![[10, 0, 0]],
            vec![[0, 10, 0]],
            vec![[0, 0, 10]],
            vec![[0, 0, 0]],
        ];
        reach.advance(&supports, &mut || Ok(())).unwrap();
        reach.advance(&supports, &mut || Ok(())).unwrap();
        assert_eq!(
            reach.units(25_000, &mut || Ok(())).unwrap(),
            vec![[0, 0, 0], [0, 0, 2], [0, 2, 0], [2, 0, 0]]
        );
        assert_eq!(
            reach.units(1, &mut || Ok(())).err(),
            Some("exact_support_limit")
        );
    }

    #[test]
    fn projects_only_after_adding_raw_stock_and_receipts() {
        let mut reach = Reachability::new([9, 0, 0], [30; 3]).unwrap();
        let supports = std::array::from_fn(|_| vec![[1, 0, 0]]);
        reach.advance(&supports, &mut || Ok(())).unwrap();
        assert_eq!(
            reach.units(25_000, &mut || Ok(())).unwrap(),
            vec![[1, 0, 0]]
        );
    }

    #[test]
    fn checks_budget_and_clamps_large_raw_receipts_without_truncation() {
        let mut reach = Reachability::new([100_000; 3], [20; 3]).unwrap();
        let supports = std::array::from_fn(|_| vec![[u64::MAX; 3]]);
        assert_eq!(
            reach
                .advance(&supports, &mut || Err("request_budget_exhausted"))
                .err(),
            Some("request_budget_exhausted")
        );
        reach.advance(&supports, &mut || Ok(())).unwrap();
        assert_eq!(reach.units(1, &mut || Ok(())).unwrap(), vec![[2; 3]]);
    }
}
