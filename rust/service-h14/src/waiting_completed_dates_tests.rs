// Included in waiting::tests to reuse its existing exact fixtures.
fn completed_dates_pair(
    fixture: impl Fn() -> (Engine, Supply),
    sid: usize,
    stock: Units,
    complete: bool,
) -> (Json, Json) {
    let run = |include_completed_dates| {
        let (mut e, mut supply) = fixture();
        let current = e.current(sid, stock, 1).unwrap();
        assert!(current.get("completedDates").is_none());
        let result = e
            .waiting_with_completed_dates(
                &mut supply,
                sid,
                stock,
                complete,
                include_completed_dates,
            )
            .unwrap();
        let work = (
            e.memo.len(),
            e.primary.len(),
            e.transitions,
            e.support_peak,
            e.kernel_calls,
            e.ticks,
        );
        (result, work)
    };
    let (plain, plain_work) = run(false);
    let (included, included_work) = run(true);
    assert_eq!(plain_work, included_work);
    assert!(plain.get("completedDates").is_none());
    let mut stripped = included.clone();
    stripped.as_object_mut().unwrap().remove("completedDates");
    assert_eq!(
        serde_json::to_vec(&plain).unwrap(),
        serde_json::to_vec(&stripped).unwrap()
    );
    assert_eq!(included["completedDates"]["schemaVersion"], json!(1));
    (plain, included)
}

fn completed_dates_value(p: Q, consumed: [Q; 3]) -> Json {
    let burden = &consumed[0] + &consumed[1] * q(2, 1) + &consumed[2] * q(3, 1);
    json!({
        "p":wire(&p), "b":wire(&burden),
        "c":wire(&consumed.iter().sum::<Q>()),
        "consumed":consumed.iter().map(wire).collect::<Vec<_>>(), "mask":0
    })
}

fn completed_dates_zero() -> Json {
    completed_dates_value(q(0, 1), [q(0, 1), q(0, 1), q(0, 1)])
}

#[test]
fn completed_dates_command_defaults_false_and_dispatches_camel_case_true() {
    let mut request = json!({"op":"waiting","sid":598,"stock":[0,0,0],"complete":true});
    let mut plain = None;
    for flag in [None, Some(false), Some(true)] {
        if let Some(flag) = flag {
            request["includeCompletedDates"] = json!(flag);
        }
        let command: Command = serde_json::from_value(request.clone()).unwrap();
        assert!(matches!(
            &command,
            Command::Waiting { include_completed_dates, .. }
                if *include_completed_dates == flag.unwrap_or(false)
        ));
        let mut e = engine([2; 3]);
        e.current(598, [0; 3], 1).unwrap();
        let result = execute(
            &mut Some(e),
            &mut Some(source(json!([]), json!([]))),
            command,
        )
        .unwrap();
        if flag == Some(true) {
            assert_eq!(
                result["completedDates"],
                json!({"schemaVersion":1,"records":[{"day":0,"value":completed_dates_zero()}]})
            );
        } else {
            assert!(result.get("completedDates").is_none());
            let bytes = serde_json::to_vec(&result).unwrap();
            if let Some(ref expected) = plain {
                assert_eq!(&bytes, expected);
            } else {
                plain = Some(bytes);
            }
        }
    }
    for invalid in [Json::Null, json!(1), json!("true")] {
        request["includeCompletedDates"] = invalid;
        assert!(serde_json::from_value::<Command>(request.clone()).is_err());
    }
}

#[test]
fn completed_dates_day_zero_covers_equal_no_supply_and_incomplete_returns() {
    let (_, empty) = completed_dates_pair(
        || (engine([2; 3]), source(json!([]), json!([]))),
        598,
        [0; 3],
        true,
    );
    assert_eq!(
        empty["completedDates"]["records"],
        json!([{"day":0,"value":completed_dates_zero()}])
    );
    let (_, equal) = completed_dates_pair(
        || {
            (
                engine([2; 3]),
                source(
                    json!([{"id":"later","day":1,"refs":[{"lawId":"unknown","count":1}]}]),
                    json!([]),
                ),
            )
        },
        599,
        [10, 0, 0],
        false,
    );
    assert_eq!(equal["value"]["mask"], json!(1));
    assert_eq!(
        equal["completedDates"]["records"],
        json!([{"day":0,"value":completed_dates_value(q(1,1), [q(10,1),q(0,1),q(0,1)])}])
    );
    let (_, incomplete) = completed_dates_pair(
        || (engine([2; 3]), remainder_source()),
        598,
        [0; 3],
        false,
    );
    assert_eq!(incomplete["reason"], json!("future_coverage_incomplete"));
    assert_eq!(
        incomplete["completedDates"]["records"],
        json!([{"day":0,"value":completed_dates_zero()}])
    );
}

#[test]
fn completed_dates_bound_prefix_does_not_evaluate_or_invent_later_dates() {
    let (_, result) = completed_dates_pair(
        || {
            (
                engine([2; 3]),
                source(
                    json!([
                        {"id":"first","day":1,"refs":[{"lawId":"deterministic:20,0,0","count":1}]},
                        {"id":"later","day":2,"refs":[{"lawId":"unknown","count":1}]}
                    ]),
                    json!([]),
                ),
            )
        },
        598,
        [0; 3],
        true,
    );
    assert_eq!(result["evaluatedDays"], json!([0, 1]));
    assert_eq!(
        result["completedDates"]["records"],
        json!([
            {"day":0,"value":completed_dates_zero()},
            {"day":1,"value":completed_dates_value(q(1,1), [q(15,1),q(0,1),q(0,1)])}
        ])
    );
}

#[test]
fn completed_dates_exhaustive_values_are_exact_actual_expectations() {
    let (_, result) = completed_dates_pair(
        || (engine([2; 3]), remainder_source()),
        598,
        [0; 3],
        true,
    );
    let records = result["completedDates"]["records"].as_array().unwrap();
    assert_eq!(records.len(), 15);
    for (day, record) in records.iter().enumerate() {
        let expected = match day {
            0 => completed_dates_zero(),
            1 => completed_dates_value(q(1, 4), [q(5, 1), q(0, 1), q(0, 1)]),
            _ => completed_dates_value(q(5, 8), [q(45, 4), q(0, 1), q(0, 1)]),
        };
        assert_eq!(record, &json!({"day":day,"value":expected}));
    }
}

#[test]
fn completed_dates_partial_keeps_only_wholly_completed_dates() {
    let (_, memo) = completed_dates_pair(
        || {
            let mut e = engine([2; 3]);
            e.max_memo = 1;
            (
                e,
                source(
                    json!([
                        {"id":"first","day":1,"refs":[{"lawId":"deterministic:10,0,0","count":1}]},
                        {"id":"second","day":2,"refs":[{"lawId":"deterministic:0,10,0","count":1}]}
                    ]),
                    json!([]),
                ),
            )
        },
        598,
        [0; 3],
        true,
    );
    assert_eq!(memo["reason"], json!("exact_memo_limit"));
    assert_eq!(
        memo["completedDates"]["records"],
        json!([
            {"day":0,"value":completed_dates_zero()},
            {"day":1,"value":completed_dates_value(q(1,2), [q(10,1),q(0,1),q(0,1)])}
        ])
    );
    let (_, support) = completed_dates_pair(
        || {
            let mut e = engine([2; 3]);
            e.max_support = 2;
            (e, remainder_source())
        },
        598,
        [0; 3],
        true,
    );
    assert_eq!(support["reason"], json!("exact_support_limit"));
    assert_eq!(
        support["completedDates"]["records"],
        json!([{"day":0,"value":completed_dates_zero()}])
    );
}

#[test]
fn completed_dates_boundary_witness_is_not_a_completed_day_fourteen_value() {
    let (_, result) = completed_dates_pair(
        || {
            (
                engine([2; 3]),
                source(
                    json!([
                        {"id":"boundary","day":14,"refs":[{"lawId":"deterministic:10,0,0","count":1}]},
                        {"id":"outside","day":15,"refs":[{"lawId":"unknown","count":1}]}
                    ]),
                    json!([]),
                ),
            )
        },
        598,
        [0; 3],
        true,
    );
    assert_eq!(result["recommendedDays"], json!(14));
    assert_eq!(result["value"], Json::Null);
    assert!(result.get("strictBoundaryWitness").is_some());
    assert_eq!(
        result["completedDates"]["records"],
        json!([{"day":0,"value":completed_dates_zero()}])
    );
}

#[test]
fn completed_dates_sparse_records_preserve_actual_color_and_reject_invalid_indices() {
    let e = engine([2; 3]);
    let values = [
        [q(0, 1), q(0, 1), q(0, 1), q(0, 1)],
        [q(1, 2), q(0, 1), q(10, 1), q(0, 1)],
        [q(1, 1), q(0, 1), q(0, 1), q(10, 1)],
    ];
    let result = e
        .waiting_result(json!({}), true, &values, &[0, 7, 14])
        .unwrap();
    assert_eq!(
        result["completedDates"]["records"],
        json!([
            {"day":0,"value":completed_dates_zero()},
            {"day":7,"value":completed_dates_value(q(1,2), [q(0,1),q(10,1),q(0,1)])},
            {"day":14,"value":completed_dates_value(q(1,1), [q(0,1),q(0,1),q(10,1)])}
        ])
    );
    for invalid in [&[0, 7][..], &[0, 7, 7], &[0, 14, 7], &[0, 7, 15]] {
        assert_eq!(
            e.waiting_result(json!({}), true, &values, invalid).unwrap_err(),
            "invalid_completed_dates"
        );
    }
}

#[test]
fn completed_dates_serialization_reserves_encoded_bytes_not_record_count() {
    let e = engine([2; 3]);
    let huge = Q::new(BigInt::one(), (BigInt::one() << 4096usize) + 1);
    let make = |p| {
        e.waiting_result(
            json!({}),
            true,
            &[[p, q(0, 1), q(0, 1), q(0, 1)]],
            &[0],
        )
        .unwrap()
    };
    let small = make(q(1, 2));
    let large = make(huge);
    let encoded_small = completed_dates_output(&small, f64::MAX).unwrap();
    let encoded_large = completed_dates_output(&large, f64::MAX).unwrap();
    assert_eq!(encoded_small, serde_json::to_vec(&small).unwrap());
    assert_eq!(encoded_large, serde_json::to_vec(&large).unwrap());
    assert!(encoded_large.len() > encoded_small.len() + 1000);
    assert_eq!(
        completed_dates_output(&large, -1.0).unwrap_err(),
        "request_budget_exhausted"
    );
    let mut size = CompletedDatesOutputSize { bytes: usize::MAX, deadline: f64::MAX };
    assert!(std::io::Write::write(&mut size, b"x").is_err());
}

#[test]
fn completed_dates_generation_deadline_refuses_without_unversioned_success() {
    let mut e = engine([2; 3]);
    let mut supply = remainder_source();
    e.current(598, [0; 3], 1).unwrap();
    e.ensure_relaxed(598).unwrap();
    e.deadline = -1.0;
    let plain = e.waiting(&mut supply, 598, [0; 3], true).unwrap();
    assert_eq!(plain["reason"], json!("request_budget_exhausted"));
    assert_eq!(
        e.waiting_with_completed_dates(&mut supply, 598, [0; 3], true, true)
            .unwrap_err(),
        "request_budget_exhausted"
    );
}
