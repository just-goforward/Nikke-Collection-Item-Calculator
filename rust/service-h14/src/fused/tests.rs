use super::*;
use num_traits::Signed;

#[test]
fn allocation_pressure_retires_only_reusable_exact_memo_once() {
    let mut e=engine([Q::one(),Q::one(),Q::one()]);
    e.memo.insert((570,[1,0,0]),Value::zero());
    let primary=e.primary.len();
    let transitions=e.transitions;
    let attempts=std::cell::Cell::new(0);
    Solver::admit_reusable(&mut e,4096,|bytes|{
        assert_eq!(bytes,4096);
        attempts.set(attempts.get()+1);
        attempts.get()==2
    }).unwrap();
    assert_eq!(attempts.get(),2);
    assert_eq!(e.memo.capacity(),0);
    assert_eq!(e.primary.len(),primary);
    assert_eq!(e.transitions,transitions);
    assert_eq!(Solver::admit_reusable(&mut e,4096,|_|false),Err("managed_payload_ceiling"));
}
fn fraction(n:i64,d:i64)->Q {Q::new(n.into(),d.into())}
fn float_q(v:f64)->Q {
    assert!(v.is_finite());
    if v==0. {return Q::zero();}
    let bits=v.to_bits();let exponent=((bits>>52)&2047) as i32;
    let mantissa=(bits&((1u64<<52)-1))|if exponent==0{0}else{1u64<<52};
    let shift=if exponent==0{-1074}else{exponent-1075};
    let n=BigInt::from(mantissa)*if bits>>63==0{1}else{-1};
    if shift>=0{Q::from_integer(n<<shift as usize)}else{Q::new(n,BigInt::one()<<(-shift) as usize)}
}
// Exact distances to the two adjacent binary64 values characterize nearest-even
// independently of the quotient, remainder, exponent and carry in ratio().
fn assert_nearest(v:f64, exact:&Q) -> Ordering {
    assert!(v.is_finite() && !v.is_sign_negative());
    let rounded=float_q(v);
    let distance=(&rounded-exact).abs();
    let bits=v.to_bits();
    for neighbor in [bits.checked_sub(1),Some(bits+1)].into_iter().flatten() {
        let adj=f64::from_bits(neighbor);
        if adj.is_finite() {
            let other=(float_q(adj)-exact).abs();
            assert!(distance<other || (distance==other && bits&1==0),
                "not nearest-even: {bits:x} vs {neighbor:x} for {exact}");
        }
    }
    rounded.cmp(exact)
}

fn check_ratio(n:&BigUint,d:&BigUint,expected_bits:u64) {
    let exact=Q::new(n.clone().into(),d.clone().into());
    let (v,ordering)=ratio(n,d).unwrap();
    assert_eq!((v.to_bits(),ordering),(expected_bits,assert_nearest(v,&exact)));
    let safe=exact.is_integer() && exact<=Q::from_integer(BigInt::from((1u64<<53)-1));
    assert_eq!(exact_integer(v,ordering),safe);
    assert_eq!((n%d).is_zero() && v<=SAFE,safe);
}
fn engine(prices:[Q;3])->Engine {
    // Canonical SR10..SR15 graph; irrelevant earlier states terminate directly.
    // Caps are derived from the graph, not copied from solver state keys.
    let mut edges=vec![[[1000,600,600];3];601];
    let rates=[[12,22,31,47,100],[54,99,144,216,450],[150,275,400,600,1000]];
    for s in 450..600 {
        let level=(s-150)/30;let exp=(s-150)%30;
        for k in 0..3 {
            let normal=(s+[2,5,10][k]).min(600);
            edges[s][k]=[rates[k][level-10],600,normal];
            assert!(exp<30);
        }
    }
    let mut caps=vec![[0;3];601];
    for s in (0..600).rev(){for k in 0..3{let [p,g,n]=edges[s][k];for (mass,t) in [(p,g),(1000-p,n)]{if mass>0{for j in 0..3{caps[s][j]=caps[s][j].max(caps[t][j]+usize::from(k==j));}}}}}
    Engine::new(Init{edges,caps,weights:prices.each_ref().map(wire),deadline_at:f64::MAX,max_memo_entries:250000,max_support_points:25000}).unwrap()
}
#[test]
fn guarded_current_refuses_before_publishing_a_shorter_exact_batch() {
    let mut e=engine([fraction(1,1),fraction(100,1),fraction(100,1)]);
    e.max_memo=1;
    // The true base root fits. Its normal child returned a relaxed lift
    // (root=false), so constructing the second exact use needs another slot.
    let root=e.get(596,[4,0,0],true).unwrap();
    assert_eq!(root.mask,1); assert_eq!(e.memo.len(),1);
    assert_eq!(e.current(596,[40,0,0],10),Err("exact_memo_limit"));
    assert!(e.current_request.is_none() && e.current_root.is_none() && e.current_choice.is_none());
    e.max_memo=250_000;
    let current=e.current(596,[40,0,0],10).unwrap();
    assert_eq!(current["kit"],"blue"); assert_eq!(current["uses"],2);
}

#[test]
fn cancelled_exact_price_order_matches_full_dots() {
    let mut e=engine(std::array::from_fn(|_| Q::one()));
    let shared=BigUint::one()<<700usize;
    for prices in [[0u32,0,0],[0,1,2],[2,2,2],[7,3,1]] {
        e.prices=prices.map(|p|BigUint::from(p)*(&shared+1u32));
        let values:Vec<_>=(0..27).map(|n:u32| Value {
            p:BigUint::one(), c:std::array::from_fn(|k| &shared+(n/3u32.pow(k as u32))%3),
            exponent:1, mask:1,
        }).collect();
        for a in &values { for b in &values {
            let expected=e.burden(b).cmp(&e.burden(a)).then_with(||Engine::total(b).cmp(&Engine::total(a)));
            assert_eq!(e.compare(a,b),expected);
        }}
    }
}
#[derive(Clone)]struct Oracle{p:Q,c:[Q;3],mask:u8}
/// Independent BigRational Bellman enumeration. No Engine get/combine, packed
/// cache, caps, minimum-use, relaxed/certain shortcuts or production comparison.
fn oracle(edges:&[[Edge;3]],prices:&[Q;3],s:usize,u:Units,memo:&mut HashMap<(usize,Units),Oracle>)->Oracle {
    if let Some(v)=memo.get(&(s,u)){return v.clone();}
    let mut best=Oracle{p:if s==600{Q::one()}else{Q::zero()},c:std::array::from_fn(|_|Q::zero()),mask:0};
    if s==600{return best;}
    for k in 0..3 {
        if u[k]==0{continue;}let mut rest=u;rest[k]-=1;let [m,g,n]=edges[s][k];
        let a=oracle(edges,prices,g,rest,memo);let b=oracle(edges,prices,n,rest,memo);
        let pg=fraction(m as i64,1000);let pn=Q::one()-&pg;
        let candidate=Oracle{p:&pg*a.p+&pn*b.p,c:std::array::from_fn(|j|&pg*&a.c[j]+&pn*&b.c[j]+fraction(if j==k{10}else{0},1)),mask:1<<k};
        let burden=|v:&Oracle|->Q{(0..3).map(|j|&v.c[j]*&prices[j]).sum()};
        let total=|v:&Oracle|->Q{v.c.iter().cloned().sum()};
        match candidate.p.cmp(&best.p).then_with(||burden(&best).cmp(&burden(&candidate))).then_with(||total(&best).cmp(&total(&candidate))) {
            Ordering::Greater=>best=candidate,Ordering::Equal=>best.mask|=candidate.mask,_=>{}
        }
    }
    memo.insert((s,u),best.clone());best
}
fn enclosed(s:&Solver,c:Cell,exact:&Oracle) {
    assert_eq!(c.mask,exact.mask);
    for k in 0..4 {
        let tag=if k==0{c.tag&(ZERO|ONE)!=0}else{c.tag&(8<<(k-1))!=0};
        let q=if k==0{&exact.p}else{&exact.c[k-1]};
        assert!(float_q(s.errors.lo(c.v[k],tag))<=*q,"lower {k}");
        assert!(float_q(s.errors.hi(c.v[k],tag))>=*q,"upper {k}");
    }
}
#[test]
fn fused_independent_finite_masks_and_canonical_vectors() {
    for prices in [[fraction(1,1),fraction(1,1),fraction(1,1)], [fraction(1,3),fraction(1,7),fraction(1,11)],
        [Q::from_integer(BigInt::one()<<100),Q::from_integer((BigInt::one()<<100)+1),Q::zero()]] {
        let mut e=engine(prices.clone());let mut reference=HashMap::new();
        for sid in [450,570,595,598,599,600] {
            let mut s=Solver::new(&e,sid,[3;3]).unwrap();
            for b in 0..=3 {for p in 0..=2 {for y in 0..=2 {
                let u=[b,p,y];let exact=oracle(&e.edges,&prices,sid,u,&mut reference);
                let (actual,_)=s.root(&mut e,u).unwrap();enclosed(&s,actual,&exact);
                let value=e.get(sid,u,true).unwrap();
                let cell=Solver::exact_cell(&e,&value).unwrap();
                assert_eq!(cell.mask,exact.mask);
                let mut tag=READY|EXACT;
                if exact.p.is_zero(){tag|=ZERO;} if exact.p.is_one(){tag|=ONE;}
                assert_nearest(cell.v[0],&exact.p);
                for (k,q) in exact.c.iter().enumerate() {
                    assert_nearest(cell.v[k+1],q);
                    if q.is_integer() && q<=&Q::from_integer(BigInt::from((1u64<<53)-1)){tag|=8<<k;}
                }
                assert_eq!(cell.tag,tag);
            }}}
        }
    }
}
#[test]
fn scalar_failure_screen_encloses_exact_probabilities_and_preserves_endpoint_bytes() {
    let prices=[fraction(1,3),fraction(1,7),fraction(1,11)];
    let mut screened=engine(prices.clone()); let mut baseline=engine(prices.clone());
    screened.start_screen(450,[15,12,8]);
    assert!(screened.screen.is_some());
    let mut oracle_cache=HashMap::new();
    let mut excluded=false;
    for sid in [450,480,508,540,570,594,599] {
        let mut a=Solver::new(&screened,sid,[4;3]).unwrap();
        let mut b=Solver::new(&baseline,sid,[4;3]).unwrap();
        for blue in 0..=4 {for purple in 0..=3 {for yellow in 0..=2 {
            let u=[blue,purple,yellow];
            let value=oracle(&screened.edges,&prices,sid,u,&mut oracle_cache);
            let f=Q::one()-&value.p;
            let (lo,hi)=screened.screen_bounds(sid,u).unwrap().unwrap();
            assert!(float_q(lo)<=f && f<=float_q(hi));
            let canonical=std::array::from_fn(|k|u[k].min(screened.caps[sid][k]));
            let candidates=screened.screen_mask(sid,canonical).unwrap();
            assert_eq!(value.mask & !candidates,0);
            excluded|=(0..3).any(|k|canonical[k]!=0 && candidates&(1<<k)==0);
            assert_eq!(records(&a.batch(&mut screened,&[u],0).unwrap()),
                records(&b.batch(&mut baseline,&[u],0).unwrap()));
        }}}
    }
    assert!(excluded);
}

#[test]
fn fused_integer_price_near_tie_and_final_mask() {
    let huge=BigInt::one()<<100;
    let mut e=engine([Q::from_integer(&huge+1),Q::from_integer(huge),Q::zero()]);
    let mut s=Solver::new(&e,598,[1,1,0]).unwrap();
    let (v,_)=s.root(&mut e,[1,1,0]).unwrap();assert_eq!(v.mask,2);assert_eq!(v.v,[1.,0.,10.,0.]);
    let mut e=engine([Q::one(),Q::one(),Q::one()]);let mut s=Solver::new(&e,598,[1;3]).unwrap();
    let (v,_)=s.root(&mut e,[1;3]).unwrap();assert_eq!(v.mask,7);assert_eq!(v.v,[1.,10.,0.,0.]);
}
#[test]
fn current_batch_strict_equality_excludes_the_atom() {
    let base=engine([Q::one(),Q::one(),Q::one()]);
    let mut edges=base.edges;
    edges[570][0][0]=500; edges[570][1][0]=500;
    edges[572][1][0]=500; edges[575][0][0]=520;
    let mut e=Engine::new(Init{edges,caps:base.caps,weights:std::array::from_fn(|_|wire(&Q::one())),deadline_at:f64::MAX,max_memo_entries:250000,max_support_points:25000}).unwrap();
    e.current(570,[10,0,0],1).unwrap();
    let batch=e.current_choice.take().unwrap();
    let mut solver=Solver::new(&e,570,[1,1,0]).unwrap();
    // V=.5+.5*.52, Q=.5+.5*.50. 100 ticks is exactly 1/100.
    for (ticks,above) in [(50,true),(99,true),(100,false),(101,false),(400,false)] {
        let (r,actual)=solver.batch_regret(&mut e,&batch,[1,1,0],ticks).unwrap();
        assert_eq!(actual,Some(above));
        assert!(float_q(r[0])<=fraction(1,100)&&float_q(r[1])>=fraction(1,100));
    }
    assert!(solver.thresholds>0);
}
#[test]
fn fused_exact_threshold_equality_and_interior_refinement() {
    let prices=[fraction(1,3),fraction(1,7),fraction(1,11)];let mut e=engine(prices.clone());
    let mut s=Solver::new(&e,570,[1,1,0]).unwrap();let (c,u)=s.root(&mut e,[1,1,0]).unwrap();
    let exact=oracle(&e.edges,&prices,570,u,&mut HashMap::new());enclosed(&s,c,&exact);
    assert!(s.refinements>0);assert!(s.objective(&e,c,u).unwrap().is_some());
    let epsilon=Q::new(BigInt::one(),BigInt::from(10).pow(100));
    assert_eq!(s.threshold(&mut e,u,exact.p.clone()).unwrap(),Ordering::Equal);
    assert_eq!(s.threshold(&mut e,u,&exact.p+&epsilon).unwrap(),Ordering::Less);
    assert_eq!(s.threshold(&mut e,u,&exact.p-&epsilon).unwrap(),Ordering::Greater);
    assert_eq!(s.thresholds,3);
}
#[test]
fn fused_correctly_rounded_ratios_ties_even_subnormals_and_large_limbs() {
    let one=BigUint::one();
    let pow=|n:usize| &one<<n;
    let unit=1f64.to_bits();
    let normal=f64::MIN_POSITIVE.to_bits();
    let max=f64::MAX.to_bits();
    let overflow=pow(1024)-pow(970); // halfway from MAX to 2^1024
    for (n,d,bits) in [
        (BigUint::zero(),one.clone(),0),(one.clone(),one.clone(),unit),
        (pow(53)-1u8,one.clone(),SAFE.to_bits()),
        (pow(53),one.clone(),SAFE.to_bits()+1),
        (pow(53)-1u8,pow(53),unit-1), // previous representable
        (pow(54)-1u8,pow(54),unit),   // midpoint below 1, carry into exponent
        (pow(53)+1u8,pow(53),unit),   // midpoint above 1
        (pow(52)+1u8,pow(52),unit+1), // next representable
        (pow(53)+3u8,pow(53),unit+2),
        (one.clone(),pow(1075),0),(BigUint::from(3u8),pow(1075),2),
        (pow(52)-1u8,pow(1074),normal-1),
        (pow(53)-1u8,pow(1075),normal),
        (one.clone(),pow(1022),normal),
        (pow(53)+1u8,pow(1075),normal),
        (pow(52)+1u8,pow(1074),normal+1),
        (pow(1024)-pow(971),one.clone(),max),
        (&overflow-1u8,one.clone(),max),
    ] {check_ratio(&n,&d,bits);}
    for n in [BigUint::zero(),one.clone()] {
        assert_eq!(ratio(&n,&BigUint::zero()),Err("fused_zero_denominator"));
    }
    for n in [overflow,pow(1024)] { // overflow by rounding, or by initial exponent
        assert_eq!(ratio(&n,&one),Err("fused_nonfinite_ratio"));
    }
    // Small operands are exactly representable; the unreduced operands are not.
    let scale=pow(4000);
    for n in 1..80u32 {for d in 1..80u32 {
        check_ratio(&(&scale*n),&(&scale*d),(f64::from(n)/f64::from(d)).to_bits());
    }}
}

#[test]
fn exact_cell_tags_distinguish_integers_from_fractions_rounded_to_integers() {
    let e=engine([Q::one(),Q::one(),Q::one()]);
    let exponent=6; // 1000^6: both 1 ± 1/d round to 1
    let d=&e.powers[exponent];
    let safe=(1u64<<53)-1;
    for (p,c,bits,int_mask,prob_tag) in [
        (d-1u8,[d-1u8,d.clone(),d+1u8],[1f64.to_bits();3],16,0),
        (d.clone(),[d*safe,d*(safe+1),BigUint::zero()],
            [SAFE.to_bits(),SAFE.to_bits()+1,0],8|32,ONE),
        (BigUint::zero(),[d/2u8,d*safe-1u8,d*safe+1u8],
            [0.5f64.to_bits(),SAFE.to_bits(),SAFE.to_bits()],0,ZERO),
    ] {
        let v=Value{p,c,exponent,mask:5};
        let cell=Solver::exact_cell(&e,&v).unwrap();
        assert_eq!((cell.tag,cell.mask),(READY|EXACT|int_mask|prob_tag,v.mask));
        for k in 0..3 {
            check_ratio(&v.c[k],d,bits[k]);
            assert_eq!(cell.v[k+1].to_bits(),bits[k]);
            assert_eq!(cell.tag&(8<<k)!=0,(&v.c[k]%d).is_zero() && cell.v[k+1]<=SAFE);
        }
    }
}
#[test]
fn fused_positive_rounding_enclosures_cover_underflow_and_depth() {
    for depth in [0,1,64,600] {let errors=Errors::new(depth);
        for v in [0.,f64::from_bits(1),f64::from_bits(13),f64::MIN_POSITIVE,0.1,1.,6000.] {
            let exact=float_q(v);
            assert!(float_q(errors.lo(v,false))<=exact);assert!(float_q(errors.hi(v,false))>=exact);
            assert_eq!(errors.lo(v,true),v);assert_eq!(errors.hi(v,true),v);
        }
    }
    let errors=Errors::new(600);let mut value=f64::MIN_POSITIVE;let mut exact=float_q(value);
    for _ in 0..600 {value=(1.*value+999.*0.)/1000.;exact/=BigInt::from(1000);}
    assert!(float_q(errors.lo(value,false))<=exact&&float_q(errors.hi(value,false))>=exact);
}
fn records(bytes:&[u8])->Vec<Vec<u8>> {
    let count=u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize;
    (0..count).map(|i|bytes[8+i*104..8+(i+1)*104].to_vec()).collect()
}
#[test]
fn fused_batch_partition_order_limits_and_failure_atomicity() {
    let mut e=engine([Q::one(),Q::one(),Q::one()]);let mut s=Solver::new(&e,570,[3;3]).unwrap();
    let units:Vec<Units>=(0..32).map(|i|[i%4,(i/4)%4,(i/16)%2]).collect();
    let all=records(&s.batch(&mut e,&units,1).unwrap());let mut partition=Vec::new();
    for chunk in units.chunks(3){partition.extend(records(&s.batch(&mut e,chunk,1).unwrap()));}
    assert_eq!(all,partition);
    let reversed:Vec<Units>=units.iter().rev().copied().collect();let mut back=records(&s.batch(&mut e,&reversed,1).unwrap());back.reverse();assert_eq!(all,back);
    assert_eq!(s.batch(&mut e,&[],1).unwrap_err(),"fused_batch_limit");
    assert_eq!(s.batch(&mut e,&[[0;3];33],1).unwrap_err(),"fused_batch_limit");
    assert_eq!(s.root(&mut e,[4,0,0]).err(),Some("fused_units_outside_domain"));
    let states=s.states;e.deadline=-1.;assert_eq!(s.batch(&mut e,&units,1).unwrap_err(),"request_budget_exhausted");assert_eq!(s.states,states);
}
#[test]
fn fused_shared_exact_memo_is_reused_and_bounded_eviction_preserves_values() {
    let mut e=engine([Q::one(),Q::one(),Q::one()]);let exact=e.get(570,[1,1,0],true).unwrap();
    let count=e.memo.len();let mut s=Solver::new(&e,570,[1,1,0]).unwrap();let (v,_)=s.root(&mut e,[1,1,0]).unwrap();
    assert_eq!(v.mask,exact.mask);assert_eq!(e.memo.len(),count);
    let mut e=engine([Q::one(),Q::one(),Q::one()]);e.max_memo=1;let mut s=Solver::new(&e,570,[2,2,0]).unwrap();
    let (cell,u)=s.root(&mut e,[2,2,0]).unwrap();
    let expected=oracle(&e.edges,&[Q::one(),Q::one(),Q::one()],570,u,&mut HashMap::new());
    enclosed(&s,cell,&expected);
    assert!(e.memo.len()+e.primary.len()<=1);
    let exact=s.exact_selected(&mut e,570,u).unwrap();
    assert_eq!(rational(&exact.p,&e.powers[exact.exponent]),expected.p);
    for k in 0..3 {assert_eq!(rational(&exact.c[k],&e.powers[exact.exponent]),expected.c[k]);}
    assert!(e.memo.len()+e.primary.len()<=1);
}
#[test]
fn fused_exact_policy_reconstruction_survives_eviction_and_keeps_cumulative_work() {
    let prices=[fraction(1,3),fraction(1,7),fraction(1,11)];
    let mut e=engine(prices.clone());e.max_memo=2;
    let mut s=Solver::new(&e,570,[2,2,1]).unwrap();
    let mut reference=HashMap::new();
    let mut transitions=0;
    for b in 0..=2 {for p in 0..=2 {for y in 0..=1 {
        let u=[b,p,y];
        let expected=oracle(&e.edges,&prices,570,u,&mut reference);
        let (cell,_)=s.root(&mut e,u).unwrap();enclosed(&s,cell,&expected);
        e.memo.clear();
        let actual=s.exact_selected(&mut e,570,u).unwrap();
        assert_eq!(actual.mask,expected.mask);
        assert_eq!(rational(&actual.p,&e.powers[actual.exponent]),expected.p);
        for k in 0..3 {assert_eq!(rational(&actual.c[k],&e.powers[actual.exponent]),expected.c[k]);}
        assert!(e.memo.len()+e.primary.len()<=2);
        assert!(e.transitions>=transitions);transitions=e.transitions;
    }}}
    assert!(transitions>0);
}
#[test]
fn fused_abi_single_owner_release_and_reinitialize() {
    unsafe {
        certified_release();ENGINE=Some(engine([Q::one(),Q::one(),Q::one()]));
        assert_eq!(certified_fused_version(),3);assert_eq!(certified_fused_init(598,1,1,1),0);assert_eq!(certified_fused_init(598,1,1,1),1);
        INPUT=[1u32,0,0].iter().flat_map(|v|v.to_le_bytes()).collect();assert_eq!(certified_fused_batch(1,1),0);
        assert_eq!(records(&OUTPUT).len(),1);
        let transitions=ENGINE.as_ref().unwrap().transitions;
        certified_fused_clear();
        assert!(SOLVER.is_none()&&ENGINE.is_some());
        assert_eq!(ENGINE.as_ref().unwrap().transitions,transitions);
        assert_eq!(certified_fused_init(598,1,1,1),0);
        certified_release();assert!(SOLVER.is_none()&&ENGINE.is_none()&&INPUT.is_empty()&&OUTPUT.is_empty());
        assert_eq!(certified_fused_batch(1,1),1);certified_release();
        ENGINE=Some(engine([Q::one(),Q::one(),Q::one()]));assert_eq!(certified_fused_init(598,0,0,0),0);assert_eq!(SOLVER.as_ref().unwrap().states,0);certified_release();
    }
}

#[test]
fn required_root_evidence_covers_noninteger_saturation_without_changing_ordinary_work() {
    let prices=[fraction(1,3),fraction(1,7),fraction(1,11)];
    let mut e=engine(prices.clone());
    let mut s=Solver::new(&e,570,[15,0,0]).unwrap();
    let units=[15,0,0];
    let optional=s.batch(&mut e,&[units],1).unwrap();
    let tail:Json=serde_json::from_slice(&optional[112..]).unwrap();
    assert!(tail["objectives"][0].is_null());
    assert_eq!(s.refinements,0);
    assert!(e.memo.is_empty());
    let required=s.batch(&mut e,&[units],2).unwrap();
    let tail:Json=serde_json::from_slice(&required[112..]).unwrap();
    let expected=oracle(&e.edges,&prices,570,units,&mut HashMap::new());
    let actual=&tail["objectives"][0];
    assert_eq!(actual["p"],json!(wire(&expected.p)));
    assert_eq!(actual["b"],json!(wire(&(0..3).map(|k|&prices[k]*&expected.c[k]).sum::<Q>())));
    assert_eq!(actual["c"],json!(wire(&expected.c.iter().cloned().sum::<Q>())));
    assert_ne!(expected.c[0].denom(),&BigInt::one());
    assert_eq!(s.refinements,1);
    let (cell,_)=s.root(&mut e,units).unwrap();
    enclosed(&s,cell,&expected);
    let states=s.states;let transitions=s.transitions;
    s.batch(&mut e,&[units],2).unwrap();
    assert_eq!((s.states,s.transitions,s.refinements),(states,transitions,1));
    assert_eq!(s.batch(&mut e,&[units],3).unwrap_err(),"fused_batch_input");
}

#[test]
fn required_root_evidence_preserves_exact_cap_under_eviction_and_deadline() {
    let mut e=engine([Q::one(),Q::one(),Q::one()]);
    e.max_memo=1;
    let mut s=Solver::new(&e,570,[15,0,0]).unwrap();
    s.batch(&mut e,&[[15,0,0]],1).unwrap();
    let bytes=s.batch(&mut e,&[[15,0,0]],2).unwrap();
    let tail:Json=serde_json::from_slice(&bytes[112..]).unwrap();
    let expected=oracle(&e.edges,&[Q::one(),Q::one(),Q::one()],570,[15,0,0],&mut HashMap::new());
    assert_eq!(tail["objectives"][0]["p"],json!(wire(&expected.p)));
    assert_eq!(tail["objectives"][0]["c"],json!(wire(&expected.c.iter().cloned().sum::<Q>())));
    e.memo.clear();
    // The fused EXACT flag survives eviction; required evidence must be rebuilt.
    let rebuilt=s.batch(&mut e,&[[15,0,0]],2).unwrap();
    let rebuilt:Json=serde_json::from_slice(&rebuilt[112..]).unwrap();
    assert_eq!(tail["objectives"],rebuilt["objectives"]);
    assert!(e.memo.len()<=1);
    e.deadline=-1.;
    assert_eq!(s.batch(&mut e,&[[15,0,0]],2).unwrap_err(),"request_budget_exhausted");
}

#[test]
fn packed_pages_preserve_sparse_slots_updates_and_capacity_diagnostics() {
    let mut e=engine([Q::one(),Q::one(),Q::one()]);
    let mut s=Solver::new(&e,450,[1,1,15]).unwrap();
    let mut expected=[Cell::default();PAGE_SLOTS];let mut occupied=0u64;
    for slot in (0..PAGE_SLOTS).map(|i|(i*17+PAGE_SLOTS-1)%PAGE_SLOTS) {
        let c=Cell{v:std::array::from_fn(|k|(slot*4+k) as f64),tag:EXACT|((slot as u8)&INTS),mask:(slot%8) as u8};
        s.store(&mut e,slot,c).unwrap();
        expected[slot]=Cell{tag:c.tag|READY,..c};occupied|=1<<slot;
        let p=&s.pages[&0];
        assert_eq!(p.occupied,occupied);
        assert_eq!(p.cells.len(),occupied.count_ones() as usize);
        assert!(p.cells.capacity()>=p.cells.len()&&p.cells.capacity()<=PAGE_SLOTS);
        assert_eq!(p.cells.capacity(),p.cells.len().div_ceil(CELL_GROWTH)*CELL_GROWTH);
        assert_eq!(s.states,p.cells.len());
        assert_eq!(s.page_bytes(),std::mem::size_of::<Page>()+p.cells.capacity()*std::mem::size_of::<StoredCell>());
        for i in 0..PAGE_SLOTS {
            match p.get(i) {
                Some(actual)=>{
                    assert_ne!(occupied&(1<<i),0);
                    assert_eq!(actual.v,expected[i].v);
                    assert_eq!((actual.tag,actual.mask),(expected[i].tag,expected[i].mask));
                }
                None=>assert_eq!(occupied&(1<<i),0),
            }
        }
    }
    let bytes=s.page_bytes();let capacity=s.pages.capacity();
    let replacement=Cell{v:[1.,30.,20.,10.],tag:READY|EXACT|ONE|INTS,mask:7};
    s.store(&mut e,9,replacement).unwrap();
    assert_eq!(s.states,PAGE_SLOTS);assert_eq!(s.page_bytes(),bytes);assert_eq!(s.pages.capacity(),capacity);
    expected[9]=replacement;
    // A neighboring page cannot corrupt the full page or count its slots twice.
    s.store(&mut e,PAGE_SLOTS,replacement).unwrap();
    assert_eq!(s.states,PAGE_SLOTS+1);assert_eq!(s.pages.len(),2);
    assert_eq!(s.pages.capacity(),capacity);
    for (i,want) in expected.iter().enumerate() {
        let actual=s.pages[&0].get(i).unwrap();
        assert_eq!(actual.v,want.v);assert_eq!((actual.tag,actual.mask),(want.tag,want.mask));
    }
    assert_eq!(s.page_bytes(),2*std::mem::size_of::<Page>()+
        s.pages.values().map(|p|p.cells.capacity()*std::mem::size_of::<StoredCell>()).sum::<usize>());
}

#[test]
fn packed_page_admits_full_new_buffer_and_keeps_old_cells_on_refusal() {
    let mut e=engine([Q::one(),Q::one(),Q::one()]);
    let mut p=Page::new();let bytes=std::mem::size_of::<StoredCell>();
    let last=PAGE_SLOTS-1;
    let c=Cell{v:[0.5,10.,20.,30.],tag:READY|EXACT,mask:5};
    p.store(&mut e,last,c,|_,requested|{assert_eq!(requested,CELL_GROWTH*bytes);Ok(())}).unwrap();
    for slot in [2,9,0] {p.store(&mut e,slot,c,|_,_|panic!("spare capacity allocated")).unwrap();}
    let capacity=p.cells.capacity();assert_eq!(capacity,CELL_GROWTH);
    let old_occupied=p.occupied;
    let primary=e.primary.len();let transitions=e.transitions;
    let peak=(capacity+2*CELL_GROWTH)*bytes;
    // One byte below the old+new peak must refuse, not admit just the delta.
    assert_eq!(p.store(&mut e,42,c,|e,requested|{
        assert_eq!(requested,2*CELL_GROWTH*bytes);
        Solver::admit_reusable(e,requested,|n|capacity*bytes+n<peak)
    }),Err("managed_payload_ceiling"));
    assert_eq!(p.occupied,old_occupied);assert_eq!(p.cells.capacity(),capacity);
    assert!(p.get(42).is_none());assert_eq!(p.get(last).unwrap().v,c.v);
    assert_eq!((e.primary.len(),e.transitions),(primary,transitions));
    // Updates never ask for headroom, even when the buffer is full.
    assert!(!p.store(&mut e,last,Cell{mask:7,..c},|_,_|panic!("update allocated")).unwrap());
    assert_eq!(p.get(2).unwrap().mask,5);assert_eq!(p.get(last).unwrap().mask,7);
    assert!(p.store(&mut e,42,c,|e,requested|{
        Solver::admit_reusable(e,requested,|n|capacity*bytes+n<=peak)
    }).unwrap());
    for slot in [1,3,4] {p.store(&mut e,slot,c,|_,_|panic!("spare capacity allocated")).unwrap();}
    p.store(&mut e,7,c,|_,requested|{assert_eq!(requested,3*CELL_GROWTH*bytes);Ok(())}).unwrap();
    assert_eq!(p.occupied,old_occupied|(1<<42)|(1<<1)|(1<<3)|(1<<4)|(1<<7));
}

#[test]
fn packed_sparse_to_dense_batches_match_independent_exact_oracle() {
    let prices=[fraction(1,3),fraction(1,7),fraction(1,11)];
    let mut e=engine(prices.clone());let mut s=Solver::new(&e,450,[2,2,15]).unwrap();
    // Engine caps shorten the yellow axis (SR14 yellow succeeds certainly).
    // Select a full interior page in the actual capped root domain, then
    // decode its keys instead of assuming an uncapped axis or fixed page size.
    let start=s.key(450,[0;3]);let base=(start/PAGE_SLOTS+1)*PAGE_SLOTS;
    assert_eq!(base%PAGE_SLOTS,0);
    assert!(base+PAGE_SLOTS-1<=s.key(450,s.max));
    let mut reference=HashMap::new();let mut saved:Vec<(Units,Vec<u8>)>=Vec::new();
    let mut occupied=0u64;
    for slot in (0..PAGE_SLOTS).map(|i|(i*17+PAGE_SLOTS-1)%PAGE_SLOTS) {
        let offset=base+slot-start;let [py,y]=s.strides[450];
        let u=[offset/py,(offset%py)/y,offset%y];
        assert!((0..3).all(|k|u[k]<=s.max[k]));
        assert_eq!(s.key(450,u),base+slot);
        // Ordinary evaluation inserts the sparse slot; required evidence may
        // update it in place. Both consumer paths must preserve its neighbors.
        s.batch(&mut e,&[u],0).unwrap();
        let bytes=s.batch(&mut e,&[u],2).unwrap();
        let record=records(&bytes).pop().unwrap();
        let expected=oracle(&e.edges,&prices,450,u,&mut reference);
        for k in 0..4 {
            let q=if k==0{&expected.p}else{&expected.c[k-1]};
            let lower=f64::from_le_bytes(record[k*24+8..k*24+16].try_into().unwrap());
            let upper=f64::from_le_bytes(record[k*24+16..k*24+24].try_into().unwrap());
            assert!(float_q(lower)<=*q&&*q<=float_q(upper));
        }
        assert_eq!(u32::from_le_bytes(record[96..100].try_into().unwrap()),expected.mask as u32);
        let tail:Json=serde_json::from_slice(&bytes[112..]).unwrap();
        assert_eq!(tail["objectives"][0]["p"],json!(wire(&expected.p)));
        assert_eq!(tail["objectives"][0]["b"],json!(wire(&(0..3).map(|k|&prices[k]*&expected.c[k]).sum::<Q>())));
        assert_eq!(tail["objectives"][0]["c"],json!(wire(&expected.c.iter().cloned().sum::<Q>())));
        assert_eq!(tail["stats"]["endpointPageBytes"],json!(s.page_bytes()));
        occupied|=1<<slot;
        assert_eq!(s.pages[&(base>>PAGE_SHIFT)].occupied,occupied);
        saved.push((u,record));
        for (prior,want) in saved.iter().rev() {
            assert_eq!(&records(&s.batch(&mut e,&[*prior],0).unwrap())[0],want);
        }
    }
    assert_eq!(s.pages[&(base>>PAGE_SHIFT)].occupied,u64::MAX);
    assert_eq!(s.pages[&(base>>PAGE_SHIFT)].cells.len(),PAGE_SLOTS);
}

#[test]
fn stored_cells_preserve_float_bits_through_unaligned_growth_and_updates() {
    assert_eq!(std::mem::size_of::<StoredCell>(),34);
    assert_eq!(std::mem::align_of::<StoredCell>(),1);
    let bits=[
        [0,1,0x8000000000000000,0x0010000000000000],
        [0x3ff0000000000000,0x7fefffffffffffff,0x7ff0000000000000,0xfff0000000000000],
        [0x7ff8000000000042,0xfff8000000000017,0x3fefffffffffffff,0x8000000000000001],
    ];
    let mut e=engine([Q::one(),Q::one(),Q::one()]);let mut p=Page::new();
    let mut occupied=0u64;
    for slot in (0..PAGE_SLOTS).map(|i|(i*17+PAGE_SLOTS-1)%PAGE_SLOTS) {
        let c=Cell{v:bits[slot%bits.len()].map(f64::from_bits),tag:(slot as u8)|EXACT,mask:slot as u8};
        p.store(&mut e,slot,c,|_,_|Ok(())).unwrap();occupied|=1<<slot;
        for i in 0..PAGE_SLOTS {
            if occupied&(1<<i)==0 {assert!(p.get(i).is_none());continue;}
            let actual=p.get(i).unwrap();
            assert_eq!(actual.v.map(f64::to_bits),bits[i%bits.len()]);
            assert_eq!((actual.tag,actual.mask),((i as u8)|EXACT|READY,i as u8));
        }
    }
    for slot in 0..PAGE_SLOTS {
        let c=Cell{v:bits[(slot+1)%bits.len()].map(f64::from_bits),tag:u8::MAX,mask:u8::MAX};
        p.store(&mut e,slot,c,|_,_|panic!("update allocated")).unwrap();
        let actual=p.get(slot).unwrap();
        assert_eq!(actual.v.map(f64::to_bits),bits[(slot+1)%bits.len()]);
        assert_eq!((actual.tag,actual.mask),(u8::MAX,u8::MAX));
    }
}

#[test]
fn relaxed_children_keep_canonical_vectors_without_poisoning_root_tie_masks() {
    let prices=[Q::one(),Q::one(),Q::one()];let mut e=engine(prices.clone());
    e.ensure_relaxed(570).unwrap();
    assert_eq!(e.relaxed[599].as_ref().unwrap().value.mask,7);
    assert_eq!(e.relaxed[599].as_ref().unwrap().bound,[1,0,0]);
    let mut s=Solver::new(&e,597,[2,1,1]).unwrap();
    let child=s.visit(&mut e,599,[1,0,0]).unwrap();
    assert_eq!(child.mask,1);assert_eq!(child.v,[1.,10.,0.,0.]);
    assert_eq!(child.tag&(READY|EXACT|ONE|INTS),READY|EXACT|ONE|INTS);
    assert!(s.pages.is_empty()&&e.memo.is_empty());
    let child_exact=s.exact_selected(&mut e,599,[1,0,0]).unwrap();
    assert_eq!(child_exact.mask,1);
    assert!(s.pages.is_empty()&&e.memo.is_empty());
    let mut reference=HashMap::new();
    for u in [[2,0,0],[1,1,0],[2,1,1],[2,0,0]] {
        let expected=oracle(&e.edges,&prices,597,u,&mut reference);
        let (actual,_)=s.root(&mut e,u).unwrap();enclosed(&s,actual,&expected);
    }
    // The same Engine can next serve this child as a root: all feasible tied
    // actions must be rediscovered, not read from the canonical-only cache.
    let mut root=Solver::new(&e,599,[1;3]).unwrap();
    for (u,mask) in [([1,0,0],1),([1,1,0],3),([1,1,1],7),([1,0,1],5),([1,1,1],7)] {
        let expected=oracle(&e.edges,&prices,599,u,&mut reference);
        let bytes=root.batch(&mut e,&[u],2).unwrap();
        assert_eq!(u32::from_le_bytes(bytes[104..108].try_into().unwrap()),mask);
        let (actual,_)=root.root(&mut e,u).unwrap();enclosed(&root,actual,&expected);
        assert!(root.relaxed_cells.is_empty());
    }
}

#[test]
fn relaxed_noninteger_continuation_matches_oracle_and_exact_root_evidence() {
    let prices=[fraction(1,101),fraction(1,3),fraction(1,7)];
    let mut e=engine(prices.clone());e.ensure_relaxed(568).unwrap();
    let bound=e.relaxed[570].as_ref().unwrap().bound;
    assert_eq!(bound,[15,0,0]);
    let expected=oracle(&e.edges,&prices,570,bound,&mut HashMap::new());
    assert_ne!(expected.c[0].denom(),&BigInt::one());
    let mut s=Solver::new(&e,568,[16,1,1]).unwrap();
    let work=e.transitions;
    let c=s.visit(&mut e,570,bound).unwrap();enclosed(&s,c,&expected);
    assert_eq!(c.tag&(ZERO|ONE),ONE);assert_eq!(c.tag&8,0);
    assert_eq!(c.tag&(16|32),16|32);
    let capacity=s.relaxed_cells.capacity();
    let exact=s.exact_selected(&mut e,570,bound).unwrap();
    assert_eq!(exact.mask,expected.mask);
    assert_eq!(rational(&exact.p,&e.powers[exact.exponent]),expected.p);
    for k in 0..3 {assert_eq!(rational(&exact.c[k],&e.powers[exact.exponent]),expected.c[k]);}
    assert_eq!(e.transitions,work);
    assert!(e.memo.is_empty()&&s.pages.is_empty());assert_eq!(s.states,0);
    s.visit(&mut e,570,bound).unwrap();
    assert_eq!(s.relaxed_cells.capacity(),capacity);
    let u=[16,0,0];let expected=oracle(&e.edges,&prices,568,u,&mut HashMap::new());
    let bytes=s.batch(&mut e,&[u],2).unwrap();
    let tail:Json=serde_json::from_slice(&bytes[112..]).unwrap();
    assert_eq!(tail["objectives"][0]["p"],json!(wire(&expected.p)));
    assert_eq!(tail["objectives"][0]["b"],json!(wire(&(0..3).map(|k|&prices[k]*&expected.c[k]).sum::<Q>())));
    assert_eq!(tail["objectives"][0]["c"],json!(wire(&expected.c.iter().cloned().sum::<Q>())));
    let (c,_)=s.root(&mut e,u).unwrap();enclosed(&s,c,&expected);
    assert_eq!(s.states,1);
    assert!(!e.memo.contains_key(&(570,bound)));
    let states=s.states;let work=e.transitions;
    assert_eq!(records(&s.batch(&mut e,&[u],2).unwrap()),records(&bytes));
    assert_eq!((s.states,e.transitions),(states,work));
}

#[test]
fn missing_or_infeasible_relaxed_certificate_keeps_finite_oracle_path() {
    let prices=[fraction(1,101),fraction(1,3),fraction(1,7)];
    for prepared in [false,true] {
        let mut e=engine(prices.clone());
        if prepared {e.ensure_relaxed(568).unwrap();}
        let mut s=Solver::new(&e,568,[2,0,0]).unwrap();
        assert!(!s.relaxed_feasible(&e,570,[1,0,0]));
        for u in [[1,0,0],[2,0,0],[0,0,0],[2,0,0]] {
            let expected=oracle(&e.edges,&prices,568,u,&mut HashMap::new());
            let (c,_)=s.root(&mut e,u).unwrap();enclosed(&s,c,&expected);
        }
        assert!(s.relaxed_cells.is_empty());
        assert!(s.states>1);
    }
}

#[test]
fn relaxed_cell_admission_and_deadline_failures_publish_no_partial_cache() {
    let mut e=engine([fraction(1,101),fraction(1,3),fraction(1,7)]);
    e.ensure_relaxed(568).unwrap();
    let mut s=Solver::new(&e,568,[16,1,1]).unwrap();
    let before=(e.primary.len(),e.memo.len(),e.transitions,s.states,s.page_bytes());
    assert_eq!(s.relaxed_cell(&mut e,570,|_,bytes|{
        assert_eq!(bytes,2*1024*1024+(TERMINAL+1)*std::mem::size_of::<Cell>());
        Err("managed_payload_ceiling")
    }).err(),Some("managed_payload_ceiling"));
    assert_eq!((e.primary.len(),e.memo.len(),e.transitions,s.states,s.page_bytes()),before);
    assert_eq!(s.relaxed_cells.capacity(),0);
    let c=s.relaxed_cell(&mut e,570,Solver::admit).unwrap();
    assert_eq!(s.relaxed_cells.len(),TERMINAL+1);
    assert_eq!(s.relaxed_cells.iter().filter(|c|c.tag&READY!=0).count(),1);
    let reused=s.relaxed_cell(&mut e,570,|_,_|panic!("cached certificate allocated")).unwrap();
    assert_eq!(reused.v,c.v);assert_eq!((reused.tag,reused.mask),(c.tag,c.mask));
    e.deadline=-1.;
    assert_eq!(s.relaxed_cell(&mut e,572,Solver::admit).err(),Some("request_budget_exhausted"));
    assert_eq!(s.relaxed_cells.iter().filter(|c|c.tag&READY!=0).count(),1);
    assert_eq!((e.primary.len(),e.memo.len(),e.transitions,s.states,s.page_bytes()),before);
}

fn action_guard_engine(prices:[Q;3])->Engine {
    let mut edges=vec![[[1000,600,600];3];601];
    // Blue has a positive-probability normal branch needing two more kits.
    // Purple/yellow's equally difficult normal branch has probability zero.
    edges[595]=[[500,600,597],[1000,600,597],[1000,600,597]];
    edges[597]=[[500,600,599];3];
    let mut caps=vec![[0;3];601];
    for s in (0..600).rev(){for k in 0..3{let [p,g,n]=edges[s][k];for (mass,t) in [(p,g),(1000-p,n)]{if mass>0{for j in 0..3{caps[s][j]=caps[s][j].max(caps[t][j]+usize::from(k==j));}}}}}
    Engine::new(Init{edges,caps,weights:prices.each_ref().map(wire),deadline_at:f64::MAX,max_memo_entries:250000,max_support_points:25000}).unwrap()
}

#[test]
fn certain_action_guard_uses_only_positive_branches_in_interval_and_exact_paths() {
    let prices=[fraction(1,101),fraction(1,3),fraction(1,7)];
    for prepared in [false,true] {
        for (u,certain,mask) in [([1,1,0],true,2),([0,1,0],true,2),([1,0,0],false,1)] {
            let mut e=action_guard_engine(prices.clone());
            if prepared {e.ensure_relaxed(595).unwrap();}
            assert_eq!(e.certain(595,u),certain);
            assert!(!e.certain(597,[0,1,0]));
            assert!(!e.certain(597,[1,0,0]));
            let expected=oracle(&e.edges,&prices,595,u,&mut HashMap::new());
            assert_eq!(expected.mask,mask);
            let mut s=Solver::new(&e,595,u).unwrap();
            let (c,_)=s.root(&mut e,u).unwrap();enclosed(&s,c,&expected);
            // Exactly one action is evaluated in all three cases: blue is
            // excluded only when a certain alternative actually exists.
            assert_eq!(s.transitions,1);
            assert!(e.memo.is_empty());
            let work=e.transitions;
            let exact=s.refined(&mut e,595,u).unwrap();enclosed(&s,exact,&expected);
            assert_eq!(e.transitions-work,1);
            assert_eq!(exact.mask,mask);
        }
    }
}

#[test]
fn relaxed_action_bounds_prune_strict_losers_but_keep_all_equal_root_actions() {
    for prepared in [false,true] {
        for tied in [false,true] {
            let prices=if tied {[fraction(1,3),fraction(1,3),fraction(1,3)]}
                else {[fraction(1,101),fraction(1,3),fraction(1,7)]};
            let mut e=engine(prices.clone());
            if prepared {e.ensure_relaxed(599).unwrap();}
            let u=[1;3];let expected=oracle(&e.edges,&prices,599,u,&mut HashMap::new());
            let mut s=Solver::new(&e,599,u).unwrap();
            let (c,_)=s.root(&mut e,u).unwrap();enclosed(&s,c,&expected);
            let evaluated=if prepared&&!tied {1} else {3};
            assert_eq!(s.transitions,evaluated);
            assert_eq!(c.mask,if tied {7} else {1});
            assert!(e.memo.is_empty());
            let work=e.transitions;
            let exact=s.refined(&mut e,599,u).unwrap();enclosed(&s,exact,&expected);
            assert_eq!(e.transitions-work,evaluated);
            if prepared {
                assert_eq!(s.relaxed_actions.len(),TERMINAL+1);
                assert_ne!(s.relaxed_actions[599][1].tag&READY,0);
                assert_ne!(s.relaxed_actions[599][2].tag&READY,0);
            } else {assert!(s.relaxed_actions.is_empty());}
            let capacity=s.relaxed_actions.capacity();
            for _ in 0..2 {
                let bytes=s.batch(&mut e,&[u],2).unwrap();
                assert_eq!(u32::from_le_bytes(bytes[104..108].try_into().unwrap()),expected.mask as u32);
            }
            assert_eq!(s.relaxed_actions.capacity(),capacity);
            assert_eq!(s.transitions,evaluated);
        }
    }
    // Zero monetary cost still compares consumption, while equal total-cost
    // actions retain every feasible bit and the lowest-index canonical vector.
    for prepared in [false,true] {
        let prices=[Q::zero(),Q::zero(),Q::zero()];
        let mut e=action_guard_engine(prices.clone());
        if prepared {e.ensure_relaxed(595).unwrap();}
        let u=[1;3];let expected=oracle(&e.edges,&prices,595,u,&mut HashMap::new());
        assert_eq!(expected.mask,6);
        let mut s=Solver::new(&e,595,u).unwrap();
        let (c,_)=s.root(&mut e,u).unwrap();enclosed(&s,c,&expected);
        let exact=s.refined(&mut e,595,u).unwrap();enclosed(&s,exact,&expected);
    }
}

#[test]
fn relaxed_action_cost_guard_preserves_noninteger_canonical_consumption() {
    let prices=[fraction(1,101),fraction(1,3),fraction(1,7)];
    let mut e=engine(prices.clone());e.ensure_relaxed(570).unwrap();
    let u=[15,1,1];let expected=oracle(&e.edges,&prices,570,u,&mut HashMap::new());
    assert_eq!(expected.mask,1);
    assert_ne!(expected.c[0].denom(),&BigInt::one());
    let mut s=Solver::new(&e,570,u).unwrap();
    let (c,_)=s.root(&mut e,u).unwrap();enclosed(&s,c,&expected);
    assert_eq!(c.tag&(ONE|8),ONE);
    assert_eq!(s.transitions,1);
    assert!(e.memo.is_empty());
    let work=e.transitions;
    let exact=s.refined(&mut e,570,u).unwrap();enclosed(&s,exact,&expected);
    assert_eq!(e.transitions-work,1);
    let bytes=s.batch(&mut e,&[u],2).unwrap();
    let tail:Json=serde_json::from_slice(&bytes[112..]).unwrap();
    assert_eq!(tail["objectives"][0]["b"],json!(wire(&(0..3).map(|k|&prices[k]*&expected.c[k]).sum::<Q>())));
    assert_eq!(tail["objectives"][0]["c"],json!(wire(&expected.c.iter().cloned().sum::<Q>())));
}

#[test]
fn exact_action_bound_pruning_cross_multiplies_reduced_finite_exponents() {
    for (prices,mask,evaluated) in [
        ([Q::one(),Q::one(),fraction(2,1)],2,1),
        ([fraction(1,3),fraction(1,3),fraction(1,3)],6,2),
        ([Q::zero(),Q::zero(),Q::zero()],6,2),
    ] {
        let mut e=action_guard_engine(prices.clone());e.ensure_relaxed(595).unwrap();
        let u=[0,1,1];let exponent=u.iter().sum::<usize>().min(e.depth[595]);
        assert!(exponent<e.relaxed[595].as_ref().unwrap().actions[2].exponent);
        let expected=oracle(&e.edges,&prices,595,u,&mut HashMap::new());
        assert_eq!(expected.mask,mask);
        let mut s=Solver::new(&e,595,u).unwrap();
        let (c,_)=s.root(&mut e,u).unwrap();enclosed(&s,c,&expected);
        assert_eq!(s.transitions,evaluated);
        assert!(e.memo.is_empty());
        let work=e.transitions;
        let exact=s.refined(&mut e,595,u).unwrap();enclosed(&s,exact,&expected);
        assert_eq!(e.transitions-work,evaluated);
        assert_eq!(e.memo[&(595,u)].exponent,exponent);
    }
}

#[test]
fn exact_memo_retirement_recomputes_growth_before_retrying_admission() {
    let prices=[fraction(1,3),fraction(1,7),fraction(1,11)];
    let mut e=engine(prices.clone());let u=[1,1,0];
    let primary_probability=e.primary_probability(570,u).unwrap();
    assert!(!e.primary.is_empty());
    let value=e.get(570,u,true).unwrap();
    let expected=oracle(&e.edges,&prices,570,u,&mut HashMap::new());
    assert_eq!(primary_probability,expected.p);
    e.memo=HashMap::with_capacity(16);
    let old_capacity=e.memo.capacity();
    for i in 0..old_capacity {e.memo.insert((500,[i,0,0]),Value::zero());}
    let primary=e.primary.len();let work=e.transitions;let ticks=e.ticks;
    let payload=128+(value.p.bits()+value.c.iter().map(|n|n.bits()).sum::<u64>()) as usize/8;
    let fresh=2*payload+4096+2*1024*1024;
    let stale=fresh+old_capacity*256;
    let requests=std::cell::RefCell::new(Vec::new());
    Solver::remember_exact_admitted(&mut e,570,u,&value,|bytes|{
        requests.borrow_mut().push(bytes);
        bytes<=fresh
    }).unwrap();
    assert_eq!(*requests.borrow(),vec![stale,fresh,2*payload+2*1024*1024]);
    assert_eq!(e.memo.len(),1);
    assert_eq!((e.primary.len(),e.transitions,e.ticks),(primary,work,ticks));
    let stored=&e.memo[&(570,u)];
    assert_eq!(stored.mask,expected.mask);
    assert_eq!(rational(&stored.p,&e.powers[stored.exponent]),expected.p);
    for k in 0..3 {assert_eq!(rational(&stored.c[k],&e.powers[stored.exponent]),expected.c[k]);}
    // A genuinely insufficient post-retirement budget still fails after one
    // retry, without clearing primary or refunding any accumulated work.
    let attempts=std::cell::Cell::new(0);
    assert_eq!(Solver::remember_exact_admitted(&mut e,570,u,&value,|_|{
        attempts.set(attempts.get()+1);false
    }),Err("managed_payload_ceiling"));
    assert_eq!(attempts.get(),2);assert_eq!(e.memo.capacity(),0);
    assert_eq!((e.primary.len(),e.transitions,e.ticks),(primary,work,ticks));
}

#[test]
fn exact_memo_entry_limit_retires_before_estimation_and_skips_blocked_insert() {
    let mut e=engine([Q::one(),Q::one(),Q::one()]);
    e.primary_probability(570,[1,1,0]).unwrap();assert!(!e.primary.is_empty());
    let primary=e.primary.len();let work=e.transitions;let ticks=e.ticks;
    let value=Value::complete();
    e.max_memo=primary+1;e.memo=HashMap::with_capacity(16);
    e.memo.insert((500,[1,0,0]),Value::zero());
    let attempts=std::cell::Cell::new(0);
    Solver::remember_exact_admitted(&mut e,600,[0;3],&value,|bytes|{
        attempts.set(attempts.get()+1);
        // The old table had spare capacity; the fresh table needs a reservation,
        // then only clone headroom needs to fit alongside the actual backing.
        assert_eq!(bytes,2*128+2*1024*1024+if attempts.get()==1 {4096} else {0});true
    }).unwrap();
    assert_eq!(attempts.get(),2);assert_eq!(e.memo.len(),1);
    assert_eq!(e.memo[&(600,[0;3])].p,BigUint::one());
    assert_eq!((e.primary.len(),e.transitions,e.ticks),(primary,work,ticks));
    e.max_memo=primary;
    Solver::remember_exact_admitted(&mut e,600,[0;3],&value,|_|panic!("no insertion to admit")).unwrap();
    assert_eq!(e.memo.capacity(),0);
    assert_eq!((e.primary.len(),e.transitions,e.ticks),(primary,work,ticks));
}

#[test]
fn exact_memo_post_growth_clone_refusal_never_inserts() {
    let mut e=engine([Q::one(),Q::one(),Q::one()]);
    let v=Value::complete();let clone_bytes=v.memo_clone_headroom();
    let attempts=std::cell::Cell::new(0);
    assert_eq!(Solver::remember_exact_admitted(&mut e,570,[1,0,0],&v,|bytes|{
        attempts.set(attempts.get()+1);
        bytes>clone_bytes // permit estimated growth, refuse the clone after reserve
    }),Err("managed_payload_ceiling"));
    assert_eq!(attempts.get(),2);assert!(e.memo.is_empty());
    Solver::remember_exact(&mut e,570,[1,0,0],&v).unwrap();
    let capacity=e.memo.capacity();
    attempts.set(0);
    Solver::remember_exact_admitted(&mut e,570,[0,1,0],&v,|bytes|{
        attempts.set(attempts.get()+1);assert_eq!(bytes,clone_bytes);true
    }).unwrap();
    assert_eq!(attempts.get(),1);assert_eq!(e.memo.capacity(),capacity);
    assert_eq!(e.memo.len(),2);
}

#[cfg(not(target_arch="wasm32"))]
#[test]
fn exact_memo_real_reserve_denial_and_bounded_retry() {
    // A real allocator refusal would affect unrelated tests. Give the test
    // its own accounted heap and run no parallel tests in that process.
    const CHILD:&str="H14_EXACT_MEMO_RESERVE_TEST_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let name=std::thread::current().name().unwrap().to_owned();
        let child=std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact",&name,"--test-threads=1"]).env(CHILD,"1").output().unwrap();
        assert!(child.status.success() && String::from_utf8_lossy(&child.stdout).contains("1 passed"),
            "isolated allocator test did not pass:\n{}\n{}",String::from_utf8_lossy(&child.stdout),String::from_utf8_lossy(&child.stderr));
        return;
    }
    // An initially empty table cannot free backing for a retry.
    let mut empty=engine([Q::one(),Q::one(),Q::one()]);
    let v=Value::complete();assert_eq!(empty.memo.capacity(),0);
    let stopped=Solver::remember_exact_admitted(&mut empty,600,[0;3],&v,|bytes|{
        let allowed=allocation::can_admit(bytes);
        allocation::certified_heap_limit(0);allowed
    });
    let denied=allocation::certified_allocation_denied();
    allocation::certified_reset_heap_peak();
    assert_eq!(stopped,Err("managed_payload_ceiling"));assert!(denied);
    assert_eq!(empty.memo.capacity(),0);drop(empty);
    for (exhaust,prior) in [(false,false),(false,true),(true,false),(true,true)] {
        let mut e=engine([Q::one(),Q::one(),Q::one()]);
        // Populate primary before get installs a reusable exact P/B/C entry:
        // primary_components would otherwise return that entry's P directly.
        let u=[1,1,0];e.primary_probability(570,u).unwrap();
        let v=e.get(570,u,true).unwrap();
        assert!(!e.primary.is_empty());
        let counts=(e.primary.len(),e.transitions,e.ticks);
        // Enough backing that its retirement also admits the subsequent clone.
        e.memo=HashMap::with_capacity(32768);
        for i in 0..e.memo.capacity() {e.memo.insert((500,[i,0,0]),Value::zero());}
        let live=allocation::certified_heap_live();
        if prior {assert!(Vec::<u8>::new().try_reserve_exact(193*1024*1024).is_err());}
        let checks=std::cell::Cell::new(0);
        let estimate_passed=std::cell::Cell::new(false);
        let result=Solver::remember_exact_admitted(&mut e,570,u,&v,|bytes|{
            let admitted=allocation::can_admit(bytes);
            if checks.replace(checks.get()+1)==0 {
                estimate_passed.set(admitted);
                // Model the independent backing-store refusal *after* a valid
                // estimate: HashMap::try_reserve(1) really receives a null
                // allocation. Only freeing the old table can allow the retry.
                allocation::certified_heap_limit(if exhaust {0} else {live});
            }
            admitted
        });
        let denied=allocation::certified_allocation_denied();
        allocation::certified_reset_heap_peak(); // allow harness allocations again
        assert!(estimate_passed.get());assert_eq!(denied,prior||exhaust);
        assert_eq!((e.primary.len(),e.transitions,e.ticks),counts);
        if exhaust {
            assert_eq!(result,Err("managed_payload_ceiling"));
            assert_eq!(checks.get(),1);assert_eq!(e.memo.capacity(),0);
        } else {
            result.unwrap();assert_eq!(checks.get(),2);assert_eq!(e.memo.len(),1);
            let stored=&e.memo[&(570,u)];
            assert_eq!((&stored.p,&stored.c,stored.exponent,stored.mask),(&v.p,&v.c,v.exponent,v.mask));
        }
    }
}
