//! W2a differential tests: the shared-denominator `Supply::convolve` kernel
//! against the retained per-pair rational oracle `convolve_rational`.
//!
//! Contract under test (plan §2 items 2–4): ordered support, exact normalized
//! masses, right-zero skip before the piece sum, left-zero rows preserved,
//! `certified_law_raw_pieces_invalid` and `exact_support_limit` at the oracle's
//! pair and `out.len()`, one `check()` tick per pair (identical `ticks` after
//! success and after each error), the frozen deadline rule of the new loops,
//! the fallback selections (forced, admission failure, signed/raw-invalid
//! masses), every caller family (`law`, `boxes`, `dispatch`, pricing rates),
//! a fixed-seed randomized differential, and peak memory at the 25,000-row
//! boundary measured with the crate's own allocator accounting.
//!
//! On native targets `now()` is the constant 0.0, so `deadline <= 0.0` is an
//! expired budget and `f64::MAX` never expires; no clock can move inside one
//! call, which is why the conversion-loop deadline is covered by the same
//! expired-budget identity rather than by a mid-call expiry.
use super::tests::{reference, row, source};
use super::*;

/// The crate's accounted allocator is compiled only for wasm32 in lib.rs; this
/// test-only inclusion reuses the same source verbatim for native peak
/// accounting. One global allocator per test binary.
#[cfg(not(target_arch = "wasm32"))]
#[path = "../allocation.rs"]
mod allocation;

type Rows = Vec<(Pieces, String)>;
const ANY: Pieces = [u64::MAX; 3];
const MIB: usize = 1024 * 1024;

fn q(n: i64, d: i64) -> Q {
    Q::new(n.into(), d.into())
}
fn o(pieces: Pieces, n: i64, d: i64) -> Outcome {
    Outcome {
        pieces,
        mass: q(n, d),
    }
}
fn rows(v: &[Outcome]) -> Rows {
    v.iter()
        .map(|o| (o.pieces, format!("{}/{}", o.mass.numer(), o.mass.denom())))
        .collect()
}
fn expected(list: &[(Pieces, &str)]) -> Rows {
    list.iter().map(|&(p, m)| (p, m.to_string())).collect()
}
fn fresh() -> Supply {
    source(json!([]))
}
fn expired() -> Supply {
    let mut supply = fresh();
    supply.deadline = 0.0;
    supply
}
fn oracle(a: &[Outcome], b: &[Outcome], caps: Pieces, limit: usize) -> (Result<Rows>, usize) {
    let mut supply = fresh();
    let result = supply
        .convolve_rational(a, b, caps, limit)
        .map(|v| rows(&v));
    (result, supply.ticks)
}
struct Run {
    result: Result<Rows>,
    ticks: usize,
    path: Option<ConvolvePath>,
}
fn run(supply: &mut Supply, a: &[Outcome], b: &[Outcome], caps: Pieces, limit: usize) -> Run {
    let before = supply.ticks;
    let result = supply.convolve(a, b, caps, limit).map(|v| rows(&v));
    Run {
        result,
        ticks: supply.ticks - before,
        path: supply.convolve_last_path,
    }
}
/// Fresh kernel versus fresh oracle: identical result (value, order, reduced
/// representation, or error identity) and identical tick count.
fn differential(a: &[Outcome], b: &[Outcome], caps: Pieces, limit: usize) -> Run {
    let mut supply = fresh();
    let got = run(&mut supply, a, b, caps, limit);
    let (want, ticks) = oracle(a, b, caps, limit);
    assert_eq!(got.result, want, "result differs from the rational oracle");
    assert_eq!(
        got.ticks, ticks,
        "tick count differs from the rational oracle"
    );
    got
}
fn fast(a: &[Outcome], b: &[Outcome], caps: Pieces, limit: usize) -> Result<Rows> {
    let got = differential(a, b, caps, limit);
    assert_eq!(got.path, Some(ConvolvePath::Fast), "fast path not taken");
    got.result
}

#[test]
fn s1_first_gate_shape_uses_80_rows_without_changing_the_workspace_estimator() {
    // Supplied replay shape and first rejected denominator-growth gate, not
    // inferred from the estimator's output.
    let lengths = [80usize, 1_141];
    let limit = 25_000;
    let caps = [70, 30, 10];
    let volume =
        convolve_reachable_volume([[70, 23, 1], [0; 3]], [[70, 30, 10], [40, 16, 16]], caps)
            .unwrap();
    assert_eq!(volume, 80); // [70,70] x [23,30] x [1,10].
    let old_rows = lengths[0] * lengths[1];
    let old_rows = old_rows.min(limit).min(71 * 31 * 11);
    assert_eq!(old_rows, 24_211);
    assert_eq!(old_rows.min(volume), 80);
    let projection_limit = limit.min(volume);
    let bits = [13_141, 1];
    let excess = [1; 2];
    let old = convolve_capped_workspace_bytes(lengths, limit, caps, bits, excess).unwrap();
    let new =
        convolve_capped_workspace_bytes(lengths, projection_limit, caps, bits, excess).unwrap();
    // These shared-estimator identities and the strict reduction hold on
    // native too; object layouts, unlike geometry, depend on the target.
    assert_eq!(
        old,
        convolve_workspace_bytes(lengths, old_rows, bits, excess).unwrap()
    );
    assert_eq!(
        new,
        convolve_workspace_bytes(lengths, 80, bits, excess).unwrap()
    );
    assert!(new < old);
    #[cfg(target_arch = "wasm32")]
    assert_eq!((old, new), (166_336_612, 909_500));

    // Initial, successive growth (both sides), and final denominator bounds
    // all retain the same row bound, while their bit bounds remain distinct.
    for gate_bits in [[1, 1], [14, 1], [13_141, 1], [13_140, 2], [13_140, 1]] {
        assert_eq!(
            convolve_capped_workspace_bytes(lengths, projection_limit, caps, gate_bits, excess),
            convolve_workspace_bytes(lengths, 80, gate_bits, excess)
        );
    }
}

#[test]
fn s1_nonzero_minimum_hand_case_keeps_exact_mass_order_and_real_support_limit() {
    let a = [o([2, 0, 0], 1, 2), o([4, 0, 0], 1, 2)];
    let b = [o([1, 0, 0], 1, 3), o([3, 0, 0], 2, 3)];
    assert_eq!(
        convolve_reachable_volume([[2, 0, 0], [1, 0, 0]], [[4, 0, 0], [3, 0, 0]], [5, 0, 0]),
        Some(3)
    );
    let got = differential(&a, &b, [5, 0, 0], 2);
    assert_eq!(
        got.result,
        Ok(expected(&[([3, 0, 0], "1/6"), ([5, 0, 0], "5/6")]))
    );
    assert_eq!((got.path, got.ticks), (Some(ConvolvePath::Fast), 4));
    let got = differential(&a, &b, [5, 0, 0], 1);
    assert_eq!((got.result, got.ticks), (Err("exact_support_limit"), 2));
}

#[test]
fn s1_reachable_box_matches_independent_small_geometry_including_zero_extrema() {
    fn points(lo: Pieces, hi: Pieces) -> Vec<Pieces> {
        let mut points = Vec::new();
        for x in lo[0]..=hi[0] {
            for y in lo[1]..=hi[1] {
                for z in lo[2]..=hi[2] {
                    points.push([x, y, z]);
                }
            }
        }
        points
    }
    let minima = [[2, 3, 1], [1, 2, 0]];
    let maxima = [[4, 5, 2], [3, 4, 1]];
    let a_points = points(minima[0], maxima[0]);
    let b_points = points(minima[1], maxima[1]);
    let a: Vec<_> = a_points
        .iter()
        .enumerate()
        .map(|(i, &p)| o(p, i64::from(i != 0 && i + 1 != a_points.len()), 1))
        .collect();
    let b: Vec<_> = b_points
        .iter()
        .enumerate()
        .map(|(i, &p)| o(p, i64::from(i != 0 && i + 1 != b_points.len()), 1))
        .collect();
    for caps in [ANY, [5, 6, 2], [u64::MAX, 6, 2], [0; 3]] {
        // Enumerate integer pairs independently of the extrema formula.
        let mut reachable = std::collections::HashSet::new();
        for x in &a_points {
            for y in &b_points {
                reachable.insert(std::array::from_fn::<_, 3, _>(|k| caps[k].min(x[k] + y[k])));
            }
        }
        let volume = convolve_reachable_volume(minima, maxima, caps).unwrap();
        assert_eq!(volume, reachable.len());
        let result = fast(&a, &b, caps, volume).unwrap();
        assert!(result.len() <= volume);
        assert!(result.iter().all(|(p, _)| reachable.contains(p)));
    }
}

#[test]
fn s1_unsafe_extrema_or_volume_overflow_retain_the_original_projection() {
    let lengths = [80, 1_141];
    let limit = 25_000;
    let bits = [13_141, 1];
    for (minima, maxima, caps) in [
        // Safe-integer overflow despite a zero cap.
        (
            [[MAX_SAFE_PIECES, 0, 0], [1, 0, 0]],
            [[MAX_SAFE_PIECES, 0, 0], [1, 0, 0]],
            [0; 3],
        ),
        // Actual u64 addition overflow, also hidden by a zero cap.
        (
            [[u64::MAX, 0, 0], [1, 0, 0]],
            [[u64::MAX, 0, 0], [1, 0, 0]],
            [0; 3],
        ),
        // Only the upper raw sum fails; the lower sum is valid.
        (
            [[0; 3], [0; 3]],
            [[MAX_SAFE_PIECES, 0, 0], [1, 0, 0]],
            ANY,
        ),
        // Valid raw sums, but width conversion/product exceeds usize.
        ([[0; 3], [0; 3]], [[MAX_SAFE_PIECES; 3], [0; 3]], ANY),
        (
            [[0; 3], [0; 3]],
            [[MAX_SAFE_PIECES; 3], [0; 3]],
            [MAX_SAFE_PIECES; 3],
        ),
    ] {
        let volume = convolve_reachable_volume(minima, maxima, caps);
        assert_eq!(volume, None);
        assert_eq!(
            convolve_capped_workspace_bytes(
                lengths,
                volume.map_or(limit, |v| limit.min(v)),
                caps,
                bits,
                [1; 2],
            ),
            convolve_capped_workspace_bytes(lengths, limit, caps, bits, [1; 2])
        );
    }
    // Exactly MAX_SAFE_PIECES is valid, even with unbounded caps.
    assert_eq!(
        convolve_reachable_volume(
            [[MAX_SAFE_PIECES - 1, 0, 0], [1, 0, 0]],
            [[MAX_SAFE_PIECES - 1, 0, 0], [1, 0, 0]],
            ANY,
        ),
        Some(1)
    );
    // A small reachable box must not rescue the original checked pair count.
    assert_eq!(
        convolve_capped_workspace_bytes([usize::MAX, 2], 1, [0; 3], [1; 2], [1; 2]),
        None
    );
}

#[test]
fn s1_reachable_projection_is_monotone_as_the_coordinate_box_expands() {
    let minima = [[2, 3, 1], [1, 2, 0]];
    let mut previous_volume = 0;
    let mut previous_bytes = 0;
    for upper_a in [[2, 3, 1], [4, 3, 1], [4, 5, 2], [5, 5, 3]] {
        let caps = [5, 6, 2];
        let volume = convolve_reachable_volume(minima, [upper_a, [3, 4, 1]], caps).unwrap();
        let bytes =
            convolve_capped_workspace_bytes([18, 18], volume.min(25_000), caps, [17, 11], [1; 2])
                .unwrap();
        assert!(volume >= previous_volume);
        assert!(bytes >= previous_bytes);
        assert!(
            bytes <= convolve_capped_workspace_bytes([18, 18], 25_000, caps, [17, 11], [1; 2]).unwrap()
        );
        previous_volume = volume;
        previous_bytes = bytes;
    }
}

#[test]
fn empty_inputs_match_the_oracle_and_leave_ticks_unchanged_even_when_expired() {
    let one = vec![o([1, 2, 3], 1, 1)];
    for (a, b) in [(&[][..], &[][..]), (&one[..], &[][..]), (&[][..], &one[..])] {
        let got = differential(a, b, ANY, 0);
        assert_eq!(got.result, Ok(Vec::new()));
        assert_eq!(got.ticks, 0);
        // The original empty product never inspected masses or the deadline.
        let mut supply = expired();
        let got = run(&mut supply, a, b, ANY, 0);
        assert_eq!(got.result, Ok(Vec::new()));
        assert_eq!(got.ticks, 0);
    }
}

#[test]
fn heterogeneous_denominators_keep_first_insertion_order_and_exact_reduced_masses() {
    let a = [o([2, 0, 0], 1, 3), o([0, 1, 0], 1, 6), o([0, 0, 1], 1, 2)];
    let b = [o([5, 0, 0], 7, 10), o([0, 2, 0], 1, 5), o([0, 0, 2], 1, 10)];
    // Hand-multiplied, row-major in (x, y) order; sums to 60/60.
    assert_eq!(
        fast(&a, &b, ANY, 25000),
        Ok(expected(&[
            ([7, 0, 0], "7/30"),
            ([2, 2, 0], "1/15"),
            ([2, 0, 2], "1/30"),
            ([5, 1, 0], "7/60"),
            ([0, 3, 0], "1/30"),
            ([0, 1, 2], "1/60"),
            ([5, 0, 1], "7/20"),
            ([0, 2, 1], "1/10"),
            ([0, 0, 3], "1/20"),
        ]))
    );
    // Unreduced inputs on the oracle side must still produce the same reduced
    // output: masses 2/6 and 3/6 are built raw.
    let raw = [
        Outcome {
            pieces: [1, 0, 0],
            mass: Q::new_raw(2.into(), 6.into()),
        },
        Outcome {
            pieces: [0, 1, 0],
            mass: Q::new_raw(3.into(), 6.into()),
        },
    ];
    assert_eq!(
        fast(&raw, &b, ANY, 25000),
        Ok(expected(&[
            ([6, 0, 0], "7/30"),
            ([1, 2, 0], "1/15"),
            ([1, 0, 2], "1/30"),
            ([5, 1, 0], "7/20"),
            ([0, 3, 0], "1/10"),
            ([0, 1, 2], "1/20"),
        ]))
    );
}

#[test]
fn duplicates_and_cap_collisions_merge_into_the_first_insertion_slot() {
    let a = [o([2, 0, 0], 1, 2), o([3, 0, 0], 1, 2)];
    let b = [o([1, 0, 0], 1, 4), o([0, 1, 0], 1, 4), o([0, 5, 0], 1, 2)];
    assert_eq!(
        fast(&a, &b, [3, 1, u64::MAX], 25000),
        Ok(expected(&[
            ([3, 0, 0], "1/4"),
            ([2, 1, 0], "3/8"),
            ([3, 1, 0], "3/8"),
        ]))
    );
    // Duplicate pieces inside one operand collapse the same way.
    let dup = [o([1, 0, 0], 1, 3), o([1, 0, 0], 2, 3)];
    assert_eq!(
        fast(&dup, &dup, ANY, 25000),
        Ok(expected(&[([2, 0, 0], "1/1")]))
    );
    // Capping to zero collapses everything onto one row; the cap applies after
    // the checked sum, so it never rescues an overflow (see the overflow test).
    assert_eq!(
        fast(&a, &b, [0; 3], 25000),
        Ok(expected(&[([0, 0, 0], "1/1")]))
    );
}

#[test]
fn right_zero_rows_skip_before_the_sum_and_left_zero_rows_are_preserved() {
    let a = [o([1, 0, 0], 1, 1), o([9, 0, 0], 0, 1)];
    // The right-zero row would overflow the checked sum and would be a new
    // support point; both are skipped before they can be observed.
    let b = [
        o([0, 1, 0], 1, 2),
        o([0, 2, 0], 1, 2),
        o([MAX_SAFE_PIECES, 0, 0], 0, 1),
    ];
    let got = differential(&a, &b, ANY, 4);
    assert_eq!(got.path, Some(ConvolvePath::Fast));
    assert_eq!(
        got.result,
        Ok(expected(&[
            ([1, 1, 0], "1/2"),
            ([1, 2, 0], "1/2"),
            ([9, 1, 0], "0/1"),
            ([9, 2, 0], "0/1"),
        ]))
    );
    assert_eq!(
        got.ticks, 6,
        "one tick per pair, including skipped right zeros"
    );
    // Right zeros do not count toward the support limit...
    assert_eq!(fast(&a[..1], &b, ANY, 2).map(|r| r.len()), Ok(2));
    // ...but preserved left-zero rows do, in the oracle's position.
    let got = differential(&a, &b, ANY, 2);
    assert_eq!(got.result, Err("exact_support_limit"));
    assert_eq!(got.ticks, 4);
    // A left-zero row collides with a live row without changing its mass.
    let left = [o([1, 0, 0], 1, 1), o([1, 0, 0], 0, 1)];
    assert_eq!(
        fast(&left, &b[..2], ANY, 25000),
        Ok(expected(&[([1, 1, 0], "1/2"), ([1, 2, 0], "1/2")]))
    );
}

#[test]
fn raw_piece_overflow_errors_at_the_same_pair_as_the_oracle() {
    let a = [o([1, 0, 0], 1, 2), o([MAX_SAFE_PIECES, 0, 0], 1, 2)];
    let b = [o([0, 0, 0], 1, 2), o([1, 0, 0], 1, 2)];
    for caps in [ANY, [0; 3]] {
        let got = differential(&a, &b, caps, 25000);
        assert_eq!(got.result, Err("certified_law_raw_pieces_invalid"));
        assert_eq!(got.ticks, 4, "pair (2, 2) is the fourth pair");
        assert_eq!(got.path, Some(ConvolvePath::Fast));
    }
    // u64 overflow (not only the safe-integer ceiling) is checked too.
    let huge = [o([0, u64::MAX, 0], 1, 1)];
    let got = differential(&huge, &[o([0, 1, 0], 1, 1)], ANY, 25000);
    assert_eq!(got.result, Err("certified_law_raw_pieces_invalid"));
    assert_eq!(got.ticks, 1);
    // Exactly at the ceiling is still valid.
    assert_eq!(
        fast(&a, &[o([0, 0, 0], 1, 1)], ANY, 25000),
        Ok(expected(&[
            ([1, 0, 0], "1/2"),
            ([MAX_SAFE_PIECES, 0, 0], "1/2")
        ]))
    );
}

#[test]
fn exact_support_limit_fires_at_the_same_out_len_and_pair() {
    let a = [o([1, 0, 0], 1, 3), o([2, 0, 0], 1, 3), o([3, 0, 0], 1, 3)];
    let b = [o([0, 1, 0], 1, 3), o([0, 2, 0], 1, 3), o([0, 3, 0], 1, 3)];
    let got = differential(&a, &b, ANY, 4);
    assert_eq!(got.result, Err("exact_support_limit"));
    assert_eq!(got.ticks, 5, "the fifth distinct row is the fifth pair");
    assert_eq!(got.path, Some(ConvolvePath::Fast));
    // limit == final support size succeeds; one less fails on the last pair.
    assert_eq!(fast(&a, &b, ANY, 9).map(|r| r.len()), Ok(9));
    let got = differential(&a, &b, ANY, 8);
    assert_eq!(got.result, Err("exact_support_limit"));
    assert_eq!(got.ticks, 9);
    // limit 0 fails on the first live pair; a leading right zero is skipped first.
    let got = differential(&a, &b, ANY, 0);
    assert_eq!((got.result, got.ticks), (Err("exact_support_limit"), 1));
    let zero_first = [o([0, 9, 0], 0, 1), o([0, 1, 0], 1, 1)];
    let got = differential(&a, &zero_first, ANY, 0);
    assert_eq!((got.result, got.ticks), (Err("exact_support_limit"), 2));
    // Collisions never consume limit slots.
    assert_eq!(
        fast(&a, &[o([0, 0, 0], 1, 2), o([0, 0, 0], 1, 2)], ANY, 3).map(|r| r.len()),
        Ok(3)
    );
}

#[test]
fn identity_laws_and_repeated_convolution_match_the_oracle_and_hand_values() {
    let law = [o([3, 0, 0], 4, 5), o([0, 1, 0], 1, 5)];
    let unit = Supply::singleton([0; 3]);
    assert_eq!(fast(&unit, &law, ANY, 25000), Ok(rows(&law)));
    assert_eq!(fast(&law, &unit, ANY, 25000), Ok(rows(&law)));
    let shifted = Supply::singleton([1, 2, 3]);
    assert_eq!(
        fast(&shifted, &law, ANY, 25000),
        Ok(expected(&[([4, 2, 3], "4/5"), ([1, 3, 3], "1/5")]))
    );
    // Binomial build-up: after two regular boxes 16/25, 8/25, 1/25.
    let mut kernel = fresh();
    let mut acc = unit.clone();
    for n in 1..=8 {
        let got = run(&mut kernel, &acc, &law, ANY, 25000);
        assert_eq!(got.path, Some(ConvolvePath::Fast));
        let (want, _) = oracle(&acc, &law, ANY, 25000);
        assert_eq!(got.result, want, "step {n}");
        acc = kernel.convolve(&acc, &law, ANY, 25000).unwrap();
        assert_eq!(acc.len(), n + 1);
        assert_eq!(acc.iter().map(|o| &o.mass).sum::<Q>(), Q::one());
        if n == 2 {
            assert_eq!(
                rows(&acc),
                expected(&[
                    ([6, 0, 0], "16/25"),
                    ([3, 1, 0], "8/25"),
                    ([0, 2, 0], "1/25")
                ])
            );
        }
    }
}

#[test]
fn forced_admission_failure_and_signed_mass_fallbacks_match_the_oracle() {
    let a = [o([2, 0, 0], 1, 3), o([0, 1, 0], 2, 3)];
    let b = [o([5, 0, 0], 7, 10), o([0, 2, 0], 3, 10)];
    let (want, ticks) = oracle(&a, &b, ANY, 25000);
    let mut forced = fresh();
    forced.convolve_force_rational = true;
    let got = run(&mut forced, &a, &b, ANY, 25000);
    assert_eq!(
        (got.result, got.ticks, got.path),
        (want.clone(), ticks, Some(ConvolvePath::Rational))
    );
    let mut denied = fresh();
    denied.convolve_force_admission_failure = true;
    let got = run(&mut denied, &a, &b, ANY, 25000);
    assert_eq!(
        (got.result, got.ticks, got.path),
        (want.clone(), ticks, Some(ConvolvePath::Rational))
    );
    // Without the hooks the same operands take the fast path.
    let got = run(&mut fresh(), &a, &b, ANY, 25000);
    assert_eq!(
        (got.result, got.ticks, got.path),
        (want, ticks, Some(ConvolvePath::Fast))
    );

    // A negative numerator or a nonpositive raw denominator anywhere selects the
    // rational fallback before any pair runs; results and ticks still agree.
    let negative = [o([2, 0, 0], -1, 2), o([0, 1, 0], 3, 2)];
    let got = differential(&a, &negative, ANY, 25000);
    assert_eq!(got.path, Some(ConvolvePath::Rational));
    // (1/3)(-1/2), (1/3)(3/2) + (2/3)(-1/2), (2/3)(3/2)
    assert_eq!(
        got.result,
        Ok(expected(&[
            ([4, 0, 0], "-1/6"),
            ([2, 1, 0], "1/6"),
            ([0, 2, 0], "1/1"),
        ]))
    );
    assert_eq!(got.ticks, 4);
    let raw_negative_denominator = [
        Outcome {
            pieces: [1, 0, 0],
            mass: Q::new_raw(1.into(), (-2).into()),
        },
        o([0, 1, 0], 1, 2),
    ];
    let got = differential(&raw_negative_denominator, &b, ANY, 25000);
    assert_eq!(got.path, Some(ConvolvePath::Rational));
    assert_eq!(got.ticks, 4);
    let raw_zero_denominator = [Outcome {
        pieces: [1, 0, 0],
        mass: Q::new_raw(0.into(), 0.into()),
    }];
    let got = differential(&b, &raw_zero_denominator, ANY, 25000);
    assert_eq!(got.path, Some(ConvolvePath::Rational));
    assert_eq!(got.ticks, 2);
}

#[test]
fn ticks_match_the_oracle_after_success_and_after_each_error_in_sequence() {
    let a = [o([1, 0, 0], 1, 2), o([MAX_SAFE_PIECES, 0, 0], 1, 2)];
    let b = [o([0, 1, 0], 1, 3), o([0, 2, 0], 0, 1), o([1, 0, 0], 2, 3)];
    let mut kernel = fresh();
    let mut reference_supply = fresh();
    let script: [(&[Outcome], &[Outcome], usize, Result<usize>); 5] = [
        (&a[..1], &b, 25000, Ok(2)),
        (&a, &b, 25000, Err("certified_law_raw_pieces_invalid")),
        (&a[..1], &b, 1, Err("exact_support_limit")),
        (&a, &b[..2], 25000, Ok(2)),
        (&[], &b, 25000, Ok(0)),
    ];
    let mut total = 0;
    for (step, (x, y, limit, outcome)) in script.iter().enumerate() {
        let got = run(&mut kernel, x, y, ANY, *limit);
        let want = reference_supply
            .convolve_rational(x, y, ANY, *limit)
            .map(|v| rows(&v));
        assert_eq!(got.result, want, "step {step}");
        assert_eq!(got.result.map(|r| r.len()), *outcome, "step {step}");
        assert_eq!(kernel.ticks, reference_supply.ticks, "step {step}");
        total += got.ticks;
    }
    // Hand count: 3 + 6 + 3 + 4 + 0 pairs, one tick each, including right zeros
    // and the erroring pair itself.
    assert_eq!(total, 16);
    assert_eq!(kernel.ticks, 16);
}

#[test]
fn expired_deadline_yields_only_request_budget_exhausted() {
    let a = [o([1, 0, 0], 1, 2), o([2, 0, 0], 1, 2)];
    let b = [o([0, 1, 0], 1, 3), o([0, 2, 0], 2, 3)];
    // Preparation (sign scan at index 0) fails before any pair: no ticks, no path.
    let mut supply = expired();
    let got = run(&mut supply, &a, &b, ANY, 25000);
    assert_eq!(
        (got.result, got.ticks, got.path),
        (Err("request_budget_exhausted"), 0, None)
    );
    // The admission hook is reached only after the sign scan, so an expired
    // budget still surfaces from preparation.
    let mut supply = expired();
    supply.convolve_force_admission_failure = true;
    let got = run(&mut supply, &a, &b, ANY, 25000);
    assert_eq!(
        (got.result, got.ticks, got.path),
        (Err("request_budget_exhausted"), 0, None)
    );
    // The pair cadence is untouched: on the rational path the 32nd tick is the
    // first that consults the clock, exactly as in the oracle.
    let wide: Vec<Outcome> = (0..32).map(|i| o([i, 0, 0], 1, 32)).collect();
    for (len, want) in [(31, Ok(31)), (32, Err("request_budget_exhausted"))] {
        let mut forced = expired();
        forced.convolve_force_rational = true;
        let got = run(&mut forced, &a[..1], &wide[..len], ANY, 25000);
        assert_eq!(got.result.map(|r| r.len()), want);
        assert_eq!(got.ticks, len);
        let mut rational = expired();
        let result = rational.convolve_rational(&a[..1], &wide[..len], ANY, 25000);
        assert_eq!(result.map(|r| r.len()), want);
        assert_eq!(rational.ticks, len);
    }
    // A live budget on the same operands completes on the fast path.
    assert_eq!(fast(&a[..1], &wide, ANY, 25000).map(|r| r.len()), Ok(32));
}

const CLASSES: &str = r#"[
  {"weight":15,"keep":false,"raw":[2,0,0,0,0]},{"weight":15,"keep":false,"raw":[3,0,0,0,0]},
  {"weight":6,"keep":true,"raw":[0,2,0,0,0]},{"weight":3,"keep":true,"raw":[0,3,0,0,0]},
  {"weight":4,"keep":true,"raw":[0,0,1,0,0]},{"weight":2,"keep":true,"raw":[0,0,2,0,0]},
  {"weight":15,"keep":false,"raw":[0,0,0,1,0]},{"weight":8,"keep":true,"raw":[0,0,0,2,0]},
  {"weight":8,"keep":true,"raw":[0,0,0,0,1]},{"weight":4,"keep":true,"raw":[0,0,0,0,2]},
  {"weight":3,"keep":false,"raw":[0,0,0,0,0]},{"weight":7,"keep":false,"raw":[0,0,0,0,0]},
  {"weight":7,"keep":false,"raw":[0,0,0,0,0]},{"weight":3,"keep":false,"raw":[0,0,0,0,0]}
]"#;
fn caller_supply(force_rational: bool) -> Supply {
    let mut supply = source(json!([
        {"id":"regular-box-v1","kind":"box"},
        {"id":"box-ii-v1","kind":"box"},
        {"id":"dispatch-board-v1","kind":"dispatch"},
        {"id":"custom","kind":"finite","outcomes":[
            row([2, 0, 0], 1, 3), row([0, 1, 0], 1, 6), row([0, 0, 1], 5, 12),
            row([7, 7, 7], 0, 1), row([0, 0, 0], 1, 12)
        ]},
        {"id":"simplex","kind":"finite","outcomes":[
            row([0, 0, 0], 1, 4), row([1, 0, 0], 1, 4), row([0, 1, 0], 1, 4), row([0, 0, 1], 1, 4)
        ]},
        {"id":"cohorts","kind":"finite","outcomesByCohort":[
            [row([1, 0, 0], 1, 1)],
            [row([0, 2, 0], 3, 4), row([0, 0, 0], 1, 4)],
            [row([0, 0, 3], 2, 5), row([3, 0, 0], 3, 5)]
        ]}
    ]));
    supply.model.classes = serde_json::from_str(CLASSES).unwrap();
    supply.model.dispatch = vec![reference("dispatch-board-v1", 1)];
    supply.model.shop = vec![reference("box-ii-v1", 5), reference("custom", 1)];
    supply.model.solo = vec![reference("regular-box-v1", 12), reference("cohorts", 2)];
    supply.convolve_force_rational = force_rational;
    supply
}

#[test]
fn law_boxes_dispatch_and_rates_callers_match_the_forced_rational_supply() {
    let mut kernel = caller_supply(false);
    let mut rational = caller_supply(true);
    let calls = [
        ("regular-box-v1", 6, 0),
        ("box-ii-v1", 5, 0),
        ("custom", 3, 0),
        ("cohorts", 2, 1),
        ("cohorts", 3, 2),
        ("dispatch-board-v1", 1, 0),
        ("dispatch-board-v1", 1, 1),
        ("deterministic:1,2,3", 4, 0),
    ];
    for (id, count, cohort) in calls {
        let got = kernel.law(&reference(id, count), cohort).map(|d| rows(&d));
        let want = rational
            .law(&reference(id, count), cohort)
            .map(|d| rows(&d));
        assert_eq!(got, want, "{id} x{count} cohort {cohort}");
        assert_eq!(
            kernel.ticks, rational.ticks,
            "{id} x{count} cohort {cohort}"
        );
        assert_eq!(kernel.convolve_last_path, Some(ConvolvePath::Fast), "{id}");
        assert_eq!(
            rational.convolve_last_path,
            Some(ConvolvePath::Rational),
            "{id}"
        );
        let total: Q = got
            .unwrap()
            .iter()
            .map(|(_, m)| {
                let (n, d) = m.split_once('/').unwrap();
                Q::new(n.parse::<BigInt>().unwrap(), d.parse::<BigInt>().unwrap())
            })
            .sum();
        assert_eq!(total, Q::one(), "{id} x{count} cohort {cohort}");
    }
    // Hand value: three "custom" draws, all-blue corner (2,0,0)^3 = (1/3)^3.
    for supply in [&mut kernel, &mut rational] {
        let custom = supply.law(&reference("custom", 3), 0).unwrap();
        assert_eq!(rows(&custom)[0], ([6, 0, 0], "1/27".to_string()));
    }
    // Pricing walks dispatch_expected, shop and solo laws through `expected`.
    let got = kernel.pricing([3, 2, 1], [0; 3], TERMINAL).unwrap();
    let want = rational.pricing([3, 2, 1], [0; 3], TERMINAL).unwrap();
    assert_eq!(got, want);
    assert_eq!(kernel.ticks, rational.ticks);
    // Support limit through `law` keeps the mapped identity and position: the
    // simplex law after n draws has C(n+3, 3) rows, C(54, 3) = 24,804 fits and
    // the 52nd draw crosses 25,000.
    let got = kernel.law(&reference("simplex", 52), 0).err();
    let want = rational.law(&reference("simplex", 52), 0).err();
    assert_eq!(got, Some("certified_supply_support_limit"));
    assert_eq!(got, want);
    assert_eq!(kernel.ticks, rational.ticks);
}

struct SplitMix(u64);
impl SplitMix {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn operand(&mut self, signed: bool) -> Vec<Outcome> {
        const DENOMINATORS: [i64; 10] = [1, 2, 3, 4, 5, 6, 7, 10, 12, 25];
        (0..self.below(6))
            .map(|_| {
                let piece = |rng: &mut Self| match rng.below(16) {
                    0 => MAX_SAFE_PIECES - rng.below(2),
                    1 => u64::MAX - rng.below(2),
                    _ => rng.below(4),
                };
                let pieces = [piece(self), piece(self), piece(self)];
                let d = DENOMINATORS[self.below(10) as usize];
                let mut n = self.below(6) as i64;
                if signed && self.below(4) == 0 {
                    n = -n;
                }
                o(pieces, n, d)
            })
            .collect()
    }
}

#[test]
fn randomized_differential_with_a_fixed_seed() {
    let mut rng = SplitMix(0x5732_6120_6B65_726E);
    let mut tally = [0usize; 5];
    for _ in 0..600 {
        let signed = rng.below(8) == 0;
        let a = rng.operand(signed);
        let b = rng.operand(signed);
        let caps = match rng.below(3) {
            0 => ANY,
            1 => [rng.below(5), rng.below(5), rng.below(5)],
            _ => [rng.below(3), u64::MAX, rng.below(7)],
        };
        let limit = rng.below(14) as usize;
        let got = differential(&a, &b, caps, limit);
        let negative = a
            .iter()
            .chain(&b)
            .any(|row| row.mass.numer() < &BigInt::zero());
        let want_path = if a.is_empty() || b.is_empty() || negative {
            ConvolvePath::Rational
        } else {
            ConvolvePath::Fast
        };
        assert_eq!(got.path, Some(want_path));
        tally[match &got.result {
            Ok(rows) if rows.is_empty() => 0,
            Ok(_) => 1,
            Err("exact_support_limit") => 2,
            Err("certified_law_raw_pieces_invalid") => 3,
            Err(other) => panic!("unexpected error {other}"),
        }] += 1;
        if want_path == ConvolvePath::Fast {
            tally[4] += 1;
        }
    }
    // The seed must exercise every outcome class and the fast path.
    assert!(tally.iter().all(|&n| n >= 20), "{tally:?}");
}

fn primes(limit: u64) -> Vec<u64> {
    let mut sieve = vec![true; limit as usize + 1];
    (2..=limit)
        .filter(|&n| {
            if sieve[n as usize] {
                (n * n..=limit)
                    .step_by(n as usize)
                    .for_each(|m| sieve[m as usize] = false);
                true
            } else {
                false
            }
        })
        .collect()
}

/// The 25,000-row boundary shape: 200 distinct prime denominators, so the
/// shared denominator is their product (about 1,800 bits) and every scaled
/// numerator is unreduced and large.
fn boundary_shape() -> (Vec<Outcome>, Vec<Outcome>, BigUint) {
    let primes = primes(1300);
    let primes = &primes[..200];
    let a: Vec<Outcome> = (0..12_500u64)
        .map(|i| {
            let p = primes[i as usize % 200] as i64;
            o([i, 0, 0], p - 1, p)
        })
        .collect();
    let b = vec![o([0, 1, 0], 2, 3), o([0, 2, 0], 5, 7)];
    let product = primes
        .iter()
        .fold(BigUint::one(), |acc, &p| acc * BigUint::from(p));
    (a, b, product)
}

#[cfg(not(target_arch = "wasm32"))]
const MEMORY_CHILD_ENV: &str = "CERTIFIED_W2A_CONVOLVE_MEMORY_CHILD";
#[cfg(not(target_arch = "wasm32"))]
const MEMORY_TEST_NAME: &str = "supply::convolve_tests::peak_memory_for_unreduced_numerators_at_the_25000_row_boundary_stays_within_160_mib";
#[cfg(not(target_arch = "wasm32"))]
const MEMORY_REPORT_PREFIX: &str = "W2A_CONVOLVE_MEMORY ";

/// One isolated measurement: absolute baseline and absolute peak of the
/// accounted allocator around a single `convolve`, under a 160 MiB ceiling.
#[cfg(not(target_arch = "wasm32"))]
struct Measurement {
    label: &'static str,
    baseline: usize,
    peak: usize,
    projection: usize,
}
#[cfg(not(target_arch = "wasm32"))]
impl Measurement {
    fn take(label: &'static str, a: &[Outcome], b: &[Outcome], caps: Pieces, rows: usize) -> Self {
        let (_, _, product) = boundary_shape();
        // The projection `convolve` admits for this exact shape: the capped
        // variant with the measured call's caps, the final denominator bits
        // (D_A = the prime product, D_B = lcm(3, 7) = 21) and excess bits of 1
        // on both sides (every numerator has the bit length of its denominator).
        let projection = convolve_capped_workspace_bytes(
            [a.len(), b.len()],
            25_000,
            caps,
            [product.bits(), 5],
            [1, 1],
        )
        .unwrap();
        let mut supply = fresh();
        allocation::certified_reset_heap_peak();
        allocation::certified_heap_limit(160 * MIB);
        let baseline = allocation::certified_heap_live();
        let out = supply.convolve(a, b, caps, 25_000).unwrap();
        let peak = allocation::certified_heap_peak();
        assert!(
            !allocation::certified_allocation_denied(),
            "{label}: the accounted allocator denied an allocation under 160 MiB"
        );
        assert_eq!(
            supply.convolve_last_path,
            Some(ConvolvePath::Fast),
            "{label}"
        );
        assert_eq!(out.len(), rows, "{label}");
        assert_eq!(supply.ticks, 25_000, "{label}");
        // Hand values: (1/2)(2/3) and (1/2)(5/7), fully reduced.
        assert_eq!(out[0].mass, q(1, 3), "{label}");
        assert_eq!(out[1].mass, q(5, 14), "{label}");
        drop(out);
        let measurement = Self {
            label,
            baseline,
            peak,
            projection,
        };
        measurement.assert_bounds();
        measurement
    }
    fn assert_bounds(&self) {
        let Self {
            label,
            baseline,
            peak,
            projection,
        } = self;
        assert!(
            peak <= &(160 * MIB),
            "{label}: absolute peak {peak} bytes exceeds 160 MiB (baseline {baseline})"
        );
        let increase = peak.saturating_sub(*baseline);
        assert!(
            &increase <= projection,
            "{label}: admission projection {projection} bytes is below the measured increase {increase} bytes (baseline {baseline}, peak {peak})"
        );
    }
    fn report(&self) -> String {
        format!(
            "{MEMORY_REPORT_PREFIX}{} baseline={} peak={} projection={}",
            self.label, self.baseline, self.peak, self.projection
        )
    }
    fn parse(line: &str) -> Option<Self> {
        // libtest prints "test <name> ... " before a --nocapture test's own
        // stdout without a newline, so the report may share its line.
        let start = line.find(MEMORY_REPORT_PREFIX)?;
        let mut fields = line[start + MEMORY_REPORT_PREFIX.len()..].split(' ');
        let label = match fields.next()? {
            "unbounded" => "unbounded",
            "capped" => "capped",
            _ => return None,
        };
        let mut value = |key: &str| -> Option<usize> {
            fields
                .next()?
                .strip_prefix(key)?
                .strip_prefix('=')?
                .parse()
                .ok()
        };
        Some(Self {
            label,
            baseline: value("baseline")?,
            peak: value("peak")?,
            projection: value("projection")?,
        })
    }
}

/// Peak memory is measured in an isolated child process so no other test
/// thread shares the process-global allocator accounting. The parent re-invokes
/// this test binary for exactly this test with one thread and an env flag; the
/// child measures, asserts, and prints one report line per shape, which the
/// parent parses and asserts again. No minimum-of-N: one measurement per shape.
#[cfg(not(target_arch = "wasm32"))]
#[test]
fn peak_memory_for_unreduced_numerators_at_the_25000_row_boundary_stays_within_160_mib() {
    let (a, b, _) = boundary_shape();
    if std::env::var_os(MEMORY_CHILD_ENV).is_some() {
        // 1. reset the peak (restores the 192 MiB limit); 2. then lower the
        // limit to 160 MiB; 3. record absolute baseline and peak separately.
        let unbounded = Measurement::take("unbounded", &a, &b, ANY, 25_000);
        println!("{}", unbounded.report());
        // One capped shape: blue collapses to 0..=99 so the capped projection
        // bounds rows by (99 + 1) * (2 + 1) * 1 = 300 rather than 25,000; the
        // result keeps 100 * 2 = 200 rows.
        let capped = Measurement::take("capped", &a, &b, [99, 2, 0], 200);
        println!("{}", capped.report());
        return;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            MEMORY_TEST_NAME,
            "--test-threads=1",
            "--nocapture",
        ])
        .env(MEMORY_CHILD_ENV, "1")
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "isolated memory child failed ({}):\n{stdout}\n{stderr}",
        output.status
    );
    let measurements: Vec<_> = stdout.lines().filter_map(Measurement::parse).collect();
    assert_eq!(
        measurements.iter().map(|m| m.label).collect::<Vec<_>>(),
        ["unbounded", "capped"],
        "child report lines missing:\n{stdout}"
    );
    for measurement in &measurements {
        println!("isolated child: {}", measurement.report());
        measurement.assert_bounds();
        assert!(
            measurement.peak > measurement.baseline,
            "{}",
            measurement.label
        );
    }
    // The boundary itself: 25,000 rows pass, 24,999 fail on the final pair with
    // the oracle's identity and position, and the full result equals the oracle.
    let got = differential(&a, &b, ANY, 24_999);
    assert_eq!(
        (got.result, got.ticks),
        (Err("exact_support_limit"), 25_000)
    );
    assert_eq!(fast(&a, &b, ANY, 25_000).map(|r| r.len()), Ok(25_000));
}

fn waiting_engine() -> crate::Engine {
    let mut edges: Vec<_> = (0..=600)
        .map(|s| [[1000, 600, (s + 1).min(600)]; 3])
        .collect();
    edges[598] = [[500, 600, 599], [250, 600, 599], [750, 600, 599]];
    crate::Engine::new(crate::Init {
        edges,
        caps: vec![[2; 3]; 601],
        weights: [wire(&q(1, 1)), wire(&q(2, 1)), wire(&q(3, 1))],
        deadline_at: f64::MAX,
        max_memo_entries: 250_000,
        max_support_points: 25_000,
    })
    .unwrap()
}
/// A supply with dated events inside the waiting horizon over every caller
/// family: heterogeneous finite rows, a repeated finite count, cohort-specific
/// rows, a box law and a deterministic law. Three nonzero priors (1/3 each).
fn waiting_supply(force_rational: bool) -> Supply {
    let mut supply = source(json!([
        {"id":"regular-box-v1","kind":"box"},
        {"id":"mixed","kind":"finite","outcomes":[
            row([10, 0, 0], 1, 3), row([19, 0, 0], 1, 6), row([0, 9, 0], 1, 2)
        ]},
        {"id":"cohorts","kind":"finite","outcomesByCohort":[
            [row([0, 0, 10], 1, 1)],
            [row([0, 10, 0], 3, 4), row([0, 0, 0], 1, 4)],
            [row([0, 0, 9], 2, 5), row([9, 0, 0], 3, 5)]
        ]}
    ]));
    supply.model.events = serde_json::from_value(json!([
        {"id":"e1","day":1,"refs":[{"lawId":"mixed","count":1}]},
        {"id":"e3","day":3,"refs":[{"lawId":"cohorts","count":1},{"lawId":"mixed","count":2}]},
        {"id":"e6","day":6,"refs":[{"lawId":"regular-box-v1","count":1}]},
        {"id":"e9","day":9,"refs":[{"lawId":"deterministic:1,0,0","count":1}]}
    ]))
    .unwrap();
    supply.convolve_force_rational = force_rational;
    supply
}

/// Waiting family (plan §2 item 3): `Engine::waiting` drives
/// `Supply::convolve` for every cohort and event (waiting.rs, the only caller
/// that passes finite caps and `max_support`). A fast-path supply and a
/// forced-rational twin must produce the same JSON result, the same supply
/// and engine tick counts and the same physical support peak.
#[test]
fn waiting_caller_matches_the_forced_rational_twin() {
    let mut results = Vec::new();
    for force_rational in [false, true] {
        let mut engine = waiting_engine();
        let mut supply = waiting_supply(force_rational);
        engine.current(598, [0; 3], 1).unwrap();
        let before = supply.ticks;
        let result = engine.waiting(&mut supply, 598, [0; 3], true).unwrap();
        // The waiting convolution was actually reached: the support grew past
        // the initial singleton, pair ticks were spent, and the last convolve
        // selected the intended path.
        assert!(
            engine.support_peak > 1,
            "support peak {}",
            engine.support_peak
        );
        assert!(supply.ticks > before);
        assert_eq!(
            supply.convolve_last_path,
            Some(if force_rational {
                ConvolvePath::Rational
            } else {
                ConvolvePath::Fast
            })
        );
        assert_eq!(result["status"], json!("certified"), "{result}");
        // waiting.rs: WAITING_HORIZON = 14 (private to that module).
        assert_eq!(result["horizonDays"], json!(14));
        results.push((result, supply.ticks, engine.ticks, engine.support_peak));
    }
    assert_eq!(results[0], results[1]);
    // Hand check on the first waiting date: day 1 convolves the singleton
    // [0,0,0] with `mixed` under caps 20, so the physical support reaches the
    // three `mixed` rows; later dates only grow it.
    assert!(results[0].3 >= 3, "support peak {}", results[0].3);
}
