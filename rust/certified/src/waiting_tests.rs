use super::*;

fn assessed(day: Option<usize>, kit: usize) -> minimum_wait::Assessment {
    let batch = minimum_wait::Batch {
        kit,
        path: vec![(599, [1000, 600, 600])],
        guard: None,
    };
    let mut assessment = minimum_wait::Assessment::unknown(batch, "test");
    assessment.reason = None;
    assessment.beyond = day.is_none();
    assessment.first_day = day;
    assessment.earliest = day.unwrap_or(8);
    assessment
}

#[test]
fn exact_wait_ties_prefer_beyond_then_descending_days_then_unknown() {
    let mut best = (assessed(Some(1), 0), Value::zero());
    for day in 2..=7 {
        keep_preferred_wait(&mut best, Ok((assessed(Some(day), 1), Value::zero())));
        assert_eq!(best.0.first_day, Some(day));
        keep_preferred_wait(&mut best, Ok((assessed(Some(day - 1), 0), Value::zero())));
        assert_eq!(best.0.first_day, Some(day));
    }
    keep_preferred_wait(&mut best, Ok((assessed(None, 2), Value::zero())));
    assert!(best.0.beyond);
    let mut unknown = assessed(Some(7), 0);
    unknown.reason = Some("exact_support_limit");
    keep_preferred_wait(&mut best, Ok((unknown, Value::zero())));
    assert_eq!(best.0.batch.kit, 2);
}

#[test]
fn optional_tie_errors_preserve_the_completed_base_label() {
    let mut best = (assessed(Some(3), 0), Value::zero());
    let completed = best.0.json();
    for reason in [
        "request_budget_exhausted",
        "exact_memo_limit",
        "minimum_wait_batch_not_exact_tie",
    ] {
        keep_preferred_wait(&mut best, Err(reason));
        assert_eq!(best.0.json(), completed);
    }
}

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
