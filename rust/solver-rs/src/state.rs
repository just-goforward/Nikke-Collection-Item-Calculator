use crate::constants::{
    EXP_BUCKETS, LEVEL_BUCKETS, STATE_BUCKETS, STATE_DIV, STOCK_ID_SIZE, STOCK_P_DIM, STOCK_Y_DIM,
};

const _: () = assert!((STATE_BUCKETS as u64) * (STOCK_ID_SIZE as u64) <= u32::MAX as u64);

#[inline]
pub(crate) fn encode_state(grade_id: i32, level: i32, exp100: i32) -> i32 {
    (grade_id * LEVEL_BUCKETS + level) * EXP_BUCKETS + exp100
}

#[inline]
pub(crate) fn grade_of(sid: i32) -> i32 {
    sid / STATE_DIV
}

#[inline]
pub(crate) fn level_of(sid: i32) -> i32 {
    (sid / EXP_BUCKETS) % LEVEL_BUCKETS
}

#[inline]
pub(crate) fn exp100_of(sid: i32) -> i32 {
    sid % EXP_BUCKETS
}

#[inline]
pub(crate) fn stock_id(b: i32, p: i32, y: i32) -> i32 {
    (b * STOCK_P_DIM + p) * STOCK_Y_DIM + y
}

#[inline]
pub(crate) fn memo_key(sid: i32, b: i32, p: i32, y: i32) -> u32 {
    (sid * STOCK_ID_SIZE + stock_id(b, p, y)) as u32
}

#[inline]
pub(crate) fn stock_of(k: i32, b: i32, p: i32, y: i32) -> i32 {
    if k == 0 {
        b
    } else if k == 1 {
        p
    } else {
        y
    }
}
