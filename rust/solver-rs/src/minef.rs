use crate::constants::{
    GAIN_B, GAIN_P, GAIN_Y, MAX_USES_B, MAX_USES_P, MAX_USES_Y, STRICT_EPSILON,
};
use crate::cost::{availability_cost, availability_cost_pre};
use crate::simulation::{next_random, seed_rng};
use crate::state::{clamp_stock_uses, memo_key, stock_of};
use crate::status::{
    reset_status, status_ok, tick_node, LAST_STATUS, STATUS_BUDGET_EXCEEDED, STATUS_MEMO_FULL,
};
use crate::transition::{
    compute_transition, is_convert, is_terminal, CONVERT_SID, TX_FAIL, TX_PROB, TX_SUCC,
};
use crate::{memo_reset, policy_action, solve_start, uses_of};

// ===== minef.ts ==============================================================================
// PORT OF: assembly/minef.ts. min-E[f] policy: SAME τ-gate as value(), secondary criterion = min
// E[f(total)] (terminal-only → decomposable) instead of the Jensen surrogate. UNCAPPED (heavier than
// the capped deployed solve; impractical at the R0/250+ node-count peak). Register-return + memo.
//
// Do not apply phase2's state-dependent cap_stock here. The current min-E[f] state and memo key do
// not retain the removed inventory as an offset, but terminal cost depends on absolute remaining
// inventory. A dominance cap is valid only after that offset is added to the state/key and parity is
// re-proven. ABI inputs are still bounded to the global memo dimensions.
const ME_CAP_DEFAULT: usize = 1 << 21;
static mut ME_CAP: usize = ME_CAP_DEFAULT;
static mut ME_MASK: u32 = (ME_CAP_DEFAULT - 1) as u32;
static mut ME_FULL_GUARD: usize = ME_CAP_DEFAULT - (ME_CAP_DEFAULT >> 3);
static mut ME_KEY: Vec<u32> = Vec::new();
static mut ME_GEN: Vec<u32> = Vec::new();
static mut ME_EPOCH: u32 = 1;
static mut ME_SP: Vec<f64> = Vec::new();
static mut ME_SPMAX: Vec<f64> = Vec::new();
static mut ME_VB: Vec<f64> = Vec::new();
static mut ME_VP: Vec<f64> = Vec::new();
static mut ME_VY: Vec<f64> = Vec::new();
static mut ME_EF: Vec<f64> = Vec::new();
static mut ME_ACT: Vec<i8> = Vec::new();
static mut ME_HF: f64 = 0.75;
static mut ME_NP: f64 = 3.0;
static mut ME_TOL: f64 = 0.0;
static mut ME_INIT_B: f64 = 0.0;
static mut ME_INIT_P: f64 = 0.0;
static mut ME_INIT_Y: f64 = 0.0;
static mut ME_DEN_B: f64 = 0.0;
static mut ME_DEN_P: f64 = 0.0;
static mut ME_DEN_Y: f64 = 0.0;
static mut ME_INV_NP: f64 = 0.0;
static mut ME_START_B: i32 = 0;
static mut ME_START_P: i32 = 0;
static mut ME_START_Y: i32 = 0;
static mut ME_COUNT: usize = 0;
static mut ME_TRAVERSAL_ORDER: [i32; 3] = [0, 1, 2];
#[cfg(feature = "research-branch-bound")]
static mut BB_AUDITED_STATES: usize = 0;
#[cfg(feature = "research-branch-bound")]
static mut BB_POTENTIALLY_ELIGIBLE_ACTIONS: usize = 0;
#[cfg(feature = "research-branch-bound")]
static mut BB_ACTUALLY_ELIGIBLE_ACTIONS: usize = 0;
#[cfg(feature = "research-branch-bound")]
static mut BB_ELIGIBILITY_MISMATCHES: usize = 0;
#[cfg(feature = "research-branch-bound")]
static mut BB_CANONICAL_PRUNABLE_ACTIONS: usize = 0;
#[cfg(feature = "research-branch-bound")]
static mut BB_BEST_FIRST_PRUNABLE_ACTIONS: usize = 0;
#[cfg(feature = "research-branch-bound")]
static mut BB_BOUND_VIOLATIONS: usize = 0;
#[cfg(feature = "research-branch-bound")]
static mut BB_MAX_POLICY_SUCCESS_GAP: f64 = 0.0;
#[cfg(feature = "research-branch-bound")]
const BB_MODE_OFF: i32 = 0;
#[cfg(feature = "research-branch-bound")]
const BB_MODE_PHASE2_PREPASS: i32 = 1;
#[cfg(feature = "research-branch-bound")]
const BB_MODE_COMPACT_PREPASS: i32 = 2;
#[cfg(feature = "research-branch-bound")]
static mut BB_PRUNING_MODE: i32 = BB_MODE_OFF;
#[cfg(feature = "research-branch-bound")]
static mut BB_APPLIED_PRUNES: usize = 0;
#[cfg(feature = "research-branch-bound")]
static mut BB_PREPASS_STATES: usize = 0;
#[cfg(feature = "research-branch-bound")]
static mut BB_PREPASS_MISMATCHES: usize = 0;
#[cfg(feature = "research-branch-bound")]
static mut BB_PREPASS_ROOT_MAX: f64 = 0.0;
#[cfg(feature = "research-branch-bound")]
static mut BB_PREPASS_ROOT_ACTION_VALID: [u8; 3] = [0; 3];
#[cfg(feature = "research-branch-bound")]
static mut BB_PREPASS_ROOT_ACTION_MAX: [f64; 3] = [0.0; 3];
#[cfg(feature = "research-branch-bound")]
const BB_MS_CAP_DEFAULT: usize = 1 << 22;
#[cfg(feature = "research-branch-bound")]
static mut BB_MS_CAP: usize = BB_MS_CAP_DEFAULT;
#[cfg(feature = "research-branch-bound")]
static mut BB_MS_MASK: u32 = (BB_MS_CAP_DEFAULT - 1) as u32;
#[cfg(feature = "research-branch-bound")]
static mut BB_MS_FULL_GUARD: usize = BB_MS_CAP_DEFAULT - (BB_MS_CAP_DEFAULT >> 3);
#[cfg(feature = "research-branch-bound")]
static mut BB_MS_KEY: Vec<u32> = Vec::new();
#[cfg(feature = "research-branch-bound")]
static mut BB_MS_GEN: Vec<u32> = Vec::new();
#[cfg(feature = "research-branch-bound")]
static mut BB_MS_VALUE: Vec<f64> = Vec::new();
#[cfg(feature = "research-branch-bound")]
static mut BB_MS_EPOCH: u32 = 1;
#[cfg(feature = "research-branch-bound")]
static mut BB_MS_COUNT: usize = 0;
#[derive(Clone, Copy)]
struct TerminalCacheLayout {
    p_dim: usize,
    y_dim: usize,
    len: usize,
}
impl TerminalCacheLayout {
    const EMPTY: Self = Self {
        p_dim: 0,
        y_dim: 0,
        len: 0,
    };

    fn new(b: usize, p: usize, y: usize) -> Self {
        let p_dim = p + 1;
        let y_dim = y + 1;
        let len = (b + 1)
            .checked_mul(p_dim)
            .and_then(|value| value.checked_mul(y_dim))
            .expect("terminal cache dimensions must fit usize");
        Self { p_dim, y_dim, len }
    }

    #[inline]
    fn index(self, b: usize, p: usize, y: usize) -> usize {
        debug_assert!(p < self.p_dim);
        debug_assert!(y < self.y_dim);
        let index = (b * self.p_dim + p) * self.y_dim + y;
        debug_assert!(index < self.len);
        index
    }
}
static mut TERM_LAYOUT: TerminalCacheLayout = TerminalCacheLayout::EMPTY;
static mut TERM_VALUE: Vec<f64> = Vec::new();
static mut TERM_GEN: Vec<u32> = Vec::new();
static mut TERM_EPOCH: u32 = 1;
// return registers (the node's chosen result)
static mut MN_SP: f64 = 0.0;
static mut MN_SPMAX: f64 = 0.0;
static mut MN_VB: f64 = 0.0;
static mut MN_VP: f64 = 0.0;
static mut MN_VY: f64 = 0.0;
static mut MN_EF: f64 = 0.0;
static mut MN_ACT: i32 = -1;
// depth-indexed candidate scratch
const ME_MAXDEPTH: usize = 2048;
static mut ME_SC_VALID: Vec<u8> = Vec::new();
static mut ME_SC_SP: Vec<f64> = Vec::new();
static mut ME_SC_SPMAX: Vec<f64> = Vec::new();
static mut ME_SC_VB: Vec<f64> = Vec::new();
static mut ME_SC_VP: Vec<f64> = Vec::new();
static mut ME_SC_VY: Vec<f64> = Vec::new();
static mut ME_SC_EF: Vec<f64> = Vec::new();
static mut MINEF_ROOT_SC_VALID: [u8; 3] = [0; 3];
static mut MINEF_ROOT_SC_SP: [f64; 3] = [0.0; 3];
static mut MINEF_ROOT_SC_VB: [f64; 3] = [0.0; 3];
static mut MINEF_ROOT_SC_VP: [f64; 3] = [0.0; 3];
static mut MINEF_ROOT_SC_VY: [f64; 3] = [0.0; 3];
static mut MINEF_ROOT_SC_EF: [f64; 3] = [0.0; 3];
static mut MINEF_ROOT_MAX_SP: f64 = 0.0;
unsafe fn me_clear_results() {
    ME_COUNT = 0;
    MN_SP = 0.0;
    MN_SPMAX = 0.0;
    MN_VB = 0.0;
    MN_VP = 0.0;
    MN_VY = 0.0;
    MN_EF = 0.0;
    MN_ACT = -1;
    MINEF_ROOT_SC_VALID = [0; 3];
    MINEF_ROOT_SC_SP = [0.0; 3];
    MINEF_ROOT_SC_VB = [0.0; 3];
    MINEF_ROOT_SC_VP = [0.0; 3];
    MINEF_ROOT_SC_VY = [0.0; 3];
    MINEF_ROOT_SC_EF = [0.0; 3];
    MINEF_ROOT_MAX_SP = 0.0;
    #[cfg(feature = "research-branch-bound")]
    {
        BB_AUDITED_STATES = 0;
        BB_POTENTIALLY_ELIGIBLE_ACTIONS = 0;
        BB_ACTUALLY_ELIGIBLE_ACTIONS = 0;
        BB_ELIGIBILITY_MISMATCHES = 0;
        BB_CANONICAL_PRUNABLE_ACTIONS = 0;
        BB_BEST_FIRST_PRUNABLE_ACTIONS = 0;
        BB_BOUND_VIOLATIONS = 0;
        BB_MAX_POLICY_SUCCESS_GAP = 0.0;
        BB_APPLIED_PRUNES = 0;
        BB_PREPASS_STATES = 0;
        BB_PREPASS_MISMATCHES = 0;
        BB_PREPASS_ROOT_MAX = 0.0;
        BB_PREPASS_ROOT_ACTION_VALID = [0; 3];
        BB_PREPASS_ROOT_ACTION_MAX = [0.0; 3];
    }
}

#[cfg(feature = "research-branch-bound")]
unsafe fn bb_ms_release_arrays() {
    BB_MS_KEY = Vec::new();
    BB_MS_GEN = Vec::new();
    BB_MS_VALUE = Vec::new();
    BB_MS_EPOCH = 1;
    BB_MS_COUNT = 0;
}

#[cfg(feature = "research-branch-bound")]
unsafe fn bb_ms_reset() {
    if BB_MS_KEY.is_empty() {
        BB_MS_KEY = vec![0u32; BB_MS_CAP];
        BB_MS_GEN = vec![0u32; BB_MS_CAP];
        BB_MS_VALUE = vec![0.0; BB_MS_CAP];
        BB_MS_EPOCH = 1;
    } else {
        BB_MS_EPOCH = BB_MS_EPOCH.wrapping_add(1);
        if BB_MS_EPOCH == 0 {
            for generation in BB_MS_GEN.iter_mut() {
                *generation = 0;
            }
            BB_MS_EPOCH = 1;
        }
    }
    BB_MS_COUNT = 0;
}

unsafe fn me_release_arrays() {
    ME_KEY = Vec::new();
    ME_GEN = Vec::new();
    ME_EPOCH = 1;
    ME_SP = Vec::new();
    ME_SPMAX = Vec::new();
    ME_VB = Vec::new();
    ME_VP = Vec::new();
    ME_VY = Vec::new();
    ME_EF = Vec::new();
    ME_ACT = Vec::new();
    ME_SC_VALID = Vec::new();
    ME_SC_SP = Vec::new();
    ME_SC_SPMAX = Vec::new();
    ME_SC_VB = Vec::new();
    ME_SC_VP = Vec::new();
    ME_SC_VY = Vec::new();
    ME_SC_EF = Vec::new();
    TERM_LAYOUT = TerminalCacheLayout::EMPTY;
    TERM_VALUE = Vec::new();
    TERM_GEN = Vec::new();
    TERM_EPOCH = 1;
    #[cfg(feature = "research-branch-bound")]
    bb_ms_release_arrays();
    me_clear_results();
}

#[no_mangle]
pub extern "C" fn configureMinEfMemo(cap_log2: i32) {
    unsafe {
        let n = cap_log2.clamp(18, 22) as u32;
        let new_cap = 1usize << n;
        if !ME_KEY.is_empty() && new_cap == ME_CAP {
            return;
        }
        ME_CAP = new_cap;
        ME_MASK = (new_cap - 1) as u32;
        ME_FULL_GUARD = new_cap - (new_cap >> 3);
        me_release_arrays();
    }
}

#[cfg(feature = "research-branch-bound")]
#[no_mangle]
pub extern "C" fn configureMinEfBranchBoundSuccessMemo(cap_log2: i32) {
    unsafe {
        let n = cap_log2.clamp(18, 22) as u32;
        let new_cap = 1usize << n;
        if !BB_MS_KEY.is_empty() && new_cap == BB_MS_CAP {
            return;
        }
        BB_MS_CAP = new_cap;
        BB_MS_MASK = (new_cap - 1) as u32;
        BB_MS_FULL_GUARD = new_cap - (new_cap >> 3);
        bb_ms_release_arrays();
    }
}

// Research-only control for measuring whether candidate traversal order changes probe/recompute
// pressure. Selection and tie-break loops remain in canonical action order.
#[no_mangle]
pub extern "C" fn configureMinEfTraversalOrder(order_code: i32) -> i32 {
    let order = match order_code {
        0 => [0, 1, 2],
        1 => [0, 2, 1],
        2 => [1, 0, 2],
        3 => [1, 2, 0],
        4 => [2, 0, 1],
        5 => [2, 1, 0],
        _ => return 0,
    };
    unsafe {
        ME_TRAVERSAL_ORDER = order;
    }
    1
}

#[no_mangle]
pub extern "C" fn releaseMinEfMemo() {
    unsafe {
        me_release_arrays();
    }
}
#[inline]
unsafe fn me_leaf_cost(b: i32, p: i32, y: i32) -> f64 {
    let cb = ((ME_START_B - b) * 10) as f64;
    let cp = ((ME_START_P - p) * 10) as f64;
    let cy = ((ME_START_Y - y) * 10) as f64;
    availability_cost_pre(cb, cp, cy, ME_DEN_B, ME_DEN_P, ME_DEN_Y, ME_NP, ME_INV_NP)
}
fn terminal_dimension(value: i32, max: i32) -> usize {
    assert!(
        (0..=max).contains(&value),
        "terminal cache dimension outside memo domain"
    );
    value as usize
}
unsafe fn terminal_cache_reset() {
    let layout = TerminalCacheLayout::new(
        terminal_dimension(ME_START_B, MAX_USES_B),
        terminal_dimension(ME_START_P, MAX_USES_P),
        terminal_dimension(ME_START_Y, MAX_USES_Y),
    );
    if TERM_VALUE.len() != layout.len {
        TERM_VALUE = vec![0.0; layout.len];
        TERM_GEN = vec![0; layout.len];
        TERM_EPOCH = 1;
    } else {
        TERM_EPOCH = TERM_EPOCH.wrapping_add(1);
        if TERM_EPOCH == 0 {
            TERM_GEN.fill(0);
            TERM_EPOCH = 1;
        }
    }
    TERM_LAYOUT = layout;
}
#[inline]
unsafe fn me_leaf_cost_cached(b: i32, p: i32, y: i32) -> f64 {
    debug_assert!(b >= 0 && p >= 0 && y >= 0);
    // Correctness requires a bounded bijection shared by reads and writes.
    // Dimension order is a performance choice; benchmark before changing it.
    let index = TERM_LAYOUT.index(b as usize, p as usize, y as usize);
    if TERM_GEN[index] == TERM_EPOCH {
        return TERM_VALUE[index];
    }
    let value = me_leaf_cost(b, p, y);
    TERM_VALUE[index] = value;
    TERM_GEN[index] = TERM_EPOCH;
    value
}

#[cfg(feature = "research-branch-bound")]
#[inline]
unsafe fn bb_ms_hash(stored: u32) -> usize {
    let mut hash = stored;
    hash ^= hash >> 16;
    hash = hash.wrapping_mul(0x85eb_ca6b);
    hash ^= hash >> 13;
    hash = hash.wrapping_mul(0xc2b2_ae35);
    hash ^= hash >> 16;
    (hash & BB_MS_MASK) as usize
}

#[cfg(feature = "research-branch-bound")]
#[inline]
unsafe fn bb_ms_probe(stored: u32) -> usize {
    let mask = BB_MS_MASK as usize;
    let mut index = bb_ms_hash(stored);
    while BB_MS_GEN[index] == BB_MS_EPOCH && BB_MS_KEY[index] != stored {
        index = (index + 1) & mask;
    }
    index
}

#[cfg(feature = "research-branch-bound")]
unsafe fn bb_ms_value(sid: i32, mut b: i32, mut p: i32, mut y: i32, depth: usize) -> f64 {
    if !status_ok() {
        return 0.0;
    }
    if is_terminal(sid) {
        return 1.0;
    }
    if is_convert(sid) {
        return bb_ms_value(CONVERT_SID, b, p, y, depth);
    }
    crate::cap_stock(sid, b, p, y);
    b = crate::CAP_B;
    p = crate::CAP_P;
    y = crate::CAP_Y;
    if b <= 0 && p <= 0 && y <= 0 {
        return 0.0;
    }

    let stored = memo_key(sid, b, p, y) + 1;
    let hit = bb_ms_probe(stored);
    if BB_MS_GEN[hit] == BB_MS_EPOCH {
        return BB_MS_VALUE[hit];
    }
    if BB_MS_COUNT >= BB_MS_FULL_GUARD {
        LAST_STATUS = STATUS_MEMO_FULL;
        return 0.0;
    }
    if depth >= ME_MAXDEPTH {
        LAST_STATUS = STATUS_BUDGET_EXCEEDED;
        return 0.0;
    }

    let mut maximum = 0.0;
    for action in 0..3i32 {
        if stock_of(action, b, p, y) <= 0 {
            continue;
        }
        compute_transition(sid, action);
        let probability = TX_PROB;
        let success_sid = TX_SUCC;
        let failure_sid = TX_FAIL;
        let next_b = b - if action == 0 { 1 } else { 0 };
        let next_p = p - if action == 1 { 1 } else { 0 };
        let next_y = y - if action == 2 { 1 } else { 0 };
        let success = bb_ms_value(success_sid, next_b, next_p, next_y, depth + 1);
        if !status_ok() {
            return 0.0;
        }
        let failure = bb_ms_value(failure_sid, next_b, next_p, next_y, depth + 1);
        if !status_ok() {
            return 0.0;
        }
        let action_maximum = probability * success + (1.0 - probability) * failure;
        if action_maximum > maximum {
            maximum = action_maximum;
        }
    }

    let slot = bb_ms_probe(stored);
    if BB_MS_GEN[slot] != BB_MS_EPOCH {
        if BB_MS_COUNT >= BB_MS_FULL_GUARD {
            LAST_STATUS = STATUS_MEMO_FULL;
            return 0.0;
        }
        BB_MS_KEY[slot] = stored;
        BB_MS_GEN[slot] = BB_MS_EPOCH;
        BB_MS_COUNT += 1;
    }
    BB_MS_VALUE[slot] = maximum;
    maximum
}

#[cfg(feature = "research-branch-bound")]
unsafe fn bb_ms_max_success_for_action(
    sid: i32,
    mut b: i32,
    mut p: i32,
    mut y: i32,
    action: i32,
) -> Option<f64> {
    if !(0..=2).contains(&action) || is_terminal(sid) {
        return None;
    }
    if is_convert(sid) {
        return bb_ms_max_success_for_action(CONVERT_SID, b, p, y, action);
    }
    crate::cap_stock(sid, b, p, y);
    b = crate::CAP_B;
    p = crate::CAP_P;
    y = crate::CAP_Y;
    if stock_of(action, b, p, y) <= 0 {
        return None;
    }
    compute_transition(sid, action);
    let probability = TX_PROB;
    let success_sid = TX_SUCC;
    let failure_sid = TX_FAIL;
    let next_b = b - if action == 0 { 1 } else { 0 };
    let next_p = p - if action == 1 { 1 } else { 0 };
    let next_y = y - if action == 2 { 1 } else { 0 };
    let success = bb_ms_value(success_sid, next_b, next_p, next_y, 1);
    if !status_ok() {
        return None;
    }
    let failure = bb_ms_value(failure_sid, next_b, next_p, next_y, 1);
    if !status_ok() {
        return None;
    }
    Some(probability * success + (1.0 - probability) * failure)
}

#[cfg(feature = "research-branch-bound")]
unsafe fn bb_action_max_success(sid: i32, b: i32, p: i32, y: i32, action: i32) -> Option<f64> {
    match BB_PRUNING_MODE {
        BB_MODE_PHASE2_PREPASS => crate::phase2_max_success_for_action(sid, b, p, y, action),
        BB_MODE_COMPACT_PREPASS => bb_ms_max_success_for_action(sid, b, p, y, action),
        _ => None,
    }
}

#[cfg(feature = "research-branch-bound")]
#[inline]
unsafe fn me_immediate_consumption_lower_bound(b: i32, p: i32, y: i32, action: usize) -> f64 {
    let cb = ((ME_START_B - b) * 10 + if action == 0 { 10 } else { 0 }) as f64;
    let cp = ((ME_START_P - p) * 10 + if action == 1 { 10 } else { 0 }) as f64;
    let cy = ((ME_START_Y - y) * 10 + if action == 2 { 10 } else { 0 }) as f64;
    availability_cost_pre(cb, cp, cy, ME_DEN_B, ME_DEN_P, ME_DEN_Y, ME_NP, ME_INV_NP)
}

#[cfg(feature = "research-branch-bound")]
unsafe fn audit_branch_bound_potential(
    base: usize,
    best_action: usize,
    max_success: f64,
    b: i32,
    p: i32,
    y: i32,
) {
    BB_AUDITED_STATES += 1;
    let best_cost = ME_SC_EF[base + best_action];
    let mut canonical_incumbent = f64::INFINITY;

    for action in 0..3usize {
        let slot = base + action;
        if ME_SC_VALID[slot] == 0 {
            continue;
        }
        let potentially_eligible = max_success - ME_SC_SPMAX[slot] <= ME_TOL + STRICT_EPSILON;
        let actually_eligible = max_success - ME_SC_SP[slot] <= ME_TOL + STRICT_EPSILON;
        if actually_eligible {
            BB_ACTUALLY_ELIGIBLE_ACTIONS += 1;
        }
        if !potentially_eligible {
            continue;
        }
        BB_POTENTIALLY_ELIGIBLE_ACTIONS += 1;
        if !actually_eligible {
            BB_ELIGIBILITY_MISMATCHES += 1;
        }
        let success_gap = ME_SC_SPMAX[slot] - ME_SC_SP[slot];
        if success_gap > BB_MAX_POLICY_SUCCESS_GAP {
            BB_MAX_POLICY_SUCCESS_GAP = success_gap;
        }
        let lower_bound = me_immediate_consumption_lower_bound(b, p, y, action);
        if lower_bound > ME_SC_EF[slot] + STRICT_EPSILON {
            BB_BOUND_VIOLATIONS += 1;
        }
        if action != best_action && lower_bound > best_cost + STRICT_EPSILON {
            BB_BEST_FIRST_PRUNABLE_ACTIONS += 1;
        }
        if lower_bound > canonical_incumbent + STRICT_EPSILON {
            BB_CANONICAL_PRUNABLE_ACTIONS += 1;
        } else if actually_eligible && ME_SC_EF[slot] < canonical_incumbent {
            canonical_incumbent = ME_SC_EF[slot];
        }
    }
}
#[inline]
// The stored key is packed, but the hash must keep the AssemblyScript port's component-wise
// mixing. minef captures an insertion slot before recursing, so a child may occupy that slot and
// change the number of recomputations. Changing probe order can therefore change ME_COUNT and the
// MEMO_FULL fallback boundary even when the policy and floating-point results remain identical.
unsafe fn me_hash(sid: i32, b: i32, p: i32, y: i32) -> usize {
    let mut h: u32 = (sid as u32).wrapping_mul(2654435761);
    h ^= (b as u32).wrapping_mul(40503);
    h ^= (p as u32).wrapping_mul(12289);
    h ^= (y as u32).wrapping_mul(3079);
    h ^= h >> 15;
    h = h.wrapping_mul(0x85eb_ca6b);
    (h & ME_MASK) as usize
}
unsafe fn me_reset() {
    if ME_KEY.is_empty() {
        ME_KEY = vec![0u32; ME_CAP];
        ME_GEN = vec![0u32; ME_CAP];
        ME_EPOCH = 1;
        ME_SP = vec![0.0; ME_CAP];
        ME_SPMAX = vec![0.0; ME_CAP];
        ME_VB = vec![0.0; ME_CAP];
        ME_VP = vec![0.0; ME_CAP];
        ME_VY = vec![0.0; ME_CAP];
        ME_EF = vec![0.0; ME_CAP];
        ME_ACT = vec![0i8; ME_CAP];
        ME_SC_VALID = vec![0u8; ME_MAXDEPTH * 3];
        ME_SC_SP = vec![0.0; ME_MAXDEPTH * 3];
        ME_SC_SPMAX = vec![0.0; ME_MAXDEPTH * 3];
        ME_SC_VB = vec![0.0; ME_MAXDEPTH * 3];
        ME_SC_VP = vec![0.0; ME_MAXDEPTH * 3];
        ME_SC_VY = vec![0.0; ME_MAXDEPTH * 3];
        ME_SC_EF = vec![0.0; ME_MAXDEPTH * 3];
    } else {
        ME_EPOCH = ME_EPOCH.wrapping_add(1);
        if ME_EPOCH == 0 {
            for generation in ME_GEN.iter_mut() {
                *generation = 0;
            }
            ME_EPOCH = 1;
        }
    }
    me_clear_results();
}

unsafe fn minef_node(sid: i32, b: i32, p: i32, y: i32, depth: usize) {
    if !status_ok() {
        return;
    }
    if is_terminal(sid) {
        MN_SP = 1.0;
        MN_SPMAX = 1.0;
        MN_VB = 0.0;
        MN_VP = 0.0;
        MN_VY = 0.0;
        MN_EF = me_leaf_cost_cached(b, p, y);
        MN_ACT = -1;
        return;
    }
    if is_convert(sid) {
        minef_node(CONVERT_SID, b, p, y, depth);
        return;
    }
    let key = memo_key(sid, b, p, y);
    let mut i = me_hash(sid, b, p, y);
    while ME_GEN[i] == ME_EPOCH {
        if ME_KEY[i] == key {
            MN_SP = ME_SP[i];
            MN_SPMAX = ME_SPMAX[i];
            MN_VB = ME_VB[i];
            MN_VP = ME_VP[i];
            MN_VY = ME_VY[i];
            MN_EF = ME_EF[i];
            MN_ACT = ME_ACT[i] as i32;
            return;
        }
        i = (i + 1) & (ME_MASK as usize);
    }
    let slot = i;

    if ME_COUNT >= ME_FULL_GUARD {
        LAST_STATUS = STATUS_MEMO_FULL;
        return;
    }
    if !tick_node() {
        return;
    }
    if depth >= ME_MAXDEPTH {
        LAST_STATUS = STATUS_BUDGET_EXCEEDED;
        return;
    }

    let base = depth * 3;
    let mut max_msp: f64 = 0.0;
    #[cfg(feature = "research-branch-bound")]
    let branch_bound_active = BB_PRUNING_MODE != BB_MODE_OFF && depth > 0;
    #[cfg(not(feature = "research-branch-bound"))]
    let branch_bound_active = false;
    #[cfg(feature = "research-branch-bound")]
    let mut prepass_action_max = [f64::NEG_INFINITY; 3];
    #[cfg(feature = "research-branch-bound")]
    if branch_bound_active {
        for action in 0..3i32 {
            if stock_of(action, b, p, y) <= 0 {
                continue;
            }
            let Some(action_max) = bb_action_max_success(sid, b, p, y, action) else {
                return;
            };
            prepass_action_max[action as usize] = action_max;
            if action_max > max_msp {
                max_msp = action_max;
            }
        }
    }
    let traversal_order = if branch_bound_active {
        [0, 1, 2]
    } else {
        ME_TRAVERSAL_ORDER
    };
    #[cfg(feature = "research-branch-bound")]
    let mut branch_bound_incumbent = f64::INFINITY;
    for k in traversal_order {
        let s = base + k as usize;
        if stock_of(k, b, p, y) <= 0 {
            ME_SC_VALID[s] = 0;
            continue;
        }
        #[cfg(feature = "research-branch-bound")]
        if branch_bound_active {
            let action_max = prepass_action_max[k as usize];
            if max_msp - action_max > ME_TOL + STRICT_EPSILON {
                ME_SC_VALID[s] = 0;
                continue;
            }
            let lower_bound = me_immediate_consumption_lower_bound(b, p, y, k as usize);
            if lower_bound > branch_bound_incumbent + STRICT_EPSILON {
                ME_SC_VALID[s] = 0;
                BB_APPLIED_PRUNES += 1;
                continue;
            }
        }
        compute_transition(sid, k);
        let prob = TX_PROB;
        let succ = TX_SUCC;
        let fail = TX_FAIL;
        let nb = b - if k == 0 { 1 } else { 0 };
        let np = p - if k == 1 { 1 } else { 0 };
        let ny = y - if k == 2 { 1 } else { 0 };

        minef_node(succ, nb, np, ny, depth + 1);
        if !status_ok() {
            return;
        }
        let (cs_sp, cs_spmax, cs_vb, cs_vp, cs_vy, cs_ef) =
            (MN_SP, MN_SPMAX, MN_VB, MN_VP, MN_VY, MN_EF);
        minef_node(fail, nb, np, ny, depth + 1);
        if !status_ok() {
            return;
        }
        let (cf_sp, cf_spmax, cf_vb, cf_vp, cf_vy, cf_ef) =
            (MN_SP, MN_SPMAX, MN_VB, MN_VP, MN_VY, MN_EF);

        let inv = 1.0 - prob;
        ME_SC_VALID[s] = 1;
        ME_SC_SP[s] = prob * cs_sp + inv * cf_sp;
        let amsp = prob * cs_spmax + inv * cf_spmax;
        ME_SC_SPMAX[s] = amsp;
        ME_SC_VB[s] = prob * cs_vb + inv * cf_vb + if k == 0 { 10.0 } else { 0.0 };
        ME_SC_VP[s] = prob * cs_vp + inv * cf_vp + if k == 1 { 10.0 } else { 0.0 };
        ME_SC_VY[s] = prob * cs_vy + inv * cf_vy + if k == 2 { 10.0 } else { 0.0 };
        ME_SC_EF[s] = prob * cs_ef + inv * cf_ef;
        if !branch_bound_active && amsp > max_msp {
            max_msp = amsp;
        }
        #[cfg(feature = "research-branch-bound")]
        if branch_bound_active {
            if (amsp - prepass_action_max[k as usize]).abs() > STRICT_EPSILON {
                BB_PREPASS_MISMATCHES += 1;
            }
            if max_msp - ME_SC_SP[s] <= ME_TOL + STRICT_EPSILON
                && ME_SC_EF[s] < branch_bound_incumbent
            {
                branch_bound_incumbent = ME_SC_EF[s];
            }
        }
    }

    let mut any_valid = false;
    for k in 0..3usize {
        if ME_SC_VALID[base + k] != 0 {
            any_valid = true;
            break;
        }
    }
    if !any_valid {
        MN_SP = 0.0;
        MN_SPMAX = 0.0;
        MN_VB = 0.0;
        MN_VP = 0.0;
        MN_VY = 0.0;
        MN_EF = me_leaf_cost_cached(b, p, y);
        MN_ACT = -1;
        ME_KEY[slot] = key;
        ME_GEN[slot] = ME_EPOCH;
        ME_SP[slot] = 0.0;
        ME_SPMAX[slot] = 0.0;
        ME_VB[slot] = 0.0;
        ME_VP[slot] = 0.0;
        ME_VY[slot] = 0.0;
        ME_EF[slot] = MN_EF;
        ME_ACT[slot] = -1;
        ME_COUNT += 1;
        return;
    }

    let mut any_elig = false;
    for k in 0..3usize {
        let s = base + k;
        if ME_SC_VALID[s] != 0 && max_msp - ME_SC_SP[s] <= ME_TOL + STRICT_EPSILON {
            any_elig = true;
            break;
        }
    }
    let mut best_k: i32 = -1;
    for k in 0..3usize {
        let s = base + k;
        if ME_SC_VALID[s] == 0 {
            continue;
        }
        let eligible = max_msp - ME_SC_SP[s] <= ME_TOL + STRICT_EPSILON;
        if any_elig && !eligible {
            continue;
        }
        if best_k < 0 {
            best_k = k as i32;
            continue;
        }
        let bs = base + best_k as usize;
        let de = ME_SC_EF[s] - ME_SC_EF[bs];
        if de.abs() > STRICT_EPSILON {
            if de < 0.0 {
                best_k = k as i32;
            }
            continue;
        }
        let dt =
            ME_SC_VB[s] + ME_SC_VP[s] + ME_SC_VY[s] - (ME_SC_VB[bs] + ME_SC_VP[bs] + ME_SC_VY[bs]);
        if dt.abs() > STRICT_EPSILON {
            if dt < 0.0 {
                best_k = k as i32;
            }
            continue;
        }
        if ME_SC_SP[s] > ME_SC_SP[bs] {
            best_k = k as i32;
        }
    }

    let bs = base + best_k as usize;
    #[cfg(feature = "research-branch-bound")]
    if depth > 0 && BB_PRUNING_MODE == BB_MODE_OFF {
        audit_branch_bound_potential(base, best_k as usize, max_msp, b, p, y);
    }
    MN_SP = ME_SC_SP[bs];
    MN_SPMAX = max_msp;
    MN_VB = ME_SC_VB[bs];
    MN_VP = ME_SC_VP[bs];
    MN_VY = ME_SC_VY[bs];
    MN_EF = ME_SC_EF[bs];
    MN_ACT = best_k;
    ME_KEY[slot] = key;
    ME_GEN[slot] = ME_EPOCH;
    ME_SP[slot] = MN_SP;
    ME_SPMAX[slot] = MN_SPMAX;
    ME_VB[slot] = MN_VB;
    ME_VP[slot] = MN_VP;
    ME_VY[slot] = MN_VY;
    ME_EF[slot] = MN_EF;
    ME_ACT[slot] = best_k as i8;
    if depth == 0 {
        MINEF_ROOT_MAX_SP = max_msp;
        for k in 0..3usize {
            let s = base + k;
            MINEF_ROOT_SC_VALID[k] = ME_SC_VALID[s];
            MINEF_ROOT_SC_SP[k] = ME_SC_SP[s];
            MINEF_ROOT_SC_VB[k] = ME_SC_VB[s];
            MINEF_ROOT_SC_VP[k] = ME_SC_VP[s];
            MINEF_ROOT_SC_VY[k] = ME_SC_VY[s];
            MINEF_ROOT_SC_EF[k] = ME_SC_EF[s];
        }
    }
    ME_COUNT += 1;
}

#[cfg(feature = "research-branch-bound")]
struct BranchBoundPrepass {
    states: usize,
    root_max: f64,
    root_action_valid: [u8; 3],
    root_action_max: [f64; 3],
}

#[cfg(feature = "research-branch-bound")]
unsafe fn prepare_branch_bound_prepass(
    sid: i32,
    hf: f64,
    np: f64,
    tol: f64,
) -> Option<BranchBoundPrepass> {
    if BB_PRUNING_MODE == BB_MODE_OFF {
        return Some(BranchBoundPrepass {
            states: 0,
            root_max: 0.0,
            root_action_valid: [0; 3],
            root_action_max: [0.0; 3],
        });
    }

    reset_status();
    let root_max = match BB_PRUNING_MODE {
        BB_MODE_PHASE2_PREPASS => {
            memo_reset();
            solve_start(
                sid, ME_START_B, ME_START_P, ME_START_Y, ME_INIT_B, ME_INIT_P, ME_INIT_Y, hf, np,
                tol,
            );
            if !status_ok() {
                return None;
            }
            crate::ROOT_SC_MAX_SP
        }
        BB_MODE_COMPACT_PREPASS => {
            bb_ms_reset();
            let maximum = bb_ms_value(sid, ME_START_B, ME_START_P, ME_START_Y, 0);
            if !status_ok() {
                return None;
            }
            maximum
        }
        _ => return None,
    };

    let mut root_action_valid = [0u8; 3];
    let mut root_action_max = [0.0; 3];
    for action in 0..3i32 {
        if stock_of(action, ME_START_B, ME_START_P, ME_START_Y) <= 0 {
            continue;
        }
        let maximum = bb_action_max_success(sid, ME_START_B, ME_START_P, ME_START_Y, action)?;
        if !status_ok() {
            return None;
        }
        root_action_valid[action as usize] = 1;
        root_action_max[action as usize] = maximum;
    }
    let states = if BB_PRUNING_MODE == BB_MODE_PHASE2_PREPASS {
        crate::COUNT
    } else {
        BB_MS_COUNT
    };
    Some(BranchBoundPrepass {
        states,
        root_max,
        root_action_valid,
        root_action_max,
    })
}

#[no_mangle]
pub extern "C" fn solveMinEf(sid: i32, pb: i32, pp: i32, py: i32, hf: f64, np: f64, tol: f64) {
    unsafe {
        ME_HF = hf;
        ME_NP = np;
        ME_TOL = tol;
        ME_INIT_B = pb as f64;
        ME_INIT_P = pp as f64;
        ME_INIT_Y = py as f64;
        ME_DEN_B = ME_INIT_B + hf * GAIN_B;
        ME_DEN_P = ME_INIT_P + hf * GAIN_P;
        ME_DEN_Y = ME_INIT_Y + hf * GAIN_Y;
        ME_INV_NP = 1.0 / np;
        ME_START_B = uses_of(pb, MAX_USES_B);
        ME_START_P = uses_of(pp, MAX_USES_P);
        ME_START_Y = uses_of(py, MAX_USES_Y);
        #[cfg(feature = "research-branch-bound")]
        let Some(prepass) = prepare_branch_bound_prepass(sid, hf, np, tol) else {
            return;
        };
        reset_status();
        terminal_cache_reset();
        me_reset();
        #[cfg(feature = "research-branch-bound")]
        {
            BB_PREPASS_STATES = prepass.states;
            BB_PREPASS_ROOT_MAX = prepass.root_max;
            BB_PREPASS_ROOT_ACTION_VALID = prepass.root_action_valid;
            BB_PREPASS_ROOT_ACTION_MAX = prepass.root_action_max;
        }
        minef_node(sid, ME_START_B, ME_START_P, ME_START_Y, 0);
    }
}

#[cfg(test)]
mod terminal_cache_tests {
    use super::TerminalCacheLayout;

    #[test]
    fn layout_uses_the_expected_dense_capacity() {
        let small = TerminalCacheLayout::new(6, 12, 44);
        assert_eq!(small.len, 7 * 13 * 45);
        assert_eq!(small.index(0, 0, 0), 0);
        assert_eq!(small.index(6, 12, 44), small.len - 1);

        let maximum = TerminalCacheLayout::new(220, 88, 44);
        assert_eq!(maximum.len, 885_105);
    }

    #[test]
    fn layout_is_a_bounded_bijection() {
        let layout = TerminalCacheLayout::new(3, 2, 4);
        let mut seen = vec![false; layout.len];

        for b in 0..=3 {
            for p in 0..=2 {
                for y in 0..=4 {
                    let index = layout.index(b, p, y);
                    assert!(index < layout.len);
                    assert!(!std::mem::replace(&mut seen[index], true));
                }
            }
        }

        assert!(seen.into_iter().all(|occupied| occupied));
    }
}
#[no_mangle]
pub extern "C" fn minEfAction() -> i32 {
    unsafe { MN_ACT }
}
#[no_mangle]
pub extern "C" fn minEfSuccessProb() -> f64 {
    unsafe { MN_SP }
}
#[no_mangle]
pub extern "C" fn minEfMaxSuccessProb() -> f64 {
    unsafe { MN_SPMAX }
}
#[no_mangle]
pub extern "C" fn minEfVecB() -> f64 {
    unsafe { MN_VB }
}
#[no_mangle]
pub extern "C" fn minEfVecP() -> f64 {
    unsafe { MN_VP }
}
#[no_mangle]
pub extern "C" fn minEfVecY() -> f64 {
    unsafe { MN_VY }
}
#[no_mangle]
pub extern "C" fn minEfExpectedCost() -> f64 {
    unsafe { MN_EF }
}
#[no_mangle]
pub extern "C" fn minEfNodeCount() -> i32 {
    unsafe { ME_COUNT as i32 }
}
#[cfg(feature = "research-branch-bound")]
#[no_mangle]
pub extern "C" fn minEfBranchBoundAuditedStates() -> i32 {
    unsafe { BB_AUDITED_STATES as i32 }
}
#[cfg(feature = "research-branch-bound")]
#[no_mangle]
pub extern "C" fn minEfBranchBoundPotentiallyEligibleActions() -> i32 {
    unsafe { BB_POTENTIALLY_ELIGIBLE_ACTIONS as i32 }
}
#[cfg(feature = "research-branch-bound")]
#[no_mangle]
pub extern "C" fn minEfBranchBoundActuallyEligibleActions() -> i32 {
    unsafe { BB_ACTUALLY_ELIGIBLE_ACTIONS as i32 }
}
#[cfg(feature = "research-branch-bound")]
#[no_mangle]
pub extern "C" fn minEfBranchBoundEligibilityMismatches() -> i32 {
    unsafe { BB_ELIGIBILITY_MISMATCHES as i32 }
}
#[cfg(feature = "research-branch-bound")]
#[no_mangle]
pub extern "C" fn minEfBranchBoundCanonicalPrunableActions() -> i32 {
    unsafe { BB_CANONICAL_PRUNABLE_ACTIONS as i32 }
}
#[cfg(feature = "research-branch-bound")]
#[no_mangle]
pub extern "C" fn minEfBranchBoundBestFirstPrunableActions() -> i32 {
    unsafe { BB_BEST_FIRST_PRUNABLE_ACTIONS as i32 }
}
#[cfg(feature = "research-branch-bound")]
#[no_mangle]
pub extern "C" fn minEfBranchBoundViolations() -> i32 {
    unsafe { BB_BOUND_VIOLATIONS as i32 }
}
#[cfg(feature = "research-branch-bound")]
#[no_mangle]
pub extern "C" fn minEfBranchBoundMaxPolicySuccessGap() -> f64 {
    unsafe { BB_MAX_POLICY_SUCCESS_GAP }
}
#[cfg(feature = "research-branch-bound")]
#[no_mangle]
pub extern "C" fn configureMinEfBranchBoundPruning(mode: i32) -> i32 {
    if !(BB_MODE_OFF..=BB_MODE_COMPACT_PREPASS).contains(&mode) {
        return 0;
    }
    unsafe {
        BB_PRUNING_MODE = mode;
    }
    1
}
#[cfg(feature = "research-branch-bound")]
#[no_mangle]
pub extern "C" fn minEfBranchBoundAppliedPrunes() -> i32 {
    unsafe { BB_APPLIED_PRUNES as i32 }
}
#[cfg(feature = "research-branch-bound")]
#[no_mangle]
pub extern "C" fn minEfBranchBoundPrepassStates() -> i32 {
    unsafe { BB_PREPASS_STATES as i32 }
}
#[cfg(feature = "research-branch-bound")]
#[no_mangle]
pub extern "C" fn minEfBranchBoundPrepassMismatches() -> i32 {
    unsafe { BB_PREPASS_MISMATCHES as i32 }
}
#[cfg(feature = "research-branch-bound")]
#[no_mangle]
pub extern "C" fn minEfBranchBoundOracleStates() -> i32 {
    unsafe {
        if BB_PRUNING_MODE == BB_MODE_PHASE2_PREPASS {
            crate::COUNT as i32
        } else if BB_PRUNING_MODE == BB_MODE_COMPACT_PREPASS {
            BB_MS_COUNT as i32
        } else {
            0
        }
    }
}
#[cfg(feature = "research-branch-bound")]
#[no_mangle]
pub extern "C" fn minEfBranchBoundPrepassRootMaxSuccess() -> f64 {
    unsafe { BB_PREPASS_ROOT_MAX }
}
#[cfg(feature = "research-branch-bound")]
#[no_mangle]
pub extern "C" fn minEfBranchBoundPrepassRootActionValid(action: i32) -> i32 {
    if !(0..=2).contains(&action) {
        return 0;
    }
    unsafe { BB_PREPASS_ROOT_ACTION_VALID[action as usize] as i32 }
}
#[cfg(feature = "research-branch-bound")]
#[no_mangle]
pub extern "C" fn minEfBranchBoundPrepassRootActionMaxSuccess(action: i32) -> f64 {
    if !(0..=2).contains(&action) {
        return 0.0;
    }
    unsafe { BB_PREPASS_ROOT_ACTION_MAX[action as usize] }
}
#[no_mangle]
pub extern "C" fn minEfRootCandidateValid(action: i32) -> i32 {
    if !(0..=2).contains(&action) {
        return 0;
    }
    unsafe { MINEF_ROOT_SC_VALID[action as usize] as i32 }
}
#[no_mangle]
pub extern "C" fn minEfRootCandidateMaxSuccessProb() -> f64 {
    unsafe { MINEF_ROOT_MAX_SP }
}
#[no_mangle]
pub extern "C" fn minEfRootCandidateSuccessProb(action: i32) -> f64 {
    if !(0..=2).contains(&action) {
        return 0.0;
    }
    unsafe { MINEF_ROOT_SC_SP[action as usize] }
}
#[no_mangle]
pub extern "C" fn minEfRootCandidateVecB(action: i32) -> f64 {
    if !(0..=2).contains(&action) {
        return 0.0;
    }
    unsafe { MINEF_ROOT_SC_VB[action as usize] }
}
#[no_mangle]
pub extern "C" fn minEfRootCandidateVecP(action: i32) -> f64 {
    if !(0..=2).contains(&action) {
        return 0.0;
    }
    unsafe { MINEF_ROOT_SC_VP[action as usize] }
}
#[no_mangle]
pub extern "C" fn minEfRootCandidateVecY(action: i32) -> f64 {
    if !(0..=2).contains(&action) {
        return 0.0;
    }
    unsafe { MINEF_ROOT_SC_VY[action as usize] }
}
#[no_mangle]
pub extern "C" fn minEfRootCandidateExpectedCost(action: i32) -> f64 {
    if !(0..=2).contains(&action) {
        return f64::INFINITY;
    }
    unsafe { MINEF_ROOT_SC_EF[action as usize] }
}
// policy lookup for the MC validator: chosen action at (sid, stock uses) from the last solveMinEf memo.
unsafe fn min_ef_action_at(sid: i32, b: i32, p: i32, y: i32) -> i32 {
    let key = memo_key(sid, b, p, y);
    let mut i = me_hash(sid, b, p, y);
    while ME_GEN[i] == ME_EPOCH {
        if ME_KEY[i] == key {
            return ME_ACT[i] as i32;
        }
        i = (i + 1) & (ME_MASK as usize);
    }
    -1
}
#[no_mangle]
pub extern "C" fn minEfActionAt(sid: i32, b: i32, p: i32, y: i32) -> i32 {
    unsafe {
        let (bounded_b, bounded_p, bounded_y) = clamp_stock_uses(b, p, y);
        min_ef_action_at(sid, bounded_b, bounded_p, bounded_y)
    }
}
#[no_mangle]
pub extern "C" fn minEfActionAtOrSolve(sid: i32, b: i32, p: i32, y: i32) -> i32 {
    unsafe {
        reset_status();
        let (bounded_b, bounded_p, bounded_y) = clamp_stock_uses(b, p, y);
        let cached = min_ef_action_at(sid, bounded_b, bounded_p, bounded_y);
        if cached >= 0 {
            return cached;
        }
        minef_node(sid, bounded_b, bounded_p, bounded_y, 0);
        if !status_ok() {
            return -1;
        }
        MN_ACT
    }
}

// INDEPENDENT Monte-Carlo estimate of E[f] under a policy (mode 0 deployed / 1 min-E[f]) — samples +
// averages f(realized total), a different path than the DP, so MC≈DP cross-checks the DP's expectation.
static mut MC_EF_MEAN: f64 = 0.0;
static mut MC_EF_SUMSQ: f64 = 0.0;
static mut MC_EF_RUNS: i32 = 0;
static mut MC_EF_COMPLETED: i32 = 0;
static mut PAIR_BASE_MEAN: f64 = 0.0;
static mut PAIR_SELECTED_MEAN: f64 = 0.0;
static mut PAIR_DELTA_MEAN: f64 = 0.0;
static mut PAIR_DELTA_SUMSQ: f64 = 0.0;
static mut PAIR_BASE_SUMSQ: f64 = 0.0;
static mut PAIR_SELECTED_SUMSQ: f64 = 0.0;
static mut PAIR_CROSS_SUM: f64 = 0.0;
static mut PAIR_RUNS: i32 = 0;
#[no_mangle]
pub extern "C" fn getMcEf() -> f64 {
    unsafe { MC_EF_MEAN }
}
#[no_mangle]
pub extern "C" fn getMcEfSumSq() -> f64 {
    unsafe { MC_EF_SUMSQ }
}
#[no_mangle]
pub extern "C" fn getMcEfRuns() -> i32 {
    unsafe { MC_EF_RUNS }
}
#[no_mangle]
pub extern "C" fn getMcEfCompletion() -> f64 {
    unsafe {
        if MC_EF_RUNS > 0 {
            MC_EF_COMPLETED as f64 / MC_EF_RUNS as f64
        } else {
            0.0
        }
    }
}

#[no_mangle]
pub extern "C" fn getPairMeanBaseline() -> f64 {
    unsafe { PAIR_BASE_MEAN }
}
#[no_mangle]
pub extern "C" fn getPairMeanSelected() -> f64 {
    unsafe { PAIR_SELECTED_MEAN }
}
#[no_mangle]
pub extern "C" fn getPairMeanDelta() -> f64 {
    unsafe { PAIR_DELTA_MEAN }
}
#[no_mangle]
pub extern "C" fn getPairDeltaSumSq() -> f64 {
    unsafe { PAIR_DELTA_SUMSQ }
}
#[no_mangle]
pub extern "C" fn getPairRuns() -> i32 {
    unsafe { PAIR_RUNS }
}
#[no_mangle]
pub extern "C" fn getPairCorrelation() -> f64 {
    unsafe {
        if PAIR_RUNS <= 0 {
            return 0.0;
        }
        let runs = PAIR_RUNS as f64;
        let cov = PAIR_CROSS_SUM / runs - PAIR_BASE_MEAN * PAIR_SELECTED_MEAN;
        let base_var = PAIR_BASE_SUMSQ / runs - PAIR_BASE_MEAN * PAIR_BASE_MEAN;
        let selected_var = PAIR_SELECTED_SUMSQ / runs - PAIR_SELECTED_MEAN * PAIR_SELECTED_MEAN;
        if base_var <= 0.0 || selected_var <= 0.0 {
            return 0.0;
        }
        cov / (base_var.sqrt() * selected_var.sqrt())
    }
}

#[inline]
fn subseed(seed: u32, run_index: i32) -> u32 {
    let mut x = seed ^ (run_index as u32).wrapping_mul(0x9E37_79B9);
    x ^= x >> 16;
    x = x.wrapping_mul(0x7FEB_352D);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846C_A68B);
    x ^ (x >> 16)
}

#[allow(
    clippy::too_many_arguments,
    reason = "hot loop passes scalar state without allocation"
)]
unsafe fn simulate_expected_f_once(
    start_sid: i32,
    b0: i32,
    p0: i32,
    y0: i32,
    init_b: f64,
    init_p: f64,
    init_y: f64,
    hf: f64,
    np: f64,
    first_action: i32,
) -> (f64, bool) {
    let mut sid = start_sid;
    let (mut b, mut p, mut y) = (b0, p0, y0);
    let (mut ub, mut up, mut uy) = (0, 0, 0);
    let mut force_first = true;
    let mut completed = false;
    for _ in 0..1000 {
        if is_terminal(sid) {
            completed = true;
            break;
        }
        if is_convert(sid) {
            sid = CONVERT_SID;
            continue;
        }
        let k = if force_first {
            force_first = false;
            first_action
        } else {
            policy_action(sid, b, p, y)
        };
        if k < 0 || stock_of(k, b, p, y) <= 0 {
            break;
        }
        if k == 0 {
            b -= 1;
            ub += 10;
        } else if k == 1 {
            p -= 1;
            up += 10;
        } else {
            y -= 1;
            uy += 10;
        }
        compute_transition(sid, k);
        sid = if next_random() < TX_PROB {
            TX_SUCC
        } else {
            TX_FAIL
        };
    }
    (
        availability_cost(
            ub as f64, up as f64, uy as f64, init_b, init_p, init_y, hf, np,
        ),
        completed,
    )
}

#[allow(
    clippy::too_many_arguments,
    reason = "matches the research rollout export contract"
)]
unsafe fn simulate_expected_f_after_first_action_policy(
    start_sid: i32,
    b0: i32,
    p0: i32,
    y0: i32,
    init_b: f64,
    init_p: f64,
    init_y: f64,
    hf: f64,
    np: f64,
    runs: i32,
    seed: u32,
    first_action: i32,
) {
    if !(0..=2).contains(&first_action) {
        MC_EF_MEAN = f64::INFINITY;
        MC_EF_SUMSQ = f64::INFINITY;
        MC_EF_RUNS = runs;
        MC_EF_COMPLETED = 0;
        return;
    }

    seed_rng(seed);
    let mut sum_f = 0.0;
    let mut sum_sq = 0.0;
    let mut completed = 0;
    for _ in 0..runs {
        let (f, done) = simulate_expected_f_once(
            start_sid,
            b0,
            p0,
            y0,
            init_b,
            init_p,
            init_y,
            hf,
            np,
            first_action,
        );
        if done {
            completed += 1;
        }
        sum_f += f;
        sum_sq += f * f;
    }
    MC_EF_MEAN = if runs > 0 { sum_f / runs as f64 } else { 0.0 };
    MC_EF_SUMSQ = sum_sq;
    MC_EF_RUNS = runs;
    MC_EF_COMPLETED = completed;
}

#[no_mangle]
pub extern "C" fn simulateExpectedFAfterFirstAction(
    start_sid: i32,
    b0: i32,
    p0: i32,
    y0: i32,
    init_b: f64,
    init_p: f64,
    init_y: f64,
    hf: f64,
    np: f64,
    tol: f64,
    runs: i32,
    seed: u32,
    first_action: i32,
) {
    unsafe {
        reset_status();
        memo_reset();
        solve_start(start_sid, b0, p0, y0, init_b, init_p, init_y, hf, np, tol);
        if !status_ok() {
            MC_EF_MEAN = 0.0;
            MC_EF_SUMSQ = 0.0;
            MC_EF_RUNS = runs;
            MC_EF_COMPLETED = 0;
            return;
        }

        simulate_expected_f_after_first_action_policy(
            start_sid,
            b0,
            p0,
            y0,
            init_b,
            init_p,
            init_y,
            hf,
            np,
            runs,
            seed,
            first_action,
        );
    }
}
#[no_mangle]
pub extern "C" fn simulateExpectedFAfterFirstActionFromPolicy(
    start_sid: i32,
    b0: i32,
    p0: i32,
    y0: i32,
    init_b: f64,
    init_p: f64,
    init_y: f64,
    hf: f64,
    np: f64,
    runs: i32,
    seed: u32,
    first_action: i32,
) {
    unsafe {
        if !status_ok() {
            MC_EF_MEAN = 0.0;
            MC_EF_SUMSQ = 0.0;
            MC_EF_RUNS = runs;
            MC_EF_COMPLETED = 0;
            return;
        }
        simulate_expected_f_after_first_action_policy(
            start_sid,
            b0,
            p0,
            y0,
            init_b,
            init_p,
            init_y,
            hf,
            np,
            runs,
            seed,
            first_action,
        );
    }
}

#[no_mangle]
pub extern "C" fn simulateExpectedFPairFromPolicy(
    start_sid: i32,
    b0: i32,
    p0: i32,
    y0: i32,
    init_b: f64,
    init_p: f64,
    init_y: f64,
    hf: f64,
    np: f64,
    runs: i32,
    seed: u32,
    baseline_action: i32,
    selected_action: i32,
) {
    unsafe {
        if !status_ok()
            || !(0..=2).contains(&baseline_action)
            || !(0..=2).contains(&selected_action)
        {
            PAIR_BASE_MEAN = 0.0;
            PAIR_SELECTED_MEAN = 0.0;
            PAIR_DELTA_MEAN = 0.0;
            PAIR_DELTA_SUMSQ = 0.0;
            PAIR_BASE_SUMSQ = 0.0;
            PAIR_SELECTED_SUMSQ = 0.0;
            PAIR_CROSS_SUM = 0.0;
            PAIR_RUNS = runs;
            return;
        }

        let mut sum_base = 0.0;
        let mut sum_selected = 0.0;
        let mut sum_delta = 0.0;
        let mut sum_delta_sq = 0.0;
        let mut sum_base_sq = 0.0;
        let mut sum_selected_sq = 0.0;
        let mut sum_cross = 0.0;

        for run in 0..runs {
            let run_seed = subseed(seed, run);
            seed_rng(run_seed);
            let (base_f, _) = simulate_expected_f_once(
                start_sid,
                b0,
                p0,
                y0,
                init_b,
                init_p,
                init_y,
                hf,
                np,
                baseline_action,
            );
            seed_rng(run_seed);
            let (selected_f, _) = simulate_expected_f_once(
                start_sid,
                b0,
                p0,
                y0,
                init_b,
                init_p,
                init_y,
                hf,
                np,
                selected_action,
            );
            let delta = selected_f - base_f;
            sum_base += base_f;
            sum_selected += selected_f;
            sum_delta += delta;
            sum_delta_sq += delta * delta;
            sum_base_sq += base_f * base_f;
            sum_selected_sq += selected_f * selected_f;
            sum_cross += base_f * selected_f;
        }

        if runs > 0 {
            let inv = 1.0 / runs as f64;
            PAIR_BASE_MEAN = sum_base * inv;
            PAIR_SELECTED_MEAN = sum_selected * inv;
            PAIR_DELTA_MEAN = sum_delta * inv;
        } else {
            PAIR_BASE_MEAN = 0.0;
            PAIR_SELECTED_MEAN = 0.0;
            PAIR_DELTA_MEAN = 0.0;
        }
        PAIR_DELTA_SUMSQ = sum_delta_sq;
        PAIR_BASE_SUMSQ = sum_base_sq;
        PAIR_SELECTED_SUMSQ = sum_selected_sq;
        PAIR_CROSS_SUM = sum_cross;
        PAIR_RUNS = runs;
    }
}
#[no_mangle]
pub extern "C" fn simulateExpectedF(
    start_sid: i32,
    b0: i32,
    p0: i32,
    y0: i32,
    init_b: f64,
    init_p: f64,
    init_y: f64,
    hf: f64,
    np: f64,
    runs: i32,
    seed: u32,
    mode: i32,
) {
    unsafe {
        seed_rng(seed);
        let mut sum_f = 0.0;
        let mut completed = 0;
        for _ in 0..runs {
            let mut sid = start_sid;
            let (mut b, mut p, mut y) = (b0, p0, y0);
            let (mut ub, mut up, mut uy) = (0, 0, 0);
            for _ in 0..1000 {
                if is_terminal(sid) {
                    completed += 1;
                    break;
                }
                if is_convert(sid) {
                    sid = CONVERT_SID;
                    continue;
                }
                let k = if mode == 1 {
                    min_ef_action_at(sid, b, p, y)
                } else {
                    policy_action(sid, b, p, y)
                };
                if k < 0 || stock_of(k, b, p, y) <= 0 {
                    break;
                }
                if k == 0 {
                    b -= 1;
                    ub += 10;
                } else if k == 1 {
                    p -= 1;
                    up += 10;
                } else {
                    y -= 1;
                    uy += 10;
                }
                compute_transition(sid, k);
                sid = if next_random() < TX_PROB {
                    TX_SUCC
                } else {
                    TX_FAIL
                };
            }
            sum_f += availability_cost(
                ub as f64, up as f64, uy as f64, init_b, init_p, init_y, hf, np,
            );
        }
        MC_EF_MEAN = if runs > 0 { sum_f / runs as f64 } else { 0.0 };
        MC_EF_RUNS = runs;
        MC_EF_COMPLETED = completed;
    }
}
