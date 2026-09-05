use crate::constants::STRICT_EPSILON;
use crate::cost::availability_cost;
use crate::phase2_max_success_for_action;
use crate::state::stock_of;
use crate::status::{status_ok, LAST_STATUS, STATUS_MEMO_FULL};
use crate::transition::{compute_transition, is_convert, is_terminal, CONVERT_SID};

pub(crate) type PolicyAction = unsafe fn(i32, i32, i32, i32) -> i32;

const C_CAP: usize = 1 << 20;
const C_MASK: u32 = (C_CAP - 1) as u32;
const C_FULL_GUARD: usize = C_CAP - C_CAP / 8;
static mut C_COUNT: usize = 0;
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
static mut CV_TOL: f64 = 0.0;

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
    C_COUNT = 0;
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
    let mut probes = 0usize;
    while C_SID[i] != -1 {
        if C_SID[i] == sid && C_B[i] == b && C_P[i] == p && C_Y[i] == y {
            C_FOUND_VAL = C_VAL[i];
            return i as i32;
        }
        probes += 1;
        if probes >= C_CAP {
            LAST_STATUS = STATUS_MEMO_FULL;
            return -1;
        }
        i = (i + 1) & (C_MASK as usize);
    }
    -1 - (i as i32)
}

#[inline]
unsafe fn c_store(slot: i32, sid: i32, b: i32, p: i32, y: i32, v: f64) {
    if C_COUNT >= C_FULL_GUARD {
        LAST_STATUS = STATUS_MEMO_FULL;
        return;
    }
    let s = slot as usize;
    C_SID[s] = sid;
    C_B[s] = b;
    C_P[s] = p;
    C_Y[s] = y;
    C_VAL[s] = v;
    C_COUNT += 1;
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
        cons_b,
        cons_p,
        cons_y,
        CV_INIT_B,
        CV_INIT_P,
        CV_INIT_Y,
        crate::G_GAIN_B,
        crate::G_GAIN_P,
        crate::G_GAIN_Y,
        CV_HF,
        CV_NP,
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

unsafe fn success_eligible_actions(sid: i32, b: i32, p: i32, y: i32) -> [bool; 3] {
    let mut success = [f64::NEG_INFINITY; 3];
    let mut maximum = f64::NEG_INFINITY;
    for action in 0..3i32 {
        if stock_of(action, b, p, y) <= 0 {
            continue;
        }
        if let Some(value) = phase2_max_success_for_action(sid, b, p, y, action) {
            success[action as usize] = value;
            maximum = maximum.max(value);
        }
        if !status_ok() {
            return [false; 3];
        }
    }
    let mut eligible = [false; 3];
    if maximum.is_finite() {
        for action in 0..3usize {
            eligible[action] =
                success[action].is_finite() && maximum - success[action] <= CV_TOL + STRICT_EPSILON;
        }
    }
    eligible
}

// E_pi[leaf] under the fixed mean-MDP policy.
unsafe fn follow_node(sid: i32, b: i32, p: i32, y: i32, policy_action: PolicyAction) -> f64 {
    if !status_ok() {
        return 0.0;
    }
    if is_terminal(sid) {
        return leaf_value(b, p, y);
    }
    if is_convert(sid) {
        return follow_node(CONVERT_SID, b, p, y, policy_action);
    }
    let f = c_find(sid, b, p, y);
    if !status_ok() {
        return 0.0;
    }
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
    let transition = compute_transition(sid, action);
    let prob = transition.probability;
    let succ = transition.success;
    let fail = transition.failure;
    let nb = b - if action == 0 { 1 } else { 0 };
    let np = p - if action == 1 { 1 } else { 0 };
    let ny = y - if action == 2 { 1 } else { 0 };
    let vs = follow_node(succ, nb, np, ny, policy_action);
    if !status_ok() {
        return 0.0;
    }
    let vf = follow_node(fail, nb, np, ny, policy_action);
    if !status_ok() {
        return 0.0;
    }
    let v = prob * vs + (1.0 - prob) * vf;
    c_store(slot, sid, b, p, y, v);
    v
}

// min_a E[leaf] — the optimizing DP.
unsafe fn opt_node(sid: i32, b: i32, p: i32, y: i32) -> f64 {
    if !status_ok() {
        return 0.0;
    }
    if is_terminal(sid) {
        return leaf_value(b, p, y);
    }
    if is_convert(sid) {
        return opt_node(CONVERT_SID, b, p, y);
    }
    let f = c_find(sid, b, p, y);
    if !status_ok() {
        return 0.0;
    }
    if f >= 0 {
        return C_FOUND_VAL;
    }
    let slot = -1 - f;
    let eligible = success_eligible_actions(sid, b, p, y);
    if !status_ok() {
        return 0.0;
    }
    let mut best = f64::INFINITY;
    let mut found = false;
    for k in 0..3i32 {
        if !eligible[k as usize] {
            continue;
        }
        let transition = compute_transition(sid, k);
        let prob = transition.probability;
        let succ = transition.success;
        let fail = transition.failure;
        let nb = b - if k == 0 { 1 } else { 0 };
        let np = p - if k == 1 { 1 } else { 0 };
        let ny = y - if k == 2 { 1 } else { 0 };
        let vs = opt_node(succ, nb, np, ny);
        if !status_ok() {
            return 0.0;
        }
        let vf = opt_node(fail, nb, np, ny);
        if !status_ok() {
            return 0.0;
        }
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

// opt_node + RECORD argmin action per node into the policy table (pi_alpha at fixed eta).
unsafe fn opt_record_node(sid: i32, b: i32, p: i32, y: i32) -> f64 {
    if !status_ok() {
        return 0.0;
    }
    if is_terminal(sid) {
        return leaf_value(b, p, y);
    }
    if is_convert(sid) {
        return opt_record_node(CONVERT_SID, b, p, y);
    }
    let f = c_find(sid, b, p, y);
    if !status_ok() {
        return 0.0;
    }
    if f >= 0 {
        return C_FOUND_VAL;
    }
    let slot = -1 - f;
    let eligible = success_eligible_actions(sid, b, p, y);
    if !status_ok() {
        return 0.0;
    }
    let mut best = f64::INFINITY;
    let mut found = false;
    let mut best_k: i32 = -1;
    for k in 0..3i32 {
        if !eligible[k as usize] {
            continue;
        }
        let transition = compute_transition(sid, k);
        let prob = transition.probability;
        let succ = transition.success;
        let fail = transition.failure;
        let nb = b - if k == 0 { 1 } else { 0 };
        let np = p - if k == 1 { 1 } else { 0 };
        let ny = y - if k == 2 { 1 } else { 0 };
        let vs = opt_record_node(succ, nb, np, ny);
        if !status_ok() {
            return 0.0;
        }
        let vf = opt_record_node(fail, nb, np, ny);
        if !status_ok() {
            return 0.0;
        }
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

// E_pi[leaf] under the RECORDED policy (the most recent opt_record pass).
unsafe fn follow_recorded_node(sid: i32, b: i32, p: i32, y: i32) -> f64 {
    if !status_ok() {
        return 0.0;
    }
    if is_terminal(sid) {
        return leaf_value(b, p, y);
    }
    if is_convert(sid) {
        return follow_recorded_node(CONVERT_SID, b, p, y);
    }
    let f = c_find(sid, b, p, y);
    if !status_ok() {
        return 0.0;
    }
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
    let transition = compute_transition(sid, action);
    let prob = transition.probability;
    let succ = transition.success;
    let fail = transition.failure;
    let nb = b - if action == 0 { 1 } else { 0 };
    let np = p - if action == 1 { 1 } else { 0 };
    let ny = y - if action == 2 { 1 } else { 0 };
    let vs = follow_recorded_node(succ, nb, np, ny);
    if !status_ok() {
        return 0.0;
    }
    let vf = follow_recorded_node(fail, nb, np, ny);
    if !status_ok() {
        return 0.0;
    }
    let v = prob * vs + (1.0 - prob) * vf;
    c_store(slot, sid, b, p, y, v);
    v
}

unsafe fn follow_recorded_success_node(sid: i32, b: i32, p: i32, y: i32) -> f64 {
    if !status_ok() {
        return 0.0;
    }
    if is_terminal(sid) {
        return 1.0;
    }
    if is_convert(sid) {
        return follow_recorded_success_node(CONVERT_SID, b, p, y);
    }
    let f = c_find(sid, b, p, y);
    if !status_ok() {
        return 0.0;
    }
    if f >= 0 {
        return C_FOUND_VAL;
    }
    let slot = -1 - f;
    let action = cvar_recorded_action(sid, b, p, y);
    if action < 0 {
        c_store(slot, sid, b, p, y, 0.0);
        return 0.0;
    }
    let transition = compute_transition(sid, action);
    let prob = transition.probability;
    let succ = transition.success;
    let fail = transition.failure;
    let nb = b - if action == 0 { 1 } else { 0 };
    let np = p - if action == 1 { 1 } else { 0 };
    let ny = y - if action == 2 { 1 } else { 0 };
    let success = follow_recorded_success_node(succ, nb, np, ny);
    if !status_ok() {
        return 0.0;
    }
    let failure = follow_recorded_success_node(fail, nb, np, ny);
    if !status_ok() {
        return 0.0;
    }
    let value = prob * success + (1.0 - prob) * failure;
    c_store(slot, sid, b, p, y, value);
    value
}

pub(crate) unsafe fn cvar_recorded_action(sid: i32, b: i32, p: i32, y: i32) -> i32 {
    if is_terminal(sid) {
        return -1;
    }
    if is_convert(sid) {
        return cvar_recorded_action(CONVERT_SID, b, p, y);
    }
    let slot = pol_probe(sid, b, p, y);
    if POL_SID[slot] == -1 {
        -1
    } else {
        POL_ACT[slot] as i32
    }
}

#[allow(
    clippy::too_many_arguments,
    reason = "matches the stable WASM CVaR setup ABI"
)]
pub(crate) unsafe fn cvar_setup(
    sid: i32,
    pb: i32,
    pp: i32,
    py: i32,
    hf: f64,
    np: f64,
    start_b: i32,
    start_p: i32,
    start_y: i32,
    tolerance: f64,
) {
    CV_HF = hf;
    CV_NP = np;
    CV_INIT_B = pb as f64;
    CV_INIT_P = pp as f64;
    CV_INIT_Y = py as f64;
    CV_START_B = start_b;
    CV_START_P = start_p;
    CV_START_Y = start_y;
    CV_START_SID = sid;
    CV_TOL = tolerance;
}

pub(crate) unsafe fn cvar_follow_mean(policy_action: PolicyAction) -> f64 {
    CV_USE_HINGE = false;
    c_reset();
    follow_node(
        CV_START_SID,
        CV_START_B,
        CV_START_P,
        CV_START_Y,
        policy_action,
    )
}

unsafe fn cvar_follow_after_first_action(first_action: i32, policy_action: PolicyAction) -> f64 {
    c_reset();
    if !(0..=2).contains(&first_action) {
        return f64::INFINITY;
    }
    let mut sid = CV_START_SID;
    if is_convert(sid) {
        sid = CONVERT_SID;
    }
    if is_terminal(sid) {
        return leaf_value(CV_START_B, CV_START_P, CV_START_Y);
    }
    if stock_of(first_action, CV_START_B, CV_START_P, CV_START_Y) <= 0 {
        return leaf_value(CV_START_B, CV_START_P, CV_START_Y);
    }
    let transition = compute_transition(sid, first_action);
    let prob = transition.probability;
    let succ = transition.success;
    let fail = transition.failure;
    let nb = CV_START_B - if first_action == 0 { 1 } else { 0 };
    let np = CV_START_P - if first_action == 1 { 1 } else { 0 };
    let ny = CV_START_Y - if first_action == 2 { 1 } else { 0 };
    let vs = follow_node(succ, nb, np, ny, policy_action);
    if !status_ok() {
        return 0.0;
    }
    let vf = follow_node(fail, nb, np, ny, policy_action);
    if !status_ok() {
        return 0.0;
    }
    prob * vs + (1.0 - prob) * vf
}

pub(crate) unsafe fn cvar_follow_mean_after_first_action(
    first_action: i32,
    policy_action: PolicyAction,
) -> f64 {
    CV_USE_HINGE = false;
    cvar_follow_after_first_action(first_action, policy_action)
}

pub(crate) unsafe fn cvar_follow_hinge_after_first_action(
    eta: f64,
    first_action: i32,
    policy_action: PolicyAction,
) -> f64 {
    CV_USE_HINGE = true;
    CV_ETA = eta;
    cvar_follow_after_first_action(first_action, policy_action)
}

pub(crate) unsafe fn cvar_node_count() -> i32 {
    C_COUNT as i32
}

pub(crate) unsafe fn cvar_follow_hinge(eta: f64, policy_action: PolicyAction) -> f64 {
    CV_USE_HINGE = true;
    CV_ETA = eta;
    c_reset();
    follow_node(
        CV_START_SID,
        CV_START_B,
        CV_START_P,
        CV_START_Y,
        policy_action,
    )
}

pub(crate) unsafe fn cvar_opt_mean() -> f64 {
    CV_USE_HINGE = false;
    c_reset();
    opt_node(CV_START_SID, CV_START_B, CV_START_P, CV_START_Y)
}

pub(crate) unsafe fn cvar_opt_hinge(eta: f64) -> f64 {
    CV_USE_HINGE = true;
    CV_ETA = eta;
    c_reset();
    opt_node(CV_START_SID, CV_START_B, CV_START_P, CV_START_Y)
}

pub(crate) unsafe fn cvar_opt_record(eta: f64) -> f64 {
    CV_USE_HINGE = true;
    CV_ETA = eta;
    c_reset();
    pol_reset();
    opt_record_node(CV_START_SID, CV_START_B, CV_START_P, CV_START_Y)
}

pub(crate) unsafe fn cvar_follow_recorded_mean() -> f64 {
    CV_USE_HINGE = false;
    c_reset();
    follow_recorded_node(CV_START_SID, CV_START_B, CV_START_P, CV_START_Y)
}

pub(crate) unsafe fn cvar_follow_recorded_hinge(eta: f64) -> f64 {
    CV_USE_HINGE = true;
    CV_ETA = eta;
    c_reset();
    follow_recorded_node(CV_START_SID, CV_START_B, CV_START_P, CV_START_Y)
}

pub(crate) unsafe fn cvar_follow_recorded_success() -> f64 {
    c_reset();
    follow_recorded_success_node(CV_START_SID, CV_START_B, CV_START_P, CV_START_Y)
}
