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

// ===== constants.ts ==========================================================================
const STRICT_EPSILON: f64 = 1e-12;
const KIT_EXP: [i32; 3] = [200, 500, 1000]; // blue, purple, yellow (KIT_META.exp)
const REQUIRED_EXP: [i32; 2] = [1000, 3000]; // R, SR (FIXED_REQUIRED_EXP)
const GAIN_B: f64 = 473.912;
const GAIN_P: f64 = 55.808;
const GAIN_Y: f64 = 24.736;
const MAX_USES_B: i32 = 220;
const MAX_USES_P: i32 = 88;
const MAX_USES_Y: i32 = 44;
const LEVEL_BUCKETS: i32 = 16;
const EXP_BUCKETS: i32 = 30;
const STATE_DIV: i32 = LEVEL_BUCKETS * EXP_BUCKETS; // 480
const STOCK_P_DIM: i32 = MAX_USES_P + 1; // 89
const STOCK_Y_DIM: i32 = MAX_USES_Y + 1; // 45
const STOCK_ID_SIZE: i32 = (MAX_USES_B + 1) * STOCK_P_DIM * STOCK_Y_DIM; // 885105
const STATUS_OK: i32 = 0;
const STATUS_BUDGET_EXCEEDED: i32 = 1;
const STATUS_MEMO_FULL: i32 = 2;
static mut LAST_STATUS: i32 = STATUS_OK;
static mut NODE_BUDGET: u32 = 0;
static mut NODE_COUNT: u32 = 0;

#[inline]
unsafe fn reset_status() {
    LAST_STATUS = STATUS_OK;
    NODE_COUNT = 0;
}

#[inline]
unsafe fn status_ok() -> bool {
    LAST_STATUS == STATUS_OK
}

#[inline]
unsafe fn tick_node() -> bool {
    if LAST_STATUS != STATUS_OK {
        return false;
    }
    if NODE_BUDGET == 0 {
        return true;
    }
    NODE_COUNT = NODE_COUNT.saturating_add(1);
    if NODE_COUNT > NODE_BUDGET {
        LAST_STATUS = STATUS_BUDGET_EXCEEDED;
        return false;
    }
    true
}

// GREAT_SUCCESS percent, flattened [gradeId*45 + kitIdx*15 + level] (solver.ts:96-113).
#[rustfmt::skip]
const GREAT_PERCENT: [f64; 90] = [
    // R blue / purple / yellow
    17.6,20.8,24.0,27.2,40.0, 16.0,19.2,22.4,27.2,40.0, 14.4,17.6,22.4,27.2,40.0,
    55.0,65.0,75.0,85.0,100.0, 50.0,60.0,70.0,85.0,100.0, 45.0,55.0,70.0,85.0,100.0,
    100.0,100.0,100.0,100.0,100.0, 100.0,100.0,100.0,100.0,100.0, 100.0,100.0,100.0,100.0,100.0,
    // SR blue / purple / yellow
    3.6,5.9,7.8,11.3,15.0, 2.2,3.3,4.9,7.6,12.5, 1.2,2.2,3.1,4.7,10.0,
    11.0,19.8,28.7,41.3,55.0, 8.0,12.0,18.0,28.0,50.0, 5.4,9.9,14.4,21.6,45.0,
    25.0,40.0,55.0,75.0,100.0, 20.0,30.0,45.0,70.0,100.0, 15.0,27.5,40.0,60.0,100.0,
];
#[inline]
fn great_success_prob(grade_id: i32, kit: i32, level: i32) -> f64 {
    GREAT_PERCENT[(grade_id * 45 + kit * 15 + level) as usize] / 100.0
}

// ===== encoding.ts ===========================================================================
#[inline]
fn encode_state(grade_id: i32, level: i32, exp100: i32) -> i32 {
    (grade_id * LEVEL_BUCKETS + level) * EXP_BUCKETS + exp100
}
#[inline]
fn grade_of(sid: i32) -> i32 {
    sid / STATE_DIV
}
#[inline]
fn level_of(sid: i32) -> i32 {
    (sid / EXP_BUCKETS) % LEVEL_BUCKETS
}
#[inline]
fn exp100_of(sid: i32) -> i32 {
    sid % EXP_BUCKETS
}
#[inline]
fn stock_id(b: i32, p: i32, y: i32) -> i32 {
    (b * STOCK_P_DIM + p) * STOCK_Y_DIM + y
}
#[inline]
fn memo_key(sid: i32, b: i32, p: i32, y: i32) -> u32 {
    (sid * STOCK_ID_SIZE + stock_id(b, p, y)) as u32
}
#[inline]
fn stock_of(k: i32, b: i32, p: i32, y: i32) -> i32 {
    if k == 0 {
        b
    } else if k == 1 {
        p
    } else {
        y
    }
}

// ===== transition.ts =========================================================================
const CONVERT_SID: i32 = 630; // encodeState(1,5,0)
#[inline]
fn is_terminal(sid: i32) -> bool {
    grade_of(sid) == 1 && level_of(sid) >= 15
}
#[inline]
fn is_convert(sid: i32) -> bool {
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
// transition outputs (single-threaded globals; read into locals before recursing — see mdp).
static mut TX_PROB: f64 = 0.0;
static mut TX_SUCC: i32 = 0;
static mut TX_FAIL: i32 = 0;
fn compute_transition(sid: i32, kit: i32) {
    let g = grade_of(sid);
    let level = level_of(sid);
    let exp100 = exp100_of(sid);
    unsafe {
        TX_PROB = great_success_prob(g, kit, level);
        TX_SUCC = encode_state(g, next_boundary(level), 0);
        TX_FAIL = fail_state_sid(g, level, exp100, kit);
    }
}

// ===== cost.ts ===============================================================================
#[inline]
fn ratio(consume: f64, availability: f64) -> f64 {
    if availability > 0.0 {
        consume / availability
    } else if consume > STRICT_EPSILON {
        f64::INFINITY
    } else {
        0.0
    }
}
#[inline]
fn ipow(base: f64, p: f64) -> f64 {
    let n = p as i32;
    if (n as f64) == p && (0..=8).contains(&n) {
        base.powi(n) // integer power: parity with AS repeated-multiply
    } else {
        base.powf(p)
    }
}
fn availability_cost(
    vb: f64,
    vp: f64,
    vy: f64,
    sb: f64,
    sp: f64,
    sy: f64,
    hf: f64,
    np: f64,
) -> f64 {
    let rb = ratio(vb, sb + hf * GAIN_B);
    let rp = ratio(vp, sp + hf * GAIN_P);
    let ry = ratio(vy, sy + hf * GAIN_Y);
    if np == f64::INFINITY {
        return rb.max(rp).max(ry);
    }
    if !np.is_finite() || np <= 0.0 {
        return f64::INFINITY;
    }
    (ipow(rb, np) + ipow(rp, np) + ipow(ry, np)).powf(1.0 / np)
}

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
unsafe fn memo_reset() {
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

unsafe fn policy_action(sid: i32, b: i32, p: i32, y: i32) -> i32 {
    cap_stock(sid, b, p, y);
    let slot = memo_find(memo_key(sid, CAP_B, CAP_P, CAP_Y));
    if slot < 0 {
        -1
    } else {
        act_at(slot)
    }
}

// ===== random.ts + simulate.ts ===============================================================
static mut RNG: u32 = 0;
#[inline]
fn next_random() -> f64 {
    unsafe {
        RNG = RNG.wrapping_mul(1664525).wrapping_add(1013904223);
        (RNG as f64) / 4294967296.0
    }
}
static mut MC_COMPLETED: i32 = 0;
static mut MC_RUNS: i32 = 0;
static mut MC_TB: f64 = 0.0;
static mut MC_TP: f64 = 0.0;
static mut MC_TY: f64 = 0.0;
static mut MC_SQB: f64 = 0.0;
static mut MC_SQP: f64 = 0.0;
static mut MC_SQY: f64 = 0.0;
// per-kit histogram of per-run total USES (bin = uses 0..255; uses <= MAX_RELEVANT_USES 220 < 256).
const HBINS: usize = 256;
static mut HIST_B: [i32; HBINS] = [0; HBINS];
static mut HIST_P: [i32; HBINS] = [0; HBINS];
static mut HIST_Y: [i32; HBINS] = [0; HBINS];
unsafe fn simulate_run_with_first_action(
    start_sid: i32,
    b0: i32,
    p0: i32,
    y0: i32,
    runs: i32,
    seed: u32,
    first_action: i32,
) {
    RNG = seed;
    let mut completed = 0;
    let (mut tb, mut tp, mut ty) = (0.0, 0.0, 0.0);
    let (mut sqb, mut sqp, mut sqy) = (0.0, 0.0, 0.0);
    HIST_B = [0; HBINS]; // reset per-run histograms for this MC call
    HIST_P = [0; HBINS];
    HIST_Y = [0; HBINS];
    for _ in 0..runs {
        let mut sid = start_sid;
        let (mut b, mut p, mut y) = (b0, p0, y0);
        let (mut ub, mut up, mut uy) = (0, 0, 0);
        let mut force_first = first_action >= 0;
        for _ in 0..1000 {
            if is_terminal(sid) {
                completed += 1;
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
        let (fb, fp, fy) = (ub as f64, up as f64, uy as f64);
        tb += fb;
        tp += fp;
        ty += fy;
        sqb += fb * fb;
        sqp += fp * fp;
        sqy += fy * fy;
        HIST_B[(ub / 10) as usize] += 1; // bin by USES
        HIST_P[(up / 10) as usize] += 1;
        HIST_Y[(uy / 10) as usize] += 1;
    }
    MC_COMPLETED = completed;
    MC_RUNS = runs;
    MC_TB = tb;
    MC_TP = tp;
    MC_TY = ty;
    MC_SQB = sqb;
    MC_SQP = sqp;
    MC_SQY = sqy;
}

unsafe fn simulate_run(start_sid: i32, b0: i32, p0: i32, y0: i32, runs: i32, seed: u32) {
    simulate_run_with_first_action(start_sid, b0, p0, y0, runs, seed, -1);
}

// ===== index.ts (wasm exports) ===============================================================
#[inline]
fn uses_of(pieces: i32, max_uses: i32) -> i32 {
    (pieces / 10).min(max_uses)
}

// solveStart (mdp.ts:221): set params + run value() from (start, stockUses); returns start slot.
// The CALLER resets the memo (epoch) first — matches AS, where solveStart itself does not reset.
unsafe fn solve_start(
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
    unsafe { MC_COMPLETED }
}
#[no_mangle]
pub extern "C" fn getMcRuns() -> i32 {
    unsafe { MC_RUNS }
}
#[no_mangle]
pub extern "C" fn getMcVecB() -> f64 {
    unsafe {
        if MC_RUNS > 0 {
            MC_TB / MC_RUNS as f64
        } else {
            0.0
        }
    }
}
#[no_mangle]
pub extern "C" fn getMcVecP() -> f64 {
    unsafe {
        if MC_RUNS > 0 {
            MC_TP / MC_RUNS as f64
        } else {
            0.0
        }
    }
}
#[no_mangle]
pub extern "C" fn getMcVecY() -> f64 {
    unsafe {
        if MC_RUNS > 0 {
            MC_TY / MC_RUNS as f64
        } else {
            0.0
        }
    }
}
// variance = E[X^2] - E[X]^2 over the runs (population form, matches AS getMcVar*).
#[inline]
fn mc_var(sum_sq: f64, sum: f64, runs: f64) -> f64 {
    let mean = sum / runs;
    sum_sq / runs - mean * mean
}
#[no_mangle]
pub extern "C" fn getMcVarB() -> f64 {
    unsafe {
        if MC_RUNS > 0 {
            mc_var(MC_SQB, MC_TB, MC_RUNS as f64)
        } else {
            0.0
        }
    }
}
#[no_mangle]
pub extern "C" fn getMcVarP() -> f64 {
    unsafe {
        if MC_RUNS > 0 {
            mc_var(MC_SQP, MC_TP, MC_RUNS as f64)
        } else {
            0.0
        }
    }
}
#[no_mangle]
pub extern "C" fn getMcVarY() -> f64 {
    unsafe {
        if MC_RUNS > 0 {
            mc_var(MC_SQY, MC_TY, MC_RUNS as f64)
        } else {
            0.0
        }
    }
}
// q-quantile (q in [0,1]) of per-run total USES: smallest u with P(X<=u) >= q (TS wrapper *10 = pieces).
unsafe fn mc_quantile(hist: &[i32; HBINS], runs: i32, q: f64) -> i32 {
    if runs <= 0 {
        return 0;
    }
    let mut threshold = (q * runs as f64) as i32;
    if threshold < 1 {
        threshold = 1;
    }
    if threshold > runs {
        threshold = runs;
    }
    let mut cum = 0;
    for (u, &c) in hist.iter().enumerate() {
        cum += c;
        if cum >= threshold {
            return u as i32;
        }
    }
    (HBINS - 1) as i32
}
#[no_mangle]
pub extern "C" fn getMcQuantileB(q: f64) -> i32 {
    unsafe { mc_quantile(&HIST_B, MC_RUNS, q) }
}
#[no_mangle]
pub extern "C" fn getMcQuantileP(q: f64) -> i32 {
    unsafe { mc_quantile(&HIST_P, MC_RUNS, q) }
}
#[no_mangle]
pub extern "C" fn getMcQuantileY(q: f64) -> i32 {
    unsafe { mc_quantile(&HIST_Y, MC_RUNS, q) }
}
// depletion probability = fraction of runs that did NOT reach SR15.
#[no_mangle]
pub extern "C" fn getMcDepletion() -> f64 {
    unsafe {
        if MC_RUNS > 0 {
            (MC_RUNS - MC_COMPLETED) as f64 / MC_RUNS as f64
        } else {
            0.0
        }
    }
}

// ===== exact-replan.ts =======================================================================
// PORT OF: assembly/exact-replan.ts (itself benchmarks/evaluator/exact-replan.ts visit()/policyFor()).
// EXACT interactive-replan success probability (the calibration's blocking gate). Each node is
// re-solved with THAT node's stock as cost basis (solve_action_at), then we follow the faithful
// `run.count` batch (intermediate fails are NOT re-solved) branching on first-success-at-attempt-i +
// the all-fail tail, caching (sid, pieces) -> P in a separate open-addressing memo.
const EX_CAP: usize = 1 << 21;
const EX_MASK: u32 = (EX_CAP - 1) as u32;
static mut EX_SID: Vec<i32> = Vec::new(); // -1 = empty
static mut EX_PB: Vec<i32> = Vec::new();
static mut EX_PP: Vec<i32> = Vec::new();
static mut EX_PY: Vec<i32> = Vec::new();
static mut EX_VAL: Vec<f64> = Vec::new();
static mut EX_COUNT: i32 = 0;
static mut E_HF: f64 = 0.5;
static mut E_NP: f64 = 3.0;
static mut E_TOL: f64 = 0.01;

unsafe fn ex_reset() {
    if EX_SID.is_empty() {
        EX_SID = vec![-1i32; EX_CAP];
        EX_PB = vec![0i32; EX_CAP];
        EX_PP = vec![0i32; EX_CAP];
        EX_PY = vec![0i32; EX_CAP];
        EX_VAL = vec![0.0f64; EX_CAP];
    } else {
        for s in EX_SID.iter_mut() {
            *s = -1;
        }
    }
    EX_COUNT = 0;
}
#[inline]
fn ex_hash(sid: i32, pb: i32, pp: i32, py: i32) -> usize {
    let mut h: u32 = (sid as u32).wrapping_mul(2654435761);
    h ^= (pb as u32).wrapping_mul(40503);
    h ^= (pp as u32).wrapping_mul(12289);
    h ^= (py as u32).wrapping_mul(3079);
    h ^= h >> 15;
    h = h.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    (h & EX_MASK) as usize
}
unsafe fn ex_find(sid: i32, pb: i32, pp: i32, py: i32) -> i32 {
    let mut i = ex_hash(sid, pb, pp, py);
    while EX_SID[i] != -1 {
        if EX_SID[i] == sid && EX_PB[i] == pb && EX_PP[i] == pp && EX_PY[i] == py {
            return i as i32;
        }
        i = (i + 1) & (EX_MASK as usize);
    }
    -1
}
unsafe fn ex_insert(sid: i32, pb: i32, pp: i32, py: i32, val: f64) {
    let mut i = ex_hash(sid, pb, pp, py);
    while EX_SID[i] != -1 {
        if EX_SID[i] == sid && EX_PB[i] == pb && EX_PP[i] == pp && EX_PY[i] == py {
            EX_VAL[i] = val;
            return;
        }
        i = (i + 1) & (EX_MASK as usize);
    }
    if EX_COUNT as usize >= EX_CAP - (EX_CAP >> 3) {
        unreachable!("exact memo near full: raise EX_CAP");
    }
    EX_SID[i] = sid;
    EX_PB[i] = pb;
    EX_PP[i] = pp;
    EX_PY[i] = py;
    EX_VAL[i] = val;
    EX_COUNT += 1;
}

// run.count: consecutive same-kit uses recommended from this node, on the node's just-built memo.
// Mirrors buildRecommendedRunForKit (solver.ts:740-784). Stock in USES.
unsafe fn run_count(sid: i32, action: i32, ub: i32, up: i32, uy: i32) -> i32 {
    let mut state = sid;
    let (mut b, mut p, mut y) = (ub, up, uy);
    if stock_of(action, b, p, y) <= 0 {
        return 0;
    }
    compute_transition(state, action);
    let success_target = TX_SUCC; // firstEdge.success (solver.ts:751)
    let mut count = 0;
    while count < 100 && !is_terminal(state) && !is_convert(state) && stock_of(action, b, p, y) > 0
    {
        if count > 0 && policy_action(state, b, p, y) != action {
            break; // policy changed (solver.ts:762-763)
        }
        compute_transition(state, action);
        if TX_SUCC != success_target {
            break; // success boundary changed (solver.ts:766)
        }
        count += 1;
        if action == 0 {
            b -= 1;
        } else if action == 1 {
            p -= 1;
        } else {
            y -= 1;
        }
        let fail = TX_FAIL;
        let leveled = grade_of(fail) != grade_of(state) || level_of(fail) != level_of(state);
        state = fail;
        if leveled {
            break; // leveled up on fail -> end run (solver.ts:771-773)
        }
    }
    count
}

// exactValue(sid, pieces): exact P of reaching SR15 under the interactive-replan policy. Faithful
// run.count batching (visit:380-423): re-solve ONCE at this node, follow the run of N same-kit uses
// (intermediate fails NOT re-solved), branch on first-success-at-attempt-i + the all-fail tail.
unsafe fn exact_value(sid: i32, pb: i32, pp: i32, py: i32) -> f64 {
    if is_terminal(sid) {
        return 1.0;
    }
    if is_convert(sid) {
        return exact_value(CONVERT_SID, pb, pp, py);
    }
    let hit = ex_find(sid, pb, pp, py);
    if hit >= 0 {
        return EX_VAL[hit as usize];
    }
    // re-solve with this node's stock as cost basis; leaves the policy memo intact for run_count.
    let action = solve_action_at(sid, pb, pp, py, E_HF, E_NP, E_TOL);
    if action < 0 {
        ex_insert(sid, pb, pp, py, 0.0);
        return 0.0;
    }
    let mut n = run_count(
        sid,
        action,
        uses_of(pb, MAX_USES_B),
        uses_of(pp, MAX_USES_P),
        uses_of(py, MAX_USES_Y),
    );
    if n < 1 {
        n = 1; // best.run.count = max(1, count) (visit:375)
    }
    let mut fail_sid = sid;
    let mut no_succ: f64 = 1.0;
    let mut agg_p: f64 = 0.0;
    let mut attempt = 1;
    while attempt <= n {
        compute_transition(fail_sid, action); // copy BEFORE recursing (recursion re-solves)
        let prob = TX_PROB;
        let succ_sid = TX_SUCC;
        let fail_next = TX_FAIL;
        let p_hit = no_succ * prob; // first success exactly at this attempt (visit:382)
        if p_hit > 0.0 {
            let cb = pb - if action == 0 { attempt * 10 } else { 0 };
            let cp = pp - if action == 1 { attempt * 10 } else { 0 };
            let cy = py - if action == 2 { attempt * 10 } else { 0 };
            agg_p += p_hit * exact_value(succ_sid, cb, cp, cy); // visit:388
        }
        no_succ *= 1.0 - prob; // visit:404
        fail_sid = fail_next;
        if no_succ == 0.0 {
            break; // visit:406
        }
        attempt += 1;
    }
    if no_succ > 0.0 {
        let cb = pb - if action == 0 { n * 10 } else { 0 };
        let cp = pp - if action == 1 { n * 10 } else { 0 };
        let cy = py - if action == 2 { n * 10 } else { 0 };
        agg_p += no_succ * exact_value(fail_sid, cb, cp, cy); // visit:411
    }
    ex_insert(sid, pb, pp, py, agg_p);
    agg_p
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
    unsafe {
        E_HF = hf;
        E_NP = np;
        E_TOL = tol;
        ex_reset();
        exact_value(sid, pb, pp, py)
    }
}
#[no_mangle]
pub extern "C" fn exactNodeCount() -> i32 {
    unsafe { EX_COUNT }
}

// ===== dist.ts ===============================================================================
// PORT OF: assembly/dist.ts. Phase 3 moment distributional DP: exact first two MOMENTS (E[X], E[X^2])
// of a target kit's total uses under the FIXED mean-MDP policy (one solve, like simulate — NOT per-node
// re-solve). Bellman-decomposable: X = δ + X' with E[X]=δ+E[X'], E[X^2]=δ^2+2δE[X']+E[X'^2].
const M_CAP: usize = 1 << 20;
const M_MASK: u32 = (M_CAP - 1) as u32;
static mut M_SID: Vec<i32> = Vec::new(); // -1 = empty
static mut M_B: Vec<i32> = Vec::new();
static mut M_P: Vec<i32> = Vec::new();
static mut M_Y: Vec<i32> = Vec::new();
static mut M_M1: Vec<f64> = Vec::new();
static mut M_M2: Vec<f64> = Vec::new();
static mut TARGET_KIT: i32 = 2;
static mut DM1: f64 = 0.0; // recursion "return" registers
static mut DM2: f64 = 0.0;
static mut START_M1: f64 = 0.0;
static mut START_M2: f64 = 0.0;

unsafe fn m_reset() {
    if M_SID.is_empty() {
        M_SID = vec![-1i32; M_CAP];
        M_B = vec![0i32; M_CAP];
        M_P = vec![0i32; M_CAP];
        M_Y = vec![0i32; M_CAP];
        M_M1 = vec![0.0f64; M_CAP];
        M_M2 = vec![0.0f64; M_CAP];
    } else {
        for s in M_SID.iter_mut() {
            *s = -1;
        }
    }
}
#[inline]
fn m_hash(sid: i32, b: i32, p: i32, y: i32) -> usize {
    let mut h: u32 = (sid as u32).wrapping_mul(2654435761);
    h ^= (b as u32).wrapping_mul(40503);
    h ^= (p as u32).wrapping_mul(12289);
    h ^= (y as u32).wrapping_mul(3079);
    h ^= h >> 15;
    h = h.wrapping_mul(0x85eb_ca6b);
    (h & M_MASK) as usize
}
// momentNode: sets DM1=E[X], DM2=E[X^2] for total TARGET_KIT uses from (sid, uses).
unsafe fn moment_node(sid: i32, b: i32, p: i32, y: i32) {
    if is_terminal(sid) {
        DM1 = 0.0;
        DM2 = 0.0;
        return;
    }
    if is_convert(sid) {
        moment_node(CONVERT_SID, b, p, y);
        return;
    }
    let mut i = m_hash(sid, b, p, y);
    while M_SID[i] != -1 {
        if M_SID[i] == sid && M_B[i] == b && M_P[i] == p && M_Y[i] == y {
            DM1 = M_M1[i];
            DM2 = M_M2[i];
            return;
        }
        i = (i + 1) & (M_MASK as usize);
    }
    let slot = i; // empty slot for insert

    let action = policy_action(sid, b, p, y);
    if action < 0 {
        DM1 = 0.0;
        DM2 = 0.0;
        M_SID[slot] = sid;
        M_B[slot] = b;
        M_P[slot] = p;
        M_Y[slot] = y;
        M_M1[slot] = 0.0;
        M_M2[slot] = 0.0;
        return;
    }
    compute_transition(sid, action);
    let prob = TX_PROB; // copy BEFORE recursing
    let succ = TX_SUCC;
    let fail = TX_FAIL;
    let delta: f64 = if action == TARGET_KIT { 1.0 } else { 0.0 };
    let nb = b - if action == 0 { 1 } else { 0 };
    let np = p - if action == 1 { 1 } else { 0 };
    let ny = y - if action == 2 { 1 } else { 0 };

    moment_node(succ, nb, np, ny);
    let s1 = DM1;
    let s2 = DM2;
    moment_node(fail, nb, np, ny);
    let f1 = DM1;
    let f2 = DM2;

    let inv = 1.0 - prob;
    let ex1 = prob * s1 + inv * f1; // E[X']
    let ex2 = prob * s2 + inv * f2; // E[X'^2]
    let m1 = delta + ex1;
    let m2 = delta * delta + 2.0 * delta * ex1 + ex2;

    M_SID[slot] = sid;
    M_B[slot] = b;
    M_P[slot] = p;
    M_Y[slot] = y;
    M_M1[slot] = m1;
    M_M2[slot] = m2;
    DM1 = m1;
    DM2 = m2;
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
        TARGET_KIT = kit;
        let uses_b = uses_of(pb, MAX_USES_B);
        let uses_p = uses_of(pp, MAX_USES_P);
        let uses_y = uses_of(py, MAX_USES_Y);
        // build the policy memo once (start stock as cost basis), like solveCore; the moment
        // recursion then FOLLOWS that fixed policy (no per-node re-solve), as simulate does.
        memo_reset();
        solve_start(
            sid, uses_b, uses_p, uses_y, pb as f64, pp as f64, py as f64, hf, np, tol,
        );
        m_reset();
        moment_node(sid, uses_b, uses_p, uses_y);
        START_M1 = DM1;
        START_M2 = DM2;
    }
}
#[no_mangle]
pub extern "C" fn distMeanUses() -> f64 {
    unsafe { START_M1 }
}
#[no_mangle]
pub extern "C" fn distVarUses() -> f64 {
    unsafe { START_M2 - START_M1 * START_M1 }
}

// ===== cvar.ts ===============================================================================
// PORT OF: assembly/cvar.ts (Phase 3 본론; see ../PHASE3_CVAR.md). Tail-aware CVaR DP via the R–U
// η-dual, made tractable by the terminal-cost collapse (consumed_i = (startUses_i − stock_i)·10 is
// already in the state). follow* = expectation under the deployed mean-MDP policy; opt* = the
// optimizing DP; *Record + followRecorded* trace the mean/tail Pareto frontier (E[f under π_α]).
const C_CAP: usize = 1 << 20;
const C_MASK: u32 = (C_CAP - 1) as u32;
static mut C_SID: Vec<i32> = Vec::new(); // -1 = empty
static mut C_B: Vec<i32> = Vec::new();
static mut C_P: Vec<i32> = Vec::new();
static mut C_Y: Vec<i32> = Vec::new();
static mut C_VAL: Vec<f64> = Vec::new();
static mut POL_SID: Vec<i32> = Vec::new(); // recorded-policy table (-1 = empty)
static mut POL_B: Vec<i32> = Vec::new();
static mut POL_P: Vec<i32> = Vec::new();
static mut POL_Y: Vec<i32> = Vec::new();
static mut POL_ACT: Vec<i8> = Vec::new();
static mut C_FOUND_VAL: f64 = 0.0;

static mut CV_HF: f64 = 0.75;
static mut CV_NP: f64 = 3.0;
static mut CV_INIT_B: f64 = 0.0; // raw initial pieces (availability basis)
static mut CV_INIT_P: f64 = 0.0;
static mut CV_INIT_Y: f64 = 0.0;
static mut CV_START_B: i32 = 0; // start stock in USES
static mut CV_START_P: i32 = 0;
static mut CV_START_Y: i32 = 0;
static mut CV_START_SID: i32 = 0;
static mut CV_ETA: f64 = 0.0;
static mut CV_USE_HINGE: bool = false;

unsafe fn c_ensure() {
    if C_SID.is_empty() {
        C_SID = vec![-1i32; C_CAP];
        C_B = vec![0i32; C_CAP];
        C_P = vec![0i32; C_CAP];
        C_Y = vec![0i32; C_CAP];
        C_VAL = vec![0.0f64; C_CAP];
        POL_SID = vec![-1i32; C_CAP];
        POL_B = vec![0i32; C_CAP];
        POL_P = vec![0i32; C_CAP];
        POL_Y = vec![0i32; C_CAP];
        POL_ACT = vec![0i8; C_CAP];
    }
}
unsafe fn c_reset() {
    c_ensure();
    for s in C_SID.iter_mut() {
        *s = -1;
    }
}
unsafe fn pol_reset() {
    c_ensure();
    for s in POL_SID.iter_mut() {
        *s = -1;
    }
}
#[inline]
fn c_hash(sid: i32, b: i32, p: i32, y: i32) -> u32 {
    let mut h: u32 = (sid as u32).wrapping_mul(2654435761);
    h ^= (b as u32).wrapping_mul(40503);
    h ^= (p as u32).wrapping_mul(12289);
    h ^= (y as u32).wrapping_mul(3079);
    h ^= h >> 15;
    h = h.wrapping_mul(0x85eb_ca6b);
    h & C_MASK
}
// hit -> slot index (>=0, sets C_FOUND_VAL); miss -> -1-slot (empty slot for insertion).
unsafe fn c_find(sid: i32, b: i32, p: i32, y: i32) -> i32 {
    let mut i = c_hash(sid, b, p, y) as usize;
    while C_SID[i] != -1 {
        if C_SID[i] == sid && C_B[i] == b && C_P[i] == p && C_Y[i] == y {
            C_FOUND_VAL = C_VAL[i];
            return i as i32;
        }
        i = (i + 1) & (C_MASK as usize);
    }
    -1 - (i as i32)
}
#[inline]
unsafe fn c_store(slot: i32, sid: i32, b: i32, p: i32, y: i32, v: f64) {
    let s = slot as usize;
    C_SID[s] = sid;
    C_B[s] = b;
    C_P[s] = p;
    C_Y[s] = y;
    C_VAL[s] = v;
}
unsafe fn pol_probe(sid: i32, b: i32, p: i32, y: i32) -> usize {
    let mut i = c_hash(sid, b, p, y) as usize;
    while POL_SID[i] != -1 {
        if POL_SID[i] == sid && POL_B[i] == b && POL_P[i] == p && POL_Y[i] == y {
            return i;
        }
        i = (i + 1) & (C_MASK as usize);
    }
    i
}

#[inline]
unsafe fn leaf_cost(b: i32, p: i32, y: i32) -> f64 {
    let cons_b = ((CV_START_B - b) * 10) as f64;
    let cons_p = ((CV_START_P - p) * 10) as f64;
    let cons_y = ((CV_START_Y - y) * 10) as f64;
    availability_cost(
        cons_b, cons_p, cons_y, CV_INIT_B, CV_INIT_P, CV_INIT_Y, CV_HF, CV_NP,
    )
}
#[inline]
unsafe fn leaf_value(b: i32, p: i32, y: i32) -> f64 {
    let c = leaf_cost(b, p, y);
    if CV_USE_HINGE {
        let d = c - CV_ETA;
        if d > 0.0 {
            d
        } else {
            0.0
        }
    } else {
        c
    }
}

// E_π[leaf] under the fixed mean-MDP policy (policy_action).
unsafe fn follow_node(sid: i32, b: i32, p: i32, y: i32) -> f64 {
    if is_terminal(sid) {
        return leaf_value(b, p, y);
    }
    if is_convert(sid) {
        return follow_node(CONVERT_SID, b, p, y);
    }
    let f = c_find(sid, b, p, y);
    if f >= 0 {
        return C_FOUND_VAL;
    }
    let slot = -1 - f;
    let action = policy_action(sid, b, p, y);
    if action < 0 {
        let v = leaf_value(b, p, y);
        c_store(slot, sid, b, p, y, v);
        return v;
    }
    compute_transition(sid, action);
    let prob = TX_PROB;
    let succ = TX_SUCC;
    let fail = TX_FAIL;
    let nb = b - if action == 0 { 1 } else { 0 };
    let np = p - if action == 1 { 1 } else { 0 };
    let ny = y - if action == 2 { 1 } else { 0 };
    let vs = follow_node(succ, nb, np, ny);
    let vf = follow_node(fail, nb, np, ny);
    let v = prob * vs + (1.0 - prob) * vf;
    c_store(slot, sid, b, p, y, v);
    v
}

// min_a E[leaf] — the optimizing DP.
unsafe fn opt_node(sid: i32, b: i32, p: i32, y: i32) -> f64 {
    if is_terminal(sid) {
        return leaf_value(b, p, y);
    }
    if is_convert(sid) {
        return opt_node(CONVERT_SID, b, p, y);
    }
    let f = c_find(sid, b, p, y);
    if f >= 0 {
        return C_FOUND_VAL;
    }
    let slot = -1 - f;
    let mut best = f64::INFINITY;
    let mut found = false;
    for k in 0..3i32 {
        if stock_of(k, b, p, y) <= 0 {
            continue;
        }
        compute_transition(sid, k);
        let prob = TX_PROB;
        let succ = TX_SUCC;
        let fail = TX_FAIL;
        let nb = b - if k == 0 { 1 } else { 0 };
        let np = p - if k == 1 { 1 } else { 0 };
        let ny = y - if k == 2 { 1 } else { 0 };
        let vs = opt_node(succ, nb, np, ny);
        let vf = opt_node(fail, nb, np, ny);
        let v = prob * vs + (1.0 - prob) * vf;
        if !found || v < best {
            best = v;
            found = true;
        }
    }
    if !found {
        best = leaf_value(b, p, y);
    }
    c_store(slot, sid, b, p, y, best);
    best
}

// opt_node + RECORD argmin action per node into the policy table (π_α at fixed η).
unsafe fn opt_record_node(sid: i32, b: i32, p: i32, y: i32) -> f64 {
    if is_terminal(sid) {
        return leaf_value(b, p, y);
    }
    if is_convert(sid) {
        return opt_record_node(CONVERT_SID, b, p, y);
    }
    let f = c_find(sid, b, p, y);
    if f >= 0 {
        return C_FOUND_VAL;
    }
    let slot = -1 - f;
    let mut best = f64::INFINITY;
    let mut found = false;
    let mut best_k: i32 = -1;
    for k in 0..3i32 {
        if stock_of(k, b, p, y) <= 0 {
            continue;
        }
        compute_transition(sid, k);
        let prob = TX_PROB;
        let succ = TX_SUCC;
        let fail = TX_FAIL;
        let nb = b - if k == 0 { 1 } else { 0 };
        let np = p - if k == 1 { 1 } else { 0 };
        let ny = y - if k == 2 { 1 } else { 0 };
        let vs = opt_record_node(succ, nb, np, ny);
        let vf = opt_record_node(fail, nb, np, ny);
        let v = prob * vs + (1.0 - prob) * vf;
        if !found || v < best {
            best = v;
            found = true;
            best_k = k;
        }
    }
    if !found {
        best = leaf_value(b, p, y);
    }
    c_store(slot, sid, b, p, y, best);
    let ps = pol_probe(sid, b, p, y);
    POL_SID[ps] = sid;
    POL_B[ps] = b;
    POL_P[ps] = p;
    POL_Y[ps] = y;
    POL_ACT[ps] = best_k as i8;
    best
}

// E_π[leaf] under the RECORDED policy (the most recent opt_record pass).
unsafe fn follow_recorded_node(sid: i32, b: i32, p: i32, y: i32) -> f64 {
    if is_terminal(sid) {
        return leaf_value(b, p, y);
    }
    if is_convert(sid) {
        return follow_recorded_node(CONVERT_SID, b, p, y);
    }
    let f = c_find(sid, b, p, y);
    if f >= 0 {
        return C_FOUND_VAL;
    }
    let slot = -1 - f;
    let ps = pol_probe(sid, b, p, y);
    let action: i32 = if POL_SID[ps] == -1 {
        -1
    } else {
        POL_ACT[ps] as i32
    };
    if action < 0 {
        let v = leaf_value(b, p, y);
        c_store(slot, sid, b, p, y, v);
        return v;
    }
    compute_transition(sid, action);
    let prob = TX_PROB;
    let succ = TX_SUCC;
    let fail = TX_FAIL;
    let nb = b - if action == 0 { 1 } else { 0 };
    let np = p - if action == 1 { 1 } else { 0 };
    let ny = y - if action == 2 { 1 } else { 0 };
    let vs = follow_recorded_node(succ, nb, np, ny);
    let vf = follow_recorded_node(fail, nb, np, ny);
    let v = prob * vs + (1.0 - prob) * vf;
    c_store(slot, sid, b, p, y, v);
    v
}

#[no_mangle]
pub extern "C" fn cvarSetup(sid: i32, pb: i32, pp: i32, py: i32, hf: f64, np: f64, tol: f64) {
    unsafe {
        CV_HF = hf;
        CV_NP = np;
        CV_INIT_B = pb as f64;
        CV_INIT_P = pp as f64;
        CV_INIT_Y = py as f64;
        CV_START_B = uses_of(pb, MAX_USES_B);
        CV_START_P = uses_of(pp, MAX_USES_P);
        CV_START_Y = uses_of(py, MAX_USES_Y);
        CV_START_SID = sid;
        memo_reset();
        solve_start(
            sid, CV_START_B, CV_START_P, CV_START_Y, pb as f64, pp as f64, py as f64, hf, np, tol,
        );
    }
}
#[no_mangle]
pub extern "C" fn cvarFollowMean() -> f64 {
    unsafe {
        CV_USE_HINGE = false;
        c_reset();
        follow_node(CV_START_SID, CV_START_B, CV_START_P, CV_START_Y)
    }
}
#[no_mangle]
pub extern "C" fn cvarFollowHinge(eta: f64) -> f64 {
    unsafe {
        CV_USE_HINGE = true;
        CV_ETA = eta;
        c_reset();
        follow_node(CV_START_SID, CV_START_B, CV_START_P, CV_START_Y)
    }
}
#[no_mangle]
pub extern "C" fn cvarOptMean() -> f64 {
    unsafe {
        CV_USE_HINGE = false;
        c_reset();
        opt_node(CV_START_SID, CV_START_B, CV_START_P, CV_START_Y)
    }
}
#[no_mangle]
pub extern "C" fn cvarOptHinge(eta: f64) -> f64 {
    unsafe {
        CV_USE_HINGE = true;
        CV_ETA = eta;
        c_reset();
        opt_node(CV_START_SID, CV_START_B, CV_START_P, CV_START_Y)
    }
}
#[no_mangle]
pub extern "C" fn cvarOptRecord(eta: f64) -> f64 {
    unsafe {
        CV_USE_HINGE = true;
        CV_ETA = eta;
        c_reset();
        pol_reset();
        opt_record_node(CV_START_SID, CV_START_B, CV_START_P, CV_START_Y)
    }
}
#[no_mangle]
pub extern "C" fn cvarFollowRecordedMean() -> f64 {
    unsafe {
        CV_USE_HINGE = false;
        c_reset();
        follow_recorded_node(CV_START_SID, CV_START_B, CV_START_P, CV_START_Y)
    }
}
#[no_mangle]
pub extern "C" fn cvarFollowRecordedHinge(eta: f64) -> f64 {
    unsafe {
        CV_USE_HINGE = true;
        CV_ETA = eta;
        c_reset();
        follow_recorded_node(CV_START_SID, CV_START_B, CV_START_P, CV_START_Y)
    }
}

// ===== minef.ts ==============================================================================
// PORT OF: assembly/minef.ts. min-E[f] policy: SAME τ-gate as value(), secondary criterion = min
// E[f(total)] (terminal-only → decomposable) instead of the Jensen surrogate. UNCAPPED (heavier than
// the capped deployed solve; impractical at the R0/250+ node-count peak). Register-return + memo.
const ME_CAP: usize = 1 << 21;
const ME_MASK: u32 = (ME_CAP - 1) as u32;
const ME_FULL_GUARD: usize = ME_CAP - (ME_CAP >> 3);
static mut ME_SID: Vec<i32> = Vec::new(); // -1 = empty
static mut ME_B: Vec<i32> = Vec::new();
static mut ME_P: Vec<i32> = Vec::new();
static mut ME_Y: Vec<i32> = Vec::new();
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

#[inline]
unsafe fn me_leaf_cost(b: i32, p: i32, y: i32) -> f64 {
    let cb = ((ME_START_B - b) * 10) as f64;
    let cp = ((ME_START_P - p) * 10) as f64;
    let cy = ((ME_START_Y - y) * 10) as f64;
    availability_cost(cb, cp, cy, ME_INIT_B, ME_INIT_P, ME_INIT_Y, ME_HF, ME_NP)
}
#[inline]
fn me_hash(sid: i32, b: i32, p: i32, y: i32) -> usize {
    let mut h: u32 = (sid as u32).wrapping_mul(2654435761);
    h ^= (b as u32).wrapping_mul(40503);
    h ^= (p as u32).wrapping_mul(12289);
    h ^= (y as u32).wrapping_mul(3079);
    h ^= h >> 15;
    h = h.wrapping_mul(0x85eb_ca6b);
    (h & ME_MASK) as usize
}
unsafe fn me_reset() {
    if ME_SID.is_empty() {
        ME_SID = vec![-1i32; ME_CAP];
        ME_B = vec![0i32; ME_CAP];
        ME_P = vec![0i32; ME_CAP];
        ME_Y = vec![0i32; ME_CAP];
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
        for s in ME_SID.iter_mut() {
            *s = -1;
        }
    }
    ME_COUNT = 0;
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
    let mut i = me_hash(sid, b, p, y);
    while ME_SID[i] != -1 {
        if ME_SID[i] == sid && ME_B[i] == b && ME_P[i] == p && ME_Y[i] == y {
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
        ME_SID[slot] = sid;
        ME_B[slot] = b;
        ME_P[slot] = p;
        ME_Y[slot] = y;
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
    ME_SID[slot] = sid;
    ME_B[slot] = b;
    ME_P[slot] = p;
    ME_Y[slot] = y;
    ME_SP[slot] = MN_SP;
    ME_SPMAX[slot] = MN_SPMAX;
    ME_VB[slot] = MN_VB;
    ME_VP[slot] = MN_VP;
    ME_VY[slot] = MN_VY;
    ME_EF[slot] = MN_EF;
    ME_ACT[slot] = best_k as i8;
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
// policy lookup for the MC validator: chosen action at (sid, stock uses) from the last solveMinEf memo.
unsafe fn min_ef_action_at(sid: i32, b: i32, p: i32, y: i32) -> i32 {
    let mut i = me_hash(sid, b, p, y);
    while ME_SID[i] != -1 {
        if ME_SID[i] == sid && ME_B[i] == b && ME_P[i] == p && ME_Y[i] == y {
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
static mut MC_EF_RUNS: i32 = 0;
static mut MC_EF_COMPLETED: i32 = 0;
#[no_mangle]
pub extern "C" fn getMcEf() -> f64 {
    unsafe { MC_EF_MEAN }
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
        MC_EF_RUNS = runs;
        MC_EF_COMPLETED = 0;
        return;
    }

    RNG = seed;
    let mut sum_f = 0.0;
    let mut completed = 0;
    for _ in 0..runs {
        let mut sid = start_sid;
        let (mut b, mut p, mut y) = (b0, p0, y0);
        let (mut ub, mut up, mut uy) = (0, 0, 0);
        let mut force_first = true;
        for _ in 0..1000 {
            if is_terminal(sid) {
                completed += 1;
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
        sum_f += availability_cost(
            ub as f64, up as f64, uy as f64, init_b, init_p, init_y, hf, np,
        );
    }
    MC_EF_MEAN = if runs > 0 { sum_f / runs as f64 } else { 0.0 };
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
        RNG = seed;
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
