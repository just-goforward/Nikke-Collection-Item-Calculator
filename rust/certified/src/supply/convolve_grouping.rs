//! E only: same-left-row, same-output-slot RHS sums within existing guard windows.
//! There is no unit shortcut, cross-row grouping, or change to C's preparation.
use super::*;

#[derive(Clone, Copy)]
pub(super) struct Bounds {
    pub lengths: [usize; 2],
    pub projection_limit: usize,
    pub caps: Pieces,
    pub denominator_bits: [u64; 2],
    pub excess_bits: [u64; 2],
}

pub(super) struct Plan {
    pub slots: usize,
    pub g: usize,
    pub q: usize,
    pub scratch_bytes: usize,
    pub c_bytes: usize,
    pub total_bytes: usize,
}

impl Plan {
    pub(super) fn new(bounds: Bounds) -> Option<Self> {
        let Bounds { lengths, projection_limit, caps, denominator_bits, excess_bits } = bounds;
        let c_bytes = convolve_capped_workspace_bytes(
            lengths, projection_limit, caps, denominator_bits, excess_bits,
        )?;
        let rows = convolve_cap_volume(caps)
            .map_or(projection_limit, |volume| projection_limit.min(volume));
        let slots = lengths[0].checked_mul(lengths[1])?.min(rows);
        // q is contributions, NOT distinct groups. Even g=1 can sum q=32
        // coefficients. First/last partial windows and right-zero skips can
        // only lower q. Output mapping size is independently bounded by slots.
        let q = lengths[1].min(32);
        let g = slots.min(q);
        let rhs_bits = denominator_bits[1].checked_add(excess_bits[1])?;
        let sum_bits = rhs_bits.checked_add(
            (usize::BITS - q.saturating_sub(1).leading_zeros()) as u64,
        )?;
        let sum_bytes = convolve_integer_bytes(sum_bits)?;
        let scratch_bytes = slots
            .checked_mul(std::mem::size_of::<usize>())?
            .checked_add(g.checked_mul(
                std::mem::size_of::<Group>().checked_add(sum_bytes)?,
            )?)?;
        let total_bytes = c_bytes.checked_add(scratch_bytes)?;
        Some(Self { slots, g, q, scratch_bytes, c_bytes, total_bytes })
    }
}

struct Group {
    slot: usize,
    first_rhs: usize,
    sum: Option<BigUint>,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ForcedFailure {
    Checked,
    Admission,
    ReserveMapping,
    ReservePool,
}

pub(super) struct Scratch {
    // This array indexes every possible output SLOT, not every live group.
    slot_to_group: Vec<usize>,
    // Only min(slots, q) groups can be live. Flush drains their owned sums.
    pool: Vec<Group>,
    #[cfg(test)]
    contributions: usize,
}

fn rejected(status: u64) {
    let _ = status;
}

impl Scratch {
    pub(super) fn prepare(supply: &Supply, bounds: Bounds) -> Option<Self> {
        #[cfg(test)]
        if supply.convolve_scratch_failure == Some(ForcedFailure::Checked) {
            rejected(2);
            return None;
        }
        let Some(plan) = Plan::new(bounds) else {
            rejected(2);
            return None;
        };
        #[cfg(test)]
        if supply.convolve_scratch_failure == Some(ForcedFailure::Admission) {
            rejected(3);
            return None;
        }
        // Retain all of C's conservative workspace allowance in addition to E.
        // Prepared C inputs are already live, making this extra admission more
        // conservative, never weakening C's admission or the allocator ceiling.
        if !supply.convolve_admit(Some(plan.total_bytes)) {
            rejected(3);
            return None;
        }
        let mut scratch = Self {
            slot_to_group: Vec::new(),
            pool: Vec::new(),
            #[cfg(test)]
            contributions: 0,
        };
        let mapping_capacity = plan.slots;
        let pool_capacity = plan.g;
        // Real recoverable Vec capacity errors, including a failure AFTER the
        // mapping allocation, exercise automatic destruction of partial scratch.
        #[cfg(test)]
        let mapping_capacity = if supply.convolve_scratch_failure
            == Some(ForcedFailure::ReserveMapping) { usize::MAX } else { mapping_capacity };
        #[cfg(test)]
        let pool_capacity = if supply.convolve_scratch_failure
            == Some(ForcedFailure::ReservePool) { usize::MAX } else { pool_capacity };
        if scratch.slot_to_group.try_reserve_exact(mapping_capacity).is_err()
            || scratch.pool.try_reserve_exact(pool_capacity).is_err()
        {
            rejected(4);
            return None;
        }
        scratch.slot_to_group.resize(plan.slots, usize::MAX);
        Some(scratch)
    }

    pub(super) fn push(&mut self, slot: usize, rhs: usize, right: &[BigUint]) {
        let group = self.slot_to_group[slot];
        if group == usize::MAX {
            self.slot_to_group[slot] = self.pool.len();
            self.pool.push(Group { slot, first_rhs: rhs, sum: None });
        } else {
            let group = &mut self.pool[group];
            if let Some(sum) = &mut group.sum {
                *sum += &right[rhs];
            } else {
                // First contribution owns only an index. The second is the
                // FIRST creation of an owned sum, from fresh scaled C integers.
                // num-bigint 0.4.8 addition.rs: Add<&BigUint>/AddAssign<&BigUint>;
                // macros.rs forwards borrowed+borrowed via a clone. Subsequent
                // sums are nondecreasing; BigDigits uses Vec growth plus carry.
                group.sum = Some(&right[group.first_rhs] + &right[rhs]);
            }
        }
        #[cfg(test)]
        { self.contributions += 1; }
    }

    #[cfg(test)]
    pub(super) fn pending(&self) -> (usize, usize) {
        (self.contributions, self.pool.len())
    }

    pub(super) fn flush(
        &mut self,
        left: &BigUint,
        right: &[BigUint],
        out: &mut [(Pieces, BigUint)],
    ) {
        for group in self.pool.drain(..) {
            let rhs = group.sum.as_ref().unwrap_or(&right[group.first_rhs]);
            out[group.slot].1 += left * rhs;
            self.slot_to_group[group.slot] = usize::MAX;
        }
        #[cfg(test)]
        { self.contributions = 0; }
        // No partial flush is counted (including an allocation trap). These
        // counters describe completed arithmetic, not published request success.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_rhs_is_borrowed_until_second_and_flush_clears_only_active_slots() {
        let mut source = super::super::tests::source(json!([]));
        source.deadline = f64::MAX;
        let bounds = Bounds {
            lengths: [2, 64], projection_limit: 100, caps: [u64::MAX; 3],
            denominator_bits: [1, 128], excess_bits: [0, 0],
        };
        let mut scratch = Scratch::prepare(&source, bounds).unwrap();
        assert_eq!(scratch.slot_to_group.len(), 100);
        let right = vec![(BigUint::one() << 127usize) - BigUint::one(); 3];
        scratch.push(77, 0, &right);
        assert!(scratch.pool[0].sum.is_none());
        assert_eq!(scratch.pool[0].first_rhs, 0);
        scratch.push(77, 1, &right);
        assert_eq!(scratch.pool[0].sum.as_ref().unwrap(), &(&right[0] * 2u32));
        scratch.push(77, 2, &right);
        assert_eq!(scratch.pending(), (3, 1));
        let mut out = vec![([0; 3], BigUint::zero()); 100];
        scratch.flush(&BigUint::from(7u32), &right, &mut out);
        assert_eq!(out[77].1, &right[0] * 21u32);
        assert_eq!(scratch.pending(), (0, 0));
        assert!(scratch.slot_to_group.iter().all(|&entry| entry == usize::MAX));
        scratch.push(77, 2, &right);
        assert!(scratch.pool[0].sum.is_none());
    }
}
