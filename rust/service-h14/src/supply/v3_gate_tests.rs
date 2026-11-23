use super::super::tests::{reference, row, source};
use super::super::*;

fn versioned_model(version: &str) -> Model {
    let mut model = source(json!([
        {"id": "dispatch-board-v1", "kind": "dispatch", "modelVersion": "documented-physical-supply-v2"},
        {"id": "regular-box-v1", "kind": "box", "modelVersion": "documented-physical-supply-v2"},
        {"id": "box-ii-v1", "kind": "box", "modelVersion": "documented-physical-supply-v2"}
    ])).model;
    model.snapshot_version = version.to_owned();
    model.priors = [1, 0, 0, 0]
        .map(|n| wire(&Q::from_integer(n.into())))
        .to_vec();
    model.dispatch_expected = [7, 14, 21, 28]
        .map(|n| {
            [
                wire(&Q::from_integer(n.into())),
                wire(&Q::zero()),
                wire(&Q::zero()),
            ]
        })
        .to_vec();
    model.dispatch = vec![reference("dispatch-board-v1", 1)];
    model
}

#[test]
fn v3_rejects_unused_non_allowlisted_and_wrong_kind_declarations_only_in_v3() {
    for (id, kind) in [
        ("unapproved-v3-law", "box"),
        ("deterministic:10,10,0", "box"),
        ("dispatch-board-v1", "box"),
        ("regular-box-v1", "dispatch"),
        ("box-ii-v1", "dispatch"),
    ] {
        for version in [
            "certified-daily-v1",
            "certified-daily-v2",
            "certified-daily-v3",
            "certified-daily-v4",
        ] {
            let mut model = versioned_model(version);
            let index = model.laws.iter().position(|law| law.id == id).unwrap_or(0);
            model.laws[index] = serde_json::from_value(json!({
                "id": id, "kind": kind, "modelVersion": "documented-physical-supply-v2"
            }))
            .unwrap();
            assert_eq!(
                Supply::new(model, f64::MAX).err(),
                if matches!(version, "certified-daily-v3" | "certified-daily-v4") {
                    Some("certified_v3_law_not_allowlisted")
                } else {
                    None
                },
                "{version}: {id}, {kind}"
            );
        }
    }
}

#[test]
fn v3_requires_declared_physical_model_version_without_changing_legacy_metadata() {
    for metadata in [
        None,
        Some(Json::Null),
        Some(json!("documented-physical-supply-v1")),
        Some(json!(2)),
        Some(json!({})),
    ] {
        for version in [
            "certified-daily-v1",
            "certified-daily-v2",
            "certified-daily-v3",
            "certified-daily-v4",
        ] {
            let mut law = json!({"id": "regular-box-v1", "kind": "box"});
            if let Some(value) = &metadata {
                law["modelVersion"] = value.clone();
            }
            let mut model = versioned_model(version);
            model.laws[1] = serde_json::from_value(law).unwrap();
            assert_eq!(
                Supply::new(model, f64::MAX).err(),
                if matches!(version, "certified-daily-v3" | "certified-daily-v4") {
                    Some("certified_v3_law_not_allowlisted")
                } else {
                    None
                },
                "{version}: {metadata:?}"
            );
        }
    }
}

#[test]
fn v3_accepts_reordered_builtin_declarations_and_equivalent_population_prior() {
    let mut model = versioned_model("certified-daily-v3");
    model.laws.reverse();
    model.population_prior = [2, 4, 6, 2]
        .map(|n| WireQ {
            numerator: n.to_string(),
            denominator: "14".into(),
        })
        .to_vec();
    let mut supply = Supply::new(model, f64::MAX).unwrap();
    assert_eq!(
        supply.pricing([1; 3], [0; 3], TERMINAL).unwrap().0,
        [Q::from_integer(7.into()), Q::zero(), Q::zero()]
    );
    assert_eq!(
        supply.minimum_wait_rates().unwrap(),
        [Q::from_integer(18.into()), Q::zero(), Q::zero()]
    );
}

#[test]
fn v5_requires_three_fixed_cohorts_and_uses_their_population_rate() {
    let fixed: Vec<_> = [1, 2, 3]
        .map(|n| wire(&Q::new(n.into(), 6.into())))
        .to_vec();
    let model = || {
        let mut value = versioned_model("certified-daily-v5");
        value.priors = fixed.clone();
        value.population_prior = fixed.clone();
        value.dispatch_expected.truncate(3);
        value
    };
    let mut supply = Supply::new(model(), f64::MAX).unwrap();
    // Independently: (7 + 2*14 + 3*21)/6 = 49/3. Cohort 3's 28 is absent.
    let expected = [Q::new(49.into(), 3.into()), Q::zero(), Q::zero()];
    assert_eq!(supply.minimum_wait_rates().unwrap(), expected);
    assert_eq!(supply.pricing([1; 3], [0; 3], TERMINAL).unwrap().0, expected);
    assert_eq!(supply.supports(&reference("deterministic:10,10,0", 1)).unwrap().len(), 3);
    for weights in [
        vec![wire(&Q::new(1.into(), 3.into())); 3],
        [1, 0, 0].map(|n| wire(&Q::from_integer(n.into()))).to_vec(),
        [1, 2, 3, 1].map(|n| wire(&Q::new(n.into(), 7.into()))).to_vec(),
    ] {
        let mut personal = model();
        personal.priors = weights.clone();
        assert_eq!(Supply::new(personal, f64::MAX).err(), Some("invalid_cohort_weights"));
        let mut population = model();
        population.population_prior = weights;
        assert_eq!(Supply::new(population, f64::MAX).err(), Some("invalid_population_prior"));
    }
    let mut wrong_arity = model();
    wrong_arity.dispatch_expected.push([wire(&Q::zero()), wire(&Q::zero()), wire(&Q::zero())]);
    assert_eq!(Supply::new(wrong_arity, f64::MAX).err(), Some("invalid_cohort_weights"));
    let mut finite = model();
    finite.laws.push(serde_json::from_value(json!({
        "id": "finite", "kind": "finite", "outcomesByCohort": [[], [], []]
    })).unwrap());
    assert_eq!(Supply::new(finite, f64::MAX).err(), Some("certified_v3_finite_law_forbidden"));
}

#[test]
fn v3_requires_exact_builtin_descriptor_set_without_changing_legacy_laws() {
    let canonical = versioned_model("certified-daily-v3").laws;
    let mut cases = vec![vec![]];
    for index in 0..canonical.len() {
        let mut missing = canonical.clone();
        missing.remove(index);
        cases.push(missing);
        let mut duplicate = canonical.clone();
        duplicate[(index + 1) % canonical.len()] = canonical[index].clone();
        cases.push(duplicate);
        let mut extra = canonical.clone();
        extra.push(canonical[index].clone());
        cases.push(extra);
    }
    for laws in cases {
        for version in [
            "certified-daily-v1",
            "certified-daily-v2",
            "certified-daily-v3",
            "certified-daily-v4",
        ] {
            let mut model = versioned_model(version);
            model.laws = laws.clone();
            assert_eq!(
                Supply::new(model, f64::MAX).err(),
                if matches!(version, "certified-daily-v3" | "certified-daily-v4") {
                    Some("certified_v3_law_not_allowlisted")
                } else {
                    None
                },
                "{version}"
            );
        }
    }
}

#[test]
fn v3_builtin_descriptors_cannot_carry_outcome_overrides() {
    for field in ["outcomes", "outcomesByCohort"] {
        let mut model = versioned_model("certified-daily-v3");
        let mut law = json!({
            "id": "regular-box-v1", "kind": "box",
            "modelVersion": "documented-physical-supply-v2"
        });
        law[field] = if field == "outcomes" {
            json!([row([99, 0, 0], 1, 1)])
        } else {
            json!(vec![vec![row([99, 0, 0], 1, 1)]; 4])
        };
        model.laws[1] = serde_json::from_value(law).unwrap();
        assert_eq!(
            Supply::new(model, f64::MAX).err(),
            Some("certified_v3_law_not_allowlisted")
        );
    }
}

#[test]
fn v3_rejects_all_finite_laws_including_unused_and_shadowing_ids() {
    for id in [
        "novel",
        "dispatch-board-v1",
        "regular-box-v1",
        "box-ii-v1",
        "deterministic:10,10,0",
    ] {
        let mut model = versioned_model("certified-daily-v3");
        model.laws = serde_json::from_value(json!([{
            "id": id, "kind": "finite", "outcomes": [row([10,10,0],1,1)]
        }]))
        .unwrap();
        assert_eq!(
            Supply::new(model, f64::MAX).err(),
            Some("certified_v3_finite_law_forbidden")
        );
    }
}

#[test]
fn v3_rejects_non_allowlisted_refs_in_every_input_even_at_zero_count() {
    for id in [
        "novel",
        "deterministic:10,0,0",
        "deterministic:0,0,0",
        "deterministic:010,10,0",
    ] {
        for slot in 0..4 {
            for count in [0, 1] {
                let mut model = versioned_model("certified-daily-v3");
                let refs = vec![reference(id, count)];
                match slot {
                    0 => model.dispatch = refs,
                    1 => model.shop = refs,
                    2 => model.solo = refs,
                    _ => {
                        model.events = vec![Event {
                            id: "future".into(),
                            day: 1,
                            refs,
                        }]
                    }
                }
                assert_eq!(
                    Supply::new(model, f64::MAX).err(),
                    Some("certified_v3_law_not_allowlisted")
                );
            }
        }
    }
}

#[test]
fn v3_weekly_kits_add_exact_recurring_and_minimum_wait_rates_and_dated_support() {
    let mut model = versioned_model("certified-daily-v3");
    model.shop = vec![reference("box-ii-v1", 5)];
    model.solo = vec![reference("regular-box-v1", 12)];
    let mut baseline = Supply::new(model, f64::MAX).unwrap();
    let rates = baseline.pricing([1; 3], [0; 3], TERMINAL).unwrap().0;
    let minimum_rates = baseline.minimum_wait_rates().unwrap();
    let mut model = baseline.model;
    model.shop.push(reference("deterministic:10,10,0", 1));
    model.events = vec![Event {
        id: "weekly-kits:2026-10-14".into(),
        day: 1,
        refs: vec![reference("deterministic:10,10,0", 1)],
    }];
    let mut weekly = Supply::new(model, f64::MAX).unwrap();
    let weekly_rates = weekly.pricing([1; 3], [0; 3], TERMINAL).unwrap().0;
    let weekly_minimum_rates = weekly.minimum_wait_rates().unwrap();
    let delta = [
        Q::new(10.into(), 7.into()),
        Q::new(10.into(), 7.into()),
        Q::zero(),
    ];
    for k in 0..3 {
        assert_eq!(&weekly_rates[k] - &rates[k], delta[k]);
        assert_eq!(&weekly_minimum_rates[k] - &minimum_rates[k], delta[k]);
    }
    let reference = weekly.model.events[0].refs[0].clone();
    assert_eq!(
        *weekly.supports(&reference).unwrap(),
        vec![vec![[10, 10, 0]]; 4]
    );
}

#[test]
fn legacy_versions_keep_finite_overrides_and_other_deterministic_tuples() {
    for version in ["certified-daily-v1", "certified-daily-v2"] {
        let mut model = versioned_model(version);
        model.laws = serde_json::from_value(json!([{
            "id": "dispatch-board-v1", "kind": "finite", "outcomes": [row([99,0,0],1,1)]
        }]))
        .unwrap();
        model.shop = vec![reference("deterministic:1,2,3", 1)];
        let mut supply = Supply::new(model, f64::MAX).unwrap();
        assert_eq!(
            supply.pricing([1; 3], [0; 3], TERMINAL).unwrap().0,
            [
                Q::new(694.into(), 7.into()),
                Q::new(2.into(), 7.into()),
                Q::new(3.into(), 7.into())
            ]
        );
    }
}

#[test]
fn population_prior_is_versioned_and_distinct_from_personal_priors() {
    let mut supply = Supply::new(versioned_model("certified-daily-v3"), f64::MAX).unwrap();
    assert_eq!(
        supply.population_prior,
        [1, 2, 3, 1].map(|n| Q::new(n.into(), 7.into()))
    );
    assert_eq!(
        supply.pricing([1; 3], [0; 3], TERMINAL).unwrap().0,
        [Q::from_integer(7.into()), Q::zero(), Q::zero()]
    );
    assert_eq!(
        supply.minimum_wait_rates().unwrap(),
        [Q::from_integer(18.into()), Q::zero(), Q::zero()]
    );
    for version in ["certified-daily-v1", "certified-daily-v2"] {
        let mut model = versioned_model(version);
        model.population_prior = [0, 0, 0, 1]
            .map(|n| wire(&Q::from_integer(n.into())))
            .to_vec();
        let mut changed = Supply::new(model, f64::MAX).unwrap();
        assert_eq!(
            changed.minimum_wait_rates().unwrap(),
            [Q::from_integer(28.into()), Q::zero(), Q::zero()]
        );
        assert_eq!(
            changed.pricing([1; 3], [0; 3], TERMINAL).unwrap().0,
            [Q::from_integer(7.into()), Q::zero(), Q::zero()]
        );
    }
}

#[test]
fn v3_rejects_valid_but_noncontract_population_priors_without_changing_legacy_priors() {
    for (numerators, denominator) in [
        ([1, 0, 0, 0], 1),
        ([0, 0, 0, 1], 1),
        ([1, 1, 1, 1], 4),
        ([1, 3, 2, 1], 7),
    ] {
        for version in [
            "certified-daily-v1",
            "certified-daily-v2",
            "certified-daily-v3",
            "certified-daily-v4",
        ] {
            let mut model = versioned_model(version);
            model.population_prior = numerators
                .map(|n| wire(&Q::new(n.into(), denominator.into())))
                .to_vec();
            assert_eq!(
                Supply::new(model, f64::MAX).err(),
                if matches!(version, "certified-daily-v3" | "certified-daily-v4") {
                    Some("invalid_population_prior")
                } else {
                    None
                },
                "{version}: {numerators:?}/{denominator}"
            );
        }
    }
}

#[test]
fn population_prior_rejects_wrong_arity_negative_mass_bad_sums_and_rationals() {
    for values in [
        vec![],
        vec![1, 0, 0],
        vec![1, 0, 0, 0, 0],
        vec![0, 0, 0, 0],
        vec![1, 1, 0, 0],
        vec![-1, 2, 0, 0],
    ] {
        let mut model = versioned_model("certified-daily-v3");
        model.population_prior = values
            .into_iter()
            .map(|n| wire(&Q::from_integer(n.into())))
            .collect();
        assert_eq!(
            Supply::new(model, f64::MAX).err(),
            Some("invalid_population_prior")
        );
    }
    for (numerator, denominator) in [("1", "0"), ("1", "-7"), ("NaN", "7")] {
        let mut model = versioned_model("certified-daily-v3");
        model.population_prior[0] = WireQ {
            numerator: numerator.into(),
            denominator: denominator.into(),
        };
        assert_eq!(Supply::new(model, f64::MAX).err(), Some("invalid_rational"));
    }
}

#[test]
fn versions_are_required_and_unknown_versions_are_rejected() {
    let missing = serde_json::from_value::<Model>(json!({
        "events": [], "laws": [], "priors": [], "populationPrior": [],
        "dispatch": [], "shop": [], "solo": [],
        "cadence": {"numerator": "30", "denominator": "1"},
        "dispatchExpected": [], "classes": []
    }));
    assert!(missing.err().unwrap().to_string().contains("snapshotVersion"));
    for version in ["", "certified-daily-v0", "certified-daily-v6"] {
        assert_eq!(
            Supply::new(versioned_model(version), f64::MAX).err(),
            Some("unsupported_snapshot_version")
        );
        assert!(!super::population_prior_is_allowed(version, &[]));
    }
    assert!(Supply::new(versioned_model("certified-daily-v4"), f64::MAX).is_ok());
}

#[test]
fn v4_same_law_refs_compose_without_deduplicating_counts() {
    let mut supply = Supply::new(versioned_model("certified-daily-v4"), f64::MAX).unwrap();
    let half = supply.law(&reference("deterministic:10,10,0", 32), 0).unwrap();
    let whole = supply.law(&reference("deterministic:10,10,0", 64), 0).unwrap();
    let composed = supply.convolve(&half, &half, [u64::MAX; 3], 100).unwrap();
    assert_eq!(composed.len(), whole.len());
    for (actual, expected) in composed.iter().zip(whole.iter()) {
        assert_eq!(actual.pieces, expected.pieces);
        assert_eq!(actual.mass, expected.mass);
    }
    assert_eq!(whole[0].pieces, [640, 640, 0]);
}
