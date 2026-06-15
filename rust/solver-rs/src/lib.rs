//! Rust port of the finite-inventory MDP solver kernel.
//!
//! This is a 1:1 translation of `../assembly/*` (AssemblyScript), which is itself a faithful,
//! equivalence-verified port of `../../src/solver.ts`. Logic, constants, op-order, and the
//! determinism strategy are preserved so the SAME `equivalence.test.ts` harness passes when the
//! loader points at this crate's wasm. Every section cites the original (`solver.ts:<line>` and the
//! corresponding `assembly/<file>.ts`).
//!
//! Concurrency: wasm is single-threaded, so module state is `static mut` (mirrors the AS module
//! globals) accessed in `unsafe`. A non-wasm/multi-thread version would wrap this in a struct.
//!
//! NOT compiled in this environment (no Rust toolchain). Build: see Cargo.toml header.
#![allow(non_snake_case, static_mut_refs)]

mod constants;
mod cost;
mod cvar;
mod distribution;
mod exact_replan;
mod minef;
mod simulation;
mod state;
mod status;
mod transition;
mod vector_moments;

use constants::*;
use cost::*;
use cvar::*;
use distribution::*;
use exact_replan::*;
use simulation::*;
use state::*;
use status::*;
use transition::*;
use vector_moments::*;

// ===== memo.ts ===============================================================================
// Capacity is RUNTIME-configurable (configureMemo) so a responsive browser loader can pick a smaller
// memo on low-memory devices. Default 1<<22 preserves the verified behavior (and is the floor for the
// common-input node-count peak ~1.96M at R0/250). Capacity affects only hashing/probing, never the
// computed values, so results are CAP-INVARIANT (proven by the cap-invariance test).
const CAP_DEFAULT: usize = 1 << 22;
static mut MEMO_CAP: usize = CAP_DEFAULT;
static mut MEMO_MASK: u32 = (CAP_DEFAULT - 1) as u32;
static mut MEMO_FULL_GUARD: usize = CAP_DEFAULT - (CAP_DEFAULT >> 3);
const TERMINAL: i32 = -2;
const DEPLETED: i32 = -3;
static mut KEYS: Vec<u32> = Vec::new();
static mut GENS: Vec<u32> = Vec::new(); // epoch a slot was written in; != EPOCH means empty
static mut SP_OK: Vec<f64> = Vec::new();
static mut SP_MAX: Vec<f64> = Vec::new();
static mut VB: Vec<f64> = Vec::new();
static mut VP: Vec<f64> = Vec::new();
static mut VY: Vec<f64> = Vec::new();
static mut ACT: Vec<i8> = Vec::new();
static mut EPOCH: u32 = 1;
static mut COUNT: usize = 0;

unsafe fn memo_ensure() {
    if KEYS.is_empty() {
        let cap = MEMO_CAP;
        KEYS = vec![0u32; cap];
        GENS = vec![0u32; cap];
        SP_OK = vec![0.0; cap];
        SP_MAX = vec![0.0; cap];
        VB = vec![0.0; cap];
        VP = vec![0.0; cap];
        VY = vec![0.0; cap];
        ACT = vec![0i8; cap];
    }
}
// Set the memo capacity to 1<<cap_log2 (clamped to [16,24]) and free the old arrays so the next solve
// reallocates at the new size. Call once at startup BEFORE solving. No-op if already at that size.
#[no_mangle]
pub extern "C" fn configureMemo(cap_log2: i32) {
    unsafe {
        let n = cap_log2.clamp(16, 24) as u32;
        let new_cap = 1usize << n;
        if !KEYS.is_empty() && new_cap == MEMO_CAP {
            return;
        }
        MEMO_CAP = new_cap;
        MEMO_MASK = (new_cap - 1) as u32;
        MEMO_FULL_GUARD = new_cap - (new_cap >> 3);
        KEYS = Vec::new(); // drop old arrays (RAII frees them); memo_ensure reallocates at new_cap
        GENS = Vec::new();
        SP_OK = Vec::new();
        SP_MAX = Vec::new();
        VB = Vec::new();
        VP = Vec::new();
        VY = Vec::new();
        ACT = Vec::new();
        EPOCH = 1;
        COUNT = 0;
    }
}
pub(crate) unsafe fn memo_reset() {
    memo_ensure();
    EPOCH = EPOCH.wrapping_add(1); // O(1) reset (epoch stamp), like the AS memo
    if EPOCH == 0 {
        for g in GENS.iter_mut() {
            *g = 0;
        }
        EPOCH = 1;
    }
    COUNT = 0;
}
#[inline]
fn hash_slot(stored: u32, mask: u32) -> u32 {
    let mut h = stored;
    h ^= h >> 16;
    h = h.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = h.wrapping_mul(0xc2b2_ae35);
    h ^= h >> 16;
    h & mask
}
unsafe fn probe(stored: u32) -> usize {
    let mask = MEMO_MASK as usize;
    let mut i = hash_slot(stored, MEMO_MASK) as usize;
    while GENS[i] == EPOCH && KEYS[i] != stored {
        i = (i + 1) & mask;
    }
    i
}
unsafe fn memo_find(key: u32) -> i32 {
    let i = probe(key + 1);
    if GENS[i] == EPOCH {
        i as i32
    } else {
        -1
    }
}
unsafe fn memo_insert(key: u32, sp: f64, spm: f64, vb: f64, vp: f64, vy: f64, act: i8) -> i32 {
    let stored = key + 1;
    let i = probe(stored);
    if GENS[i] != EPOCH {
        if COUNT >= MEMO_FULL_GUARD {
            LAST_STATUS = STATUS_MEMO_FULL;
            return -1;
        }
        KEYS[i] = stored;
        GENS[i] = EPOCH;
        COUNT += 1;
    }
    SP_OK[i] = sp;
    SP_MAX[i] = spm;
    VB[i] = vb;
    VP[i] = vp;
    VY[i] = vy;
    ACT[i] = act;
    i as i32
}
#[inline]
unsafe fn sp_ok_at(slot: i32) -> f64 {
    if slot == TERMINAL {
        1.0
    } else if slot == DEPLETED {
        0.0
    } else {
        SP_OK[slot as usize]
    }
}
#[inline]
unsafe fn sp_max_at(slot: i32) -> f64 {
    if slot == TERMINAL {
        1.0
    } else if slot == DEPLETED {
        0.0
    } else {
        SP_MAX[slot as usize]
    }
}
#[inline]
unsafe fn vb_at(slot: i32) -> f64 {
    if slot == TERMINAL || slot == DEPLETED {
        0.0
    } else {
        VB[slot as usize]
    }
}
#[inline]
unsafe fn vp_at(slot: i32) -> f64 {
    if slot == TERMINAL || slot == DEPLETED {
        0.0
    } else {
        VP[slot as usize]
    }
}
#[inline]
unsafe fn vy_at(slot: i32) -> f64 {
    if slot == TERMINAL || slot == DEPLETED {
        0.0
    } else {
        VY[slot as usize]
    }
}
#[inline]
unsafe fn act_at(slot: i32) -> i32 {
    if slot == TERMINAL || slot == DEPLETED {
        -1
    } else {
        ACT[slot as usize] as i32
    }
}

// ===== mdp.ts ================================================================================
static mut G_HF: f64 = 0.5;
static mut G_NP: f64 = 3.0;
static mut G_TOL: f64 = 0.01;
static mut G_INIT_B: f64 = 0.0;
static mut G_INIT_P: f64 = 0.0;
static mut G_INIT_Y: f64 = 0.0;

const INF: i32 = i32::MAX;
static mut WC: Vec<i32> = Vec::new(); // worstCaseUses cache [sid*3+kit], param-independent
unsafe fn wc_ensure() {
    if WC.is_empty() {
        WC = vec![-1i32; 960 * 3];
    }
}
unsafe fn worst_case_uses(sid: i32, kit: i32) -> i32 {
    wc_ensure();
    let ck = (sid * 3 + kit) as usize;
    if WC[ck] != -1 {
        return WC[ck];
    }
    let mut s = sid;
    let mut cnt = 0;
    let mut guard = 0;
    while !is_terminal(s) {
        guard += 1;
        if guard > 1000 {
            return INF;
        }
        if is_convert(s) {
            s = CONVERT_SID;
            continue;
        }
        compute_transition(s, kit);
        s = TX_FAIL;
        cnt += 1;
    }
    WC[ck] = cnt;
    cnt
}
static mut CAP_B: i32 = 0;
static mut CAP_P: i32 = 0;
static mut CAP_Y: i32 = 0;
unsafe fn cap_stock(sid: i32, b: i32, p: i32, y: i32) {
    let cb = worst_case_uses(sid, 0);
    let cp = worst_case_uses(sid, 1);
    let cy = worst_case_uses(sid, 2);
    if cb == INF || cp == INF || cy == INF {
        CAP_B = b;
        CAP_P = p;
        CAP_Y = y;
        return;
    }
    let nb = b.min(cb);
    let np = p.min(cp);
    let ny = y.min(cy);
    if b + p + y > 0 && nb + np + ny <= 0 {
        CAP_B = b;
        CAP_P = p;
        CAP_Y = y;
        return;
    }
    CAP_B = nb;
    CAP_P = np;
    CAP_Y = ny;
}

const MAXDEPTH: usize = 2048;
static mut DEPTH: usize = 0;
static mut SC_VALID: Vec<u8> = Vec::new();
static mut SC_SP: Vec<f64> = Vec::new();
static mut SC_VB: Vec<f64> = Vec::new();
static mut SC_VP: Vec<f64> = Vec::new();
static mut SC_VY: Vec<f64> = Vec::new();
static mut SC_COST: Vec<f64> = Vec::new();
static mut ROOT_SC_VALID: [u8; 3] = [0; 3];
static mut ROOT_SC_SP: [f64; 3] = [0.0; 3];
static mut ROOT_SC_VB: [f64; 3] = [0.0; 3];
static mut ROOT_SC_VP: [f64; 3] = [0.0; 3];
static mut ROOT_SC_VY: [f64; 3] = [0.0; 3];
static mut ROOT_SC_COST: [f64; 3] = [0.0; 3];
static mut ROOT_SC_MAX_SP: f64 = 0.0;
unsafe fn scratch_ensure() {
    if SC_SP.is_empty() {
        SC_VALID = vec![0u8; MAXDEPTH * 3];
        SC_SP = vec![0.0; MAXDEPTH * 3];
        SC_VB = vec![0.0; MAXDEPTH * 3];
        SC_VP = vec![0.0; MAXDEPTH * 3];
        SC_VY = vec![0.0; MAXDEPTH * 3];
        SC_COST = vec![0.0; MAXDEPTH * 3];
    }
}
#[inline]
unsafe fn root_candidate_reset() {
    ROOT_SC_VALID = [0; 3];
    ROOT_SC_SP = [0.0; 3];
    ROOT_SC_VB = [0.0; 3];
    ROOT_SC_VP = [0.0; 3];
    ROOT_SC_VY = [0.0; 3];
    ROOT_SC_COST = [0.0; 3];
    ROOT_SC_MAX_SP = 0.0;
}
#[inline]
unsafe fn better(a: usize, b: usize) -> bool {
    let dc = SC_COST[a] - SC_COST[b];
    if dc.abs() > STRICT_EPSILON {
        return dc < 0.0;
    }
    let dt = (SC_VB[a] + SC_VP[a] + SC_VY[a]) - (SC_VB[b] + SC_VP[b] + SC_VY[b]);
    if dt.abs() > STRICT_EPSILON {
        return dt < 0.0;
    }
    SC_SP[a] > SC_SP[b]
}

unsafe fn value(sid: i32, mut b: i32, mut p: i32, mut y: i32) -> i32 {
    if is_terminal(sid) {
        return TERMINAL;
    }
    if is_convert(sid) {
        return value(CONVERT_SID, b, p, y);
    }
    cap_stock(sid, b, p, y);
    b = CAP_B;
    p = CAP_P;
    y = CAP_Y;
    if b <= 0 && p <= 0 && y <= 0 {
        return DEPLETED;
    }
    let key = memo_key(sid, b, p, y);
    let hit = memo_find(key);
    if hit >= 0 {
        return hit;
    }

    if DEPTH >= MAXDEPTH {
        LAST_STATUS = STATUS_BUDGET_EXCEEDED;
        return -1;
    }
    let is_root_frame = DEPTH == 0;
    let base = DEPTH * 3;
    DEPTH += 1;
    let mut max_msp: f64 = 0.0;
    for k in 0..3i32 {
        let s = base + k as usize;
        if stock_of(k, b, p, y) <= 0 {
            SC_VALID[s] = 0;
            continue;
        }
        compute_transition(sid, k);
        let prob = TX_PROB;
        let succ = TX_SUCC;
        let fail = TX_FAIL;
        let nb = b - if k == 0 { 1 } else { 0 };
        let np = p - if k == 1 { 1 } else { 0 };
        let ny = y - if k == 2 { 1 } else { 0 };

        let cs = value(succ, nb, np, ny);
        if !status_ok() {
            DEPTH -= 1;
            return -1;
        }
        let cs_sp = sp_ok_at(cs);
        let cs_spm = sp_max_at(cs);
        let cs_vb = vb_at(cs);
        let cs_vp = vp_at(cs);
        let cs_vy = vy_at(cs);
        let cf = value(fail, nb, np, ny);
        if !status_ok() {
            DEPTH -= 1;
            return -1;
        }
        let cf_sp = sp_ok_at(cf);
        let cf_spm = sp_max_at(cf);
        let cf_vb = vb_at(cf);
        let cf_vp = vp_at(cf);
        let cf_vy = vy_at(cf);

        let inv = 1.0 - prob;
        let vbk = prob * cs_vb + inv * cf_vb + if k == 0 { 10.0 } else { 0.0 };
        let vpk = prob * cs_vp + inv * cf_vp + if k == 1 { 10.0 } else { 0.0 };
        let vyk = prob * cs_vy + inv * cf_vy + if k == 2 { 10.0 } else { 0.0 };
        let spk = prob * cs_sp + inv * cf_sp;
        let amspk = prob * cs_spm + inv * cf_spm;
        if amspk > max_msp {
            max_msp = amspk;
        }
        SC_VALID[s] = 1;
        SC_SP[s] = spk;
        SC_VB[s] = vbk;
        SC_VP[s] = vpk;
        SC_VY[s] = vyk;
        SC_COST[s] = availability_cost(vbk, vpk, vyk, G_INIT_B, G_INIT_P, G_INIT_Y, G_HF, G_NP);
    }

    if is_root_frame {
        ROOT_SC_MAX_SP = max_msp;
        for k in 0..3usize {
            let s = base + k;
            ROOT_SC_VALID[k] = SC_VALID[s];
            ROOT_SC_SP[k] = SC_SP[s];
            ROOT_SC_VB[k] = SC_VB[s];
            ROOT_SC_VP[k] = SC_VP[s];
            ROOT_SC_VY[k] = SC_VY[s];
            ROOT_SC_COST[k] = SC_COST[s];
        }
    }

    let mut any_elig = false;
    for k in 0..3usize {
        let s = base + k;
        if SC_VALID[s] != 0 && max_msp - SC_SP[s] <= G_TOL + STRICT_EPSILON {
            any_elig = true;
            break;
        }
    }
    let mut best_k: i32 = -1;
    for k in 0..3usize {
        let s = base + k;
        if SC_VALID[s] == 0 {
            continue;
        }
        let eligible = max_msp - SC_SP[s] <= G_TOL + STRICT_EPSILON;
        if any_elig && !eligible {
            continue;
        }
        if best_k < 0 || better(s, base + best_k as usize) {
            best_k = k as i32;
        }
    }
    let bs = base + best_k as usize;
    let out_sp = SC_SP[bs];
    let out_vb = SC_VB[bs];
    let out_vp = SC_VP[bs];
    let out_vy = SC_VY[bs];
    DEPTH -= 1;
    let out = memo_insert(key, out_sp, max_msp, out_vb, out_vp, out_vy, best_k as i8);
    if !status_ok() {
        return -1;
    }
    out
}

pub(crate) unsafe fn policy_action(sid: i32, b: i32, p: i32, y: i32) -> i32 {
    cap_stock(sid, b, p, y);
    let slot = memo_find(memo_key(sid, CAP_B, CAP_P, CAP_Y));
    if slot < 0 {
        -1
    } else {
        act_at(slot)
    }
}

// ===== index.ts (wasm exports) ===============================================================
#[inline]
pub(crate) fn uses_of(pieces: i32, max_uses: i32) -> i32 {
    (pieces / 10).min(max_uses)
}

// solveStart (mdp.ts:221): set params + run value() from (start, stockUses); returns start slot.
// The CALLER resets the memo (epoch) first — matches AS, where solveStart itself does not reset.
pub(crate) unsafe fn solve_start(
    sid: i32,
    uses_b: i32,
    uses_p: i32,
    uses_y: i32,
    init_b: f64,
    init_p: f64,
    init_y: f64,
    hf: f64,
    np: f64,
    tol: f64,
) -> i32 {
    scratch_ensure();
    root_candidate_reset();
    G_HF = hf;
    G_NP = np;
    G_TOL = tol;
    G_INIT_B = init_b;
    G_INIT_P = init_p;
    G_INIT_Y = init_y;
    DEPTH = 0;
    value(sid, uses_b, uses_p, uses_y)
}

// solveActionAt (mdp.ts:253): re-solve from (sid, pieces) using THAT node's stock as cost basis,
// return recommended action (0/1/2) or -1. memo_reset is O(1) (epoch), so per-replan-node calls are
// cheap. Used by the exact interactive-replan kernel below.
unsafe fn solve_action_at(sid: i32, pb: i32, pp: i32, py: i32, hf: f64, np: f64, tol: f64) -> i32 {
    reset_status();
    memo_reset();
    let slot = solve_start(
        sid,
        uses_of(pb, MAX_USES_B),
        uses_of(pp, MAX_USES_P),
        uses_of(py, MAX_USES_Y),
        pb as f64,
        pp as f64,
        py as f64,
        hf,
        np,
        tol,
    );
    if !status_ok() {
        return -1;
    }
    act_at(slot)
}

#[no_mangle]
pub extern "C" fn getSolveStatus() -> i32 {
    unsafe { LAST_STATUS }
}
#[no_mangle]
pub extern "C" fn configureNodeBudget(budget: u32) {
    unsafe {
        NODE_BUDGET = budget;
    }
}
#[no_mangle]
pub extern "C" fn solveCore(sid: i32, b: i32, p: i32, y: i32, hf: f64, np: f64, tol: f64) -> i32 {
    unsafe {
        reset_status();
        memo_reset();
        solve_start(
            sid,
            uses_of(b, MAX_USES_B),
            uses_of(p, MAX_USES_P),
            uses_of(y, MAX_USES_Y),
            b as f64,
            p as f64,
            y as f64,
            hf,
            np,
            tol,
        )
    }
}
#[no_mangle]
pub extern "C" fn simulateCore(sid: i32, b: i32, p: i32, y: i32, runs: i32, seed: u32) {
    unsafe {
        simulate_run(
            sid,
            uses_of(b, MAX_USES_B),
            uses_of(p, MAX_USES_P),
            uses_of(y, MAX_USES_Y),
            runs,
            seed,
            policy_action,
        )
    }
}
#[no_mangle]
pub extern "C" fn simulateAfterFirstActionCore(
    sid: i32,
    b: i32,
    p: i32,
    y: i32,
    runs: i32,
    seed: u32,
    first_action: i32,
) {
    unsafe {
        simulate_run_with_first_action(
            sid,
            uses_of(b, MAX_USES_B),
            uses_of(p, MAX_USES_P),
            uses_of(y, MAX_USES_Y),
            runs,
            seed,
            first_action,
            policy_action,
        )
    }
}
#[no_mangle]
pub extern "C" fn policyActionAt(sid: i32, b: i32, p: i32, y: i32) -> i32 {
    unsafe {
        if !status_ok() {
            return -1;
        }
        policy_action(sid, b, p, y)
    }
}
#[no_mangle]
pub extern "C" fn resAction(slot: i32) -> i32 {
    unsafe { act_at(slot) }
}
#[no_mangle]
pub extern "C" fn resSuccessProb(slot: i32) -> f64 {
    unsafe { sp_ok_at(slot) }
}
#[no_mangle]
pub extern "C" fn resMaxSuccessProb(slot: i32) -> f64 {
    unsafe { sp_max_at(slot) }
}
#[no_mangle]
pub extern "C" fn resVecB(slot: i32) -> f64 {
    unsafe { vb_at(slot) }
}
#[no_mangle]
pub extern "C" fn resVecP(slot: i32) -> f64 {
    unsafe { vp_at(slot) }
}
#[no_mangle]
pub extern "C" fn resVecY(slot: i32) -> f64 {
    unsafe { vy_at(slot) }
}
#[no_mangle]
pub extern "C" fn rootCandidateValid(action: i32) -> i32 {
    if !(0..=2).contains(&action) {
        return 0;
    }
    unsafe { ROOT_SC_VALID[action as usize] as i32 }
}
#[no_mangle]
pub extern "C" fn rootCandidateMaxSuccessProb() -> f64 {
    unsafe { ROOT_SC_MAX_SP }
}
#[no_mangle]
pub extern "C" fn rootCandidateSuccessProb(action: i32) -> f64 {
    if !(0..=2).contains(&action) {
        return 0.0;
    }
    unsafe { ROOT_SC_SP[action as usize] }
}
#[no_mangle]
pub extern "C" fn rootCandidateVecB(action: i32) -> f64 {
    if !(0..=2).contains(&action) {
        return 0.0;
    }
    unsafe { ROOT_SC_VB[action as usize] }
}
#[no_mangle]
pub extern "C" fn rootCandidateVecP(action: i32) -> f64 {
    if !(0..=2).contains(&action) {
        return 0.0;
    }
    unsafe { ROOT_SC_VP[action as usize] }
}
#[no_mangle]
pub extern "C" fn rootCandidateVecY(action: i32) -> f64 {
    if !(0..=2).contains(&action) {
        return 0.0;
    }
    unsafe { ROOT_SC_VY[action as usize] }
}
#[no_mangle]
pub extern "C" fn rootCandidateCost(action: i32) -> f64 {
    if !(0..=2).contains(&action) {
        return f64::INFINITY;
    }
    unsafe { ROOT_SC_COST[action as usize] }
}
#[no_mangle]
pub extern "C" fn statesCount() -> i32 {
    unsafe { COUNT as i32 }
}
#[no_mangle]
pub extern "C" fn getMcCompleted() -> i32 {
    unsafe { mc_completed() }
}
#[no_mangle]
pub extern "C" fn getMcRuns() -> i32 {
    unsafe { mc_runs() }
}
#[no_mangle]
pub extern "C" fn getMcVecB() -> f64 {
    unsafe { mc_vec_b() }
}
#[no_mangle]
pub extern "C" fn getMcVecP() -> f64 {
    unsafe { mc_vec_p() }
}
#[no_mangle]
pub extern "C" fn getMcVecY() -> f64 {
    unsafe { mc_vec_y() }
}
#[no_mangle]
pub extern "C" fn getMcVarB() -> f64 {
    unsafe { mc_var_b() }
}
#[no_mangle]
pub extern "C" fn getMcVarP() -> f64 {
    unsafe { mc_var_p() }
}
#[no_mangle]
pub extern "C" fn getMcVarY() -> f64 {
    unsafe { mc_var_y() }
}
#[no_mangle]
pub extern "C" fn getMcQuantileB(q: f64) -> i32 {
    unsafe { mc_quantile_b(q) }
}
#[no_mangle]
pub extern "C" fn getMcQuantileP(q: f64) -> i32 {
    unsafe { mc_quantile_p(q) }
}
#[no_mangle]
pub extern "C" fn getMcQuantileY(q: f64) -> i32 {
    unsafe { mc_quantile_y(q) }
}
#[no_mangle]
pub extern "C" fn getMcDepletion() -> f64 {
    unsafe { mc_depletion() }
}

#[no_mangle]
pub extern "C" fn exactCore(
    sid: i32,
    pb: i32,
    pp: i32,
    py: i32,
    hf: f64,
    np: f64,
    tol: f64,
) -> f64 {
    unsafe { exact_core(sid, pb, pp, py, hf, np, tol, solve_action_at, policy_action) }
}
#[no_mangle]
pub extern "C" fn exactNodeCount() -> i32 {
    unsafe { exact_node_count() }
}

#[no_mangle]
pub extern "C" fn distCore(
    sid: i32,
    pb: i32,
    pp: i32,
    py: i32,
    hf: f64,
    np: f64,
    tol: f64,
    kit: i32,
) {
    unsafe {
        let uses_b = uses_of(pb, MAX_USES_B);
        let uses_p = uses_of(pp, MAX_USES_P);
        let uses_y = uses_of(py, MAX_USES_Y);
        // build the policy memo once (start stock as cost basis), like solveCore; the moment
        // recursion then FOLLOWS that fixed policy (no per-node re-solve), as simulate does.
        memo_reset();
        solve_start(
            sid, uses_b, uses_p, uses_y, pb as f64, pp as f64, py as f64, hf, np, tol,
        );
        dist_start(sid, uses_b, uses_p, uses_y, kit, policy_action);
    }
}
#[no_mangle]
pub extern "C" fn distMeanUses() -> f64 {
    unsafe { dist_mean_uses() }
}
#[no_mangle]
pub extern "C" fn distVarUses() -> f64 {
    unsafe { dist_var_uses() }
}

#[no_mangle]
pub extern "C" fn momentVectorAfterFirstActionFromPolicy(
    start_sid: i32,
    b0: i32,
    p0: i32,
    y0: i32,
    first_action: i32,
) {
    unsafe {
        moment_vector_after_first_action_from_policy(
            start_sid,
            b0,
            p0,
            y0,
            first_action,
            policy_action,
        )
    }
}

#[no_mangle]
pub extern "C" fn momentMeanBUses() -> f64 {
    unsafe { moment_mean_b_uses() }
}
#[no_mangle]
pub extern "C" fn momentMeanPUses() -> f64 {
    unsafe { moment_mean_p_uses() }
}
#[no_mangle]
pub extern "C" fn momentMeanYUses() -> f64 {
    unsafe { moment_mean_y_uses() }
}
#[no_mangle]
pub extern "C" fn momentSecondBBUses() -> f64 {
    unsafe { moment_second_bb_uses() }
}
#[no_mangle]
pub extern "C" fn momentSecondPPUses() -> f64 {
    unsafe { moment_second_pp_uses() }
}
#[no_mangle]
pub extern "C" fn momentSecondYYUses() -> f64 {
    unsafe { moment_second_yy_uses() }
}
#[no_mangle]
pub extern "C" fn momentSecondBPUses() -> f64 {
    unsafe { moment_second_bp_uses() }
}
#[no_mangle]
pub extern "C" fn momentSecondBYUses() -> f64 {
    unsafe { moment_second_by_uses() }
}
#[no_mangle]
pub extern "C" fn momentSecondPYUses() -> f64 {
    unsafe { moment_second_py_uses() }
}
#[no_mangle]
pub extern "C" fn momentVectorNodeCount() -> i32 {
    unsafe { moment_vector_node_count() }
}

#[no_mangle]
pub extern "C" fn cvarSetup(sid: i32, pb: i32, pp: i32, py: i32, hf: f64, np: f64, tol: f64) {
    unsafe {
        reset_status();
        let start_b = uses_of(pb, MAX_USES_B);
        let start_p = uses_of(pp, MAX_USES_P);
        let start_y = uses_of(py, MAX_USES_Y);
        cvar_setup(sid, pb, pp, py, hf, np, start_b, start_p, start_y);
        memo_reset();
        solve_start(
            sid, start_b, start_p, start_y, pb as f64, pp as f64, py as f64, hf, np, tol,
        );
    }
}
#[no_mangle]
pub extern "C" fn cvarFollowMean() -> f64 {
    unsafe { cvar_follow_mean(policy_action) }
}
#[no_mangle]
pub extern "C" fn cvarFollowMeanAfterFirstAction(first_action: i32) -> f64 {
    unsafe { cvar_follow_mean_after_first_action(first_action, policy_action) }
}
#[no_mangle]
pub extern "C" fn cvarNodeCount() -> i32 {
    unsafe { cvar_node_count() }
}
#[no_mangle]
pub extern "C" fn cvarFollowHinge(eta: f64) -> f64 {
    unsafe { cvar_follow_hinge(eta, policy_action) }
}
#[no_mangle]
pub extern "C" fn cvarOptMean() -> f64 {
    unsafe { cvar_opt_mean() }
}
#[no_mangle]
pub extern "C" fn cvarOptHinge(eta: f64) -> f64 {
    unsafe { cvar_opt_hinge(eta) }
}
#[no_mangle]
pub extern "C" fn cvarOptRecord(eta: f64) -> f64 {
    unsafe { cvar_opt_record(eta) }
}
#[no_mangle]
pub extern "C" fn cvarFollowRecordedMean() -> f64 {
    unsafe { cvar_follow_recorded_mean() }
}
#[no_mangle]
pub extern "C" fn cvarFollowRecordedHinge(eta: f64) -> f64 {
    unsafe { cvar_follow_recorded_hinge(eta) }
}
