use crate::constants::{
    EXP_BUCKETS, LEVEL_BUCKETS, MAX_USES_B, MAX_USES_P, MAX_USES_Y, STATE_BUCKETS, STATE_DIV,
    STOCK_ID_SIZE, STOCK_P_DIM, STOCK_Y_DIM,
};

const _: () = assert!((STATE_BUCKETS as u64) * (STOCK_ID_SIZE as u64) <= u32::MAX as u64);
const _: () = assert!((STATE_BUCKETS as i64) * (STOCK_ID_SIZE as i64) <= i32::MAX as i64);

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
    debug_assert!((0..=MAX_USES_B).contains(&b));
    debug_assert!((0..=MAX_USES_P).contains(&p));
    debug_assert!((0..=MAX_USES_Y).contains(&y));
    (b * STOCK_P_DIM + p) * STOCK_Y_DIM + y
}

#[inline]
pub(crate) fn memo_key(sid: i32, b: i32, p: i32, y: i32) -> u32 {
    debug_assert!((0..STATE_BUCKETS).contains(&sid));
    (sid * STOCK_ID_SIZE + stock_id(b, p, y)) as u32
}

#[cfg(test)]
#[inline]
pub(crate) fn decode_memo_key(key: u32) -> (i32, i32, i32, i32) {
    let key = key as i32;
    let sid = key / STOCK_ID_SIZE;
    let stock = key % STOCK_ID_SIZE;
    let b = stock / (STOCK_P_DIM * STOCK_Y_DIM);
    let remainder = stock % (STOCK_P_DIM * STOCK_Y_DIM);
    let p = remainder / STOCK_Y_DIM;
    let y = remainder % STOCK_Y_DIM;
    debug_assert_eq!(memo_key(sid, b, p, y), key as u32);
    (sid, b, p, y)
}

#[inline]
pub(crate) fn clamp_stock_uses(b: i32, p: i32, y: i32) -> (i32, i32, i32) {
    (
        b.clamp(0, MAX_USES_B),
        p.clamp(0, MAX_USES_P),
        y.clamp(0, MAX_USES_Y),
    )
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

#[cfg(test)]
mod tests {
    use super::{decode_memo_key, memo_key};
    use crate::constants::{MAX_USES_B, MAX_USES_P, MAX_USES_Y, STATE_BUCKETS};

    #[test]
    fn packed_memo_key_round_trips_boundary_and_interior_values() {
        for (sid, b, p, y) in [
            (0, 0, 0, 0),
            (1, 1, 1, 1),
            (510, 61, 42, 17),
            (STATE_BUCKETS - 1, MAX_USES_B, MAX_USES_P, MAX_USES_Y),
        ] {
            let key = memo_key(sid, b, p, y);
            assert_eq!(decode_memo_key(key), (sid, b, p, y));
        }
    }
}
