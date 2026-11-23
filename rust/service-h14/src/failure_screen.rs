//! Request-local, optional scalar Bellman guide. A disjoint enclosure can
//! exclude a first kit; an overlap NEVER certifies equality or a winner.
//! Tile coordinates do not depend on the day's supply box, so growing inventory
//! reuses prior work. The guide does not insert in either exact memo.
use super::*;

const TILE: usize = 64; // 4 x 4 x 4 neighbouring inventories
const GROUP: usize = 128;
const MAX_BYTES: usize = 24 << 20;
type Group = [Option<Box<[u32; TILE]>>; GROUP];

pub(super) struct Screen {
    layout: Vec<[usize; 3]>,
    directory: Vec<Option<Box<Group>>>,
    bytes: usize,
    visits: usize,
}

impl Screen {
    fn new(caps: &[Units]) -> Option<Self> {
        let mut layout = Vec::with_capacity(caps.len());
        let mut tiles = 0usize;
        for &[b,p,y] in caps {
            let ny = y/4+1;
            let stride = (p/4+1).checked_mul(ny)?;
            layout.push([tiles,stride,ny]);
            tiles = tiles.checked_add((b/4+1).checked_mul(stride)?)?;
        }
        let count = tiles.div_ceil(GROUP);
        let bytes = count.checked_mul(std::mem::size_of::<Option<Box<Group>>>())?
            .checked_add(layout.capacity()*std::mem::size_of::<[usize;3]>())?;
        if !Self::fits(0,bytes) {return None;}
        let mut directory = Vec::new();
        if !optional_reserve_exact(&mut directory, count) { return None; }
        directory.resize_with(count, || None);
        Some(Self {layout,directory,bytes,visits:0})
    }
    fn fits(bytes:usize, extra:usize) -> bool {
        if bytes+extra > MAX_BYTES {return false;}
        #[cfg(target_arch="wasm32")]
        if !allocation::can_admit(extra+(16<<20)) {return false;}
        true
    }
    fn location(&self, s:usize, [b,p,y]:Units) -> (usize,usize) {
        let [offset,stride,ny] = self.layout[s];
        (offset+(b/4)*stride+(p/4)*ny+y/4, (b%4)*16+(p%4)*4+y%4)
    }
    fn get(&self, tile:usize, slot:usize) -> Option<f32> {
        let n=self.directory[tile/GROUP].as_ref()?[tile%GROUP].as_ref()?[slot];
        n.checked_sub(1).map(f32::from_bits)
    }
    fn put(&mut self, tile:usize, slot:usize, center:f32) -> bool {
        let group=&mut self.directory[tile/GROUP];
        if group.is_none() {
            let size=std::mem::size_of::<Group>();
            if !Self::fits(self.bytes,size) {return false;}
            *group=Some(Box::new(std::array::from_fn(|_| None)));
            self.bytes+=size;
        }
        let page=&mut group.as_mut().unwrap()[tile%GROUP];
        if page.is_none() {
            let size=TILE*4;
            if !Self::fits(self.bytes,size) {return false;}
            *page=Some(Box::new([0;TILE]));
            self.bytes+=size;
        }
        page.as_mut().unwrap()[slot]=center.to_bits()+1;
        true
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn optional_screen_real_denial_does_not_label_next_trap() {
    use crate::allocation::optional_reserve_probe::{deny,isolated};
    isolated(|| assert!(deny(1, || Screen::new(&[[20;3]])).is_none()));
}

impl Engine {
    pub(super) fn start_screen(&mut self,sid:usize,u:Units) {
        if self.screen.is_none() && !self.screen_retired && sid<TERMINAL &&
            (0..3).fold(1usize,|n,k|n.saturating_mul(u[k].min(self.caps[sid][k])+1))>1024 {
            self.screen=Screen::new(&self.caps);
            self.screen_retired=self.screen.is_none();
        }
    }
    fn screen_value(&mut self,s:usize,raw:Units)->Result<Option<f32>> {
        if s==TERMINAL || self.certain(s,raw) {return Ok(Some(0.));}
        let u=std::array::from_fn(|k|raw[k].min(self.caps[s][k]));
        if self.insufficient(s,u) {return Ok(Some(1.));}
        let screen=self.screen.as_mut().unwrap();
        screen.visits+=1;
        if screen.visits%128==0 && now()>=self.deadline {return Err("request_budget_exhausted");}
        let (tile,slot)=screen.location(s,u);
        if let Some(v)=screen.get(tile,slot) {return Ok(Some(v));}
        let mut best=1f64;
        for k in 0..3 {if u[k]!=0 {
            let Some(v)=self.screen_action(s,u,k)? else {return Ok(None)};
            best=best.min(v);
        }}
        let center=best as f32;
        if !self.screen.as_mut().unwrap().put(tile,slot,center) {
            self.screen=None;
            self.screen_retired=true;
            return Ok(None);
        }
        Ok(Some(center))
    }
    fn screen_action(&mut self,s:usize,mut u:Units,k:usize)->Result<Option<f64>> {
        u[k]-=1;
        let [p,g,n]=self.edges[s][k];
        let Some(gv)=self.screen_value(g,u)? else {return Ok(None)};
        if p==1000||g==n {return Ok(Some(f64::from(gv)));}
        let Some(nv)=self.screen_value(n,u)? else {return Ok(None)};
        Ok(Some((p as f64*f64::from(gv)+(1000-p) as f64*f64::from(nv))/1000.))
    }
    // No cancellation: integer weights are nonnegative and sum to 1000.
    // Each edge has at most 4 binary64 roundings and 1 binary32 rounding.
    // Min is monotone and nonexpansive. Relative error compounds by less than
    // (1+2^-23)^depth, plus <= depth*2^-148 absolute subnormal error.
    // The padded bounds below cover both this and converting back to a bound
    // around the stored center, for every forward graph (depth <= 600).
    fn screen_radius(&self,s:usize,v:f64)->f64 {
        (self.depth[s]+1) as f64*(v * (1./2_097_152.) + 4.*f64::from(f32::from_bits(1)))
    }
    pub(super) fn screen_bounds(&mut self,s:usize,u:Units)->Result<Option<(f64,f64)>> {
        if self.screen.is_none() {return Ok(None);}
        if s==TERMINAL||self.certain(s,u) {return Ok(Some((0.,0.)));}
        let Some(v)=self.screen_value(s,u)? else {return Ok(None)};
        let v=f64::from(v); let err=self.screen_radius(s,v);
        Ok(Some(((v-err).max(0.),(v+err).min(1.))))
    }
    pub(super) fn screen_mask(&mut self,s:usize,u:Units)->Result<u8> {
        if self.screen.is_none() {return Ok(7);}
        let mut lower=[f64::INFINITY;3]; let mut best=f64::INFINITY;
        for k in 0..3 {if u[k]!=0 {
            let Some(v)=self.screen_action(s,u,k)? else {return Ok(7)};
            let err=self.screen_radius(s,v);
            lower[k]=v-err; best=best.min(v+err);
        }}
        // Do not change a baseline fused rounding/refinement decision near a
        // P tie: its binary64 success envelopes are much narrower than this
        // extra separation (even for the maximum graph depth of 600).
        Ok((0..3).fold(0,|mask,k|mask|(u8::from(lower[k]<=best+1e-9)<<k)))
    }
}
