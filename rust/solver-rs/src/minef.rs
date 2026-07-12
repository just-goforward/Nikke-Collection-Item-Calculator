use crate::constants::{
    GAIN_B, GAIN_P, GAIN_Y, MAX_USES_B, MAX_USES_P, MAX_USES_Y, STRICT_EPSILON,
};
use crate::cost::{availability_cost, availability_cost_pre};
use crate::simulation::{next_random, seed_rng};
use crate::state::{memo_key, stock_of};
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
        MN_EF = me_leaf_cost(b, p, y);
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
    for k in 0..3i32 {
        let s = base + k as usize;
        if stock_of(k, b, p, y) <= 0 {
            ME_SC_VALID[s] = 0;
            continue;
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
        if amsp > max_msp {
            max_msp = amsp;
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
        MN_EF = me_leaf_cost(b, p, y);
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
        reset_status();
        me_reset();
        minef_node(sid, ME_START_B, ME_START_P, ME_START_Y, 0);
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
    unsafe { min_ef_action_at(sid, b, p, y) }
}
#[no_mangle]
pub extern "C" fn minEfActionAtOrSolve(sid: i32, b: i32, p: i32, y: i32) -> i32 {
    unsafe {
        reset_status();
        let cached = min_ef_action_at(sid, b, p, y);
        if cached >= 0 {
            return cached;
        }
        minef_node(sid, b, p, y, 0);
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
