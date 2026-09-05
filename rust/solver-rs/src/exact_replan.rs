use crate::constants::{MAX_USES_B, MAX_USES_P, MAX_USES_Y};
use crate::state::{grade_of, level_of, stock_of};
use crate::transition::{compute_transition, is_convert, is_terminal, CONVERT_SID};
use crate::uses_of;

pub(crate) type SolveActionAt = unsafe fn(i32, i32, i32, i32, f64, f64, f64) -> i32;
pub(crate) type PolicyAction = unsafe fn(i32, i32, i32, i32) -> i32;

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
unsafe fn run_count(
    sid: i32,
    action: i32,
    ub: i32,
    up: i32,
    uy: i32,
    policy_action: PolicyAction,
) -> i32 {
    let mut state = sid;
    let (mut b, mut p, mut y) = (ub, up, uy);
    if stock_of(action, b, p, y) <= 0 {
        return 0;
    }
    let success_target = compute_transition(state, action).success; // firstEdge.success (solver.ts:751)
    let mut count = 0;
    while count < 100 && !is_terminal(state) && !is_convert(state) && stock_of(action, b, p, y) > 0
    {
        if count > 0 && policy_action(state, b, p, y) != action {
            break; // policy changed (solver.ts:762-763)
        }
        let transition = compute_transition(state, action);
        if transition.success != success_target {
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
        let fail = transition.failure;
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
unsafe fn exact_value(
    sid: i32,
    pb: i32,
    pp: i32,
    py: i32,
    solve_action_at: SolveActionAt,
    policy_action: PolicyAction,
) -> f64 {
    if is_terminal(sid) {
        return 1.0;
    }
    if is_convert(sid) {
        return exact_value(CONVERT_SID, pb, pp, py, solve_action_at, policy_action);
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
        policy_action,
    );
    if n < 1 {
        n = 1; // best.run.count = max(1, count) (visit:375)
    }
    let mut fail_sid = sid;
    let mut no_succ: f64 = 1.0;
    let mut agg_p: f64 = 0.0;
    let mut attempt = 1;
    while attempt <= n {
        let transition = compute_transition(fail_sid, action); // copy BEFORE recursing (recursion re-solves)
        let prob = transition.probability;
        let succ_sid = transition.success;
        let fail_next = transition.failure;
        let p_hit = no_succ * prob; // first success exactly at this attempt (visit:382)
        if p_hit > 0.0 {
            let cb = pb - if action == 0 { attempt * 10 } else { 0 };
            let cp = pp - if action == 1 { attempt * 10 } else { 0 };
            let cy = py - if action == 2 { attempt * 10 } else { 0 };
            agg_p += p_hit * exact_value(succ_sid, cb, cp, cy, solve_action_at, policy_action);
            // visit:388
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
        agg_p += no_succ * exact_value(fail_sid, cb, cp, cy, solve_action_at, policy_action);
        // visit:411
    }
    ex_insert(sid, pb, pp, py, agg_p);
    agg_p
}

#[allow(
    clippy::too_many_arguments,
    reason = "keeps exact-replan state explicit and allocation-free"
)]
pub(crate) unsafe fn exact_core(
    sid: i32,
    pb: i32,
    pp: i32,
    py: i32,
    hf: f64,
    np: f64,
    tol: f64,
    solve_action_at: SolveActionAt,
    policy_action: PolicyAction,
) -> f64 {
    E_HF = hf;
    E_NP = np;
    E_TOL = tol;
    ex_reset();
    exact_value(sid, pb, pp, py, solve_action_at, policy_action)
}

pub(crate) unsafe fn exact_node_count() -> i32 {
    EX_COUNT
}
