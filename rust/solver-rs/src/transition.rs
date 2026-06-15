use crate::constants::{great_success_prob, KIT_EXP, REQUIRED_EXP};
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

pub(crate) fn compute_transition(sid: i32, kit: i32) {
    let g = grade_of(sid);
    let level = level_of(sid);
    let exp100 = exp100_of(sid);
    unsafe {
        TX_PROB = great_success_prob(g, kit, level);
        TX_SUCC = encode_state(g, next_boundary(level), 0);
        TX_FAIL = fail_state_sid(g, level, exp100, kit);
    }
}
