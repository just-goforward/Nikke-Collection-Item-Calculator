//! Version-specific physical-law and population-prior admission rules.
use super::*;

pub(super) fn validate_laws(model: &Model) -> Result<()> {
    let physical = match model.snapshot_version.as_str() {
        "certified-daily-v1" | "certified-daily-v2" => false,
        "certified-daily-v3" | "certified-daily-v4" => true,
        _ => return Err("unsupported_snapshot_version"),
    };
    if physical {
        if model.laws.iter().any(|law| law.kind == "finite") {
            return Err("certified_v3_finite_law_forbidden");
        }
        if model.laws.len() != 3
            || ![
                ("dispatch-board-v1", "dispatch"),
                ("regular-box-v1", "box"),
                ("box-ii-v1", "box"),
            ]
            .iter()
            .all(|(id, kind)| {
                model.laws.iter().any(|law| {
                    law.id == *id
                        && law.kind == *kind
                        && law.model_version.as_ref().and_then(Json::as_str)
                            == Some("documented-physical-supply-v2")
                        && law.outcomes.is_none()
                        && law.outcomes_by_cohort.is_none()
                })
            })
        {
            return Err("certified_v3_law_not_allowlisted");
        }
        if model
            .dispatch
            .iter()
            .chain(&model.shop)
            .chain(&model.solo)
            .chain(model.events.iter().flat_map(|event| &event.refs))
            .any(|reference| {
                !matches!(
                    reference.law_id.as_str(),
                    "dispatch-board-v1" | "regular-box-v1" | "box-ii-v1" | "deterministic:10,10,0"
                )
            })
        {
            return Err("certified_v3_law_not_allowlisted");
        }
    }
    Ok(())
}

pub(super) fn population_prior_is_allowed(version: &str, population_prior: &[Q]) -> bool {
    match version {
        "certified-daily-v1" | "certified-daily-v2" => true,
        "certified-daily-v3" | "certified-daily-v4" => {
            population_prior == [1, 2, 3, 1].map(|n| Q::new(n.into(), 7.into()))
        }
        _ => false,
    }
}

#[cfg(test)]
#[path = "v3_gate_tests.rs"]
mod tests;
