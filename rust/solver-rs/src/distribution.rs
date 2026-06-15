use crate::transition::{
    compute_transition, is_convert, is_terminal, CONVERT_SID, TX_FAIL, TX_PROB, TX_SUCC,
};

type PolicyAction = unsafe fn(i32, i32, i32, i32) -> i32;

const M_CAP: usize = 1 << 20;
const M_MASK: u32 = (M_CAP - 1) as u32;
static mut M_SID: Vec<i32> = Vec::new();
static mut M_B: Vec<i32> = Vec::new();
static mut M_P: Vec<i32> = Vec::new();
static mut M_Y: Vec<i32> = Vec::new();
static mut M_M1: Vec<f64> = Vec::new();
static mut M_M2: Vec<f64> = Vec::new();
static mut TARGET_KIT: i32 = 2;
static mut DM1: f64 = 0.0;
static mut DM2: f64 = 0.0;
static mut START_M1: f64 = 0.0;
static mut START_M2: f64 = 0.0;

pub(crate) unsafe fn dist_start(
    sid: i32,
    b: i32,
    p: i32,
    y: i32,
    kit: i32,
    policy_action: PolicyAction,
) {
    TARGET_KIT = kit;
    m_reset();
    moment_node(sid, b, p, y, policy_action);
    START_M1 = DM1;
    START_M2 = DM2;
}

pub(crate) unsafe fn dist_mean_uses() -> f64 {
    START_M1
}

pub(crate) unsafe fn dist_var_uses() -> f64 {
    START_M2 - START_M1 * START_M1
}

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

unsafe fn moment_node(sid: i32, b: i32, p: i32, y: i32, policy_action: PolicyAction) {
    if is_terminal(sid) {
        set_return(0.0, 0.0);
        return;
    }
    if is_convert(sid) {
        moment_node(CONVERT_SID, b, p, y, policy_action);
        return;
    }
    let mut i = m_hash(sid, b, p, y);
    while M_SID[i] != -1 {
        if M_SID[i] == sid && M_B[i] == b && M_P[i] == p && M_Y[i] == y {
            set_return(M_M1[i], M_M2[i]);
            return;
        }
        i = (i + 1) & (M_MASK as usize);
    }
    let slot = i;

    let action = policy_action(sid, b, p, y);
    if action < 0 {
        store(slot, sid, b, p, y, 0.0, 0.0);
        set_return(0.0, 0.0);
        return;
    }
    compute_transition(sid, action);
    let prob = TX_PROB;
    let succ = TX_SUCC;
    let fail = TX_FAIL;
    let delta = if action == TARGET_KIT { 1.0 } else { 0.0 };
    let nb = b - if action == 0 { 1 } else { 0 };
    let np = p - if action == 1 { 1 } else { 0 };
    let ny = y - if action == 2 { 1 } else { 0 };

    moment_node(succ, nb, np, ny, policy_action);
    let s1 = DM1;
    let s2 = DM2;
    moment_node(fail, nb, np, ny, policy_action);
    let f1 = DM1;
    let f2 = DM2;

    let inv = 1.0 - prob;
    let ex1 = prob * s1 + inv * f1;
    let ex2 = prob * s2 + inv * f2;
    let m1 = delta + ex1;
    let m2 = delta * delta + 2.0 * delta * ex1 + ex2;

    store(slot, sid, b, p, y, m1, m2);
    set_return(m1, m2);
}

#[inline]
unsafe fn set_return(m1: f64, m2: f64) {
    DM1 = m1;
    DM2 = m2;
}

#[inline]
unsafe fn store(slot: usize, sid: i32, b: i32, p: i32, y: i32, m1: f64, m2: f64) {
    M_SID[slot] = sid;
    M_B[slot] = b;
    M_P[slot] = p;
    M_Y[slot] = y;
    M_M1[slot] = m1;
    M_M2[slot] = m2;
}
