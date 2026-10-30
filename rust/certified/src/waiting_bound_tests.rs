fn bound_fixture_engine(first: [Edge; 3], weights: [i64; 3]) -> Engine {
    let mut edges: Vec<_> = (0..=TERMINAL)
        .map(|s| [[1000, TERMINAL, (s + 1).min(TERMINAL)]; 3])
        .collect();
    edges[598] = first;
    Engine::new(Init {
        edges,
        caps: vec![[2; 3]; 601],
        weights: weights.map(|n| wire(&q(n, 1))),
        deadline_at: f64::MAX,
        max_memo_entries: 250_000,
        max_support_points: 25_000,
    })
    .unwrap()
}

fn expected_bound_certificate(
    day: usize,
    evaluated: &[usize],
    b: Q,
    consumed: [Q; 3],
) -> Json {
    json!({
        "status":"certified",
        "horizonDays":14,
        "recommendedDays":day,
        "rangeBoundary":day == 14,
        "bestDayRange":[day,day],
        "value":{
            "p":wire(&q(1,1)),
            "b":wire(&b),
            "c":wire(&consumed.iter().sum::<Q>()),
            "consumed":consumed.iter().map(wire).collect::<Vec<_>>(),
            "mask":0
        },
        "evaluatedDays":evaluated,
        "successImprovementUpperBound":wire(&q(0,1)),
        "successProbabilityInterval":{"lower":wire(&q(1,1)),"upper":wire(&q(1,1))},
        "reason":null,
        "evidence":[
            "exact_cohort_conditional_distributions_single_latent_cohort",
            "exact_rational_completed_date_prefix",
            "exact_P_B_C_equal_unlimited_optimum_at_completed_date",
            "earliest_exact_objective_tie_in_completed_prefix",
            "fixed_prices_all_dates",
            "nonnegative_nonexpiring_inventory_coupling",
            "range_only_no_global_or_deadline_claim"
        ]
    })
}

#[test]
fn waiting_bound_day_one_has_exact_actual_value_and_only_completed_prefix() {
    let mut e = engine([2; 3]);
    let mut supply = source(
        json!([{"id":"first","day":1,"refs":[{"lawId":"deterministic:20,0,0","count":1}]}]),
        json!([]),
    );
    e.current(598, [0; 3], 1).unwrap();
    let result = e.waiting(&mut supply, 598, [0; 3], true).unwrap();
    // Blue succeeds on the first half of branches, otherwise consumes one
    // more blue: P=1, B=C=10+(1/2)*10=15. No day-14 boundary event exists.
    assert_eq!(
        result,
        expected_bound_certificate(1, &[0, 1], q(15, 1), [q(15, 1), q(0, 1), q(0, 1)])
    );
}

#[test]
fn waiting_bound_primary_equality_without_burden_equality_continues() {
    let mut e = engine([2; 3]);
    let mut supply = source(
        json!([
            {"id":"purple","day":1,"refs":[{"lawId":"deterministic:0,10,0","count":1}]},
            {"id":"blue","day":2,"refs":[{"lawId":"deterministic:10,0,0","count":1}]}
        ]),
        json!([]),
    );
    e.current(599, [0; 3], 1).unwrap();
    // Every action at 599 completes immediately. Day 1 has P=1 but B=20;
    // blue on day 2 attains the fixed relaxed P=1, B=C=10 bound.
    assert_eq!(
        e.waiting(&mut supply, 599, [0; 3], true).unwrap(),
        expected_bound_certificate(2, &[0, 1, 2], q(10, 1), [q(10, 1), q(0, 1), q(0, 1)])
    );
}

#[test]
fn waiting_bound_primary_and_burden_equality_without_total_equality_continues() {
    let mut e = bound_fixture_engine(
        [[1000, 599, 600], [1000, 600, 600], [1000, 600, 600]],
        [1, 2, 3],
    );
    let mut supply = source(
        json!([
            {"id":"blue","day":1,"refs":[{"lawId":"deterministic:20,0,0","count":1}]},
            {"id":"purple","day":2,"refs":[{"lawId":"deterministic:0,10,0","count":1}]}
        ]),
        json!([]),
    );
    e.current(598, [0; 3], 1).unwrap();
    // Two blue actions cost B=20,C=20. One purple action costs B=20,C=10.
    // Thus day 1 ties P/B but must not terminate before the C improvement.
    assert_eq!(
        e.waiting(&mut supply, 598, [0; 3], true).unwrap(),
        expected_bound_certificate(2, &[0, 1, 2], q(20, 1), [q(0, 1), q(10, 1), q(0, 1)])
    );
}

#[test]
fn waiting_bound_flat_prefix_below_bound_does_not_terminate() {
    let mut e = engine([2; 3]);
    let mut supply = source(
        json!([
            {"id":"first","day":1,"refs":[{"lawId":"deterministic:10,0,0","count":1}]},
            {"id":"later","day":5,"refs":[{"lawId":"deterministic:10,0,0","count":1}]}
        ]),
        json!([]),
    );
    e.current(598, [0; 3], 1).unwrap();
    // Days 1..4 tie at P=1/2; the bound is attained only on day 5.
    assert_eq!(
        e.waiting(&mut supply, 598, [0; 3], true).unwrap(),
        expected_bound_certificate(
            5,
            &[0, 1, 2, 3, 4, 5],
            q(15, 1),
            [q(15, 1), q(0, 1), q(0, 1)]
        )
    );
}

#[test]
fn waiting_bound_equal_objectives_keep_actual_color_not_relaxed_color() {
    let mut e = bound_fixture_engine([[1000, 600, 600]; 3], [1; 3]);
    let mut supply = source(
        json!([{"id":"purple","day":1,"refs":[{"lawId":"deterministic:0,10,0","count":1}]}]),
        json!([]),
    );
    e.current(599, [0; 3], 1).unwrap();
    e.ensure_relaxed(599).unwrap();
    assert_eq!(
        json!(e.actual_view(&e.relaxed[599].as_ref().unwrap().value).consumed),
        json!([wire(&q(10, 1)), wire(&q(0, 1)), wire(&q(0, 1))])
    );
    assert_eq!(
        e.waiting(&mut supply, 599, [0; 3], true).unwrap(),
        expected_bound_certificate(1, &[0, 1], q(10, 1), [q(0, 1), q(10, 1), q(0, 1)])
    );
}

#[test]
fn waiting_bound_earliest_tie_uses_that_dates_actual_vector() {
    let e = bound_fixture_engine([[1000, 600, 600]; 3], [1; 3]);
    let purple = [q(1, 1), q(0, 1), q(10, 1), q(0, 1)];
    let blue = [q(1, 1), q(10, 1), q(0, 1), q(0, 1)];
    let values = [[q(0, 1), q(0, 1), q(0, 1), q(0, 1)], purple, blue.clone()];
    assert_eq!(
        e.completed_prefix_bound_certificate(&values, &[0, 1, 2], &blue)
            .unwrap()
            .unwrap(),
        expected_bound_certificate(1, &[0, 1, 2], q(10, 1), [q(0, 1), q(10, 1), q(0, 1)])
    );
}

#[test]
fn waiting_bound_requires_complete_future_coverage() {
    let mut e = engine([2; 3]);
    let mut supply = source(
        json!([{"id":"first","day":1,"refs":[{"lawId":"deterministic:20,0,0","count":1}]}]),
        json!([]),
    );
    e.current(598, [0; 3], 1).unwrap();
    assert_eq!(
        e.waiting(&mut supply, 598, [0; 3], false).unwrap(),
        json!({
            "status":"unresolved","horizonDays":14,"recommendedDays":null,
            "rangeBoundary":false,"bestDayRange":[0,14],"value":null,
            "evaluatedDays":[0],"successImprovementUpperBound":null,
            "successProbabilityInterval":null,"reason":"future_coverage_incomplete",
            "evidence":[]
        })
    );
}

#[test]
fn waiting_bound_incomplete_cohort_date_cannot_certify_an_attaining_first_cohort() {
    let mut e = engine([2; 3]);
    e.max_support = 1;
    let model = serde_json::from_value(json!({
        "snapshotVersion":"certified-daily-v1",
        "events":[{"id":"first","day":1,"refs":[{"lawId":"split","count":1}]}],
        "laws":[{"id":"split","kind":"finite","outcomesByCohort":[
            [{"pieces":[20,0,0],"mass":wire(&q(1,1))}],
            [
                {"pieces":[20,0,0],"mass":wire(&q(1,2))},
                {"pieces":[10,0,0],"mass":wire(&q(1,2))}
            ],
            [{"pieces":[20,0,0],"mass":wire(&q(1,1))}]
        ]}],
        "priors":[wire(&q(1,2)),wire(&q(1,2)),wire(&q(0,1))],
        "populationPrior":([1,2,3,1].map(|n| wire(&q(n,7)))),
        "dispatch":[],"shop":[],"solo":[],"cadence":wire(&q(30,1)),
        "dispatchExpected":vec![vec![wire(&q(1,1));3];3],"classes":[]
    }))
    .unwrap();
    let mut supply = Supply::new(model, f64::MAX).unwrap();
    e.current(598, [0; 3], 1).unwrap();
    assert_eq!(
        e.waiting(&mut supply, 598, [0; 3], true).unwrap(),
        json!({
            "status":"unresolved","horizonDays":14,"recommendedDays":null,
            "rangeBoundary":false,"bestDayRange":[0,14],"value":null,
            "evaluatedDays":[0],"successImprovementUpperBound":wire(&q(1,1)),
            "successProbabilityInterval":{"lower":wire(&q(0,1)),"upper":wire(&q(1,1))},
            "reason":"exact_support_limit",
            "evidence":[
                "PH_lower_bound_from_last_exact_completed_date_and_nonnegative_inventory_coupling",
                "UNKNOWN_is_not_equality_or_false"
            ]
        })
    );
}

#[test]
fn waiting_bound_expired_deadline_cannot_return_a_completed_prefix_certificate() {
    let mut e = engine([2; 3]);
    let bound = [q(1, 1), q(15, 1), q(0, 1), q(0, 1)];
    let values = [
        [q(0, 1), q(0, 1), q(0, 1), q(0, 1)],
        bound.clone(),
    ];
    e.deadline = -1.0;
    assert_eq!(
        e.completed_prefix_bound_certificate(&values, &[0, 1], &bound)
            .unwrap_err(),
        "request_budget_exhausted"
    );
}

#[test]
fn waiting_bound_deadline_error_keeps_existing_unresolved_prefix_behavior() {
    let mut e = engine([2; 3]);
    let mut supply = source(
        json!([{"id":"first","day":1,"refs":[{"lawId":"deterministic:20,0,0","count":1}]}]),
        json!([]),
    );
    e.current(598, [0; 3], 1).unwrap();
    // Cache the relaxation before expiring the native clock; the daily
    // deadline check must retain the existing unresolved result contract.
    e.ensure_relaxed(598).unwrap();
    e.deadline = -1.0;
    let result = e.waiting(&mut supply, 598, [0; 3], true).unwrap();
    assert_eq!(result["status"], json!("unresolved"));
    assert_eq!(result["reason"], json!("request_budget_exhausted"));
    assert_eq!(result["recommendedDays"], Json::Null);
    assert_eq!(result["value"], Json::Null);
    assert_eq!(result["evaluatedDays"], json!([0]));
    assert_eq!(result["bestDayRange"], json!([0, 14]));
    assert_eq!(
        result["successProbabilityInterval"],
        json!({"lower":wire(&q(0,1)),"upper":wire(&q(1,1))})
    );
}

#[test]
fn waiting_bound_preserves_lazy_future_validation_and_propagates_evaluated_errors() {
    for invalid_day in [1, 2] {
        let mut e = engine([2; 3]);
        let mut supply = source(
            json!([
                {"id":"first","day":1,"refs":[{"lawId":"deterministic:20,0,0","count":1}]},
                {"id":"invalid","day":invalid_day,"refs":[{
                    "lawId":"deterministic:9007199254740992,0,0","count":1
                }]}
            ]),
            json!([]),
        );
        e.current(598, [0; 3], 1).unwrap();
        if invalid_day == 1 {
            assert_eq!(
                e.waiting(&mut supply, 598, [0; 3], true).unwrap_err(),
                "certified_law_raw_pieces_invalid"
            );
        } else {
            assert_eq!(
                e.waiting(&mut supply, 598, [0; 3], true).unwrap(),
                expected_bound_certificate(
                    1,
                    &[0, 1],
                    q(15, 1),
                    [q(15, 1), q(0, 1), q(0, 1)]
                )
            );
        }
    }
}

#[test]
fn waiting_bound_retains_day_zero_and_no_supply_certificates() {
    let mut e = engine([2; 3]);
    let mut supply = source(
        json!([{"id":"later","day":1,"refs":[{
            "lawId":"deterministic:9007199254740992,0,0","count":1
        }]}]),
        json!([]),
    );
    e.current(599, [10, 0, 0], 1).unwrap();
    assert_eq!(
        e.waiting(&mut supply, 599, [10, 0, 0], true).unwrap(),
        json!({
            "status":"certified","horizonDays":14,"recommendedDays":0,
            "rangeBoundary":false,"bestDayRange":[0,0],
            "value":{
                "p":wire(&q(1,1)),"b":wire(&q(10,1)),"c":wire(&q(10,1)),
                "consumed":[wire(&q(10,1)),wire(&q(0,1)),wire(&q(0,1))],"mask":1
            },
            "evaluatedDays":[0],"successImprovementUpperBound":wire(&q(0,1)),
            "successProbabilityInterval":{"lower":wire(&q(1,1)),"upper":wire(&q(1,1))},
            "reason":null,
            "evidence":[
                "exact_P_B_C_equal_feasible_unlimited_optimum",
                "fixed_prices_all_dates",
                "nonnegative_nonexpiring_inventory_coupling",
                "range_only_no_deadline"
            ]
        })
    );
    let mut e = engine([2; 3]);
    let mut supply = source(json!([]), json!([]));
    e.current(598, [0; 3], 1).unwrap();
    assert_eq!(
        e.waiting(&mut supply, 598, [0; 3], true).unwrap(),
        json!({
            "status":"certified","horizonDays":14,"recommendedDays":0,
            "rangeBoundary":false,"bestDayRange":[0,0],
            "value":{
                "p":wire(&q(0,1)),"b":wire(&q(0,1)),"c":wire(&q(0,1)),
                "consumed":[wire(&q(0,1)),wire(&q(0,1)),wire(&q(0,1))],"mask":0
            },
            "evaluatedDays":[0],"successImprovementUpperBound":wire(&q(1,1)),
            "successProbabilityInterval":{"lower":wire(&q(0,1)),"upper":wire(&q(0,1))},
            "reason":null,
            "evidence":[
                "no_random_and_no_deterministic_arrivals_in_complete_future_snapshot",
                "exact_all_dates_same_inventory"
            ]
        })
    );
}

#[test]
fn waiting_bound_unattained_keeps_exhaustive_evidence_and_all_fifteen_dates() {
    let mut e = engine([2; 3]);
    let mut supply = remainder_source();
    e.current(598, [0; 3], 1).unwrap();
    let result = e.waiting(&mut supply, 598, [0; 3], true).unwrap();
    assert_eq!(result["evaluatedDays"], json!((0..=14).collect::<Vec<_>>()));
    assert_eq!(
        result["evidence"],
        json!([
            "exact_cohort_conditional_distributions_single_latent_cohort",
            "exact_rational_all_15_date_expectations",
            "fixed_prices_all_dates",
            "nonnegative_nonexpiring_inventory_coupling",
            "exact_previous_day_strict_lex_inequality",
            "range_only_no_global_or_deadline_claim"
        ])
    );
    assert_eq!(
        result["value"],
        json!({
            "p":wire(&q(5,8)),"b":wire(&q(45,4)),"c":wire(&q(45,4)),
            "consumed":[wire(&q(45,4)),wire(&q(0,1)),wire(&q(0,1))],"mask":0
        })
    );
}

#[test]
fn waiting_exhaustive_unattained_bound_returns_earliest_actual_color_vector() {
    let mut e = bound_fixture_engine([[1000, 600, 600]; 3], [2, 2, 1]);
    let mut supply = source(
        json!([
            {"id":"purple","day":1,"refs":[{"lawId":"deterministic:0,10,0","count":1}]},
            {"id":"blue","day":2,"refs":[{"lawId":"deterministic:10,0,0","count":1}]}
        ]),
        json!([]),
    );
    e.current(599, [0; 3], 1).unwrap();
    e.ensure_relaxed(599).unwrap();
    let relaxed = &e.relaxed[599].as_ref().unwrap().value;
    let d = &e.powers[relaxed.exponent];
    let bound = [
        rational(&relaxed.p, d),
        rational(&relaxed.c[0], d),
        rational(&relaxed.c[1], d),
        rational(&relaxed.c[2], d),
    ];
    assert_eq!(bound, [q(1, 1), q(0, 1), q(0, 1), q(10, 1)]);
    let purple = [q(1, 1), q(0, 1), q(10, 1), q(0, 1)];
    let blue = [q(1, 1), q(10, 1), q(0, 1), q(0, 1)];
    // These are ALL reachable date inventories: day 0, day 1, and days 2..14.
    // Gold's relaxed B=10 is never feasible. Both available colors have
    // P=1, B=20, C=10, but the later blue action wins the color tie.
    for (pieces, expected) in [
        ([0, 0, 0], [q(0, 1), q(0, 1), q(0, 1), q(0, 1)]),
        ([0, 10, 0], purple.clone()),
        ([10, 10, 0], blue.clone()),
    ] {
        let actual = e
            .expected_rows(
                599,
                &[Supply::singleton(pieces), vec![], vec![]],
                &[q(1, 1), q(0, 1), q(0, 1)],
            )
            .unwrap();
        assert_eq!(actual, expected);
        assert_eq!(e.qcompare(&actual, &bound), Ordering::Less);
    }
    assert_eq!(e.qcompare(&purple, &blue), Ordering::Equal);
    assert_ne!(purple, blue);
    // Full exhaustive evidence rules out both an F-prefix certificate and a
    // strict boundary witness. The former qview(h) returns blue and fails.
    assert_eq!(
        e.waiting(&mut supply, 599, [0; 3], true).unwrap(),
        json!({
            "status":"certified","horizonDays":14,"recommendedDays":1,
            "rangeBoundary":false,"bestDayRange":[1,1],
            "value":{
                "p":wire(&q(1,1)),"b":wire(&q(20,1)),"c":wire(&q(10,1)),
                "consumed":[wire(&q(0,1)),wire(&q(10,1)),wire(&q(0,1))],"mask":0
            },
            "evaluatedDays":(0..=14).collect::<Vec<_>>(),
            "successImprovementUpperBound":wire(&q(0,1)),
            "successProbabilityInterval":{"lower":wire(&q(1,1)),"upper":wire(&q(1,1))},
            "reason":null,
            "evidence":[
                "exact_cohort_conditional_distributions_single_latent_cohort",
                "exact_rational_all_15_date_expectations",
                "fixed_prices_all_dates",
                "nonnegative_nonexpiring_inventory_coupling",
                "exact_previous_day_strict_lex_inequality",
                "range_only_no_global_or_deadline_claim"
            ]
        })
    );
}

#[test]
fn waiting_bound_first_attained_on_day_fourteen_uses_completed_prefix_certificate() {
    let mut e = bound_fixture_engine([[1000, 600, 600]; 3], [1, 1, 3]);
    let mut supply = source(
        json!([
            {"id":"split","day":1,"refs":[{"lawId":"split","count":1}]},
            {"id":"last","day":14,"refs":[{"lawId":"deterministic:1,1,0","count":1}]}
        ]),
        json!([{"id":"split","kind":"finite","outcomes":[
            {"pieces":[0,10,0],"mass":wire(&q(1,3))},
            {"pieces":[10,0,0],"mass":wire(&q(1,3))},
            {"pieces":[9,9,0],"mass":wire(&q(1,3))}
        ]}]),
    );
    e.current(599, [0; 3], 1).unwrap();
    // The target-blue=0 and all scarce-color trajectories select one of the
    // already successful pure-color rows, so the boundary search finds no
    // strict witness. The unsampled [9,9,0] row fails until day 14: P=2/3 on
    // days 1..13, then P=1, B=C=10. Its final blue tie yields 20/3 blue and
    // 10/3 purple in expectation, not the relaxation's all-blue vector.
    assert_eq!(
        e.waiting(&mut supply, 599, [0; 3], true).unwrap(),
        expected_bound_certificate(
            14,
            &(0..=14).collect::<Vec<_>>(),
            q(10, 1),
            [q(20, 3), q(10, 3), q(0, 1)]
        )
    );
}

#[test]
fn waiting_bound_supply_deadline_keeps_a_nonzero_completed_prefix_lower_bound() {
    let mut e = engine([2; 3]);
    let model = source(
        json!([{"id":"later","day":2,"refs":[{"lawId":"deterministic:10,0,0","count":1}]}]),
        json!([]),
    )
    .model;
    let mut supply = Supply::new(model, -1.0).unwrap();
    e.current(598, [10, 0, 0], 1).unwrap();
    // Day 1 has no receipt and completes at P=1/2. The supply clock expires
    // when day 2's convolution starts; no production/test day hook is needed.
    assert_eq!(
        e.waiting(&mut supply, 598, [10, 0, 0], true).unwrap(),
        json!({
            "status":"unresolved","horizonDays":14,"recommendedDays":null,
            "rangeBoundary":false,"bestDayRange":[0,14],"value":null,
            "evaluatedDays":[0,1],"successImprovementUpperBound":wire(&q(1,2)),
            "successProbabilityInterval":{"lower":wire(&q(1,2)),"upper":wire(&q(1,1))},
            "reason":"request_budget_exhausted",
            "evidence":[
                "PH_lower_bound_from_last_exact_completed_date_and_nonnegative_inventory_coupling",
                "UNKNOWN_is_not_equality_or_false"
            ]
        })
    );
}
