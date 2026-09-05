use crate::state::stock_of;
use crate::status::{status_ok, LAST_STATUS, STATUS_MEMO_FULL};
use crate::transition::{compute_transition, is_convert, is_terminal, CONVERT_SID};

pub(crate) type PolicyAction = unsafe fn(i32, i32, i32, i32) -> i32;

const VM_CAP: usize = 1 << 20;
const VM_MASK: u32 = (VM_CAP - 1) as u32;
const VM_FULL_GUARD: usize = VM_CAP - VM_CAP / 8;
static mut VM_COUNT: usize = 0;
static mut VM_SID: Vec<i32> = Vec::new();
static mut VM_B: Vec<i32> = Vec::new();
static mut VM_P: Vec<i32> = Vec::new();
static mut VM_Y: Vec<i32> = Vec::new();
static mut VM_MB: Vec<f64> = Vec::new();
static mut VM_MP: Vec<f64> = Vec::new();
static mut VM_MY: Vec<f64> = Vec::new();
static mut VM_BB: Vec<f64> = Vec::new();
static mut VM_PP: Vec<f64> = Vec::new();
static mut VM_YY: Vec<f64> = Vec::new();
static mut VM_BP: Vec<f64> = Vec::new();
static mut VM_BY: Vec<f64> = Vec::new();
static mut VM_PY: Vec<f64> = Vec::new();
static mut VMR: [f64; 9] = [0.0; 9];
static mut VM_START: [f64; 9] = [0.0; 9];

unsafe fn vm_reset() {
    if VM_SID.is_empty() {
        VM_SID = vec![-1i32; VM_CAP];
        VM_B = vec![0i32; VM_CAP];
        VM_P = vec![0i32; VM_CAP];
        VM_Y = vec![0i32; VM_CAP];
        VM_MB = vec![0.0f64; VM_CAP];
        VM_MP = vec![0.0f64; VM_CAP];
        VM_MY = vec![0.0f64; VM_CAP];
        VM_BB = vec![0.0f64; VM_CAP];
        VM_PP = vec![0.0f64; VM_CAP];
        VM_YY = vec![0.0f64; VM_CAP];
        VM_BP = vec![0.0f64; VM_CAP];
        VM_BY = vec![0.0f64; VM_CAP];
        VM_PY = vec![0.0f64; VM_CAP];
    } else {
        for s in VM_SID.iter_mut() {
            *s = -1;
        }
    }
    VM_COUNT = 0;
}

#[inline]
fn vm_hash(sid: i32, b: i32, p: i32, y: i32) -> usize {
    let mut h: u32 = (sid as u32).wrapping_mul(2654435761);
    h ^= (b as u32).wrapping_mul(40503);
    h ^= (p as u32).wrapping_mul(12289);
    h ^= (y as u32).wrapping_mul(3079);
    h ^= h >> 15;
    h = h.wrapping_mul(0x85eb_ca6b);
    (h & VM_MASK) as usize
}

#[inline]
fn vm_mix(action: i32, prob: f64, s: [f64; 9], f: [f64; 9]) -> [f64; 9] {
    let inv = 1.0 - prob;
    let yb = prob * s[0] + inv * f[0];
    let yp = prob * s[1] + inv * f[1];
    let yy = prob * s[2] + inv * f[2];
    let ybb = prob * s[3] + inv * f[3];
    let ypp = prob * s[4] + inv * f[4];
    let yyy = prob * s[5] + inv * f[5];
    let ybp = prob * s[6] + inv * f[6];
    let yby = prob * s[7] + inv * f[7];
    let ypy = prob * s[8] + inv * f[8];
    let db = if action == 0 { 1.0 } else { 0.0 };
    let dp = if action == 1 { 1.0 } else { 0.0 };
    let dy = if action == 2 { 1.0 } else { 0.0 };
    [
        db + yb,
        dp + yp,
        dy + yy,
        db * db + 2.0 * db * yb + ybb,
        dp * dp + 2.0 * dp * yp + ypp,
        dy * dy + 2.0 * dy * yy + yyy,
        db * dp + db * yp + dp * yb + ybp,
        db * dy + db * yy + dy * yb + yby,
        dp * dy + dp * yy + dy * yp + ypy,
    ]
}

#[inline]
unsafe fn vm_set(vals: [f64; 9]) {
    VMR = vals;
}

#[inline]
unsafe fn vm_get() -> [f64; 9] {
    VMR
}

#[inline]
unsafe fn vm_store(slot: usize, sid: i32, b: i32, p: i32, y: i32, vals: [f64; 9]) {
    VM_SID[slot] = sid;
    VM_B[slot] = b;
    VM_P[slot] = p;
    VM_Y[slot] = y;
    VM_MB[slot] = vals[0];
    VM_MP[slot] = vals[1];
    VM_MY[slot] = vals[2];
    VM_BB[slot] = vals[3];
    VM_PP[slot] = vals[4];
    VM_YY[slot] = vals[5];
    VM_BP[slot] = vals[6];
    VM_BY[slot] = vals[7];
    VM_PY[slot] = vals[8];
}

unsafe fn vector_moment_node(sid: i32, b: i32, p: i32, y: i32, policy_action: PolicyAction) {
    if !status_ok() {
        vm_set([0.0; 9]);
        return;
    }
    if is_terminal(sid) {
        vm_set([0.0; 9]);
        return;
    }
    if is_convert(sid) {
        vector_moment_node(CONVERT_SID, b, p, y, policy_action);
        return;
    }
    let mut i = vm_hash(sid, b, p, y);
    let mut probes = 0usize;
    while VM_SID[i] != -1 {
        if VM_SID[i] == sid && VM_B[i] == b && VM_P[i] == p && VM_Y[i] == y {
            vm_set([
                VM_MB[i], VM_MP[i], VM_MY[i], VM_BB[i], VM_PP[i], VM_YY[i], VM_BP[i], VM_BY[i],
                VM_PY[i],
            ]);
            return;
        }
        probes += 1;
        if probes >= VM_CAP {
            LAST_STATUS = STATUS_MEMO_FULL;
            vm_set([0.0; 9]);
            return;
        }
        i = (i + 1) & (VM_MASK as usize);
    }
    if VM_COUNT >= VM_FULL_GUARD {
        LAST_STATUS = STATUS_MEMO_FULL;
        vm_set([0.0; 9]);
        return;
    }
    VM_COUNT += 1;
    let slot = i;

    let action = policy_action(sid, b, p, y);
    if action < 0 || stock_of(action, b, p, y) <= 0 {
        let vals = [0.0; 9];
        vm_store(slot, sid, b, p, y, vals);
        vm_set(vals);
        return;
    }

    let transition = compute_transition(sid, action);
    let prob = transition.probability;
    let succ = transition.success;
    let fail = transition.failure;
    let nb = b - if action == 0 { 1 } else { 0 };
    let np = p - if action == 1 { 1 } else { 0 };
    let ny = y - if action == 2 { 1 } else { 0 };

    vector_moment_node(succ, nb, np, ny, policy_action);
    if !status_ok() {
        return;
    }
    let succ_vals = vm_get();
    vector_moment_node(fail, nb, np, ny, policy_action);
    if !status_ok() {
        return;
    }
    let fail_vals = vm_get();
    let vals = vm_mix(action, prob, succ_vals, fail_vals);
    vm_store(slot, sid, b, p, y, vals);
    vm_set(vals);
}

pub(crate) unsafe fn moment_vector_after_first_action_from_policy(
    start_sid: i32,
    b0: i32,
    p0: i32,
    y0: i32,
    first_action: i32,
    policy_action: PolicyAction,
) {
    VM_START = [0.0; 9];
    if !status_ok() || !(0..=2).contains(&first_action) {
        return;
    }
    vm_reset();
    if stock_of(first_action, b0, p0, y0) <= 0 {
        return;
    }
    let transition = compute_transition(start_sid, first_action);
    let prob = transition.probability;
    let succ = transition.success;
    let fail = transition.failure;
    let nb = b0 - if first_action == 0 { 1 } else { 0 };
    let np = p0 - if first_action == 1 { 1 } else { 0 };
    let ny = y0 - if first_action == 2 { 1 } else { 0 };
    vector_moment_node(succ, nb, np, ny, policy_action);
    if !status_ok() {
        return;
    }
    let succ_vals = vm_get();
    vector_moment_node(fail, nb, np, ny, policy_action);
    if !status_ok() {
        return;
    }
    let fail_vals = vm_get();
    VM_START = vm_mix(first_action, prob, succ_vals, fail_vals);
}

pub(crate) unsafe fn moment_mean_b_uses() -> f64 {
    VM_START[0]
}

pub(crate) unsafe fn moment_mean_p_uses() -> f64 {
    VM_START[1]
}

pub(crate) unsafe fn moment_mean_y_uses() -> f64 {
    VM_START[2]
}

pub(crate) unsafe fn moment_second_bb_uses() -> f64 {
    VM_START[3]
}

pub(crate) unsafe fn moment_second_pp_uses() -> f64 {
    VM_START[4]
}

pub(crate) unsafe fn moment_second_yy_uses() -> f64 {
    VM_START[5]
}

pub(crate) unsafe fn moment_second_bp_uses() -> f64 {
    VM_START[6]
}

pub(crate) unsafe fn moment_second_by_uses() -> f64 {
    VM_START[7]
}

pub(crate) unsafe fn moment_second_py_uses() -> f64 {
    VM_START[8]
}

pub(crate) unsafe fn moment_vector_node_count() -> i32 {
    VM_COUNT as i32
}
