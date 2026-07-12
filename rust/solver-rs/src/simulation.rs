use crate::state::stock_of;
use crate::transition::{
    compute_transition, is_convert, is_terminal, CONVERT_SID, TX_FAIL, TX_PROB, TX_SUCC,
};

pub(crate) type PolicyAction = unsafe fn(i32, i32, i32, i32) -> i32;

static mut RNG: u32 = 0;
static mut MC_COMPLETED: i32 = 0;
static mut MC_RUNS: i32 = 0;
static mut MC_TB: f64 = 0.0;
static mut MC_TP: f64 = 0.0;
static mut MC_TY: f64 = 0.0;
static mut MC_SQB: f64 = 0.0;
static mut MC_SQP: f64 = 0.0;
static mut MC_SQY: f64 = 0.0;

const HBINS: usize = 256;
static mut HIST_B: [i32; HBINS] = [0; HBINS];
static mut HIST_P: [i32; HBINS] = [0; HBINS];
static mut HIST_Y: [i32; HBINS] = [0; HBINS];

#[inline]
pub(crate) unsafe fn seed_rng(seed: u32) {
    RNG = seed;
}

#[inline]
pub(crate) fn next_random() -> f64 {
    unsafe {
        RNG = RNG.wrapping_mul(1664525).wrapping_add(1013904223);
        (RNG as f64) / 4294967296.0
    }
}

pub(crate) unsafe fn simulate_run(
    start_sid: i32,
    b0: i32,
    p0: i32,
    y0: i32,
    runs: i32,
    seed: u32,
    policy_action: PolicyAction,
) {
    simulate_run_with_first_action(start_sid, b0, p0, y0, runs, seed, -1, policy_action);
}

#[allow(
    clippy::too_many_arguments,
    reason = "hot loop passes scalar state without allocation"
)]
pub(crate) unsafe fn simulate_run_with_first_action(
    start_sid: i32,
    b0: i32,
    p0: i32,
    y0: i32,
    runs: i32,
    seed: u32,
    first_action: i32,
    policy_action: PolicyAction,
) {
    seed_rng(seed);
    let mut completed = 0;
    let (mut tb, mut tp, mut ty) = (0.0, 0.0, 0.0);
    let (mut sqb, mut sqp, mut sqy) = (0.0, 0.0, 0.0);
    HIST_B = [0; HBINS];
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
        HIST_B[(ub / 10) as usize] += 1;
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

pub(crate) unsafe fn mc_completed() -> i32 {
    MC_COMPLETED
}

pub(crate) unsafe fn mc_runs() -> i32 {
    MC_RUNS
}

pub(crate) unsafe fn mc_vec_b() -> f64 {
    mc_mean(MC_TB)
}

pub(crate) unsafe fn mc_vec_p() -> f64 {
    mc_mean(MC_TP)
}

pub(crate) unsafe fn mc_vec_y() -> f64 {
    mc_mean(MC_TY)
}

pub(crate) unsafe fn mc_var_b() -> f64 {
    mc_var(MC_SQB, MC_TB)
}

pub(crate) unsafe fn mc_var_p() -> f64 {
    mc_var(MC_SQP, MC_TP)
}

pub(crate) unsafe fn mc_var_y() -> f64 {
    mc_var(MC_SQY, MC_TY)
}

pub(crate) unsafe fn mc_quantile_b(q: f64) -> i32 {
    mc_quantile(&HIST_B, q)
}

pub(crate) unsafe fn mc_quantile_p(q: f64) -> i32 {
    mc_quantile(&HIST_P, q)
}

pub(crate) unsafe fn mc_quantile_y(q: f64) -> i32 {
    mc_quantile(&HIST_Y, q)
}

pub(crate) unsafe fn mc_depletion() -> f64 {
    if MC_RUNS > 0 {
        (MC_RUNS - MC_COMPLETED) as f64 / MC_RUNS as f64
    } else {
        0.0
    }
}

unsafe fn mc_mean(sum: f64) -> f64 {
    if MC_RUNS > 0 {
        sum / MC_RUNS as f64
    } else {
        0.0
    }
}

unsafe fn mc_var(sum_sq: f64, sum: f64) -> f64 {
    if MC_RUNS <= 0 {
        return 0.0;
    }
    let mean = sum / MC_RUNS as f64;
    sum_sq / MC_RUNS as f64 - mean * mean
}

unsafe fn mc_quantile(hist: &[i32; HBINS], q: f64) -> i32 {
    if MC_RUNS <= 0 {
        return 0;
    }
    let mut threshold = (q * MC_RUNS as f64) as i32;
    if threshold < 1 {
        threshold = 1;
    }
    if threshold > MC_RUNS {
        threshold = MC_RUNS;
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
