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

pub(crate) static mut TX_PROB: f64 = 0.0;
pub(crate) static mut TX_SUCC: i32 = 0;
pub(crate) static mut TX_FAIL: i32 = 0;

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

pub(crate) fn compute_transition(sid: i32, kit: i32) {
    unsafe {
        ensure_transition_table();
        let index = (sid * 3 + kit) as usize;
        TX_PROB = TRANSITION_PROB[index];
        TX_SUCC = TRANSITION_SUCC[index];
        TX_FAIL = TRANSITION_FAIL[index];
    }
}
