//! Directed enclosures select candidates only. Overlap is resolved with exact
//! integers, never epsilon ties. Ports the current primary/cost guidance.
use super::*;
use num_traits::ToPrimitive;

#[derive(Clone, Copy)]
pub struct Interval { lo: f64, hi: f64 }
const ZERO: Interval = Interval { lo: 0.0, hi: 0.0 };
const ONE: Interval = Interval { lo: 1.0, hi: 1.0 };
fn up(x: f64) -> f64 { if !x.is_finite() { f64::INFINITY } else { f64::from_bits(x.to_bits()+1) } }
fn down(x: f64) -> f64 { if x <= 0.0 || !x.is_finite() { 0.0 } else { f64::from_bits(x.to_bits()-1) } }
fn weighted(p: usize, g: Interval, n: Interval) -> Interval {
    if p == 1000 { return g; }
    let term = |v, p, upper| {
        if v == 0.0 || p == 0 { 0.0 }
        else if upper { up(up(v*p as f64)/1000.0) } else { down(down(v*p as f64)/1000.0) }
    };
    Interval { lo: down(term(g.lo,p,false)+term(n.lo,1000-p,false)),
        hi: up(term(g.hi,p,true)+term(n.hi,1000-p,true)) }
}
fn consume(child: Interval, price: Interval) -> Interval {
    Interval { lo: down(child.lo+down(10.0*price.lo)), hi: up(child.hi+up(10.0*price.hi)) }
}
fn possible(actions: &[Option<Interval>;3]) -> u8 {
    let upper = actions.iter().flatten().map(|v| v.hi).fold(f64::INFINITY,f64::min);
    actions.iter().enumerate().fold(0,|mask,(k,a)| if a.is_some_and(|a| a.lo <= upper) {mask|1<<k} else {mask})
}
fn minimum(actions: &[Option<Interval>;3]) -> Interval {
    Interval { lo:actions.iter().flatten().map(|a| a.lo).fold(f64::INFINITY,f64::min),
        hi:actions.iter().flatten().map(|a| a.hi).fold(f64::INFINITY,f64::min) }
}
/// Floor the exact rational to a binary64 dyadic; nextUp encloses the remainder.
pub fn ratio(n: &BigUint, d: &BigUint) -> Interval {
    if n.is_zero() { return ZERO; }
    let mut e = n.bits() as i64-d.bits() as i64;
    if if e >= 0 { n < &(d << e as usize) } else { &(n << -e as usize) < d } { e-=1; }
    if e > 1023 { return Interval {lo:0.0,hi:f64::INFINITY}; }
    let shift = if e < -1022 {1074} else {52-e};
    let (numerator,denominator) = if shift >= 0 {(n<<shift as usize,d.clone())} else {(n.clone(),d<<-shift as usize)};
    let quotient = &numerator / &denominator;
    let remainder = numerator % denominator;
    let bits = quotient.to_u64().unwrap_or(0);
    let lo = if e < -1022 {f64::from_bits(bits)} else { f64::from_bits(((e+1023) as u64)<<52 | (bits-(1u64<<52))) };
    Interval {lo,hi:if remainder.is_zero() {lo} else {up(lo)}}
}
const PAGE: usize = 4096;
struct BoundPage { lower: Box<[f64;PAGE]>, width: Box<[f32;PAGE]>, status: Box<[u8;PAGE]> }
pub struct Arena {
    sid: usize, root: Units, offsets: Vec<usize>, purple: Vec<usize>, yellow: Vec<usize>,
    failure: HashMap<usize,BoundPage>, cost: HashMap<usize,BoundPage>,
}
impl Arena {
    pub fn new(sid: usize, root: Units, caps: &[Units]) -> Self {
        let mut offsets = vec![0;601]; let mut purple = offsets.clone(); let mut yellow = offsets.clone();
        let mut cells = 0;
        for s in sid..TERMINAL {
            offsets[s] = cells; purple[s] = root[1].min(caps[s][1])+1; yellow[s] = root[2].min(caps[s][2])+1;
            cells += (root[0].min(caps[s][0])+1)*purple[s]*yellow[s];
        }
        Self {sid,root,offsets,purple,yellow,failure:HashMap::new(),cost:HashMap::new()}
    }
    pub fn supports(&self, sid: usize, u: Units) -> bool { sid >= self.sid && (0..3).all(|k| u[k] <= self.root[k]) }
    fn index(&self, s: usize, u: Units) -> usize { self.offsets[s]+(u[0]*self.purple[s]+u[1])*self.yellow[s]+u[2] }
    fn get(&self, cost: bool, s: usize, u: Units) -> Option<Interval> {
        let i = self.index(s,u);
        let pages = if cost {&self.cost} else {&self.failure};
        let page = pages.get(&(i/PAGE))?; let row = i%PAGE;
        if page.status[row] == 0 {None}
        else {Some(Interval {lo:page.lower[row],hi:up(page.lower[row]+page.width[row] as f64)})}
    }
    fn put(&mut self, cost: bool, s: usize, u: Units, value: Interval) {
        if !value.hi.is_finite() || value.lo < 0.0 || value.hi < value.lo {return;}
        let i = self.index(s,u);
        let pages = if cost {&mut self.cost} else {&mut self.failure};
        if !pages.contains_key(&(i/PAGE)) {
            #[cfg(target_arch = "wasm32")]
            if !crate::allocation::can_admit(PAGE*13+16*1024*1024) {return;}
            pages.insert(i/PAGE,BoundPage {lower:Box::new([0.0;PAGE]),width:Box::new([0.0;PAGE]),status:Box::new([0;PAGE])});
        }
        let page = pages.get_mut(&(i/PAGE)).unwrap(); let row = i%PAGE;
        let width = up(value.hi-value.lo);
        let mut packed = width as f32;
        if (packed as f64) < width {packed=f32::from_bits(packed.to_bits()+1);}
        if !packed.is_finite() {return;}
        page.lower[row]=value.lo; page.width[row]=packed; page.status[row]=1;
    }
}
#[derive(Clone)]
pub struct Primary { p: BigUint, exponent: usize, mask: u8 }
impl Engine {
    pub fn ensure_guidance(&mut self, s: usize, raw: Units) {
        if s == TERMINAL {return;}
        let u = self.canonical(s,raw);
        if self.arena.as_ref().is_none_or(|a| !a.supports(s,u)) {
            self.arena=Some(Arena::new(s,u,&self.caps));
        }
    }
    fn canonical(&self,s:usize,u:Units) -> Units {std::array::from_fn(|k| u[k].min(self.caps[s][k]))}
    fn insufficient(&self,s:usize,u:Units) -> bool {
        let level=if s<150 {s/10} else {(s-150)/30};
        u.iter().sum::<usize>() < (15-level+4)/5+if s<150 {2} else {0}
    }
    fn certain_mask(&self,s:usize,u:Units) -> u8 {
        let mut mask=0;
        for k in 0..3 {
            if u[k]==0 {continue;}
            let [p,g,n]=self.edges[s][k]; let mut rem=u; rem[k]-=1;
            if self.certain(if p==1000 {g} else {n},rem) {mask|=1<<k;}
        }
        mask
    }
    fn failure_action(&mut self,s:usize,u:Units,k:usize) -> Result<Interval> {
        let [p,g,n]=self.edges[s][k]; let mut rem=u; rem[k]-=1;
        let gv=self.failure_bound(g,rem)?;
        let nv=if p<1000 {self.failure_bound(n,rem)?} else {ZERO};
        Ok(weighted(p,gv,nv))
    }
    fn failure_actions(&mut self,s:usize,u:Units) -> Result<[Option<Interval>;3]> {
        let mut actions=[None;3];
        for k in 0..3 {if u[k]>0 {actions[k]=Some(self.failure_action(s,u,k)?);}}
        Ok(actions)
    }
    fn failure_bound(&mut self,s:usize,raw:Units) -> Result<Interval> {
        self.check()?;
        if s==TERMINAL {return Ok(ZERO);}
        let u=self.canonical(s,raw);
        if self.insufficient(s,u) {return Ok(ONE);}
        if self.certain(s,u) {return Ok(ZERO);}
        if let Some(v)=self.arena.as_ref().unwrap().get(false,s,u) {return Ok(v);}
        let v=minimum(&self.failure_actions(s,u)?);
        self.arena.as_mut().unwrap().put(false,s,u,v);
        Ok(v)
    }
    fn primary_get(&mut self,s:usize,raw:Units) -> Result<Primary> {
        self.check()?;
        if s==TERMINAL {return Ok(Primary {p:BigUint::one(),exponent:0,mask:0});}
        let u=self.canonical(s,raw);
        if self.insufficient(s,u) {return Ok(Primary {p:BigUint::zero(),exponent:0,mask:0});}
        if self.certain(s,u) {return Ok(Primary {p:BigUint::one(),exponent:0,mask:self.certain_mask(s,u)});}
        if let Some(v)=self.primary.get(&(s,u)) {return Ok(v.clone());}
        let candidates=possible(&self.failure_actions(s,u)?);
        let exponent=u.iter().sum::<usize>().min(self.depth[s]);
        let mut best=BigUint::zero(); let mut mask=0;
        for k in 0..3 {
            if candidates&(1<<k)==0 {continue;}
            self.transitions+=1;
            let [p,g,n]=self.edges[s][k]; let mut rem=u; rem[k]-=1;
            let gv=self.primary_get(g,rem)?;
            let mut value=gv.p*&self.powers[exponent-1-gv.exponent]*p;
            if p<1000 {let nv=self.primary_get(n,rem)?;value+=nv.p*&self.powers[exponent-1-nv.exponent]*(1000-p);}
            if value>best {best=value;mask=1<<k;}
            else if value==best && !best.is_zero() {mask|=1<<k;}
        }
        let result=Primary {p:best,exponent,mask};
        if self.memo.len()+self.primary.len()>=self.max_memo {return Err("exact_memo_limit");}
        self.primary.insert((s,u),result.clone());
        Ok(result)
    }
    fn primary_mask(&mut self,s:usize,u:Units) -> Result<u8> {
        if self.insufficient(s,u) {return Ok(0);}
        if self.certain(s,u) {return Ok(self.certain_mask(s,u));}
        let candidates=possible(&self.failure_actions(s,u)?);
        if candidates.count_ones()==1 {Ok(candidates)} else {Ok(self.primary_get(s,u)?.mask)}
    }
    fn price_bound(&self,k:usize) -> Interval {self.price_bounds[k]}
    fn cost_action(&mut self,s:usize,u:Units,k:usize) -> Result<Interval> {
        let [p,g,n]=self.edges[s][k]; let mut rem=u; rem[k]-=1;
        let gv=self.cost_bound(g,rem)?;
        let nv=if p<1000 {self.cost_bound(n,rem)?} else {ZERO};
        Ok(consume(weighted(p,gv,nv),self.price_bound(k)))
    }
    fn cost_actions(&mut self,s:usize,u:Units,mask:u8) -> Result<[Option<Interval>;3]> {
        let mut actions=[None;3];
        for k in 0..3 {if mask&(1<<k)!=0 {actions[k]=Some(self.cost_action(s,u,k)?);}}
        Ok(actions)
    }
    fn cost_bound(&mut self,s:usize,raw:Units) -> Result<Interval> {
        self.check()?;
        if s==TERMINAL {return Ok(ZERO);}
        let u=self.canonical(s,raw);
        if self.insufficient(s,u) {return Ok(ZERO);}
        if let Some(v)=self.arena.as_ref().unwrap().get(true,s,u) {return Ok(v);}
        if self.relaxed[s].is_none() {self.unlimited(s)?;}
        let relaxed=self.relaxed[s].as_ref().unwrap();
        if (0..3).all(|k| u[k]>=relaxed.bound[k]) {
            if let Some(v)=self.relaxed_cost[s] {return Ok(v);}
            let v=ratio(&self.burden(&relaxed.value),&(&self.powers[relaxed.value.exponent]*&self.guidance_scale));
            self.relaxed_cost[s]=Some(v);
            return Ok(v);
        }
        let mask=self.primary_mask(s,u)?;
        if mask==0 {return Ok(ZERO);}
        let value=minimum(&self.cost_actions(s,u,mask)?);
        self.arena.as_mut().unwrap().put(true,s,u,value);
        Ok(value)
    }
    pub fn guided_candidates(&mut self,s:usize,u:Units) -> Result<u8> {
        let mask=self.primary_mask(s,u)?;
        Ok(possible(&self.cost_actions(s,u,mask)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dyadic_enclosures_contain_exact_rationals_including_subnormals() {
        for (n,d) in [(BigUint::from(1u32),BigUint::from(3u32)),
            (BigUint::from(1u32),BigUint::one()<<1100),
            ((BigUint::one()<<2100)+BigUint::from(17u32),BigUint::one()<<2096),
            (BigUint::one()<<1074,BigUint::one()<<1074)] {
            let bounds=ratio(&n,&d);
            let exact=rational(&n,&d);
            assert!(Q::from_float(bounds.lo).unwrap()<=exact);
            assert!(Q::from_float(bounds.hi).unwrap()>=exact);
        }
    }
}
