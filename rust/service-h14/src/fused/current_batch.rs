//! The published Current owns the normal path. At its i-th great leaf only
//! i+1 kits have been spent. Parent caps dominate all positive child caps
//! plus the consumed kit, so subtracting from canonical root units is exact.
use super::*;

impl Solver {
    pub(super) fn batch_regret(&mut self, e: &mut Engine, batch: &minimum_wait::Batch, units: Units, threshold_ticks: usize) -> Result<([f64; 2], Option<bool>)> {
        let (root, units) = self.root(e, units)?;
        let k = batch.kit;
        if batch.uses() == 0 || units[k] < batch.uses() { return Err("batch_regret_infeasible"); }
        let bounds = |s: &Solver, c: Cell| {
            let exact = c.tag & (ONE | ZERO) != 0;
            [s.errors.lo(c.v[0], exact), s.errors.hi(c.v[0], exact).min(1.)]
        };
        let mut tail = [0.; 2];
        for (i, &(_, [p, g, n])) in batch.path.iter().enumerate().rev() {
            let mut rest = units;
            rest[k] -= i + 1;
            let great = self.visit(e, g, rest)?;
            let a = bounds(self, great);
            if p == 1000 { tail = a; continue; }
            if i + 1 == batch.uses() {
                let normal = self.visit(e, n, rest)?;
                tail = bounds(self, normal);
            }
            tail = [down(down(down(p as f64*a[0]) + down((1000-p) as f64*tail[0]))/1000.).max(0.),
                    up(up(up(p as f64*a[1]) + up((1000-p) as f64*tail[1]))/1000.).min(1.)];
        }
        let v = bounds(self, root);
        let r = [down(v[0]-tail[1]).max(0.), up(v[1]-tail[0]).min(1.)];
        if r[0] > r[1] { return Err("batch_regret_inconsistent"); }
        let h = threshold_ticks as f64 / 10_000.;
        if r[0] > up(h) { return Ok((r,Some(true))); }
        if r[1] < down(h) { return Ok((r,Some(false))); }
        // Optional exact refinement may be refused. The original interval still
        // certifies the mean, but this atom contributes only to possible mass.
        #[cfg(target_arch = "wasm32")]
        let previously_denied = allocation::certified_allocation_denied();
        let result: Result<_> = (|| {
            self.thresholds += 1;
            let v = self.exact_selected(e,self.sid,units)?;
            let wait = rational(&v.p,&e.powers[v.exponent]);
            let mut forced = Q::zero();
            for (i, &(_, [p, g, n])) in batch.path.iter().enumerate().rev() {
                let mut rest=units;
                rest[k]-=i+1;
                let great=self.exact_selected(e,g,rest)?;
                let great=rational(&great.p,&e.powers[great.exponent]);
                if p==1000 {forced=great;continue;}
                if i+1==batch.uses(){
                    let normal=self.exact_selected(e,n,rest)?;
                    forced=rational(&normal.p,&e.powers[normal.exponent]);
                }
                let prob=Q::new(p.into(),1000.into());
                forced=&prob*great+(Q::one()-prob)*forced;
            }
            let exact=wait-forced;
            if exact < Q::zero() || exact > Q::one() { return Err("batch_regret_inconsistent"); }
            let tight = ratio_bounds(&exact.numer().to_biguint().unwrap(), &exact.denom().to_biguint().unwrap())?;
            Ok((tight, Some(exact > Q::new(threshold_ticks.into(),10_000.into()))))
        })();
        match result {
            Err("managed_payload_ceiling" | "exact_memo_limit") => {
                // This refinement was optional. Its handled denial must not
                // label an unrelated trap later in the same native batch.
                let fallback = Ok((r, None));
                #[cfg(target_arch = "wasm32")]
                let fallback = allocation::finish_fallible_retry(previously_denied, fallback);
                fallback
            }
            other => other,
        }
    }
}

#[no_mangle] pub extern "C" fn certified_current_batch_version() -> u32 { 2 }
#[no_mangle] pub unsafe extern "C" fn certified_current_batch_rows(count: usize, day: usize, kit: usize, uses: usize, threshold_ticks: usize) -> u32 {
    failure((|| {
        if !(1..=BATCH).contains(&count) || !(1..=14).contains(&day) || !(50..=400).contains(&threshold_ticks) || INPUT.len()!=12*count { return Err("batch_regret_input"); }
        let s = SOLVER.as_mut().ok_or("fused_not_initialized")?;
        let e = ENGINE.as_mut().ok_or("wasm_not_initialized")?;
        if !e.current_request.is_some_and(|(sid,stock,limit)| sid==s.sid && kit<3 && uses>0 && uses<=limit && uses<=stock[kit]/10) { return Err("batch_regret_current_binding"); }
        // Temporarily move (never clone) the request-owned path while visiting the Engine.
        let batch = e.current_choice.take().ok_or("batch_regret_missing_current")?;
        let result = (|| {
            if batch.kit!=kit || batch.uses()!=uses || batch.path[0].0!=s.sid { return Err("batch_regret_current_binding"); }
            if let Some(reason)=batch.guard { return Err(reason); }
            let mut out = Vec::with_capacity(24+20*count);
            for n in [2,count,day,kit,uses,threshold_ticks] { out.extend_from_slice(&(n as u32).to_le_bytes()); }
            for row in INPUT.chunks_exact(12) {
                let u = std::array::from_fn(|k| u32::from_le_bytes(row[4*k..4*k+4].try_into().unwrap()) as usize);
                let (r, pass) = s.batch_regret(e,&batch,u,threshold_ticks)?;
                for v in r {out.extend_from_slice(&v.to_le_bytes());}
                out.extend_from_slice(&pass.map_or(2,u32::from).to_le_bytes());
            }
            Ok(out)
        })();
        e.current_choice = Some(batch);
        OUTPUT = result?;
        Ok(())
    })())
}
