//! Rust port of the finite-inventory MDP solver kernel.
//!
//! This began as a translation of `../assembly/*` (AssemblyScript), which is itself an
//! equivalence-verified port of the TypeScript solver. Internal layouts and lookup paths are now
//! optimized, while observable policy and numeric results remain bit-identical. Floating-point
//! operand order, candidate traversal, tie-breaks, and documented probe-order contracts are
//! preserved and guarded by the parity tests.
//!
//! Concurrency: wasm is single-threaded, so module state is `static mut` (mirrors the AS module
//! globals) accessed in `unsafe`. A non-wasm/multi-thread version would wrap this in a struct.
//!
//! Build and verification commands are documented in the Cargo.toml header and package scripts.
#![allow(non_snake_case, static_mut_refs)]

mod constants;
mod cost;
mod cvar;
mod distribution;
mod exact_replan;
mod minef;
#[cfg(feature = "research-sparse-pi")]
mod prioritized_sparse_pi;
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
const OVERFLOW_CAP_LOG2: [u32; 2] = [20, 18];
const MEMO_SLOT_BYTES: usize = 49;
const SLOT_SEGMENT_SHIFT: usize = 24;
const SLOT_LOCAL_MASK: usize = (1 << SLOT_SEGMENT_SHIFT) - 1;
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
static mut PRIMARY_COUNT: usize = 0;
static mut PHASE2_OVERFLOW_ENABLED: bool = false;
static mut ACTIVE_OVERFLOW_SEGMENTS: usize = 0;
static mut OVERFLOW_SEGMENTS: Vec<MemoOverflowSegment> = Vec::new();

struct MemoStorage {
    keys: Vec<u32>,
    gens: Vec<u32>,
    sp_ok: Vec<f64>,
    sp_max: Vec<f64>,
    vb: Vec<f64>,
    vp: Vec<f64>,
    vy: Vec<f64>,
    act: Vec<i8>,
}

impl MemoStorage {
    fn try_new(cap: usize) -> Result<Self, ()> {
        Ok(Self {
            keys: try_filled_vec(cap, 0u32)?,
            gens: try_filled_vec(cap, 0u32)?,
            sp_ok: try_filled_vec(cap, 0.0)?,
            sp_max: try_filled_vec(cap, 0.0)?,
            vb: try_filled_vec(cap, 0.0)?,
            vp: try_filled_vec(cap, 0.0)?,
            vy: try_filled_vec(cap, 0.0)?,
            act: try_filled_vec(cap, 0i8)?,
        })
    }
}

struct MemoOverflowSegment {
    cap: usize,
    count: usize,
    guard: usize,
    mask: u32,
    storage: MemoStorage,
}

impl MemoOverflowSegment {
    fn try_new(cap_log2: u32) -> Result<Self, ()> {
        let cap = 1usize << cap_log2;
        Ok(Self {
            cap,
            count: 0,
            guard: cap - (cap >> 3),
            mask: (cap - 1) as u32,
            storage: MemoStorage::try_new(cap)?,
        })
    }

    fn probe(&self, stored: u32, epoch: u32) -> usize {
        let mask = self.mask as usize;
        let mut index = hash_slot(stored, self.mask) as usize;
        while self.storage.gens[index] == epoch && self.storage.keys[index] != stored {
            index = (index + 1) & mask;
        }
        index
    }
}

fn try_filled_vec<T: Clone>(len: usize, value: T) -> Result<Vec<T>, ()> {
    let mut values = Vec::new();
    values.try_reserve_exact(len).map_err(|_| ())?;
    values.resize(len, value);
    Ok(values)
}

unsafe fn release_phase2_memo_arrays() {
    KEYS = Vec::new();
    GENS = Vec::new();
    SP_OK = Vec::new();
    SP_MAX = Vec::new();
    VB = Vec::new();
    VP = Vec::new();
    VY = Vec::new();
    ACT = Vec::new();
    OVERFLOW_SEGMENTS = Vec::new();
    ACTIVE_OVERFLOW_SEGMENTS = 0;
    EPOCH = 1;
    COUNT = 0;
    PRIMARY_COUNT = 0;
}

unsafe fn memo_ensure() -> bool {
    if KEYS.is_empty() {
        let storage = match MemoStorage::try_new(MEMO_CAP) {
            Ok(storage) => storage,
            Err(()) => {
                LAST_STATUS = STATUS_MEMORY_LIMIT;
                return false;
            }
        };
        KEYS = storage.keys;
        GENS = storage.gens;
        SP_OK = storage.sp_ok;
        SP_MAX = storage.sp_max;
        VB = storage.vb;
        VP = storage.vp;
        VY = storage.vy;
        ACT = storage.act;
    }
    true
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
        release_phase2_memo_arrays(); // drop old arrays; memo_ensure reallocates at new_cap
    }
}
#[no_mangle]
pub extern "C" fn configurePhase2Overflow(enabled: i32) {
    unsafe {
        let next = enabled != 0;
        if next == PHASE2_OVERFLOW_ENABLED {
            return;
        }
        PHASE2_OVERFLOW_ENABLED = next;
        release_phase2_memo_arrays();
    }
}
#[no_mangle]
pub extern "C" fn releasePhase2Memo() {
    unsafe {
        release_phase2_memo_arrays();
    }
}
pub(crate) unsafe fn memo_reset() {
    if !memo_ensure() {
        return;
    }
    EPOCH = EPOCH.wrapping_add(1); // O(1) reset (epoch stamp), like the AS memo
    if EPOCH == 0 {
        for g in GENS.iter_mut() {
            *g = 0;
        }
        for segment in OVERFLOW_SEGMENTS.iter_mut() {
            for generation in segment.storage.gens.iter_mut() {
                *generation = 0;
            }
        }
        EPOCH = 1;
    }
    COUNT = 0;
    PRIMARY_COUNT = 0;
    ACTIVE_OVERFLOW_SEGMENTS = 0;
    for segment in OVERFLOW_SEGMENTS.iter_mut() {
        segment.count = 0;
    }
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
unsafe fn probe_primary(stored: u32) -> usize {
    let mask = MEMO_MASK as usize;
    let mut i = hash_slot(stored, MEMO_MASK) as usize;
    while GENS[i] == EPOCH && KEYS[i] != stored {
        i = (i + 1) & mask;
    }
    i
}
unsafe fn memo_find(key: u32) -> i32 {
    let stored = key + 1;
    let i = probe_primary(stored);
    if GENS[i] == EPOCH {
        return i as i32;
    }
    for (segment_index, segment) in OVERFLOW_SEGMENTS
        .iter()
        .take(ACTIVE_OVERFLOW_SEGMENTS)
        .enumerate()
    {
        let local_index = segment.probe(stored, EPOCH);
        if segment.storage.gens[local_index] == EPOCH {
            return encode_overflow_slot(segment_index, local_index);
        }
    }
    -1
}
unsafe fn memo_insert(key: u32, sp: f64, spm: f64, vb: f64, vp: f64, vy: f64, act: i8) -> i32 {
    let stored = key + 1;
    let primary_index = probe_primary(stored);
    if GENS[primary_index] == EPOCH {
        let slot = primary_index as i32;
        write_memo_slot(slot, sp, spm, vb, vp, vy, act);
        return slot;
    }
    for (segment_index, segment) in OVERFLOW_SEGMENTS
        .iter()
        .take(ACTIVE_OVERFLOW_SEGMENTS)
        .enumerate()
    {
        let local_index = segment.probe(stored, EPOCH);
        if segment.storage.gens[local_index] == EPOCH {
            let slot = encode_overflow_slot(segment_index, local_index);
            write_memo_slot(slot, sp, spm, vb, vp, vy, act);
            return slot;
        }
    }

    if PRIMARY_COUNT < MEMO_FULL_GUARD {
        KEYS[primary_index] = stored;
        GENS[primary_index] = EPOCH;
        PRIMARY_COUNT += 1;
        COUNT += 1;
        let slot = primary_index as i32;
        write_memo_slot(slot, sp, spm, vb, vp, vy, act);
        return slot;
    }

    if !PHASE2_OVERFLOW_ENABLED {
        LAST_STATUS = STATUS_MEMO_FULL;
        return -1;
    }
    let segment_index = match writable_overflow_segment() {
        Some(index) => index,
        None => return -1,
    };
    let segment = &mut OVERFLOW_SEGMENTS[segment_index];
    let local_index = segment.probe(stored, EPOCH);
    segment.storage.keys[local_index] = stored;
    segment.storage.gens[local_index] = EPOCH;
    segment.count += 1;
    COUNT += 1;
    let slot = encode_overflow_slot(segment_index, local_index);
    write_memo_slot(slot, sp, spm, vb, vp, vy, act);
    slot
}

unsafe fn writable_overflow_segment() -> Option<usize> {
    if ACTIVE_OVERFLOW_SEGMENTS > 0 {
        let active_index = ACTIVE_OVERFLOW_SEGMENTS - 1;
        if OVERFLOW_SEGMENTS[active_index].count < OVERFLOW_SEGMENTS[active_index].guard {
            return Some(active_index);
        }
    }
    let next_index = ACTIVE_OVERFLOW_SEGMENTS;
    let Some(&cap_log2) = OVERFLOW_CAP_LOG2.get(next_index) else {
        LAST_STATUS = STATUS_MEMO_FULL;
        return None;
    };
    if next_index == OVERFLOW_SEGMENTS.len() {
        let segment = match MemoOverflowSegment::try_new(cap_log2) {
            Ok(segment) => segment,
            Err(()) => {
                LAST_STATUS = STATUS_MEMORY_LIMIT;
                return None;
            }
        };
        OVERFLOW_SEGMENTS.push(segment);
    }
    ACTIVE_OVERFLOW_SEGMENTS += 1;
    Some(next_index)
}

#[inline]
fn encode_overflow_slot(segment_index: usize, local_index: usize) -> i32 {
    (((segment_index + 1) << SLOT_SEGMENT_SHIFT) | local_index) as i32
}

#[inline]
fn decode_memo_slot(slot: i32) -> (usize, usize) {
    let raw = slot as usize;
    (raw >> SLOT_SEGMENT_SHIFT, raw & SLOT_LOCAL_MASK)
}

unsafe fn write_memo_slot(slot: i32, sp: f64, spm: f64, vb: f64, vp: f64, vy: f64, act: i8) {
    let (segment_tag, local_index) = decode_memo_slot(slot);
    if segment_tag == 0 {
        SP_OK[local_index] = sp;
        SP_MAX[local_index] = spm;
        VB[local_index] = vb;
        VP[local_index] = vp;
        VY[local_index] = vy;
        ACT[local_index] = act;
        return;
    }
    let storage = &mut OVERFLOW_SEGMENTS[segment_tag - 1].storage;
    storage.sp_ok[local_index] = sp;
    storage.sp_max[local_index] = spm;
    storage.vb[local_index] = vb;
    storage.vp[local_index] = vp;
    storage.vy[local_index] = vy;
    storage.act[local_index] = act;
}
#[inline]
unsafe fn sp_ok_at(slot: i32) -> f64 {
    if slot == TERMINAL {
        1.0
    } else if slot == DEPLETED {
        0.0
    } else {
        let (segment_tag, local_index) = decode_memo_slot(slot);
        if segment_tag == 0 {
            SP_OK[local_index]
        } else {
            OVERFLOW_SEGMENTS[segment_tag - 1].storage.sp_ok[local_index]
        }
    }
}
#[inline]
unsafe fn sp_max_at(slot: i32) -> f64 {
    if slot == TERMINAL {
        1.0
    } else if slot == DEPLETED {
        0.0
    } else {
        let (segment_tag, local_index) = decode_memo_slot(slot);
        if segment_tag == 0 {
            SP_MAX[local_index]
        } else {
            OVERFLOW_SEGMENTS[segment_tag - 1].storage.sp_max[local_index]
        }
    }
}
#[inline]
unsafe fn vb_at(slot: i32) -> f64 {
    if slot == TERMINAL || slot == DEPLETED {
        0.0
    } else {
        let (segment_tag, local_index) = decode_memo_slot(slot);
        if segment_tag == 0 {
            VB[local_index]
        } else {
            OVERFLOW_SEGMENTS[segment_tag - 1].storage.vb[local_index]
        }
    }
}
#[inline]
unsafe fn vp_at(slot: i32) -> f64 {
    if slot == TERMINAL || slot == DEPLETED {
        0.0
    } else {
        let (segment_tag, local_index) = decode_memo_slot(slot);
        if segment_tag == 0 {
            VP[local_index]
        } else {
            OVERFLOW_SEGMENTS[segment_tag - 1].storage.vp[local_index]
        }
    }
}
#[inline]
unsafe fn vy_at(slot: i32) -> f64 {
    if slot == TERMINAL || slot == DEPLETED {
        0.0
    } else {
        let (segment_tag, local_index) = decode_memo_slot(slot);
        if segment_tag == 0 {
            VY[local_index]
        } else {
            OVERFLOW_SEGMENTS[segment_tag - 1].storage.vy[local_index]
        }
    }
}
#[inline]
unsafe fn act_at(slot: i32) -> i32 {
    if slot == TERMINAL || slot == DEPLETED {
        -1
    } else {
        let (segment_tag, local_index) = decode_memo_slot(slot);
        if segment_tag == 0 {
            ACT[local_index] as i32
        } else {
            OVERFLOW_SEGMENTS[segment_tag - 1].storage.act[local_index] as i32
        }
    }
}

// ===== mdp.ts ================================================================================
static mut G_HF: f64 = 0.5;
static mut G_NP: f64 = 3.0;
static mut G_TOL: f64 = 0.01;
static mut G_INIT_B: f64 = 0.0;
static mut G_INIT_P: f64 = 0.0;
static mut G_INIT_Y: f64 = 0.0;
pub(crate) static mut G_GAIN_B: f64 = 0.0;
pub(crate) static mut G_GAIN_P: f64 = 0.0;
pub(crate) static mut G_GAIN_Y: f64 = 0.0;
static mut G_DEN_B: f64 = 0.0;
static mut G_DEN_P: f64 = 0.0;
static mut G_DEN_Y: f64 = 0.0;
static mut G_INV_NP: f64 = 0.0;

const INF: i32 = i32::MAX;
static mut WC: Vec<i32> = Vec::new(); // worstCaseUses cache [sid*3+kit], param-independent
unsafe fn wc_ensure() {
    if WC.is_empty() {
        WC = vec![-1i32; STATE_BUCKETS as usize * 3];
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
    if !status_ok() {
        return -1;
    }
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
    }

    let mut any_elig = false;
    for k in 0..3usize {
        let s = base + k;
        if SC_VALID[s] != 0 && max_msp - SC_SP[s] <= G_TOL + STRICT_EPSILON {
            any_elig = true;
            break;
        }
    }

    for k in 0..3usize {
        let s = base + k;
        if SC_VALID[s] == 0 {
            continue;
        }
        let eligible = max_msp - SC_SP[s] <= G_TOL + STRICT_EPSILON;
        if !is_root_frame && any_elig && !eligible {
            continue;
        }
        SC_COST[s] = availability_cost_pre(
            SC_VB[s], SC_VP[s], SC_VY[s], G_DEN_B, G_DEN_P, G_DEN_Y, G_NP, G_INV_NP,
        );
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

pub(crate) unsafe fn phase2_max_success_for_action(
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
        return phase2_max_success_for_action(CONVERT_SID, b, p, y, action);
    }
    cap_stock(sid, b, p, y);
    b = CAP_B;
    p = CAP_P;
    y = CAP_Y;
    if stock_of(action, b, p, y) <= 0 {
        return None;
    }
    compute_transition(sid, action);
    let prob = TX_PROB;
    let succ = TX_SUCC;
    let fail = TX_FAIL;
    let nb = b - if action == 0 { 1 } else { 0 };
    let np = p - if action == 1 { 1 } else { 0 };
    let ny = y - if action == 2 { 1 } else { 0 };
    let success_slot = value(succ, nb, np, ny);
    if !status_ok() {
        return None;
    }
    let failure_slot = value(fail, nb, np, ny);
    if !status_ok() {
        return None;
    }
    Some(prob * sp_max_at(success_slot) + (1.0 - prob) * sp_max_at(failure_slot))
}

// ===== index.ts (wasm exports) ===============================================================
#[inline]
pub(crate) fn uses_of(pieces: i32, max_uses: i32) -> i32 {
    (pieces / 10).clamp(0, max_uses)
}

// solveStart (mdp.ts:221): set params + run value() from (start, stockUses); returns start slot.
// The CALLER resets the memo (epoch) first — matches AS, where solveStart itself does not reset.
#[allow(
    clippy::too_many_arguments,
    reason = "matches the stable solver entry contract"
)]
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
    G_DEN_B = init_b + hf * G_GAIN_B;
    G_DEN_P = init_p + hf * G_GAIN_P;
    G_DEN_Y = init_y + hf * G_GAIN_Y;
    G_INV_NP = 1.0 / np;
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
#[allow(
    clippy::too_many_arguments,
    reason = "the WASM ABI carries raw inventory, forecast gains, and solver parameters"
)]
pub extern "C" fn solveCore(
    sid: i32,
    b: i32,
    p: i32,
    y: i32,
    gain_b: f64,
    gain_p: f64,
    gain_y: f64,
    hf: f64,
    np: f64,
    tol: f64,
) -> i32 {
    unsafe {
        reset_status();
        if !set_gain_context(gain_b, gain_p, gain_y) {
            return -1;
        }
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

pub(crate) unsafe fn set_gain_context(gain_b: f64, gain_p: f64, gain_y: f64) -> bool {
    if !gain_b.is_finite()
        || !gain_p.is_finite()
        || !gain_y.is_finite()
        || gain_b < 0.0
        || gain_p < 0.0
        || gain_y < 0.0
    {
        LAST_STATUS = STATUS_INVALID_INPUT;
        return false;
    }
    G_GAIN_B = gain_b;
    G_GAIN_P = gain_p;
    G_GAIN_Y = gain_y;
    true
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
        let (bounded_b, bounded_p, bounded_y) = clamp_stock_uses(b, p, y);
        policy_action(sid, bounded_b, bounded_p, bounded_y)
    }
}
#[no_mangle]
pub extern "C" fn phase2MaxSuccessForActionAt(
    sid: i32,
    b: i32,
    p: i32,
    y: i32,
    action: i32,
) -> f64 {
    unsafe {
        let (bounded_b, bounded_p, bounded_y) = clamp_stock_uses(b, p, y);
        phase2_max_success_for_action(sid, bounded_b, bounded_p, bounded_y, action).unwrap_or(-1.0)
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
pub extern "C" fn phase2OverflowSegments() -> i32 {
    unsafe { ACTIVE_OVERFLOW_SEGMENTS as i32 }
}
#[no_mangle]
pub extern "C" fn phase2MemoCapacity() -> i32 {
    unsafe {
        let overflow_capacity: usize = OVERFLOW_SEGMENTS
            .iter()
            .take(ACTIVE_OVERFLOW_SEGMENTS)
            .map(|segment| segment.cap)
            .sum();
        (MEMO_CAP + overflow_capacity) as i32
    }
}
#[no_mangle]
pub extern "C" fn phase2MemoLogicalBytes() -> i32 {
    phase2MemoCapacity().saturating_mul(MEMO_SLOT_BYTES as i32)
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
        let (bounded_b, bounded_p, bounded_y) = clamp_stock_uses(b0, p0, y0);
        moment_vector_after_first_action_from_policy(
            start_sid,
            bounded_b,
            bounded_p,
            bounded_y,
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

#[allow(
    clippy::too_many_arguments,
    reason = "the research ABI carries raw inventory, forecast gains, and solver parameters"
)]
#[no_mangle]
pub extern "C" fn cvarSetup(
    sid: i32,
    pb: i32,
    pp: i32,
    py: i32,
    gain_b: f64,
    gain_p: f64,
    gain_y: f64,
    hf: f64,
    np: f64,
    tol: f64,
) {
    unsafe {
        reset_status();
        if !set_gain_context(gain_b, gain_p, gain_y) {
            return;
        }
        let start_b = uses_of(pb, MAX_USES_B);
        let start_p = uses_of(pp, MAX_USES_P);
        let start_y = uses_of(py, MAX_USES_Y);
        cvar_setup(sid, pb, pp, py, hf, np, start_b, start_p, start_y, tol);
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
pub extern "C" fn cvarFollowHingeAfterFirstAction(eta: f64, first_action: i32) -> f64 {
    unsafe { cvar_follow_hinge_after_first_action(eta, first_action, policy_action) }
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
#[no_mangle]
pub extern "C" fn cvarFollowRecordedSuccess() -> f64 {
    unsafe { cvar_follow_recorded_success() }
}
#[no_mangle]
pub extern "C" fn cvarRecordedActionAt(sid: i32, b: i32, p: i32, y: i32) -> i32 {
    unsafe {
        let (bounded_b, bounded_p, bounded_y) = clamp_stock_uses(b, p, y);
        cvar_recorded_action(sid, bounded_b, bounded_p, bounded_y)
    }
}

#[cfg(test)]
mod segmented_memo_tests {
    use super::{
        decode_memo_slot, encode_overflow_slot, hash_slot, MemoOverflowSegment, SLOT_SEGMENT_SHIFT,
    };

    #[test]
    fn overflow_slot_encoding_preserves_segment_and_local_index() {
        let slot = encode_overflow_slot(1, 12_345);
        assert_eq!(decode_memo_slot(slot), (2, 12_345));
        assert!(slot >= (2 << SLOT_SEGMENT_SHIFT));
    }

    #[test]
    fn overflow_probe_keeps_colliding_keys_distinct() {
        let mut segment = MemoOverflowSegment::try_new(4).expect("small test segment");
        let epoch = 7;
        let first = 1u32;
        let first_hash = hash_slot(first, segment.mask);
        let second = (2..10_000u32)
            .find(|candidate| hash_slot(*candidate, segment.mask) == first_hash)
            .expect("a collision in 16 slots");

        let first_index = segment.probe(first, epoch);
        segment.storage.keys[first_index] = first;
        segment.storage.gens[first_index] = epoch;
        let second_index = segment.probe(second, epoch);
        segment.storage.keys[second_index] = second;
        segment.storage.gens[second_index] = epoch;

        assert_ne!(first_index, second_index);
        assert_eq!(segment.probe(first, epoch), first_index);
        assert_eq!(segment.probe(second, epoch), second_index);
    }
}
