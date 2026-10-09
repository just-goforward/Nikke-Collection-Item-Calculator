//! Current contract, not the reference package's deadline/pricing contract.
//! Exact denominator-ladder DP derives from src/certified/integerTable.ts and
//! the compatible BigUint recurrence in certified-boundary-v1. No host math.
#[cfg(target_arch = "wasm32")]
mod allocation;
mod supply;
mod waiting;
mod guidance;
use num_bigint::{BigInt, BigUint};
use num_rational::BigRational as Q;
use num_traits::{One, Zero};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};
use std::cmp::Ordering;
use std::collections::HashMap;

type Result<T> = std::result::Result<T, &'static str>;
type Units = [usize; 3];
type Edge = [usize; 3];
const TERMINAL: usize = 600;

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "certified")]
extern "C" { fn now_ms() -> f64; }
fn now() -> f64 {
    #[cfg(target_arch = "wasm32")]
    { unsafe { now_ms() } }
    #[cfg(not(target_arch = "wasm32"))]
    { 0.0 }
}

#[derive(Clone, Serialize, Deserialize)]
struct WireQ { numerator: String, denominator: String }
impl WireQ {
    fn rational(&self) -> Result<Q> {
        let n: BigInt = self.numerator.parse().map_err(|_| "invalid_rational")?;
        let d: BigInt = self.denominator.parse().map_err(|_| "invalid_rational")?;
        if d <= BigInt::zero() { return Err("invalid_rational"); }
        Ok(Q::new(n, d))
    }
}
fn wire(q: &Q) -> WireQ {
    WireQ { numerator: q.numer().to_string(), denominator: q.denom().to_string() }
}
fn rational(n: &BigUint, d: &BigUint) -> Q { Q::new(n.clone().into(), d.clone().into()) }

#[derive(Clone)]
struct Value { p: BigUint, c: [BigUint; 3], exponent: usize, mask: u8 }
impl Value {
    fn zero() -> Self { Self { p: BigUint::zero(), c: std::array::from_fn(|_| BigUint::zero()), exponent: 0, mask: 0 } }
    fn complete() -> Self { Self { p: BigUint::one(), ..Self::zero() } }
}
#[derive(Clone)]
struct Relaxed { value: Value, bound: Units, actions: [Value; 3] }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Init {
    edges: Vec<[Edge; 3]>,
    caps: Vec<Units>,
    weights: [WireQ; 3],
    deadline_at: f64,
    max_memo_entries: usize,
    max_support_points: usize,
}
#[derive(Serialize)]
struct PublicValue { p: WireQ, b: WireQ, c: WireQ, consumed: [WireQ; 3], mask: u8 }
#[derive(Clone, Deserialize, Serialize)]
struct Row { pieces: supply::Pieces, mass: WireQ }

struct Engine {
    edges: Vec<[Edge; 3]>,
    caps: Vec<Units>,
    depth: Vec<usize>,
    powers: Vec<BigUint>,
    prices: [BigUint; 3],
    scale: BigUint,
    relaxed: Vec<Option<Relaxed>>,
    memo: HashMap<(usize, Units), Value>,
    deadline: f64,
    max_memo: usize,
    max_support: usize,
    ticks: usize,
    transitions: usize,
    support_peak: usize,
    current_root: Option<Value>,
    kernel_calls: usize,
    completion: Vec<u16>,
    completion_p: usize,
    completion_y: usize,
    arena: Option<guidance::Arena>,
    primary: HashMap<(usize,Units),guidance::Primary>,
    guidance_scale: BigUint,
    price_bounds: [guidance::Interval;3],
    relaxed_cost: Vec<Option<guidance::Interval>>,
}
impl Engine {
    fn new(input: Init) -> Result<Self> {
        if input.edges.len() != 601 || input.caps.len() != 601 || !input.deadline_at.is_finite() ||
            input.max_memo_entries == 0 || input.max_memo_entries > 250_000 ||
            input.max_support_points == 0 || input.max_support_points > 25_000 {
            return Err("invalid_work_limits");
        }
        let weights: Vec<Q> = input.weights.iter().map(WireQ::rational).collect::<Result<_>>()?;
        if weights.iter().any(|q| q < &Q::zero()) { return Err("invalid_price"); }
        let common: BigInt = weights.iter().map(|q| q.denom()).product();
        let prices: [BigUint;3] = std::array::from_fn(|k| (weights[k].numer() * (&common / weights[k].denom())).to_biguint().unwrap());
        let guidance_scale = BigUint::one() << prices.iter().map(|p| p.bits()).max().unwrap().max(1) as usize;
        let price_bounds=std::array::from_fn(|k| guidance::ratio(&prices[k],&guidance_scale));
        let mut depth = vec![0; 601];
        for s in (0..TERMINAL).rev() {
            for [p, g, n] in input.edges[s] {
                if p == 0 || p > 1000 || g <= s || g > TERMINAL || n <= s || n > TERMINAL {
                    return Err("certified_game_not_acyclic");
                }
                depth[s] = depth[s].max(depth[g] + 1);
                if p < 1000 { depth[s] = depth[s].max(depth[n] + 1); }
            }
        }
        let powers = (0..=depth.iter().copied().max().unwrap()).map(|n| BigUint::from(1000u32).pow(n as u32)).collect();
        // Exact P=1 feasibility: on the ordered game domains a fixed sequence
        // completing the all-worst branch completes every positive branch.
        // This is the current TS CertainCompletion recurrence, not a heuristic.
        let completion_p = input.caps.iter().map(|u| u[1]).max().unwrap()+1;
        let completion_y = input.caps.iter().map(|u| u[2]).max().unwrap()+1;
        let stride = completion_p * completion_y;
        let mut completion = vec![0u16;601*stride];
        for s in (0..TERMINAL).rev() {
            if now() >= input.deadline_at { return Err("request_budget_exhausted"); }
            let worst: [usize;3] = std::array::from_fn(|k| {
                let [p,g,n] = input.edges[s][k]; if p == 1000 {g} else {n}
            });
            for p in 0..completion_p {
                for y in 0..completion_y {
                    let offset = p*completion_y+y;
                    let mut need = 1+completion[worst[0]*stride+offset];
                    if p > 0 { need = need.min(completion[worst[1]*stride+offset-completion_y]); }
                    if y > 0 { need = need.min(completion[worst[2]*stride+offset-1]); }
                    completion[s*stride+offset] = need;
                }
            }
        }
        Ok(Self { edges: input.edges, caps: input.caps, depth, powers, prices,
            scale: common.to_biguint().unwrap(), relaxed: vec![None; 601], memo: HashMap::new(),
            deadline: input.deadline_at, max_memo: input.max_memo_entries, max_support: input.max_support_points,
            ticks: 0, transitions: 0, support_peak: 0, current_root: None, kernel_calls: 0,
            completion, completion_p, completion_y, arena:None, primary:HashMap::new(), guidance_scale,
            price_bounds, relaxed_cost:vec![None;601] })
    }
    fn check(&mut self) -> Result<()> {
        self.ticks += 1;
        if self.ticks % 32 == 0 && now() >= self.deadline { return Err("request_budget_exhausted"); }
        Ok(())
    }
    fn burden(&self, v: &Value) -> BigUint { (0..3).map(|k| &v.c[k] * &self.prices[k]).sum() }
    fn total(v: &Value) -> BigUint { v.c.iter().sum() }
    fn compare(&self, a: &Value, b: &Value) -> Ordering {
        // All action candidates share an exponent; STOP is identically zero.
        a.p.cmp(&b.p).then_with(|| self.burden(b).cmp(&self.burden(a)))
            .then_with(|| Self::total(b).cmp(&Self::total(a)))
    }
    fn lift(&self, v: &Value, exponent: usize) -> Value {
        if exponent >= v.exponent {
            let f = &self.powers[exponent - v.exponent];
            Value { p: &v.p * f, c: std::array::from_fn(|k| &v.c[k] * f), exponent, mask: v.mask }
        } else {
            // A feasible unlimited policy may have a shorter path than the
            // state's maximum depth. All its numerators divide this factor.
            let f = &self.powers[v.exponent - exponent];
            assert!((&v.p % f).is_zero() && v.c.iter().all(|n| (n % f).is_zero()));
            Value { p: &v.p / f, c: std::array::from_fn(|k| &v.c[k] / f), exponent, mask: v.mask }
        }
    }
    fn combine(&mut self, p: usize, g: &Value, n: &Value, exponent: usize, k: usize) -> Result<Value> {
        self.check()?;
        self.transitions += 1;
        let gm = &self.powers[exponent - 1 - g.exponent] * p;
        let nm = if p < 1000 { &self.powers[exponent - 1 - n.exponent] * (1000 - p) } else { BigUint::zero() };
        let mut c = std::array::from_fn(|j| &g.c[j] * &gm + &n.c[j] * &nm);
        c[k] += &self.powers[exponent] * 10u32;
        Ok(Value { p: &g.p * gm + &n.p * nm, c, exponent, mask: 1 << k })
    }
    fn unlimited(&mut self, s: usize) -> Result<Relaxed> {
        if s == TERMINAL { return Ok(Relaxed { value: Value::complete(), bound: [0;3], actions: std::array::from_fn(|_| Value::zero()) }); }
        if let Some(v) = &self.relaxed[s] { return Ok(v.clone()); }
        let mut best = Value::zero();
        let mut chosen = 0;
        let mut actions = std::array::from_fn(|_| Value::zero());
        for k in 0..3 {
            let [p, g, n] = self.edges[s][k];
            let gv = self.unlimited(g)?.value;
            let nv = if p < 1000 { self.unlimited(n)?.value } else { Value::zero() };
            let v = self.combine(p, &gv, &nv, self.depth[s], k)?;
            match self.compare(&v, &best) {
                Ordering::Greater => { best = v.clone(); chosen = k; }
                Ordering::Equal => best.mask |= v.mask,
                _ => {}
            }
            actions[k] = v;
        }
        let [p, g, n] = self.edges[s][chosen];
        let gb = self.unlimited(g)?.bound;
        let nb = if p < 1000 { self.unlimited(n)?.bound } else { [0;3] };
        let bound = std::array::from_fn(|k| gb[k].max(nb[k]) + usize::from(chosen == k));
        let result = Relaxed { value: best, bound, actions };
        self.relaxed[s] = Some(result.clone());
        Ok(result)
    }
    fn get(&mut self, s: usize, raw: Units, root: bool) -> Result<Value> {
        self.check()?;
        if s == TERMINAL { return Ok(Value::complete()); }
        let u: Units = std::array::from_fn(|k| raw[k].min(self.caps[s][k]));
        let level = if s < 150 { s / 10 } else { (s - 150) / 30 };
        let min_uses = (15 - level + 4) / 5 + if s < 150 { 2 } else { 0 };
        let total = u.iter().sum::<usize>();
        if total < min_uses { return Ok(Value::zero()); }
        if let Some(v) = self.memo.get(&(s, u)) { return Ok(v.clone()); }
        let exponent = total.min(self.depth[s]);
        let relaxed = self.unlimited(s)?;
        if !root && (0..3).all(|k| u[k] >= relaxed.bound[k]) { return Ok(self.lift(&relaxed.value, exponent)); }
        let mut order = [0, 1, 2];
        order.sort_by(|&a, &b| self.burden(&relaxed.actions[a]).cmp(&self.burden(&relaxed.actions[b]))
            .then_with(|| Self::total(&relaxed.actions[a]).cmp(&Self::total(&relaxed.actions[b]))).then(a.cmp(&b)));
        let mut best = Value::zero();
        let mut chosen = 3;
        let certain = self.certain(s,u);
        let candidates = if self.arena.is_some() {self.guided_candidates(s,u)?} else {7};
        for k in order {
            if u[k] == 0 || candidates&(1<<k)==0 { continue; }
            if certain {
                let [p,g,n] = self.edges[s][k];
                let mut remaining = u; remaining[k] -= 1;
                if !self.certain(if p == 1000 {g} else {n},remaining) { continue; }
            }
            // Unlimited action is an exact lower cost bound when P=1.
            if best.p == self.powers[exponent] {
                let bound = &relaxed.actions[k];
                let left = self.burden(bound) * &self.powers[exponent];
                let right = self.burden(&best) * &self.powers[bound.exponent];
                if left > right || (left == right &&
                    Self::total(bound) * &self.powers[exponent] > Self::total(&best) * &self.powers[bound.exponent]) { continue; }
            }
            let mut remaining = u;
            remaining[k] -= 1;
            let [p, g, n] = self.edges[s][k];
            let gv = self.get(g, remaining, false)?;
            let nv = if p < 1000 { self.get(n, remaining, false)? } else { Value::zero() };
            let v = self.combine(p, &gv, &nv, exponent, k)?;
            match self.compare(&v, &best) {
                Ordering::Greater => { best = v; chosen = k; }
                Ordering::Equal => {
                    let mask = best.mask | v.mask;
                    if k < chosen { best = v; chosen = k; }
                    best.mask = mask;
                }
                _ => {}
            }
        }
        if self.memo.len()+self.primary.len() >= self.max_memo { return Err("exact_memo_limit"); }
        self.memo.insert((s, u), best.clone());
        Ok(best)
    }
    fn certain(&self, s: usize, u: Units) -> bool {
        let p = u[1].min(self.completion_p-1);
        let y = u[2].min(self.completion_y-1);
        u[0] >= self.completion[s*self.completion_p*self.completion_y+p*self.completion_y+y] as usize
    }
    fn view(&self, v: &Value) -> PublicValue {
        let d = &self.powers[v.exponent];
        PublicValue { p: wire(&rational(&v.p, d)), b: wire(&rational(&self.burden(v), d)),
            c: wire(&rational(&Self::total(v), d)), consumed: std::array::from_fn(|k| wire(&rational(&v.c[k], d))), mask: v.mask }
    }
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Command {
    ConfigureSupply { model: supply::Model, basis: Units, stock: Units, sid: usize, deadline: f64 },
    Init { input: Init },
    Current { sid: usize, stock: Units, batch: usize },
    Waiting { sid: usize, stock: Units, complete: bool },
    Value { sid: usize, units: Units, root: bool },
    Unlimited { sid: usize },
}
fn execute(engine: &mut Option<Engine>, supply: &mut Option<supply::Supply>, command: Command) -> Result<Json> {
    if let Command::ConfigureSupply { model, basis, stock, sid, deadline } = command {
        if sid > TERMINAL || !deadline.is_finite() { return Err("invalid_wasm_request"); }
        let mut source = supply::Supply::new(model,deadline)?;
        let (rates,weights) = source.pricing(basis,stock,sid)?;
        let result = json!({"basisStock":basis,"recurringRate":rates.iter().map(wire).collect::<Vec<_>>(),
            "weights":weights.iter().map(wire).collect::<Vec<_>>(),"cohortWeights":source.priors.iter().map(wire).collect::<Vec<_>>()});
        *supply = Some(source);
        return Ok(result);
    }
    if let Command::Init { input } = command {
        *engine = Some(Engine::new(input)?);
        return Ok(Json::Null);
    }
    let e = engine.as_mut().ok_or("wasm_not_initialized")?;
    if now() >= e.deadline { return Err("request_budget_exhausted"); }
    match command {
        Command::Current { sid, stock, batch } => {
            if sid > TERMINAL || batch == 0 || batch > 1000 { return Err("invalid_wasm_request"); }
            e.kernel_calls += 1;
            e.current(sid,stock,batch)
        }
        Command::Waiting { sid, stock, complete } => {
            if sid > TERMINAL { return Err("invalid_state"); }
            e.waiting(supply.as_mut().ok_or("supply_not_initialized")?,sid,stock,complete)
        }
        Command::Value { sid, units, root } => {
            if sid > TERMINAL { return Err("invalid_state"); }
            if units.iter().sum::<usize>()>36 || e.arena.is_some() {e.ensure_guidance(sid,units);}
            let v = e.get(sid, units, root)?;
            Ok(json!(e.view(&v)))
        }
        Command::Unlimited { sid } => {
            if sid > TERMINAL { return Err("invalid_state"); }
            let r = e.unlimited(sid)?;
            Ok(json!({ "value": e.view(&r.value), "bound": r.bound }))
        }
        _ => Err("invalid_command"),
    }
}

// Single-owner Worker ABI. Input and output buffers are module-owned, never
// retain a JS view across a call (memory.grow may detach it).
static mut INPUT: Vec<u8> = Vec::new();
static mut OUTPUT: Vec<u8> = Vec::new();
static mut ENGINE: Option<Engine> = None;
static mut SUPPLY: Option<supply::Supply> = None;
#[no_mangle]
pub extern "C" fn certified_abi_version() -> u32 { 1 }
#[no_mangle]
pub unsafe extern "C" fn certified_input(length: usize) -> *mut u8 {
    if length > 32 * 1024 * 1024 { return std::ptr::null_mut(); }
    INPUT.resize(length, 0);
    INPUT.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn certified_output_ptr() -> *const u8 { OUTPUT.as_ptr() }
#[no_mangle]
pub unsafe extern "C" fn certified_output_len() -> usize { OUTPUT.len() }
#[no_mangle]
pub unsafe extern "C" fn certified_release() {
    ENGINE = None;
    SUPPLY = None;
    INPUT = Vec::new();
    OUTPUT = Vec::new();
}
#[no_mangle]
pub unsafe extern "C" fn certified_call() {
    OUTPUT.clear();
    let result = serde_json::from_slice::<Command>(&INPUT).map_err(|_| "invalid_wasm_request")
        .and_then(|command| execute(&mut ENGINE, &mut SUPPLY, command));
    let stats = ENGINE.as_ref().map(|e| json!({ "memoEntries": e.memo.len()+e.primary.len(), "exactTransitions": e.transitions, "supportPeakPoints": e.support_peak, "kernelCalls":e.kernel_calls }));
    let response = match result {
        Ok(value) => json!({ "value": value, "stats": stats }),
        Err(reason) => json!({ "error": reason, "stats": stats }),
    };
    OUTPUT = serde_json::to_vec(&response).unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_ladder_and_action_ties() {
        let edges = (0..=600).map(|s| [[1000,600,(s+1).min(600)];3]).collect();
        let mut engine = Engine::new(Init { edges, caps:vec![[1;3];601],
            weights:std::array::from_fn(|_| wire(&Q::one())), deadline_at:f64::MAX,
            max_memo_entries:250000,max_support_points:25000 }).unwrap();
        let value = engine.get(599,[1,1,1],true).unwrap();
        assert_eq!(value.mask,7);
        assert_eq!(engine.view(&value).p.numerator,"1");
        assert_eq!(engine.view(&value).c.numerator,"10");
        assert_eq!(engine.view(&value).consumed[0].numerator,"10");
    }
}
