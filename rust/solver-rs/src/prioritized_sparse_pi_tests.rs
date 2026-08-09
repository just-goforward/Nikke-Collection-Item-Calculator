use super::*;

#[test]
fn packed_state_round_trips_at_domain_edges() {
    for state in [
        UsesState {
            sid: 0,
            blue: 0,
            purple: 0,
            yellow: 0,
        },
        UsesState {
            sid: 959,
            blue: MAX_USES_B,
            purple: MAX_USES_P,
            yellow: MAX_USES_Y,
        },
    ] {
        assert_eq!(
            unpack(memo_key(state.sid, state.blue, state.purple, state.yellow)).sid,
            state.sid
        );
        let unpacked = unpack(memo_key(state.sid, state.blue, state.purple, state.yellow));
        assert_eq!(
            (unpacked.blue, unpacked.purple, unpacked.yellow),
            (state.blue, state.purple, state.yellow)
        );
    }
}

#[test]
fn strict_improvement_preserves_ties() {
    let incumbent = PolicyValue {
        cost: 1.0,
        success: 0.8,
        total_uses: 10.0,
        ..PolicyValue::default()
    };
    assert!(!is_better(incumbent, incumbent));
    assert!(is_better(
        PolicyValue {
            cost: 0.9,
            ..incumbent
        },
        incumbent
    ));
    assert!(is_better(
        PolicyValue {
            total_uses: 9.0,
            ..incumbent
        },
        incumbent
    ));
    assert!(is_better(
        PolicyValue {
            success: 0.9,
            ..incumbent
        },
        incumbent
    ));
}
