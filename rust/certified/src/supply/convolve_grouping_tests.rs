//! Focused E tests; the original 19 convolve_tests remain unchanged.
use super::convolve_grouping::{Bounds, ForcedFailure, Plan};
use super::*;

fn source() -> Supply {
    tests::source(json!([]))
}
fn outcome(pieces: Pieces, numerator: i64, denominator: i64) -> Outcome {
    Outcome { pieces, mass: Q::new(numerator.into(), denominator.into()) }
}
fn rows(result: Result<Vec<Outcome>>) -> Result<Vec<(Pieces, Q)>> {
    result.map(|rows| rows.into_iter().map(|row| (row.pieces, row.mass)).collect())
}
fn differential(
    a: &[Outcome], b: &[Outcome], caps: Pieces, limit: usize,
    ticks: usize, failure: Option<ForcedFailure>,
) -> Supply {
    let mut grouped = source();
    grouped.ticks = ticks;
    grouped.convolve_scratch_failure = failure;
    let mut oracle = source();
    oracle.ticks = ticks;
    assert_eq!(
        rows(grouped.convolve(a, b, caps, limit)),
        rows(oracle.convolve_rational(a, b, caps, limit)),
    );
    assert_eq!(grouped.ticks, oracle.ticks);
    assert_eq!(grouped.convolve_last_path, Some(ConvolvePath::Fast));
    assert_eq!(grouped.convolve_grouping_active, failure.is_none());
    grouped
}

#[test]
fn e_exact_heterogeneous_nonadjacent_groups_keep_first_slots_and_left_rows_separate() {
    let a = vec![outcome([1, 0, 0], 3, 7), outcome([0, 1, 0], 2, 11)];
    let b = vec![
        outcome([0, 0, 0], 1, 3), outcome([4, 0, 0], 2, 5),
        outcome([0, 0, 0], 3, 13), outcome([9, 0, 0], 5, 17),
    ];
    let mut supply = differential(&a, &b, [2, 1, 0], 4, 0, None);
    let actual = rows(supply.convolve(&a, &b, [2, 1, 0], 4)).unwrap();
    assert_eq!(
        actual,
        vec![
            ([1, 0, 0], Q::new(22.into(), 91.into())),
            ([2, 0, 0], Q::new(177.into(), 595.into())),
            ([0, 1, 0], Q::new(44.into(), 429.into())),
            ([2, 1, 0], Q::new(118.into(), 935.into())),
        ],
    );
}

#[test]
fn e_flushes_before_existing_checks_for_every_entry_alignment_and_at_each_row_end() {
    let a = vec![outcome([0; 3], 1, 1); 3];
    let b = vec![outcome([0; 3], 1, 1); 67];
    for initial in 0..32 {
        let mut supply = source();
        supply.ticks = initial;
        supply.convolve_flush_trace = Some(Vec::new());
        let result = supply.convolve(&a, &b, [0; 3], 1).unwrap();
        assert_eq!(result[0].mass, Q::from_integer(201.into()));
        // Independent schedule: count accepted contributions until a BEFORE
        // boundary or row end, not by reusing the grouping implementation.
        let mut want = Vec::new();
        let mut tick = initial;
        for row in 0..3 {
            let mut pending = 0;
            for _ in 0..67 {
                if (tick + 1) % 32 == 0 && pending > 0 {
                    want.push((tick, row, pending, 1));
                    pending = 0;
                }
                tick += 1;
                pending += 1;
            }
            if pending > 0 { want.push((tick, row, pending, 1)); }
        }
        assert_eq!(supply.convolve_flush_trace.as_ref().unwrap(), &want);
        assert_eq!(supply.ticks, initial + 201);
        assert!(want.iter().all(|&(_, _, m, g)| m <= 32 && g == 1));
    }
}

#[test]
fn e_completed_flush_precedes_a_failing_original_guard_and_does_not_include_failed_pair() {
    for initial in [0, 1, 30, 31, 32, 63] {
        let a = vec![outcome([0; 3], 1, 1)];
        let b = vec![outcome([0; 3], 1, 1); 40];
        let fail_at = (initial / 32 + 1) * 32;
        let mut supply = source();
        supply.ticks = initial;
        supply.convolve_fail_check_at = Some(fail_at);
        supply.convolve_flush_trace = Some(Vec::new());
        let mut oracle = source();
        oracle.ticks = initial;
        oracle.convolve_fail_check_at = Some(fail_at);
        assert_eq!(
            rows(supply.convolve(&a, &b, [0; 3], 1)),
            Err("request_budget_exhausted"),
        );
        assert_eq!(
            rows(oracle.convolve_rational(&a, &b, [0; 3], 1)),
            Err("request_budget_exhausted"),
        );
        assert_eq!(supply.ticks, oracle.ticks);
        let completed = fail_at - initial - 1;
        let expected = if completed == 0 {
            vec![]
        } else {
            vec![(fail_at - 1, 0, completed, 1)]
        };
        assert_eq!(supply.convolve_flush_trace.unwrap(), expected);
    }
}

#[test]
fn e_right_zero_visits_tick_but_skip_invalid_pieces_and_left_zero_retains_support() {
    let a = vec![outcome([0; 3], 0, 1), outcome([1, 0, 0], 2, 3)];
    let mut b = vec![outcome([u64::MAX; 3], 0, 1); 65];
    b[0] = outcome([0; 3], 1, 5);
    b[30] = outcome([2, 0, 0], 1, 7);
    b[32] = outcome([0; 3], 2, 11);
    let mut supply = differential(&a, &b, [2, 0, 0], 3, 1, None);
    let actual = rows(supply.convolve(&a, &b, [2, 0, 0], 3)).unwrap();
    assert_eq!(actual.iter().map(|row| row.0).collect::<Vec<_>>(),
        vec![[0, 0, 0], [2, 0, 0], [1, 0, 0]]);
    assert!(actual[0].1.is_zero());
    let all_zero = vec![outcome([u64::MAX; 3], 0, 1); 65];
    let mut empty = differential(&a, &all_zero, [0; 3], 0, 31, None);
    assert!(empty.convolve(&a, &all_zero, [0; 3], 0).unwrap().is_empty());
}

#[test]
fn e_pending_groups_do_not_move_raw_or_support_errors_past_the_original_pair() {
    let a = vec![outcome([0; 3], 1, 1)];
    for initial in [0, 1, 30, 31] {
        for failing_index in [0, 1, 30, 31, 32, 63] {
            let mut b = vec![outcome([0; 3], 1, 7); 65];
            b[failing_index].pieces = [MAX_SAFE_PIECES + 1, 0, 0];
            let supply = differential(&a, &b, [0; 3], 1, initial, None);
            assert_eq!(supply.ticks, initial + failing_index + 1);
        }
        let mut b = vec![outcome([0; 3], 1, 7); 65];
        b[32].pieces = [1, 0, 0];
        let supply = differential(&a, &b, [1, 0, 0], 1, initial, None);
        assert_eq!(supply.ticks, initial + 33);
    }
}

#[test]
fn e_q_not_g_bounds_carries_and_mapping_storage_is_independent_of_live_groups() {
    let bounds = Bounds {
        lengths: [2, 67], projection_limit: 1, caps: [0; 3],
        denominator_bits: [1, 128], excess_bits: [0, 0],
    };
    let narrow = Plan::new(bounds).unwrap();
    assert_eq!((narrow.slots, narrow.g, narrow.q), (1, 1, 32));
    let wider = Plan::new(Bounds {
        projection_limit: 100, caps: [u64::MAX; 3], ..bounds
    }).unwrap();
    assert_eq!((wider.slots, wider.g, wider.q), (100, 32, 32));
    let widest = Plan::new(Bounds {
        lengths: [10, 67], projection_limit: 600, caps: [u64::MAX; 3], ..bounds
    }).unwrap();
    assert_eq!((widest.slots, widest.g, widest.q), (600, 32, 32));
    assert_eq!(widest.scratch_bytes - wider.scratch_bytes,
        500 * std::mem::size_of::<usize>());
    assert_eq!(narrow.total_bytes, narrow.c_bytes + narrow.scratch_bytes);
    assert!(Plan::new(Bounds { lengths: [usize::MAX, 2], ..bounds }).is_none());
    assert!(Plan::new(Bounds { denominator_bits: [1, u64::MAX], ..bounds }).is_none());
    let n = (BigUint::one() << 128usize) - BigUint::one();
    let a = vec![outcome([0; 3], 7, 3)];
    let b = vec![Outcome { pieces: [0; 3], mass: Q::from_integer(n.clone().into()) }; 67];
    let mut supply = differential(&a, &b, [0; 3], 1, 1, None);
    let actual = supply.convolve(&a, &b, [0; 3], 1).unwrap();
    assert_eq!(actual[0].mass, Q::new((n * 469u32).into(), 3.into()));
}

#[test]
fn e_each_scratch_rejection_uses_prepared_c_without_rational_restart_or_lost_errors() {
    let a = vec![outcome([0; 3], 3, 7), outcome([1, 0, 0], 2, 11)];
    let b = vec![outcome([0; 3], 5, 13); 67];
    for failure in [
        ForcedFailure::Checked, ForcedFailure::Admission,
        ForcedFailure::ReserveMapping, ForcedFailure::ReservePool,
    ] {
        differential(&a, &b, [1, 0, 0], 2, 31, Some(failure));
        differential(&a, &b, [1, 0, 0], 1, 31, Some(failure));
        let mut invalid = b.clone();
        invalid[32].pieces = [MAX_SAFE_PIECES + 1, 0, 0];
        differential(&a, &invalid, [0; 3], 1, 31, Some(failure));
        let mut supply = source();
        supply.convolve_scratch_failure = Some(failure);
        supply.convolve_fail_check_at = Some(32);
        assert_eq!(rows(supply.convolve(&a, &b, [1, 0, 0], 2)),
            Err("request_budget_exhausted"));
        assert_eq!(supply.ticks, 32);
        assert_eq!(supply.convolve_last_path, Some(ConvolvePath::Fast));
        assert!(!supply.convolve_grouping_active);
    }
}

#[test]
fn e_failed_c_preparation_never_activates_scratch() {
    let a = vec![outcome([0; 3], 1, 1)];
    let mut supply = source();
    supply.convolve_force_admission_failure = true;
    supply.convolve_scratch_failure = Some(ForcedFailure::ReservePool);
    assert!(supply.convolve(&a, &a, [0; 3], 1).is_ok());
    assert_eq!(supply.convolve_last_path, Some(ConvolvePath::Rational));
    assert!(!supply.convolve_grouping_active);
    let mut expired = source();
    expired.deadline = 0.0;
    assert_eq!(rows(expired.convolve(&a, &a, [0; 3], 1)),
        Err("request_budget_exhausted"));
    assert_eq!(expired.ticks, 0);
    assert!(!expired.convolve_grouping_active);
}
