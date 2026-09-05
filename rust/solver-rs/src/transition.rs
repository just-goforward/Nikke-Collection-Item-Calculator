use crate::constants::{great_success_prob, KIT_EXP, REQUIRED_EXP, STATE_BUCKETS};
use crate::state::{encode_state, exp100_of, grade_of, level_of};

pub(crate) const CONVERT_SID: i32 = 630;

#[inline]
pub(crate) fn is_terminal(sid: i32) -> bool {
    grade_of(sid) == 1 && level_of(sid) >= 15
}

#[inline]
pub(crate) fn is_convert(sid: i32) -> bool {
    grade_of(sid) == 0 && level_of(sid) >= 15
}

#[inline]
fn next_boundary(level: i32) -> i32 {
    if level < 5 {
        5
    } else if level < 10 {
        10
    } else {
        15
    }
}

fn fail_state_sid(grade_id: i32, mut level: i32, exp100: i32, kit: i32) -> i32 {
    let mut exp = exp100 * 100 + KIT_EXP[kit as usize];
    let required = REQUIRED_EXP[grade_id as usize];
    while exp >= required && level < 15 {
        exp -= required;
        level += 1;
        if level == 5 || level == 10 || level == 15 {
            exp = 0;
            break;
        }
    }
    encode_state(grade_id, level, exp / 100)
}

#[derive(Clone, Copy)]
pub(crate) struct Transition {
    pub(crate) probability: f64,
    pub(crate) success: i32,
    pub(crate) failure: i32,
}

const TRANSITION_TABLE_SIZE: usize = STATE_BUCKETS as usize * 3;
static mut TRANSITION_PROB: [f64; TRANSITION_TABLE_SIZE] = [0.0; TRANSITION_TABLE_SIZE];
static mut TRANSITION_SUCC: [i32; TRANSITION_TABLE_SIZE] = [0; TRANSITION_TABLE_SIZE];
static mut TRANSITION_FAIL: [i32; TRANSITION_TABLE_SIZE] = [0; TRANSITION_TABLE_SIZE];
static mut TRANSITION_TABLE_READY: bool = false;

unsafe fn ensure_transition_table() {
    if TRANSITION_TABLE_READY {
        return;
    }
    for sid in 0..STATE_BUCKETS {
        let grade = grade_of(sid);
        let level = level_of(sid);
        let exp100 = exp100_of(sid);
        for kit in 0..3i32 {
            let index = (sid * 3 + kit) as usize;
            if level >= 15 {
                TRANSITION_PROB[index] = 0.0;
                TRANSITION_SUCC[index] = sid;
                TRANSITION_FAIL[index] = sid;
            } else {
                TRANSITION_PROB[index] = great_success_prob(grade, kit, level);
                TRANSITION_SUCC[index] = encode_state(grade, next_boundary(level), 0);
                TRANSITION_FAIL[index] = fail_state_sid(grade, level, exp100, kit);
            }
        }
    }
    TRANSITION_TABLE_READY = true;
}

pub(crate) fn compute_transition(sid: i32, kit: i32) -> Transition {
    unsafe {
        ensure_transition_table();
        let index = (sid * 3 + kit) as usize;
        Transition {
            probability: TRANSITION_PROB[index],
            success: TRANSITION_SUCC[index],
            failure: TRANSITION_FAIL[index],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{compute_transition, Transition};
    use crate::state::encode_state;

    fn assert_copy<T: Copy>() {}

    #[test]
    fn transition_and_stock_cap_return_the_existing_values() {
        assert_copy::<Transition>();

        let start = encode_state(0, 0, 0);
        let transition = compute_transition(start, 0);
        assert_eq!(
            transition.probability.to_bits(),
            (17.6_f64 / 100.0).to_bits()
        );
        assert_eq!(transition.success, encode_state(0, 5, 0));
        assert_eq!(transition.failure, encode_state(0, 0, 2));
        assert_eq!(
            unsafe { crate::cap_stock(start, 300, 300, 300) },
            (225, 90, 45)
        );

        let terminal = encode_state(1, 15, 0);
        let terminal_transition = compute_transition(terminal, 2);
        assert_eq!(terminal_transition.probability, 0.0);
        assert_eq!(terminal_transition.success, terminal);
        assert_eq!(terminal_transition.failure, terminal);
        assert_eq!(unsafe { crate::cap_stock(terminal, 7, 8, 9) }, (7, 8, 9));
    }
}
