// Synthetic two-step exact cases only: no production inputs, WASM or timing loops.
fn continuation_source() -> Supply {
    source(
        json!([
            {"id":"first","day":1,"refs":[{"lawId":"first","count":1}]},
            {"id":"boundary","day":14,"refs":[{"lawId":"deterministic:10,0,0","count":1}]},
            {"id":"outside","day":15,"refs":[{"lawId":"unknown","count":1}]}
        ]),
        json!([{"id":"first","kind":"finite","outcomes":[
            {"pieces":[0,0,0],"mass":wire(&q(1,2))},
            {"pieces":[10,0,0],"mass":wire(&q(1,2))}
        ]}]),
    )
}

fn assert_continuation_prefix(result: &Json, last: usize) {
    let days: Vec<_> = (0..=last).collect();
    assert_eq!(result["evaluatedDays"], json!(days));
    let dates = result["completedDates"]["records"].as_array().unwrap();
    let risks = result["riskSummaries"]["records"].as_array().unwrap();
    assert_eq!(dates.len(), last + 1);
    assert_eq!(risks.len(), last + 1);
    for day in 0..=last {
        assert_eq!(dates[day]["day"], json!(day));
        assert_eq!(risks[day]["day"], json!(day));
        assert_eq!(risks[day]["meanSuccessP"], dates[day]["value"]["p"]);
    }
}

#[test]
fn risk_summary_boundary_continuation_preserves_off_wire_and_collects_exact_dates() {
    let mut off = engine([2; 3]);
    let current = off.current(598, [0; 3], 1).unwrap();
    let plain = off.waiting_with_summaries(
        &mut continuation_source(), 598, [0; 3], true, true, false,
    ).unwrap();
    let off_endpoints = off.waiting_endpoint_solves;
    let off_roots = off.kernel_calls;
    assert_eq!(plain["status"], json!("certified"));
    assert_eq!(plain["recommendedDays"], json!(14));
    assert_eq!(plain["bestDayRange"], json!([14, 14]));
    assert_eq!(plain["rangeBoundary"], json!(true));
    assert_eq!(plain["reason"], Json::Null);
    assert_eq!(plain["value"], Json::Null);
    assert_eq!(plain["evaluatedDays"], json!([0]));
    assert_eq!(plain["completedDates"]["records"],
        json!([{"day":0,"value":completed_dates_zero()}]));
    assert!(plain.get("riskSummaries").is_none());

    let mut legacy = engine([2; 3]);
    legacy.current(598, [0; 3], 1).unwrap();
    let legacy = legacy.waiting_with_completed_dates(
        &mut continuation_source(), 598, [0; 3], true, true,
    ).unwrap();
    assert_eq!(serde_json::to_vec(&plain).unwrap(), serde_json::to_vec(&legacy).unwrap());

    for completed in [false, true] {
        let mut on = engine([2; 3]);
        assert_eq!(on.current(598, [0; 3], 1).unwrap(), current);
        let result = on.waiting_with_summaries(
            &mut continuation_source(), 598, [0; 3], true, completed, true,
        ).unwrap();
        assert_eq!(result["strictBoundaryWitness"], plain["strictBoundaryWitness"]);
        assert_eq!(result["status"], json!("certified"));
        assert_eq!(result["recommendedDays"], json!(14));
        assert_eq!(result["rangeBoundary"], json!(true));
        assert_eq!(result["reason"], Json::Null);
        assert_eq!(result["value"],
            completed_dates_value(q(3, 4), [q(25, 2), Q::zero(), Q::zero()]));
        assert_eq!(result["successProbabilityInterval"],
            json!({"lower":wire(&q(3,4)),"upper":wire(&q(3,4))}));
        assert_eq!(result["successImprovementUpperBound"], json!(wire(&q(1, 4))));
        assert_eq!(result["evaluatedDays"], json!((0..=14).collect::<Vec<_>>()));
        let records = result["riskSummaries"]["records"].as_array().unwrap();
        assert_eq!(records.len(), 15);
        for day in 0..=14 {
            let expected = match day {
                0 => risk_record(day, Q::zero(), Q::one(), Q::zero()),
                14 => risk_record(day, q(3, 4), Q::zero(), q(1, 2)),
                _ => risk_record(day, q(1, 4), q(1, 2), Q::zero()),
            };
            assert_eq!(records[day], expected);
        }
        if completed {
            assert_continuation_prefix(&result, 14);
            for day in 1..14 {
                assert_eq!(result["completedDates"]["records"][day]["value"],
                    completed_dates_value(q(1, 4), [q(5, 1), Q::zero(), Q::zero()]));
            }
        } else {
            assert!(result.get("completedDates").is_none());
        }
        // Two grouped endpoints per arrival date, none for D0/empty dates.
        // Boundary roots are reused; there is no second Current/future engine.
        assert_eq!(on.waiting_endpoint_solves, off_endpoints + 4);
        assert_eq!(on.kernel_calls, off_roots);
        assert_eq!(on.support_peak, 2);
    }
}

#[test]
fn risk_summary_boundary_empty_dates_apply_inclusive_thresholds_without_endpoint_work() {
    let mut e = engine([2; 3]);
    e.edges[598] = [[10, 600, 599]; 3];
    let mut supply = source(json!([
        {"id":"first","day":1,"refs":[{"lawId":"deterministic:10,0,0","count":1}]},
        {"id":"boundary","day":14,"refs":[{"lawId":"deterministic:10,0,0","count":1}]}
    ]), json!([]));
    e.current(598, [0; 3], 1).unwrap();
    let result = e.waiting_with_summaries(&mut supply, 598, [0; 3], true, true, true).unwrap();
    assert_continuation_prefix(&result, 14);
    let records = result["riskSummaries"]["records"].as_array().unwrap();
    assert_eq!(records[1], risk_record(1, q(1, 100), Q::zero(), Q::zero()));
    for day in 2..14 {
        assert_eq!(records[day], risk_record(day, q(1, 100), Q::one(), Q::zero()));
    }
    assert_eq!(records[14], risk_record(14, Q::one(), Q::zero(), Q::one()));
    assert_eq!(result["value"],
        completed_dates_value(Q::one(), [q(199, 10), Q::zero(), Q::zero()]));
    assert!(result.get("strictBoundaryWitness").is_some());
    assert_eq!(e.waiting_endpoint_solves, 4); // two boundary + two date endpoints
}

#[test]
fn risk_summary_boundary_collection_stops_preserve_proof_and_atomic_prior_prefix() {
    for memo_stop in [false, true] {
        let mut e = engine([2; 3]);
        if memo_stop {
            // Boundary uses exactly (598,R1), (599,R1), (598,R2).
            e.max_memo = 3;
        } else {
            e.max_support = 1;
        }
        let mut supply = source(
            json!([
                {"id":"first","day":1,"refs":[{"lawId":"deterministic:10,0,0","count":1}]},
                {"id":"second","day":2,"refs":[{"lawId":"second","count":1}]},
                {"id":"boundary","day":14,"refs":[{"lawId":"deterministic:10,0,0","count":1}]}
            ]),
            json!([{"id":"second","kind":"finite","outcomes":[
                {"pieces":[0,0,0],"mass":wire(&q(1,2))},
                {"pieces":[0,10,0],"mass":wire(&q(1,2))}
            ]}]),
        );
        e.current(598, [0; 3], 1).unwrap();
        let current = json!(e.actual_view(e.current_root.as_ref().unwrap()));
        let result = e.waiting_with_summaries(
            &mut supply, 598, [0; 3], true, true, true,
        ).unwrap();
        assert_continuation_prefix(&result, 1);
        assert_eq!(result["status"], json!("certified"));
        assert_eq!(result["recommendedDays"], json!(14));
        assert_eq!(result["bestDayRange"], json!([14, 14]));
        assert_eq!(result["rangeBoundary"], json!(true));
        assert_eq!(result["value"], Json::Null);
        assert!(result.get("strictBoundaryWitness").is_some());
        assert_eq!(result["reason"], json!(if memo_stop {
            "exact_memo_limit"
        } else {
            "exact_support_limit"
        }));
        assert_eq!(result["successProbabilityInterval"],
            json!({"lower":wire(&q(1,2)),"upper":wire(&Q::one())}));
        assert_eq!(result["riskSummaries"]["records"], json!([
            risk_record(0, Q::zero(), Q::one(), Q::zero()),
            risk_record(1, q(1, 2), Q::zero(), Q::zero())
        ]));
        assert!(result["evidence"].as_array().unwrap().contains(
            &json!("strict_boundary_certificate_retained_date_collection_incomplete")));
        assert_eq!(json!(e.actual_view(e.current_root.as_ref().unwrap())), current);
        if memo_stop {
            // First D2 endpoint was read before the second exhausted admission;
            // neither an expectation nor risk row for D2 may be published.
            assert_eq!(e.waiting_endpoint_solves, 5);
        }
    }
}

#[test]
fn risk_summary_boundary_p1_attainment_keeps_only_actual_completed_prefix() {
    let result = risk_summary_pair(
        || (engine([2; 3]), source(json!([
            {"id":"unneeded-boundary","day":14,"refs":[{"lawId":"unknown","count":1}]}
        ]), json!([]))), 599, [10, 0, 0], true, true,
    );
    assert_eq!(result["recommendedDays"], json!(0));
    assert_continuation_prefix(&result, 0);
    assert_eq!(result["riskSummaries"]["records"],
        json!([risk_record(0, Q::one(), Q::one(), Q::one())]));
    assert!(result.get("strictBoundaryWitness").is_none());
    // No D1..14 record is inferred from the F certificate.
}

#[test]
fn risk_summary_boundary_continuation_keeps_current_h7_prices_and_limits() {
    let mut e = engine([2; 3]);
    let mut supply = source(
        json!([
            {"id":"first","day":1,"refs":[{"lawId":"first","count":1}]},
            {"id":"boundary","day":14,"refs":[{"lawId":"deterministic:10,0,0","count":1}]}
        ]),
        json!([{"id":"first","kind":"finite","outcomes":[
            {"pieces":[0,0,0],"mass":wire(&q(1,2))},
            {"pieces":[5,0,0],"mass":wire(&q(1,2))}
        ]}]),
    );
    e.current(598, [10, 0, 0], 1).unwrap();
    let current = json!(e.actual_view(e.current_root.as_ref().unwrap()));
    let request = e.current_request;
    let prices = e.prices.clone();
    let scale = e.scale.clone();
    let limits = (e.deadline, e.max_memo, e.max_support);
    let h7 = e.minimum_wait(&mut supply, 598, [10, 0, 0], true).unwrap();
    let result = e.waiting_with_summaries(
        &mut supply, 598, [10, 0, 0], true, true, true,
    ).unwrap();
    assert_continuation_prefix(&result, 14);
    assert!(result.get("strictBoundaryWitness").is_some());
    assert_eq!(result["value"],
        completed_dates_value(Q::one(), [q(15, 1), Q::zero(), Q::zero()]));
    assert_eq!(e.minimum_wait(&mut supply, 598, [10, 0, 0], true).unwrap(), h7);
    assert_eq!(json!(e.actual_view(e.current_root.as_ref().unwrap())), current);
    assert_eq!(e.current_request, request);
    assert_eq!(e.prices, prices);
    assert_eq!(e.scale, scale);
    assert_eq!((e.deadline, e.max_memo, e.max_support), limits);
}
