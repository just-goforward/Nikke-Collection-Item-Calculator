//! Research-only prioritized sparse policy iteration.
//!
//! The product build does not enable this module. A completed result means that the current policy
//! has no strict improvement anywhere in the recursively discovered eligible-action successor
//! closure. Priority changes traversal only: states with the largest discovered root-path mass are
//! inspected first, and a bounded number of changes is applied before the policy is reevaluated.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};

use crate::constants::{
    GAIN_B, GAIN_P, GAIN_Y, MAX_USES_B, MAX_USES_P, MAX_USES_Y, STOCK_ID_SIZE, STOCK_P_DIM,
    STOCK_Y_DIM, STRICT_EPSILON,
};
use crate::cost::availability_cost_pre;
use crate::state::{clamp_stock_uses, memo_key, stock_of};
use crate::status::{reset_status, status_ok};
use crate::transition::{
    compute_transition, is_convert, is_terminal, CONVERT_SID, TX_FAIL, TX_PROB, TX_SUCC,
};
use crate::{memo_reset, phase2_max_success_for_action, policy_action, solve_start, uses_of};

const OUTCOME_COMPLETED: i32 = 0;
const OUTCOME_PHASE2_FAILURE: i32 = 1;
const OUTCOME_ITERATION_BUDGET_EXCEEDED: i32 = 2;
const OUTCOME_STATE_BUDGET_EXCEEDED: i32 = 3;
const OUTCOME_INVALID_INPUT: i32 = 4;

#[derive(Clone, Copy, Debug, Default)]
struct UsesState {
    sid: i32,
    blue: i32,
    purple: i32,
    yellow: i32,
}

#[derive(Clone, Copy, Debug, Default)]
struct PolicyValue {
    cost: f64,
    success: f64,
    total_uses: f64,
    blue: f64,
    purple: f64,
    yellow: f64,
}

#[derive(Clone, Copy, Debug)]
struct EvaluationEntry {
    state: UsesState,
    value: PolicyValue,
    // Traversal heuristic only. It is the largest discovered path mass, not total occupancy.
    path_priority: f64,
}

struct PolicyEvaluation<'a> {
    entries: Vec<EvaluationEntry>,
    index: HashMap<u32, usize>,
    overrides: &'a HashMap<u32, i8>,
    start: UsesState,
    denominator_blue: f64,
    denominator_purple: f64,
    denominator_yellow: f64,
    norm_power: f64,
    inverse_norm_power: f64,
    max_states: usize,
}

#[derive(Clone, Copy, Debug)]
struct PendingState {
    entry_index: usize,
    path_priority: f64,
}

impl PartialEq for PendingState {
    fn eq(&self, other: &Self) -> bool {
        self.entry_index == other.entry_index
            && self.path_priority.to_bits() == other.path_priority.to_bits()
    }
}

impl Eq for PendingState {}

impl PartialOrd for PendingState {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for PendingState {
    fn cmp(&self, other: &Self) -> Ordering {
        self.path_priority
            .total_cmp(&other.path_priority)
            .then_with(|| other.entry_index.cmp(&self.entry_index))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EvaluationError {
    Phase2Failure,
    StateBudgetExceeded,
}

static mut LAST_OUTCOME: i32 = OUTCOME_INVALID_INPUT;
static mut LAST_ACTION: i32 = -1;
static mut LAST_SUCCESS: f64 = 0.0;
static mut LAST_COST: f64 = f64::INFINITY;
static mut LAST_BLUE: f64 = 0.0;
static mut LAST_PURPLE: f64 = 0.0;
static mut LAST_YELLOW: f64 = 0.0;
static mut LAST_PROBABILITY_GAP: f64 = 0.0;
static mut LAST_PASSES: i32 = 0;
static mut LAST_PEAK_STATES: i32 = 0;
static mut LAST_SCANNED_STATES: i32 = 0;
static mut LAST_CHANGES: i32 = 0;
static mut LAST_OVERRIDES: Vec<(u32, i8)> = Vec::new();

#[inline]
fn unpack(key: u32) -> UsesState {
    let sid = (key as i32) / STOCK_ID_SIZE;
    let stock = (key as i32) % STOCK_ID_SIZE;
    let blue = stock / (STOCK_P_DIM * STOCK_Y_DIM);
    let remainder = stock % (STOCK_P_DIM * STOCK_Y_DIM);
    let purple = remainder / STOCK_Y_DIM;
    let yellow = remainder % STOCK_Y_DIM;
    UsesState {
        sid,
        blue,
        purple,
        yellow,
    }
}

#[inline]
fn decrement(state: UsesState, action: i32) -> UsesState {
    UsesState {
        blue: state.blue - i32::from(action == 0),
        purple: state.purple - i32::from(action == 1),
        yellow: state.yellow - i32::from(action == 2),
        ..state
    }
}

#[inline]
fn combine(probability: f64, success: PolicyValue, failure: PolicyValue) -> PolicyValue {
    let inverse = 1.0 - probability;
    PolicyValue {
        cost: probability * success.cost + inverse * failure.cost,
        success: probability * success.success + inverse * failure.success,
        total_uses: probability * success.total_uses + inverse * failure.total_uses,
        blue: probability * success.blue + inverse * failure.blue,
        purple: probability * success.purple + inverse * failure.purple,
        yellow: probability * success.yellow + inverse * failure.yellow,
    }
}

#[inline]
fn is_better(candidate: PolicyValue, incumbent: PolicyValue) -> bool {
    let cost_delta = candidate.cost - incumbent.cost;
    if cost_delta.abs() > STRICT_EPSILON {
        return cost_delta < 0.0;
    }
    let total_delta = candidate.total_uses - incumbent.total_uses;
    if total_delta.abs() > STRICT_EPSILON {
        return total_delta < 0.0;
    }
    candidate.success > incumbent.success
}

impl PolicyEvaluation<'_> {
    fn leaf(&self, state: UsesState, success: f64) -> PolicyValue {
        let blue = ((self.start.blue - state.blue) * 10) as f64;
        let purple = ((self.start.purple - state.purple) * 10) as f64;
        let yellow = ((self.start.yellow - state.yellow) * 10) as f64;
        PolicyValue {
            cost: availability_cost_pre(
                blue,
                purple,
                yellow,
                self.denominator_blue,
                self.denominator_purple,
                self.denominator_yellow,
                self.norm_power,
                self.inverse_norm_power,
            ),
            success,
            total_uses: (blue + purple + yellow) / 10.0,
            blue,
            purple,
            yellow,
        }
    }

    fn action_at(&self, state: UsesState) -> i32 {
        let key = memo_key(state.sid, state.blue, state.purple, state.yellow);
        self.overrides.get(&key).map_or_else(
            || unsafe { policy_action(state.sid, state.blue, state.purple, state.yellow) },
            |v| *v as i32,
        )
    }

    fn insert(
        &mut self,
        state: UsesState,
        value: PolicyValue,
        path_priority: f64,
    ) -> Result<PolicyValue, EvaluationError> {
        if self.entries.len() >= self.max_states {
            return Err(EvaluationError::StateBudgetExceeded);
        }
        let key = memo_key(state.sid, state.blue, state.purple, state.yellow);
        let index = self.entries.len();
        self.entries.push(EvaluationEntry {
            state,
            value,
            path_priority,
        });
        self.index.insert(key, index);
        Ok(value)
    }

    fn value(
        &mut self,
        state: UsesState,
        path_priority: f64,
    ) -> Result<PolicyValue, EvaluationError> {
        let key = memo_key(state.sid, state.blue, state.purple, state.yellow);
        if let Some(&index) = self.index.get(&key) {
            if path_priority > self.entries[index].path_priority {
                self.entries[index].path_priority = path_priority;
            }
            return Ok(self.entries[index].value);
        }
        if is_terminal(state.sid) {
            return self.insert(state, self.leaf(state, 1.0), path_priority);
        }
        if is_convert(state.sid) {
            let converted = self.value(
                UsesState {
                    sid: CONVERT_SID,
                    ..state
                },
                path_priority,
            )?;
            return self.insert(state, converted, path_priority);
        }
        let action = self.action_at(state);
        if !(0..=2).contains(&action)
            || stock_of(action, state.blue, state.purple, state.yellow) <= 0
        {
            return self.insert(state, self.leaf(state, 0.0), path_priority);
        }
        compute_transition(state.sid, action);
        let (probability, success_sid, failure_sid) = unsafe { (TX_PROB, TX_SUCC, TX_FAIL) };
        let next = decrement(state, action);
        let success = self.value(
            UsesState {
                sid: success_sid,
                ..next
            },
            path_priority * probability,
        )?;
        let failure = self.value(
            UsesState {
                sid: failure_sid,
                ..next
            },
            path_priority * (1.0 - probability),
        )?;
        self.insert(state, combine(probability, success, failure), path_priority)
    }
}

#[allow(
    clippy::too_many_arguments,
    reason = "keeps the research evaluation contract explicit without a second config type"
)]
fn evaluate_policy<'a>(
    overrides: &'a HashMap<u32, i8>,
    start: UsesState,
    raw_blue: i32,
    raw_purple: i32,
    raw_yellow: i32,
    horizon_factor: f64,
    norm_power: f64,
    max_states: usize,
) -> Result<(PolicyEvaluation<'a>, PolicyValue), EvaluationError> {
    let mut evaluation = PolicyEvaluation {
        entries: Vec::new(),
        index: HashMap::new(),
        overrides,
        start,
        denominator_blue: raw_blue as f64 + horizon_factor * GAIN_B,
        denominator_purple: raw_purple as f64 + horizon_factor * GAIN_P,
        denominator_yellow: raw_yellow as f64 + horizon_factor * GAIN_Y,
        norm_power,
        inverse_norm_power: 1.0 / norm_power,
        max_states,
    };
    let root = evaluation.value(start, 1.0)?;
    Ok((evaluation, root))
}

fn best_action(
    evaluation: &mut PolicyEvaluation<'_>,
    entry_index: usize,
    tolerance: f64,
    pending: &mut BinaryHeap<PendingState>,
) -> Result<Option<i32>, EvaluationError> {
    let entry = evaluation.entries[entry_index];
    let state = entry.state;
    if is_terminal(state.sid) || is_convert(state.sid) {
        return Ok(None);
    }
    let current_action = evaluation.action_at(state);
    let mut action_success = [-1.0; 3];
    let mut maximum: f64 = -1.0;
    for action in 0..3i32 {
        let value = unsafe {
            phase2_max_success_for_action(state.sid, state.blue, state.purple, state.yellow, action)
        };
        if !unsafe { status_ok() } {
            return Err(EvaluationError::Phase2Failure);
        }
        if let Some(value) = value {
            action_success[action as usize] = value;
            maximum = maximum.max(value);
        }
    }

    let mut selected_action = current_action;
    let mut selected_value = entry.value;
    for action in 0..3i32 {
        let success_probability = action_success[action as usize];
        if success_probability < 0.0
            || maximum - success_probability > tolerance + STRICT_EPSILON
            || stock_of(action, state.blue, state.purple, state.yellow) <= 0
        {
            continue;
        }
        compute_transition(state.sid, action);
        let (probability, success_sid, failure_sid) = unsafe { (TX_PROB, TX_SUCC, TX_FAIL) };
        let next = decrement(state, action);
        let previous_len = evaluation.entries.len();
        let success = evaluation.value(
            UsesState {
                sid: success_sid,
                ..next
            },
            entry.path_priority * probability,
        )?;
        let failure = evaluation.value(
            UsesState {
                sid: failure_sid,
                ..next
            },
            entry.path_priority * (1.0 - probability),
        )?;
        for index in previous_len..evaluation.entries.len() {
            pending.push(PendingState {
                entry_index: index,
                path_priority: evaluation.entries[index].path_priority,
            });
        }
        let candidate = combine(probability, success, failure);
        if is_better(candidate, selected_value) {
            selected_action = action;
            selected_value = candidate;
        }
    }
    Ok((selected_action != current_action).then_some(selected_action))
}

fn reset_result() {
    unsafe {
        LAST_OUTCOME = OUTCOME_INVALID_INPUT;
        LAST_ACTION = -1;
        LAST_SUCCESS = 0.0;
        LAST_COST = f64::INFINITY;
        LAST_BLUE = 0.0;
        LAST_PURPLE = 0.0;
        LAST_YELLOW = 0.0;
        LAST_PROBABILITY_GAP = 0.0;
        LAST_PASSES = 0;
        LAST_PEAK_STATES = 0;
        LAST_SCANNED_STATES = 0;
        LAST_CHANGES = 0;
        LAST_OVERRIDES = Vec::new();
    }
}

fn publish_policy(overrides: &HashMap<u32, i8>) {
    let mut sorted = overrides
        .iter()
        .map(|(key, action)| (*key, *action))
        .collect::<Vec<_>>();
    sorted.sort_unstable_by_key(|entry| entry.0);
    unsafe {
        LAST_OVERRIDES = sorted;
    }
}

fn publish_root(overrides: &HashMap<u32, i8>, start: UsesState, root: PolicyValue) {
    let key = memo_key(start.sid, start.blue, start.purple, start.yellow);
    let action = overrides.get(&key).map_or_else(
        || unsafe { policy_action(start.sid, start.blue, start.purple, start.yellow) },
        |value| *value as i32,
    );
    let mut maximum: f64 = -1.0;
    let mut selected = -1.0;
    for candidate in 0..3i32 {
        if let Some(value) = unsafe {
            phase2_max_success_for_action(
                start.sid,
                start.blue,
                start.purple,
                start.yellow,
                candidate,
            )
        } {
            maximum = maximum.max(value);
            if candidate == action {
                selected = value;
            }
        }
    }
    unsafe {
        LAST_ACTION = action;
        LAST_SUCCESS = root.success;
        LAST_COST = root.cost;
        LAST_BLUE = root.blue;
        LAST_PURPLE = root.purple;
        LAST_YELLOW = root.yellow;
        LAST_PROBABILITY_GAP = if selected >= 0.0 {
            (maximum - selected).max(0.0)
        } else {
            f64::INFINITY
        };
    }
}

#[allow(
    clippy::too_many_arguments,
    reason = "research ABI keeps the candidate configuration explicit"
)]
#[no_mangle]
pub extern "C" fn solvePrioritizedSparsePi(
    sid: i32,
    raw_blue: i32,
    raw_purple: i32,
    raw_yellow: i32,
    horizon_factor: f64,
    norm_power: f64,
    tolerance: f64,
    max_passes: i32,
    max_states: i32,
    max_updates_per_pass: i32,
) {
    reset_result();
    if max_passes <= 0
        || max_states <= 0
        || max_updates_per_pass <= 0
        || !horizon_factor.is_finite()
        || horizon_factor < 0.0
        || !(norm_power.is_finite() || norm_power == f64::INFINITY)
        || norm_power <= 0.0
        || !tolerance.is_finite()
        || tolerance < 0.0
    {
        return;
    }
    unsafe {
        reset_status();
        memo_reset();
        let root_slot = solve_start(
            sid,
            uses_of(raw_blue, MAX_USES_B),
            uses_of(raw_purple, MAX_USES_P),
            uses_of(raw_yellow, MAX_USES_Y),
            raw_blue as f64,
            raw_purple as f64,
            raw_yellow as f64,
            horizon_factor,
            norm_power,
            tolerance,
        );
        if root_slot < 0 || !status_ok() {
            LAST_OUTCOME = OUTCOME_PHASE2_FAILURE;
            return;
        }
    }

    let (blue, purple, yellow) = clamp_stock_uses(
        uses_of(raw_blue, MAX_USES_B),
        uses_of(raw_purple, MAX_USES_P),
        uses_of(raw_yellow, MAX_USES_Y),
    );
    let start = UsesState {
        sid,
        blue,
        purple,
        yellow,
    };
    let max_states = max_states as usize;
    let update_limit = max_updates_per_pass as usize;
    let mut overrides = HashMap::<u32, i8>::new();
    let mut final_root = None;
    let mut outcome = OUTCOME_ITERATION_BUDGET_EXCEEDED;

    for pass in 0..max_passes {
        let (mut evaluation, root) = match evaluate_policy(
            &overrides,
            start,
            raw_blue,
            raw_purple,
            raw_yellow,
            horizon_factor,
            norm_power,
            max_states,
        ) {
            Ok(result) => result,
            Err(EvaluationError::Phase2Failure) => {
                outcome = OUTCOME_PHASE2_FAILURE;
                break;
            }
            Err(EvaluationError::StateBudgetExceeded) => {
                outcome = OUTCOME_STATE_BUDGET_EXCEEDED;
                break;
            }
        };
        final_root = Some(root);
        unsafe {
            LAST_PASSES = pass + 1;
            LAST_PEAK_STATES = LAST_PEAK_STATES.max(evaluation.entries.len() as i32);
        }
        let mut pending = BinaryHeap::new();
        for (entry_index, entry) in evaluation.entries.iter().enumerate() {
            pending.push(PendingState {
                entry_index,
                path_priority: entry.path_priority,
            });
        }
        let mut scanned = vec![false; evaluation.entries.len()];
        let mut changes = Vec::<(u32, i8)>::new();
        let mut failed = None;
        while let Some(next) = pending.pop() {
            if next.entry_index >= scanned.len() {
                scanned.resize(evaluation.entries.len(), false);
            }
            if scanned[next.entry_index] {
                continue;
            }
            scanned[next.entry_index] = true;
            unsafe {
                LAST_SCANNED_STATES = LAST_SCANNED_STATES.saturating_add(1);
            }
            match best_action(&mut evaluation, next.entry_index, tolerance, &mut pending) {
                Ok(Some(action)) => {
                    let state = evaluation.entries[next.entry_index].state;
                    changes.push((
                        memo_key(state.sid, state.blue, state.purple, state.yellow),
                        action as i8,
                    ));
                    if changes.len() >= update_limit {
                        break;
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    failed = Some(error);
                    break;
                }
            }
            if scanned.len() < evaluation.entries.len() {
                scanned.resize(evaluation.entries.len(), false);
            }
            unsafe {
                LAST_PEAK_STATES = LAST_PEAK_STATES.max(evaluation.entries.len() as i32);
            }
        }
        if let Some(error) = failed {
            outcome = match error {
                EvaluationError::Phase2Failure => OUTCOME_PHASE2_FAILURE,
                EvaluationError::StateBudgetExceeded => OUTCOME_STATE_BUDGET_EXCEEDED,
            };
            break;
        }
        if changes.is_empty() {
            outcome = OUTCOME_COMPLETED;
            final_root = Some(root);
            break;
        }
        unsafe {
            LAST_CHANGES = LAST_CHANGES.saturating_add(changes.len() as i32);
        }
        for (key, action) in changes {
            let state = unpack(key);
            let baseline =
                unsafe { policy_action(state.sid, state.blue, state.purple, state.yellow) };
            if action as i32 == baseline {
                overrides.remove(&key);
            } else {
                overrides.insert(key, action);
            }
        }
    }

    if outcome == OUTCOME_ITERATION_BUDGET_EXCEEDED {
        if let Ok((evaluation, root)) = evaluate_policy(
            &overrides,
            start,
            raw_blue,
            raw_purple,
            raw_yellow,
            horizon_factor,
            norm_power,
            max_states,
        ) {
            unsafe {
                LAST_PEAK_STATES = LAST_PEAK_STATES.max(evaluation.entries.len() as i32);
            }
            final_root = Some(root);
        }
    }
    publish_policy(&overrides);
    if let Some(root) = final_root {
        publish_root(&overrides, start, root);
    }
    unsafe {
        LAST_OUTCOME = outcome;
    }
}

#[no_mangle]
pub extern "C" fn prioritizedSparsePiOutcome() -> i32 {
    unsafe { LAST_OUTCOME }
}

#[no_mangle]
pub extern "C" fn prioritizedSparsePiAction() -> i32 {
    unsafe { LAST_ACTION }
}

#[no_mangle]
pub extern "C" fn prioritizedSparsePiSuccess() -> f64 {
    unsafe { LAST_SUCCESS }
}

#[no_mangle]
pub extern "C" fn prioritizedSparsePiCost() -> f64 {
    unsafe { LAST_COST }
}

#[no_mangle]
pub extern "C" fn prioritizedSparsePiVecB() -> f64 {
    unsafe { LAST_BLUE }
}

#[no_mangle]
pub extern "C" fn prioritizedSparsePiVecP() -> f64 {
    unsafe { LAST_PURPLE }
}

#[no_mangle]
pub extern "C" fn prioritizedSparsePiVecY() -> f64 {
    unsafe { LAST_YELLOW }
}

#[no_mangle]
pub extern "C" fn prioritizedSparsePiProbabilityGap() -> f64 {
    unsafe { LAST_PROBABILITY_GAP }
}

#[no_mangle]
pub extern "C" fn prioritizedSparsePiPasses() -> i32 {
    unsafe { LAST_PASSES }
}

#[no_mangle]
pub extern "C" fn prioritizedSparsePiPeakStates() -> i32 {
    unsafe { LAST_PEAK_STATES }
}

#[no_mangle]
pub extern "C" fn prioritizedSparsePiScannedStates() -> i32 {
    unsafe { LAST_SCANNED_STATES }
}

#[no_mangle]
pub extern "C" fn prioritizedSparsePiChanges() -> i32 {
    unsafe { LAST_CHANGES }
}

#[no_mangle]
pub extern "C" fn prioritizedSparsePiOverrideCount() -> i32 {
    unsafe { LAST_OVERRIDES.len() as i32 }
}

#[no_mangle]
pub extern "C" fn prioritizedSparsePiActionAt(
    sid: i32,
    blue: i32,
    purple: i32,
    yellow: i32,
) -> i32 {
    let (blue, purple, yellow) = clamp_stock_uses(blue, purple, yellow);
    let key = memo_key(sid, blue, purple, yellow);
    unsafe {
        match LAST_OVERRIDES.binary_search_by_key(&key, |entry| entry.0) {
            Ok(index) => LAST_OVERRIDES[index].1 as i32,
            Err(_) => policy_action(sid, blue, purple, yellow),
        }
    }
}

#[no_mangle]
pub extern "C" fn releasePrioritizedSparsePi() {
    reset_result();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packed_state_round_trips_at_domain_edges() {
        for state in [
            UsesState {
                sid: 0,
                blue: 0,
                purple: 0,
                yellow: 0,
            },
            UsesState {
                sid: 959,
                blue: MAX_USES_B,
                purple: MAX_USES_P,
                yellow: MAX_USES_Y,
            },
        ] {
            assert_eq!(
                unpack(memo_key(state.sid, state.blue, state.purple, state.yellow)).sid,
                state.sid
            );
            let unpacked = unpack(memo_key(state.sid, state.blue, state.purple, state.yellow));
            assert_eq!(
                (unpacked.blue, unpacked.purple, unpacked.yellow),
                (state.blue, state.purple, state.yellow)
            );
        }
    }

    #[test]
    fn strict_improvement_preserves_ties() {
        let incumbent = PolicyValue {
            cost: 1.0,
            success: 0.8,
            total_uses: 10.0,
            ..PolicyValue::default()
        };
        assert!(!is_better(incumbent, incumbent));
        assert!(is_better(
            PolicyValue {
                cost: 0.9,
                ..incumbent
            },
            incumbent
        ));
        assert!(is_better(
            PolicyValue {
                total_uses: 9.0,
                ..incumbent
            },
            incumbent
        ));
        assert!(is_better(
            PolicyValue {
                success: 0.9,
                ..incumbent
            },
            incumbent
        ));
    }
}
