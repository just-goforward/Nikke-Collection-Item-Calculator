//! Service positive interval DP over the current Engine. No fast-math, FMA or
//! reassociation: each weighted edge retains the same four rounding operations.
use super::*;
use num_traits::{Euclid, ToPrimitive};
const READY: u8 = 1;
const ZERO: u8 = 2;
const ONE: u8 = 4;
const INTS: u8 = 56;
const EXACT: u8 = 128;
pub const BATCH: usize = 32;
const SAFE: f64 = 9007199254740991.0;
const PAGE_SHIFT: usize = 6;
const PAGE_SLOTS: usize = 1 << PAGE_SHIFT;
const CELL_GROWTH: usize = 4;
#[derive(Clone, Copy, Default)]
struct Cell { v: [f64; 4], tag: u8, mask: u8 }
/// Padding-free backing only. Read packed fields by value into an aligned Cell;
/// never form references to the packed float array or any of its elements.
#[repr(C, packed)]
#[derive(Clone, Copy)]
struct StoredCell { v: [f64; 4], tag: u8, mask: u8 }
impl StoredCell {
    fn pack(c:Cell)->Self {Self {v:c.v,tag:c.tag,mask:c.mask}}
    fn unpack(self)->Cell {Cell {v:self.v,tag:self.tag,mask:self.mask}}
}
/// Occupied slots are stored in ascending slot order. Rank is independent of
/// READY/EXACT and preserves every certified cell when another slot is inserted.
struct Page { occupied: u64, cells: Vec<StoredCell> }
impl Page {
    fn new() -> Self { Self { occupied:0, cells:Vec::new() } }
    fn rank(&self,slot:usize)->usize { (self.occupied&((1u64<<slot)-1)).count_ones() as usize }
    fn get(&self,slot:usize)->Option<Cell> {
        if self.occupied&(1u64<<slot)==0 {None} else {Some(self.cells[self.rank(slot)].unpack())}
    }
    fn store(&mut self,e:&mut Engine,slot:usize,mut c:Cell,admit:impl FnOnce(&mut Engine,usize)->Result<()>)->Result<bool> {
        let bit=1u64<<slot;let rank=self.rank(slot);c.tag|=READY;
        if self.occupied&bit!=0 {self.cells[rank]=StoredCell::pack(c);return Ok(false);}
        if self.cells.len()==self.cells.capacity() {
            let capacity=(self.cells.capacity()+CELL_GROWTH).min(PAGE_SLOTS);
            // LIVE already includes the old buffer. Admit the entire new
            // allocation, not just its capacity delta: realloc may copy it.
            admit(e,capacity*std::mem::size_of::<StoredCell>())?;
            self.cells.try_reserve_exact(capacity-self.cells.len()).map_err(|_|"managed_payload_ceiling")?;
        }
        self.cells.insert(rank,StoredCell::pack(c));self.occupied|=bit;Ok(true)
    }
}
fn up(v: f64) -> f64 {
    if v == f64::INFINITY || v.is_nan() { v }
    else if v == 0. { f64::from_bits(1) }
    else { f64::from_bits(if v > 0. { v.to_bits()+1 } else { v.to_bits()-1 }) }
}
fn down(v: f64) -> f64 { -up(-v) }
/// Integer quotient/remainder rounding, not separately rounded numerator/denominator.
/// Returns the rounded value and its ordering relative to the exact positive ratio.
fn ratio(n: &BigUint, d: &BigUint) -> Result<(f64, Ordering)> {
    if d.is_zero() { return Err("fused_zero_denominator"); }
    if n.is_zero() { return Ok((0., Ordering::Equal)); }
    let mut e = n.bits() as i64 - d.bits() as i64;
    if e >= 0 { if n < &(d << e as usize) { e -= 1; } }
    else if &(n << (-e) as usize) < d { e -= 1; }
    if e > 1023 { return Err("fused_nonfinite_ratio"); }
    let shift = (52-e).max(0).min(1074) as usize;
    let scaled;
    let (a, b) = if e > 52 {
        scaled = d << (e-52) as usize;
        (n, &scaled)
    } else if shift != 0 {
        scaled = n << shift;
        (&scaled, d)
    } else {
        (n, d)
    };
    let (mut q, r) = a.div_rem_euclid(b);
    let twice = &r << 1usize;
    let round = twice > *b || (twice == *b && q.bit(0));
    if round { q += 1u8; }
    let order = if r.is_zero() { Ordering::Equal } else if round { Ordering::Greater } else { Ordering::Less };
    let mut mantissa = q.to_u64().ok_or("fused_ratio_mantissa")?;
    if e < -1022 { return Ok((f64::from_bits(mantissa), order)); }
    if mantissa == 1u64 << 53 { mantissa >>= 1; e += 1; }
    if e > 1023 { return Err("fused_nonfinite_ratio"); }
    Ok((f64::from_bits(((e+1023) as u64)<<52 | (mantissa & ((1u64<<52)-1))), order))
}
fn exact_integer(rounded: f64, ordering: Ordering) -> bool {
    ordering == Ordering::Equal && rounded <= SAFE && rounded.fract() == 0.0
}
fn ratio_bounds(n: &BigUint, d: &BigUint) -> Result<[f64;2]> {
    let (v,o)=ratio(n,d)?;
    Ok([if o==Ordering::Greater {down(v)} else {v}, if o==Ordering::Less {up(v)} else {v}])
}
struct Errors { relative: f64, lower: f64, upper: f64, absolute: f64 }
impl Errors {
    fn new(depth: usize) -> Self {
        let operations=(4*depth+4) as f64;
        let nu=operations*(f64::EPSILON/2.);
        let relative=up(nu/down(1.-nu));
        let lower=down(1./up(1.+relative));
        let upper=up(1./down(1.-relative));
        Self { relative, lower, upper, absolute:up((operations*f64::from_bits(1))*upper) }
    }
    fn lo(&self,v:f64,exact:bool)->f64 { if exact {v} else {down(down(v*self.lower)-self.absolute).max(0.)} }
    fn hi(&self,v:f64,exact:bool)->f64 { if exact {v} else {up(up(v*self.upper)+self.absolute)} }
}
// Internal page numbers are linearized graph coordinates, never caller
// strings. An odd multiplier permutes the entire usize domain and mixes
// consecutive pages into distinct high hash tags without hashing bytes.
#[derive(Default)]
struct PageHash(u64);
impl std::hash::Hasher for PageHash {
    fn finish(&self)->u64 { self.0 }
    fn write_usize(&mut self, page:usize) { self.0=(page as u64).wrapping_mul(0x9e3779b97f4a7c15); }
    fn write(&mut self, bytes:&[u8]) {
        for &b in bytes { self.0=(self.0^u64::from(b)).wrapping_mul(0x100000001b3); }
    }
}
pub(super) struct Solver {
    sid:usize, max:Units, offsets:Vec<usize>, strides:Vec<[usize;2]>, pages:HashMap<usize,Page,std::hash::BuildHasherDefault<PageHash>>, cell_bytes:usize,
    errors:Errors, price_bounds:[[f64;2];3], number_prices:Option<[f64;3]>, relaxed_cells:Vec<Cell>,
    relaxed_actions:Vec<[Cell;3]>,
    exact_clock_step:u8,
    visits:usize, states:usize, hits:usize, transitions:usize, refinements:usize, thresholds:usize, batches:usize,
}
impl Solver {
    fn new(e:&Engine,sid:usize,max:Units)->Result<Self> {
        if sid>TERMINAL {return Err("fused_invalid_init");}
        if now()>=e.deadline {return Err("request_budget_exhausted");}
        if e.configured_source_root.is_some_and(|(actual,_)|actual!=sid) {return Err("fused_invalid_init");}
        let max=std::array::from_fn(|k|max[k].min(e.caps[sid][k]));
        let mut offsets=vec![0;601]; let mut strides=vec![[0;2];601]; let mut offset=0usize;
        for s in 0..TERMINAL {
            let p=max[1].min(e.caps[s][1])+1; let y=max[2].min(e.caps[s][2])+1;
            offsets[s]=offset; strides[s]=[p.checked_mul(y).ok_or("fused_key_overflow")?,y];
            offset=offset.checked_add((max[0].min(e.caps[s][0])+1).checked_mul(strides[s][0]).ok_or("fused_key_overflow")?).ok_or("fused_key_overflow")?;
        }
        let mut price_bounds=[[0.;2];3];
        for k in 0..3 {price_bounds[k]=ratio_bounds(&e.prices[k],&e.scale)?;}
        let dot:BigUint=(0..3).map(|k|&e.prices[k]*(10*max[k])).sum();
        let safe=BigUint::from(9007199254740991u64);
        let number_prices=if dot<=safe && e.prices.iter().all(|p|p<=&safe) {Some(std::array::from_fn(|k|e.prices[k].to_f64().unwrap()))} else {None};
        Ok(Self {sid,max,offsets,strides,pages:HashMap::default(),cell_bytes:0,errors:Errors::new(e.depth[sid]),price_bounds,number_prices,relaxed_cells:Vec::new(),
            relaxed_actions:Vec::new(),exact_clock_step:0,
            visits:0,states:0,hits:0,transitions:0,refinements:0,thresholds:0,batches:0})
    }
    fn key(&self,s:usize,u:Units)->usize {self.offsets[s]+u[0]*self.strides[s][0]+u[1]*self.strides[s][1]+u[2]}
    fn admit_reusable(e:&mut Engine,bytes:usize,can_admit:impl Fn(usize)->bool)->Result<()> {
        Self::admit_reusable_estimated(e,|_|bytes,can_admit)
    }
    fn admit_reusable_estimated(e:&mut Engine,estimate:impl Fn(&Engine)->usize,can_admit:impl Fn(usize)->bool)->Result<()> {
        if !can_admit(estimate(e)) {
            // A purely advisory scalar table is expendable before any exact memo.
            if e.screen.take().is_some() {
                e.screen_retired=true;
                if can_admit(estimate(e)) {return Ok(());}
            }
            // Drop reusable backing once, never primary or work counters.
            e.memo=HashMap::new();
            // Retirement changes the next table allocation as well as LIVE.
            // Never retry a growth estimate derived from the freed backing.
            if !can_admit(estimate(e)){return Err("managed_payload_ceiling");}
        }
        Ok(())
    }
    fn admit(e:&mut Engine,bytes:usize)->Result<()> {
        #[cfg(target_arch = "wasm32")]
        return Self::admit_reusable(e,bytes,allocation::can_admit);
        #[cfg(not(target_arch = "wasm32"))]
        Self::admit_reusable(e,bytes,|_|true)
    }
    // Page payload only: live page metadata plus actual cell backing capacity.
    // Hash-table keys, spare buckets and controls remain in allocator telemetry.
    fn page_bytes(&self)->usize {self.pages.len()*std::mem::size_of::<Page>()+self.cell_bytes}
    fn store(&mut self,e:&mut Engine,key:usize,c:Cell)->Result<Cell> {
        let page=key>>PAGE_SHIFT;let slot=key&(PAGE_SLOTS-1);
        if let Some(p)=self.pages.get_mut(&page) {
            let before=p.cells.capacity();
            let inserted=p.store(e,slot,c,Self::admit)?;
            self.cell_bytes+=(p.cells.capacity()-before)*std::mem::size_of::<StoredCell>();
            self.states+=usize::from(inserted);
        } else {
            if self.pages.len()==self.pages.capacity() {
                // Only growth needs admission. The fallible allocator charges
                // the actual new table while the old one is still live; no
                // guessed whole-table charge on every newly occupied page.
                #[cfg(target_arch = "wasm32")]
                let previously_denied=allocation::certified_allocation_denied();
                if self.pages.try_reserve(1).is_err() {
                    e.memo=HashMap::new();
                    let reserved=self.pages.try_reserve(1).map_err(|_|"managed_payload_ceiling");
                    #[cfg(target_arch = "wasm32")]
                    let reserved=allocation::finish_fallible_retry(previously_denied,reserved);
                    reserved?;
                }
            }
            let mut p=Page::new();p.store(e,slot,c,Self::admit)?;
            self.cell_bytes+=p.cells.capacity()*std::mem::size_of::<StoredCell>();
            self.pages.insert(page,p);self.states+=1;
        }
        Ok(c)
    }
    // The bound certifies feasibility of the unlimited canonical policy, hence
    // equality of the finite optimal value and canonical consumed vector. It
    // does NOT certify all finite tied actions: never shortcut this solver's
    // root or publish these canonical-only cells in pages / Engine::memo.
    fn relaxed_feasible(&self,e:&Engine,s:usize,u:Units)->bool {
        s>self.sid&&e.relaxed[s].as_ref().is_some_and(|r|(0..3).all(|k|u[k]>=r.bound[k]))
    }
    fn canonical_mask(mask:u8)->u8 {if mask==0 {0} else {1<<mask.trailing_zeros()}}
    fn relaxed_cell(&mut self,e:&mut Engine,s:usize,admit:impl FnOnce(&mut Engine,usize)->Result<()>)->Result<Cell> {
        if let Some(c)=self.relaxed_cells.get(s).filter(|c|c.tag&READY!=0) {return Ok(*c);}
        if now()>=e.deadline {return Err("request_budget_exhausted");}
        let backing=if self.relaxed_cells.is_empty() {(TERMINAL+1)*std::mem::size_of::<Cell>()} else {0};
        admit(e,2*1024*1024+backing)?;
        let mut c=Self::exact_cell(e,&e.relaxed[s].as_ref().unwrap().value)?;
        c.mask=Self::canonical_mask(c.mask);
        if self.relaxed_cells.is_empty() {
            self.relaxed_cells.try_reserve_exact(TERMINAL+1).map_err(|_|"managed_payload_ceiling")?;
            self.relaxed_cells.resize(TERMINAL+1,Cell::default());
        }
        // One correctly rounded seed per state. Errors' 4*depth+4 operation
        // envelope already covers seed rounding plus all remaining DP edges.
        self.relaxed_cells[s]=c;Ok(c)
    }
    fn relaxed_action_cell(&mut self,e:&mut Engine,s:usize,k:usize)->Result<Cell> {
        if let Some(row)=self.relaxed_actions.get(s) {if row[k].tag&READY!=0 {return Ok(row[k]);}}
        if now()>=e.deadline {return Err("request_budget_exhausted");}
        let backing=if self.relaxed_actions.is_empty() {(TERMINAL+1)*std::mem::size_of::<[Cell;3]>()} else {0};
        Self::admit(e,2*1024*1024+backing)?;
        let c=Self::exact_cell(e,&e.relaxed[s].as_ref().unwrap().actions[k])?;
        if self.relaxed_actions.is_empty() {
            self.relaxed_actions.try_reserve_exact(TERMINAL+1).map_err(|_|"managed_payload_ceiling")?;
            self.relaxed_actions.resize(TERMINAL+1,[Cell::default();3]);
        }
        self.relaxed_actions[s][k]=c;Ok(c)
    }
    // Fused cells already prove the optimal continuation. Reconstruct that
    // policy, not a second all-actions search through Engine::get.
    fn exact_action(&mut self,e:&mut Engine,s:usize,u:Units,k:usize)->Result<Value> {
        let [p,g,n]=e.edges[s][k];let mut remaining=u;remaining[k]-=1;
        let gv=self.exact_selected(e,g,remaining)?;
        let nv=if p<1000&&g!=n {self.exact_selected(e,n,remaining)?} else {Value::zero()};
        e.combine(p,&gv,if p<1000&&g==n{&gv}else{&nv},u.iter().sum::<usize>().min(e.depth[s]),k)
    }
    fn remember_exact(e:&mut Engine,s:usize,u:Units,v:&Value)->Result<()> {
        #[cfg(target_arch = "wasm32")]
        return Self::remember_exact_admitted(e,s,u,v,allocation::can_admit);
        #[cfg(not(target_arch = "wasm32"))]
        Self::remember_exact_admitted(e,s,u,v,|_|true)
    }
    fn remember_exact_admitted(e:&mut Engine,s:usize,u:Units,v:&Value,can_admit:impl Fn(usize)->bool)->Result<()> {
        // Entry-limit retirement precedes estimation. If primary occupies all
        // entries, there is no insertion or rational clone to admit at all.
        if e.memo.len()+e.primary.len()>=e.max_memo {e.memo=HashMap::new();}
        if e.primary.len()>=e.max_memo {return Ok(());}
        let clone_bytes=v.memo_clone_headroom();
        Self::admit_reusable_estimated(e,|e|{
            let growth=if e.memo.len()==e.memo.capacity(){e.memo.capacity().saturating_mul(256).saturating_add(4096)}else{0};
            clone_bytes.saturating_add(growth)
        },&can_admit)?;
        if e.memo.len()==e.memo.capacity() {
            #[cfg(any(target_arch="wasm32",test))]
            let previously_denied=allocation::certified_allocation_denied();
            if let Err(reason)=e.reserve_exact_memo_slot() {
                // An empty table has nothing to free. Otherwise retry once,
                // from an empty memo, not against the original rehash layout.
                if e.memo.capacity()==0 {return Err(reason);}
                e.memo=HashMap::new();
                let reserved=e.reserve_exact_memo_slot();
                #[cfg(any(target_arch="wasm32",test))]
                let reserved=allocation::finish_fallible_retry(previously_denied,reserved);
                reserved?;
            }
            // LIVE now includes the real backing. Do not use admit_reusable:
            // it could retire this reserved table and make insert grow again.
            if !can_admit(clone_bytes) {return Err("managed_payload_ceiling");}
        }
        e.memo.insert((s,u),v.clone());
        Ok(())
    }
    fn exact_selected(&mut self,e:&mut Engine,s:usize,raw:Units)->Result<Value> {
        if self.exact_clock_step==0 && now()>=e.deadline{return Err("request_budget_exhausted");}
        self.exact_clock_step=(self.exact_clock_step+1)&15;
        Self::admit(e,2*1024*1024)?;
        if s==TERMINAL{return Ok(Value::complete());}
        let u=std::array::from_fn(|k|raw[k].min(e.caps[s][k]));
        if self.relaxed_feasible(e,s,u) {
            let r=e.relaxed[s].as_ref().unwrap();
            let mut v=e.lift(&r.value,u.iter().sum::<usize>().min(e.depth[s]));
            v.mask=Self::canonical_mask(v.mask);
            return Ok(v);
        }
        if let Some(v)=e.memo.get(&(s,u)){return Ok(v.clone());}
        let c=self.visit(e,s,u)?;
        if c.mask==0{return Ok(Value::zero());}
        if c.tag&INTS==INTS&&c.tag&(ZERO|ONE)!=0 {
            // Integer tags certify the entire selected vector, not rounded
            // equality. No rational subtree or memo entry is needed here.
            return Ok(Value{p:BigUint::from(u8::from(c.tag&ONE!=0)),
                c:std::array::from_fn(|k|BigUint::from(c.v[k+1] as u64)),exponent:0,mask:c.mask});
        }
        let mut v=self.exact_action(e,s,u,c.mask.trailing_zeros() as usize)?;
        v.mask=c.mask;
        Self::remember_exact(e,s,u,&v)?;
        Ok(v)
    }
    fn refined(&mut self,e:&mut Engine,s:usize,u:Units)->Result<Cell> {
        Self::admit(e,2*1024*1024)?;
        self.refinements+=1;
        if let Some(v)=e.memo.get(&(s,u)){return Self::exact_cell(e,v);}
        let v={
            let mut best=Value::zero();
            let certain=e.certain(s,u);
            for k in 0..3 {
                if u[k]==0{continue;}
                let [p,g,n]=e.edges[s][k];let mut remaining=u;remaining[k]-=1;
                if certain&&!e.certain(if p==1000 {g} else {n},remaining) {continue;}
                // Exact version of the interval guard below. Strict dominance
                // only: equal burden/total actions must retain their mask bits.
                if best.p==e.powers[best.exponent] {
                    if let Some(r)=e.relaxed[s].as_ref() {
                        // Relaxed values use depth[s], while finite candidates
                        // may use fewer remaining kits. Compare denominators
                        // explicitly; Engine::compare requires equal exponents.
                        let bound=&r.actions[k];
                        let left=e.burden(bound)*&e.powers[best.exponent];
                        let right=e.burden(&best)*&e.powers[bound.exponent];
                        if left>right||(left==right&&Engine::total(bound)*&e.powers[best.exponent]
                            >Engine::total(&best)*&e.powers[bound.exponent]) {continue;}
                    }
                }
                let action=self.exact_action(e,s,u,k)?;
                match e.compare(&action,&best){
                    Ordering::Greater=>best=action,
                    Ordering::Equal=>best.mask|=action.mask,
                    Ordering::Less=>{}
                }
            }
            Self::remember_exact(e,s,u,&best)?;
            best
        };
        Self::exact_cell(e,&v)
    }
    fn exact_cell(e:&Engine,v:&Value)->Result<Cell> {
        let d=&e.powers[v.exponent];
        let mut tag=READY|EXACT;
        if v.p.is_zero(){tag|=ZERO;} if &v.p==d{tag|=ONE;}
        let probability=if tag&ONE!=0 {1.} else if tag&ZERO!=0 {0.} else {ratio(&v.p,d)?.0};
        let mut values=[probability,0.,0.,0.];
        for k in 0..3 {
            let (rounded, ordering) = ratio(&v.c[k], d)?;
            values[k+1] = rounded;
            if exact_integer(rounded, ordering) { tag |= 8 << k; }
        }
        Ok(Cell{v:values,tag,mask:v.mask})
    }
    fn burden(&self,c:Cell,upper:bool)->f64 {
        let mut total=0.;
        for k in 0..3 {
            let exact=c.tag&(8<<k)!=0;
            let v=if upper {self.errors.hi(c.v[k+1],exact)} else {self.errors.lo(c.v[k+1],exact)};
            let p=self.price_bounds[k][usize::from(upper)]; if v==0.||p==0.{continue;}
            total=if upper {up(total+up(v*p))} else {down(total+down(v*p)).max(0.)};
        } total
    }
    fn compare(&self,e:&Engine,a:Cell,b:Cell)->Option<Ordering> {
        if (a.tag&ONE)!=(b.tag&ONE) {return Some(if a.tag&ONE!=0{Ordering::Greater}else{Ordering::Less});}
        if (a.tag&ZERO)!=(b.tag&ZERO) {return Some(if a.tag&ZERO!=0{Ordering::Less}else{Ordering::Greater});}
        if a.tag&(ZERO|ONE)==0 {
            if self.errors.lo(a.v[0],false)>self.errors.hi(b.v[0],false){return Some(Ordering::Greater);}
            if self.errors.hi(a.v[0],false)<self.errors.lo(b.v[0],false){return Some(Ordering::Less);}
            return None;
        }
        if a.tag&INTS==INTS && b.tag&INTS==INTS {
            let order=if let Some(p)=self.number_prices {
                let dot=|v:Cell|v.v[1]*p[0]+v.v[2]*p[1]+v.v[3]*p[2]; dot(b).partial_cmp(&dot(a)).unwrap()
            } else {
                let dot=|v:Cell|->BigUint{(0..3).map(|k|&e.prices[k]*BigUint::from(v.v[k+1] as u64)).sum()};dot(b).cmp(&dot(a))
            };
            return Some(order.then_with(||b.v[1..].iter().sum::<f64>().partial_cmp(&a.v[1..].iter().sum::<f64>()).unwrap()));
        }
        if self.burden(a,true)<self.burden(b,false){Some(Ordering::Greater)}
        else if self.burden(a,false)>self.burden(b,true){Some(Ordering::Less)} else {None}
    }
    fn visit(&mut self,e:&mut Engine,s:usize,raw:Units)->Result<Cell> {
        self.visits+=1;
        if self.visits%128==0 && now()>=e.deadline{return Err("request_budget_exhausted");}
        if s==TERMINAL{return Ok(Cell{v:[1.,0.,0.,0.],tag:READY|ONE|INTS,mask:0});}
        let u:Units=std::array::from_fn(|k|raw[k].min(e.caps[s][k]));
        let level=if s<150{s/10}else{(s-150)/30};
        if u.iter().sum::<usize>()<(15-level+4)/5+if s<150{2}else{0}{return Ok(Cell{v:[0.;4],tag:READY|ZERO|INTS,mask:0});}
        if self.relaxed_feasible(e,s,u) {return self.relaxed_cell(e,s,Self::admit);}
        let key=self.key(s,u);
        if let Some(c)=self.pages.get(&(key>>PAGE_SHIFT)).and_then(|p|p.get(key&(PAGE_SLOTS-1))) {self.hits+=1;return Ok(c);}
        let mut actions=[Cell::default();3];
        let certain=e.certain(s,u);let mut incumbent=Cell::default();
        let candidates=if certain {7} else {e.screen_mask(s,u)?};
        for k in 0..3 {
            if u[k]==0||candidates&(1<<k)==0{continue;}
            let [m,g,n]=e.edges[s][k];let mut remaining=u;remaining[k]-=1;
            // Reuse Engine's exact all-worst-branch completion certificate.
            // A zero-probability normal branch must not veto a certain action.
            if certain&&!e.certain(if m==1000 {g} else {n},remaining) {continue;}
            if incumbent.tag&ONE!=0&&e.relaxed[s].is_some() {
                let bound=self.relaxed_action_cell(e,s,k)?;
                // Any feasible P=1 incumbent strictly above the unlimited
                // action bound excludes that action; overlap/equality cannot.
                if self.compare(e,incumbent,bound)==Some(Ordering::Greater) {continue;}
            }
            let great=self.visit(e,g,remaining)?;
            let normal=if m==1000||g==n{great}else{self.visit(e,n,remaining)?};
            self.transitions+=1;
            let mut c=Cell{v:[0.;4],tag:READY|(great.tag&normal.tag&(ZERO|ONE)),mask:1<<k};
            c.v[0]=if c.tag&ONE!=0{1.}else if c.tag&ZERO!=0{0.}else{((m as f64*great.v[0]+(1000-m) as f64*normal.v[0])/1000.).min(1.)};
            for j in 0..3 {
                let numerator=m as f64*great.v[j+1]+(1000-m) as f64*normal.v[j+1];
                c.v[j+1]=numerator/1000.+if k==j{10.}else{0.};
                // Exact-integer children and a numerator <= SAFE make the
                // weighted integer exactly representable. Avoid Wasm fmod.
                if great.tag&normal.tag&(8<<j)!=0 && numerator<=SAFE && (numerator as u64)%1000==0 {c.tag|=8<<j;}
            }
            actions[k]=c;
            if c.tag&ONE!=0&&(incumbent.tag&ONE==0||self.compare(e,c,incumbent)==Some(Ordering::Greater)) {incumbent=c;}
        }
        // STOP dominates every zero-success action (even when prices are zero).
        if actions.iter().filter(|a|a.tag!=0).all(|a|a.tag&ZERO!=0) {
            return self.store(e,key,Cell{v:[0.;4],tag:READY|ZERO|INTS,mask:0});
        }
        for k in 0..3 {
            if actions[k].tag==0{continue;}
            let mut c=actions[k];let mut proved=true;
            for j in 0..3 {if j==k||actions[j].tag==0{continue;}match self.compare(e,c,actions[j]){Some(Ordering::Greater)=>{},Some(Ordering::Equal)=>c.mask|=1<<j,_=>{proved=false;break;}}}
            if proved{return self.store(e,key,c);}
        }
        let c=self.refined(e,s,u)?;self.store(e,key,c)
    }
    fn root(&mut self,e:&mut Engine,raw:Units)->Result<(Cell,Units)> {
        if now()>=e.deadline{return Err("request_budget_exhausted");}
        let u=std::array::from_fn(|k|raw[k].min(e.caps[self.sid][k]));
        if (0..3).any(|k|u[k]>self.max[k]){return Err("fused_units_outside_domain");}
        let c=self.visit(e,self.sid,u)?;Ok((c,u))
    }
    fn objective(&self,e:&Engine,c:Cell,u:Units)->Result<Option<Json>> {
        if c.tag&(INTS|ZERO|ONE)&INTS==INTS && c.tag&(ZERO|ONE)!=0 {
            let consumed:[BigUint;3]=std::array::from_fn(|k|BigUint::from(c.v[k+1] as u64));
            let burden:BigUint=(0..3).map(|k|&consumed[k]*&e.prices[k]).sum();
            return Ok(Some(json!({"p":wire(&Q::from_integer(BigInt::from(c.v[0] as u8))),"b":wire(&rational(&burden,&e.scale)),"c":wire(&Q::from_integer(consumed.iter().sum::<BigUint>().into()))})));
        }
        if c.tag&EXACT==0{return Ok(None);}
        let Some(v)=e.memo.get(&(self.sid,u)) else{return Ok(None)};
        Ok(Some(Self::exact_objective(e,v)))
    }
    fn exact_objective(e:&Engine,v:&Value)->Json {
        let d=&e.powers[v.exponent];
        json!({"p":wire(&rational(&v.p,d)),"b":wire(&rational(&e.burden(v),&(d*&e.scale))),"c":wire(&rational(&Engine::total(v),d))})
    }
    fn threshold(&mut self,e:&mut Engine,u:Units,t:Q)->Result<Ordering> {
        let (c,u)=self.root(e,u)?;
        if c.tag&ZERO!=0{return Ok(Q::zero().cmp(&t));}if c.tag&ONE!=0{return Ok(Q::one().cmp(&t));}
        if t<=Q::zero(){return Ok(Ordering::Greater);}if t>=Q::one(){return Ok(Ordering::Less);}
        let b=ratio_bounds(&t.numer().to_biguint().unwrap(),&t.denom().to_biguint().unwrap())?;
        if self.errors.lo(c.v[0],false)>b[1]{return Ok(Ordering::Greater);}if self.errors.hi(c.v[0],false)<b[0]{return Ok(Ordering::Less);}
        self.thresholds+=1;
        let refined=self.refined(e,self.sid,u)?;let key=self.key(self.sid,u);self.store(e,key,refined)?;
        let v=self.exact_selected(e,self.sid,u)?;
        Ok(rational(&v.p,&e.powers[v.exponent]).cmp(&t))
    }
    // 0: no evidence, 1: opportunistic, 2: required exact root objective.
    fn batch(&mut self,e:&mut Engine,units:&[Units],evidence_mode:u8)->Result<Vec<u8>> {
        if units.is_empty()||units.len()>BATCH{return Err("fused_batch_limit");}
        if evidence_mode>2{return Err("fused_batch_input");}
        self.batches+=1;let mut output=Vec::with_capacity(8+units.len()*104);output.extend_from_slice(&(units.len() as u32).to_le_bytes());output.extend_from_slice(&0u32.to_le_bytes());
        let mut evidence=Vec::with_capacity(units.len());
        for u in units {
            let (mut c,u)=self.root(e,*u)?;
            let mut objective=if evidence_mode!=0{self.objective(e,c,u)?}else{None};
            if evidence_mode==2 && objective.is_none() {
                // Required proof applies even to noninteger saturated roots.
                // Reconstruct certified optimal continuations and compare the
                // root exactly; never infer equality from rounded values.
                c=self.refined(e,self.sid,u)?;
                let key=self.key(self.sid,u);
                self.store(e,key,c)?;
                objective=self.objective(e,c,u)?;
                if objective.is_none(){
                    let value=self.exact_selected(e,self.sid,u)?;
                    objective=Some(Self::exact_objective(e,&value));
                }
            }
            for k in 0..4 {
                let exact=if k==0{c.tag&(ZERO|ONE)!=0}else{c.tag&(8<<(k-1))!=0};
                let hi=self.errors.hi(c.v[k],exact);let values=[c.v[k],self.errors.lo(c.v[k],exact),if k==0{hi.min(1.)}else{hi}];
                for v in values{output.extend_from_slice(&v.to_le_bytes());}
            }
            output.extend_from_slice(&(c.mask as u32).to_le_bytes());output.extend_from_slice(&0u32.to_le_bytes());
            evidence.push(objective);
        }
        let tail=json!({"objectives":evidence,"stats":{"endpointStates":self.states,"endpointCacheHits":self.hits,"endpointTransitions":self.transitions,"endpointPages":self.pages.len(),"endpointPageBytes":self.page_bytes(),"endpointExactRefinements":self.refinements,"endpointThresholdRefinements":self.thresholds,"endpointRelativeError":self.errors.relative,"endpointBatches":self.batches,"exactMemoEntries":e.memo.len()+e.primary.len(),"exactTransitions":e.transitions}});
        let mut size=CompletedDatesOutputSize{bytes:0,deadline:e.deadline};
        serde_json::to_writer(&mut size,&tail).map_err(|_|"request_budget_exhausted")?;
        if size.bytes>4*1024*1024{return Err("fused_response_limit");}
        Self::admit(e,output.len()+size.bytes)?;
        output.try_reserve_exact(size.bytes).map_err(|_|"managed_payload_ceiling")?;
        output[4..8].copy_from_slice(&(size.bytes as u32).to_le_bytes());
        serde_json::to_writer(&mut output,&tail).map_err(|_|"fused_encoding")?;
        if now()>=e.deadline{return Err("request_budget_exhausted");}Ok(output)
    }
}
static mut SOLVER:Option<Solver>=None;
pub(super) fn clear(){unsafe{SOLVER=None;}}
#[no_mangle] pub extern "C" fn certified_fused_version()->u32{3}
fn failure(result:Result<()>)->u32{match result{Ok(())=>0,Err(reason)=>{unsafe{OUTPUT=reason.as_bytes().to_vec();}1}}}
#[no_mangle] pub unsafe extern "C" fn certified_fused_init(sid:usize,b:usize,p:usize,y:usize)->u32 {
    failure((||{if SOLVER.is_some(){return Err("fused_already_initialized");}let e=ENGINE.as_ref().ok_or("wasm_not_initialized")?;SOLVER=Some(Solver::new(e,sid,[b,p,y])?);Ok(())})())
}
#[no_mangle] pub unsafe extern "C" fn certified_fused_batch(count:usize,evidence:usize)->u32 {
    failure((||{if count==0||count>BATCH||evidence>2||INPUT.len()!=count*12{return Err("fused_batch_input");}
        let mut units=[[0;3];BATCH];for i in 0..count{for k in 0..3{let at=i*12+k*4;units[i][k]=u32::from_le_bytes(INPUT[at..at+4].try_into().unwrap()) as usize;}}
        let e=ENGINE.as_mut().ok_or("wasm_not_initialized")?;let s=SOLVER.as_mut().ok_or("fused_not_initialized")?;
        OUTPUT=s.batch(e,&units[..count],evidence as u8)?;Ok(())})())
}
#[derive(Deserialize)]struct Threshold{units:Units,threshold:WireQ}
#[no_mangle] pub unsafe extern "C" fn certified_fused_threshold()->u32 {
    failure((||{let input:Threshold=serde_json::from_slice(&INPUT).map_err(|_|"fused_threshold_input")?;
        let e=ENGINE.as_mut().ok_or("wasm_not_initialized")?;let s=SOLVER.as_mut().ok_or("fused_not_initialized")?;
        let order=s.threshold(e,input.units,input.threshold.rational()?)?;
        OUTPUT=(match order{Ordering::Less=>-1i32,Ordering::Equal=>0,Ordering::Greater=>1}).to_le_bytes().to_vec();Ok(())})())
}
#[no_mangle]pub extern "C" fn certified_fused_clear(){clear();}
/// Read-only telemetry during finalization, without allocation or new work.
#[no_mangle]pub unsafe extern "C" fn certified_fused_stat(index:usize)->f64 {
    let Some(s)=SOLVER.as_ref() else{return 0.;};
    match index {
        0=>s.states as f64,1=>s.hits as f64,2=>s.transitions as f64,
        3=>s.pages.len() as f64,4=>s.page_bytes() as f64,
        5=>s.refinements as f64,6=>s.thresholds as f64,7=>s.errors.relative,8=>s.batches as f64,
        9=>ENGINE.as_ref().map_or(0.,|e|(e.memo.len()+e.primary.len()) as f64),
        10=>ENGINE.as_ref().map_or(0.,|e|e.transitions as f64),
        // Bit lengths dominate decimal strings; two single-root results and
        // their rational-decoding overlap remain charged on the host.
        11=>ENGINE.as_ref().map_or(0.,|e|256.*1024.+64.*(
            e.scale.bits()+e.prices.iter().map(|p|p.bits()).max().unwrap_or(0)
            +(e.depth[s.sid] as u64)*10+128) as f64),
        _=>f64::NAN,
    }
}
mod current_batch;
#[cfg(test)]mod tests;
