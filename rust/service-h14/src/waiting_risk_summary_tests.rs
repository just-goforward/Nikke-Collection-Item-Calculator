// Included in waiting::tests; existing current, H7, and completed-date fixtures
// stay untouched. Non-boundary risk-enabled runs share the exact off path;
// strict-boundary continuation is covered separately.
fn risk_summary_pair(
    fixture: impl Fn() -> (Engine, Supply),
    sid: usize,
    stock: Units,
    complete: bool,
    completed_dates: bool,
) -> Json {
    let run = |risk| {
        let (mut e, mut supply) = fixture();
        let current = e.current(sid, stock, 1).unwrap();
        let result = e.waiting_with_summaries(
            &mut supply, sid, stock, complete, completed_dates, risk,
        ).unwrap();
        let work = (
            e.memo.len(), e.primary.len(), e.transitions, e.support_peak,
            e.kernel_calls, e.ticks, e.waiting_endpoint_solves,
        );
        (current, result, work)
    };
    let (plain_current, plain, plain_work) = run(false);
    let (current, included, work) = run(true);
    assert_eq!(current, plain_current);
    assert!(current.get("riskSummaries").is_none());
    assert_eq!(work, plain_work);
    assert!(plain.get("riskSummaries").is_none());
    let mut stripped = included.clone();
    stripped.as_object_mut().unwrap().remove("riskSummaries");
    assert_eq!(serde_json::to_vec(&plain).unwrap(), serde_json::to_vec(&stripped).unwrap());
    assert_eq!(included["riskSummaries"]["schemaVersion"], json!(1));
    assert_eq!(included["riskSummaries"]["policyVersion"], json!("experimental-w-selector-v1"));
    assert_eq!(included["riskSummaries"]["horizonDays"], json!(14));
    assert_eq!(included["riskSummaries"]["records"].as_array().unwrap().len(),
        included["evaluatedDays"].as_array().unwrap().len());
    eprintln!("risk fixture: additionalEndpointSolves=0; off/on endpoint solves={}", work.6);
    included
}

fn risk_record(day: usize, mean: Q, insufficient: Q, certified: Q) -> Json {
    json!({
        "day":day, "meanSuccessP":wire(&mean),
        "insufficientGainMass":wire(&insufficient),
        "noFurtherWaitCertifiedMass":wire(&certified),
        "renewedWaitUpperBound":wire(&(Q::one() - certified))
    })
}

#[test]
fn risk_summary_command_defaults_off_and_is_independent_of_completed_dates() {
    for completed_dates in [false, true] {
        let mut plain = None;
        for flag in [None, Some(false), Some(true)] {
            let mut request = json!({
                "op":"waiting", "sid":598, "stock":[0,0,0], "complete":true,
                "includeCompletedDates":completed_dates
            });
            if let Some(flag) = flag {
                request["includeRiskSummaries"] = json!(flag);
            }
            let command: Command = serde_json::from_value(request.clone()).unwrap();
            assert!(matches!(&command, Command::Waiting { include_risk_summaries, .. }
                if *include_risk_summaries == flag.unwrap_or(false)));
            let mut e = engine([2; 3]);
            e.current(598, [0; 3], 1).unwrap();
            let result = execute(&mut Some(e), &mut Some(source(json!([]), json!([]))), command).unwrap();
            assert_eq!(result.get("completedDates").is_some(), completed_dates);
            if flag == Some(true) {
                assert_eq!(result["riskSummaries"]["records"],
                    json!([risk_record(0, Q::zero(), Q::one(), Q::zero())]));
            } else {
                assert!(result.get("riskSummaries").is_none());
                let bytes = serde_json::to_vec(&result).unwrap();
                if let Some(ref expected) = plain {
                    assert_eq!(&bytes, expected);
                } else {
                    plain = Some(bytes);
                }
            }
            for invalid in [Json::Null, json!(1), json!("true")] {
                request["includeRiskSummaries"] = invalid;
                assert!(serde_json::from_value::<Command>(request.clone()).is_err());
            }
        }
    }
}

#[test]
fn risk_summary_exact_rows_means_and_empty_dates_preserve_completed_wire() {
    for completed in [false, true] {
        let result = risk_summary_pair(
            || (engine([2; 3]), remainder_source()), 598, [0; 3], true, completed,
        );
        let records = result["riskSummaries"]["records"].as_array().unwrap();
        assert_eq!(records.len(), 15);
        for day in 0..=14 {
            let expected = match day {
                0 => risk_record(day, Q::zero(), Q::one(), Q::zero()),
                1 => risk_record(day, q(1, 4), q(1, 2), Q::zero()),
                _ => risk_record(day, q(5, 8), Q::zero(), q(1, 4)),
            };
            assert_eq!(records[day], expected);
            if completed {
                assert_eq!(records[day]["meanSuccessP"],
                    result["completedDates"]["records"][day]["value"]["p"]);
            }
        }
    }
}

#[test]
fn risk_summary_shortcuts_and_incomplete_coverage_supply_only_actual_day_zero() {
    for (sid, stock, complete) in [(598, [0; 3], true), (599, [10, 0, 0], false)] {
        let result = risk_summary_pair(
            || (engine([2; 3]), source(json!([]), json!([]))),
            sid, stock, complete, true,
        );
        let p = if sid == 599 { Q::one() } else { Q::zero() };
        assert_eq!(result["riskSummaries"]["records"],
            json!([risk_record(0, p.clone(), Q::one(), p)]));
    }
    let incomplete = risk_summary_pair(
        || (engine([2; 3]), remainder_source()), 598, [0; 3], false, true,
    );
    assert_eq!(incomplete["reason"], json!("future_coverage_incomplete"));
    assert_eq!(incomplete["riskSummaries"]["records"],
        json!([risk_record(0, Q::zero(), Q::one(), Q::zero())]));
}

#[test]
fn risk_summary_bound_prefix_and_mid_date_failure_never_fabricate_future_records() {
    let prefix = risk_summary_pair(
        || (engine([2; 3]), source(json!([
            {"id":"first","day":1,"refs":[{"lawId":"deterministic:20,0,0","count":1}]},
            {"id":"later","day":2,"refs":[{"lawId":"unknown","count":1}]}
        ]), json!([]))), 598, [0; 3], true, true,
    );
    assert_eq!(prefix["riskSummaries"]["records"], json!([
        risk_record(0, Q::zero(), Q::one(), Q::zero()),
        risk_record(1, Q::one(), Q::zero(), Q::one())
    ]));
    let partial = risk_summary_pair(
        || {
            let mut e = engine([2; 3]);
            e.max_memo = 2;
            (e, source(json!([
                {"id":"first","day":1,"refs":[{"lawId":"deterministic:10,0,0","count":1}]},
                {"id":"second","day":2,"refs":[{"lawId":"second","count":1}]}
            ]), json!([{"id":"second","kind":"finite","outcomes":[
                {"pieces":[10,0,0],"mass":wire(&q(1,2))},
                {"pieces":[0,10,0],"mass":wire(&q(1,2))}
            ]}])))
        }, 598, [0; 3], true, true,
    );
    assert_eq!(partial["reason"], json!("exact_memo_limit"));
    assert_eq!(partial["riskSummaries"]["records"], json!([
        risk_record(0, Q::zero(), Q::one(), Q::zero()),
        risk_record(1, q(1, 2), Q::zero(), Q::zero())
    ]));
    let support = risk_summary_pair(
        || {
            let mut e = engine([2; 3]);
            e.max_support = 2;
            (e, remainder_source())
        }, 598, [0; 3], true, true,
    );
    assert_eq!(support["reason"], json!("exact_support_limit"));
    assert_eq!(support["riskSummaries"]["records"],
        json!([risk_record(0, Q::zero(), Q::one(), Q::zero())]));
}

#[test]
fn risk_summary_cohort_weighted_zero_and_duplicate_rows_reuse_endpoint_q() {
    let mut e = engine([2; 3]);
    let summary = risk_summary::Summaries::new(&Q::zero(), f64::MAX).unwrap();
    let mut accumulator = summary.accumulator();
    let supports = [
        vec![point([10, 0, 0], 1, 2), point([19, 0, 0], 1, 2)],
        vec![point([0, 0, 0], 1, 4), point([20, 0, 0], 3, 4)],
        vec![point([0, 0, 10], 1, 1)],
    ];
    let priors = [q(1, 3), q(2, 3), Q::zero()];
    let expected = e.expected_rows_with_risk(598, &supports, &priors, Some(&mut accumulator)).unwrap();
    let mass = accumulator.finish(f64::MAX).unwrap();
    assert_eq!(expected[0], q(2, 3));
    assert_eq!(e.waiting_endpoint_solves, 3);
    let mut summary = summary;
    summary.complete_date(1, &expected[0], Some(mass), f64::MAX).unwrap();
    let result = risk_summary::attach(json!({}), Some(summary), f64::MAX).unwrap();
    assert_eq!(result["riskSummaries"]["records"][1],
        risk_record(1, q(2, 3), q(1, 6), q(1, 2)));
}

#[test]
fn risk_summary_rejects_source_mass_cancellation_even_in_zero_prior_cohort() {
    for zero_prior in [false, true] {
        let mut e = engine([2; 3]);
        let summary = risk_summary::Summaries::new(&Q::zero(), f64::MAX).unwrap();
        let mut accumulator = summary.accumulator();
        let bad = vec![point([10, 0, 0], -1, 2), point([19, 0, 0], 3, 2)];
        let supports = if zero_prior {
            vec![Supply::singleton([0; 3]), bad]
        } else {
            vec![bad, vec![]]
        };
        assert_eq!(
            e.expected_rows_with_risk(598, &supports, &[Q::one(), Q::zero()], Some(&mut accumulator)).err(),
            Some("invalid_risk_summary_mass")
        );
    }
    for priors in [vec![], vec![q(1, 2)], vec![q(-1, 2), q(3, 2)]] {
        assert_eq!(risk_summary::validate_priors(&priors, f64::MAX), Err("invalid_risk_summary_mass"));
    }
}

#[test]
fn risk_summary_requires_same_current_request_and_preserves_h7_label() {
    let mut e = engine([2; 3]);
    let mut supply = remainder_source();
    e.current(598, [10, 0, 0], 1).unwrap();
    assert_eq!(
        e.waiting_with_summaries(&mut supply, 598, [0; 3], true, false, true).err(),
        Some("risk_summary_current_binding_mismatch")
    );
    let current = serde_json::to_value(e.actual_view(e.current_root.as_ref().unwrap())).unwrap();
    let before = e.minimum_wait(&mut supply, 598, [10, 0, 0], true).unwrap();
    e.waiting_with_summaries(&mut supply, 598, [10, 0, 0], true, true, true).unwrap();
    let after = e.minimum_wait(&mut supply, 598, [10, 0, 0], true).unwrap();
    assert_eq!(before, after);
    assert_eq!(current, serde_json::to_value(e.actual_view(e.current_root.as_ref().unwrap())).unwrap());
}

#[test]
fn risk_summary_serialization_and_expired_generation_use_existing_guard() {
    let huge = Q::new(BigInt::one(), (BigInt::one() << 4096usize) + 1);
    let result = risk_summary::attach(
        json!({}), Some(risk_summary::Summaries::new(&huge, f64::MAX).unwrap()), f64::MAX,
    ).unwrap();
    let encoded = completed_dates_output(&result, f64::MAX).unwrap();
    assert_eq!(encoded, serde_json::to_vec(&result).unwrap());
    assert!(encoded.len() > 1000);
    assert_eq!(completed_dates_output(&result, -1.0).err(), Some("request_budget_exhausted"));
    let mut e = engine([2; 3]);
    let mut supply = remainder_source();
    e.current(598, [0; 3], 1).unwrap();
    e.deadline = -1.0;
    assert_eq!(
        e.waiting_with_summaries(&mut supply, 598, [0; 3], true, false, true).err(),
        Some("request_budget_exhausted")
    );
    assert!(e.current_root.is_some());
}

#[test]
fn risk_summary_small_native_overhead_observation() {
    // Small fixture only: no claim about production, WASM, or hard workloads.
    let mut elapsed = [std::time::Duration::ZERO; 2];
    let mut bytes = [0; 2];
    let mut endpoints = [0; 2];
    for _ in 0..20 {
        for (index, enabled) in [false, true].into_iter().enumerate() {
            let mut e = engine([2; 3]);
            let mut supply = remainder_source();
            e.current(598, [0; 3], 1).unwrap();
            let start = std::time::Instant::now();
            let result = e.waiting_with_summaries(&mut supply, 598, [0; 3], true, true, enabled).unwrap();
            elapsed[index] += start.elapsed();
            bytes[index] = serde_json::to_vec(&result).unwrap().len();
            endpoints[index] = e.waiting_endpoint_solves;
        }
    }
    assert_eq!(endpoints[0], endpoints[1]);
    eprintln!(
        "small native debug fixture, 20 repetitions: off_us={} on_us={} off_bytes={} on_bytes={} endpoint_solves={:?} additionalEndpointSolves=0",
        elapsed[0].as_micros(), elapsed[1].as_micros(), bytes[0], bytes[1], endpoints
    );
}
