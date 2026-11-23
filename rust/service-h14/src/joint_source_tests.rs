use super::*;
use std::collections::BTreeMap;

fn row(pieces: Pieces, n: BigInt, d: BigInt) -> Json {
    json!({"pieces":pieces,"mass":{"numerator":n.to_string(),"denominator":d.to_string()}})
}
fn fraction(pieces: Pieces, n: i64, d: i64) -> Json { row(pieces,n.into(),d.into()) }
fn law(id: &str, rows: Json) -> Json { json!({"id":id,"kind":"finite","modelVersion":"spectral-test","outcomes":rows}) }
fn event(day: usize, id: &str, count: usize) -> Json {
    json!({"id":format!("{day}-{id}"),"day":day,"refs":[{"lawId":id,"count":count}]})
}
fn model(laws: Json, events: Json) -> supply::Model {
    model_with_classes(laws,events,json!([]))
}
fn model_with_classes(laws: Json, events: Json, classes: Json) -> supply::Model {
    let population: Vec<_> = [1,2,3,1].into_iter().map(|n| wire(&Q::new(n.into(),7.into()))).collect();
    serde_json::from_value(json!({"snapshotVersion":"certified-daily-v2","laws":laws,"events":events,
        "priors":[wire(&Q::one()),wire(&Q::zero()),wire(&Q::zero()),wire(&Q::zero())],"populationPrior":population,
        "dispatch":[],"shop":[],"solo":[],"cadence":wire(&Q::from_integer(30.into())),
        "dispatchExpected":vec![vec![wire(&Q::zero());3];4],"classes":classes})).unwrap()
}
fn begin(stock: Pieces) -> Begin {
    Begin { algorithm:ALGORITHM.into(),source_identity:"0".repeat(64),source_key:"1".repeat(64),projection_key:"2".repeat(64),
        sid:0,stock,windows:[std::array::from_fn(|k| -((stock[k]%10) as i64));14],source_error_bounds:[1e-6;14],host_performed_work:123 }
}
fn request(laws: Json, events: Json, stock: Pieces, caps: Units) -> Request {
    from_model(model(laws,events),stock,caps)
}
fn from_model(m: supply::Model, stock: Pieces, caps: Units) -> Request {
    let input = begin(stock);
    let mut work = Work::host_debit(input.host_performed_work);
    Request::new(supply::Supply::new(m,f64::MAX).unwrap(),input,caps,f64::MAX,ROWS,&mut work).unwrap()
}
fn word(b: &[u8], at: usize) -> u32 { u32::from_le_bytes(b[at..at+4].try_into().unwrap()) }
// Replay the host's greedy rule over actual wire masses. An aligned hint must
// prune one leading run only; every retained endpoint must be canonical.
fn assert_ordering(rows: &[Projected]) -> usize {
    let mut sum = 0.0;
    let mut prelude = 0;
    let mut retained = false;
    for row in rows {
        let mass = (row.weight as f64) * MASS_SCALE;
        let next = f64::from_bits((sum + mass).to_bits() + 1);
        if next <= ADVISORY_ORDERING_HINT {
            assert!(!retained, "a later atom still fits after the low-mass prelude");
            sum = next;
            prelude += 1;
        } else {
            retained = true;
        }
    }
    assert!(sum <= ADVISORY_ORDERING_HINT);
    assert!(rows[..prelude].windows(2).all(|pair| mass_key(&pair[0]) <= mass_key(&pair[1])));
    assert!(rows[prelude..].windows(2).all(|pair| pair[0].units <= pair[1].units));
    prelude
}

fn through(r: &mut Request, last: usize) -> BTreeMap<usize,BTreeMap<[u32;3],f64>> {
    let mut dates = BTreeMap::new();
    let mut streamed = 0;
    let mut expected_rows = 0;
    loop {
        let packet = r.next().unwrap();
        assert_eq!(&packet[..4],b"JQS2");
        assert_eq!(word(&packet,12),NONE);
        let day = word(&packet,8) as usize;
        match word(&packet,4) {
            2 => {
                assert!(r.projected.iter().map(|p| p.weight as u128).sum::<u128>() <= M as u128);
                assert_ordering(&r.projected);
                let metadata: Json = serde_json::from_slice(&packet[24..]).unwrap();
                expected_rows = metadata["rowCount"].as_u64().unwrap() as usize;
                assert_eq!(expected_rows, r.projected.len());
                streamed = 0;
            }
            3 => {
                let rows = dates.entry(day).or_insert_with(BTreeMap::new);
                for i in 0..word(&packet,16) as usize {
                    let at = 24+20*i;
                    let units = std::array::from_fn(|k| word(&packet,at+4*k));
                    let mass = f64::from_le_bytes(packet[at+12..at+20].try_into().unwrap());
                    assert!(mass > 0.0 && mass.is_finite());
                    let expected = &r.projected[streamed];
                    assert_eq!(units, expected.units);
                    assert_eq!(mass.to_bits(), ((expected.weight as f64) * MASS_SCALE).to_bits());
                    streamed += 1;
                    assert!(rows.insert(units,mass).is_none());
                }
            }
            5 => {
                assert_eq!(streamed, expected_rows);
                r.ack(day).unwrap();
                if day == last { return dates; }
            }
            _ => {}
        }
    }
}
// Independent unsaturated path enumeration. No production convolution, FFT,
// Q63 conversion, floor-fold or periodic wrapping is used by this oracle.
fn oracle(stock: Pieces, caps: Units, draws: &[Vec<(Pieces,Q)>]) -> BTreeMap<[u32;3],Q> {
    let mut raw = BTreeMap::from([([0u64;3],Q::one())]);
    for draw in draws {
        let mut next = BTreeMap::new();
        for (a,p) in raw { for (b,q) in draw {
            let key = std::array::from_fn(|k| a[k]+b[k]);
            *next.entry(key).or_insert_with(Q::zero) += &p*q;
        }}
        raw=next;
    }
    let mut result = BTreeMap::new();
    for (pieces,p) in raw {
        let units = std::array::from_fn(|k| ((pieces[k]+stock[k])/10).min(caps[k] as u64) as u32);
        *result.entry(units).or_insert_with(Q::zero) += p;
    }
    result
}
fn assert_l1(actual: &BTreeMap<[u32;3],f64>, exact: &BTreeMap<[u32;3],Q>) {
    let mut error=0.0;
    for (u,p) in exact { error += (actual.get(u).copied().unwrap_or(0.0)-p.to_f64().unwrap()).abs(); }
    for (u,p) in actual { if !exact.contains_key(u) { error += p; } }
    assert!(error < 1e-8,"full L1 {error}");
    assert!(actual.values().sum::<f64>() <= 1.0+2e-14);
}
#[test]
fn exact_joint_oracle_residues_dated_phases_caps_and_all_fourteen_acks() {
    let draw=vec![([0,9,0],Q::new(1.into(),2.into())),([9,0,1],Q::new(1.into(),2.into()))];
    let mut r=request(json!([law("joint",json!([fraction([0,9,0],1,2),fraction([9,0,1],1,2)]))]),
        json!([event(1,"joint",2),event(2,"deterministic:1,1,9",1),event(3,"deterministic:20,10,10",1)]),[9,0,0],[4,2,2]);
    let actual=through(&mut r,14);
    assert_eq!(actual.len(),14);
    let mut draws=vec![draw.clone(),draw];
    assert_l1(&actual[&1],&oracle([9,0,0],[4,2,2],&draws));
    draws.push(vec![([1,1,9],Q::one())]);
    assert_l1(&actual[&2],&oracle([9,0,0],[4,2,2],&draws));
    draws.push(vec![([20,10,10],Q::one())]);
    for d in 3..=14 { assert_l1(&actual[&d],&oracle([9,0,0],[4,2,2],&draws)); }
    assert_eq!(word(&r.next().unwrap(),4),6);
    assert_eq!(r.last_acked,14);
    assert_eq!(r.work.host,123);
    assert_eq!(r.work.ledger.total,r.work.ledger.scalar.iter().sum::<u64>());
    assert_eq!(r.work.ledger.mac_equivalent(),r.work.ledger.total.div_ceil(8));
    assert!(r.work.peak_rows<=ROWS && r.work.peak_bytes<=BYTES);
}
#[test]
fn persistent_cohort_mixture_is_not_a_product_of_daily_mixtures() {
    let coin=|a,b| json!([fraction([a,0,0],1,2),fraction([b,0,0],1,2)]);
    let mut m=model(json!([{"id":"cohort","kind":"finite","outcomesByCohort":[coin(0,10),coin(20,30),coin(0,0),coin(0,0)]}]),
        json!([event(1,"cohort",1),event(2,"cohort",1)]));
    m.priors=vec![wire(&Q::new(1.into(),2.into())),wire(&Q::new(1.into(),2.into())),wire(&Q::zero()),wire(&Q::zero())];
    let mut r=from_model(m,[0;3],[8;3]);
    let actual=through(&mut r,2);
    let exact=BTreeMap::from([([0,0,0],Q::new(1.into(),8.into())),([1,0,0],Q::new(1.into(),4.into())),([2,0,0],Q::new(1.into(),8.into())),
        ([4,0,0],Q::new(1.into(),8.into())),([5,0,0],Q::new(1.into(),4.into())),([6,0,0],Q::new(1.into(),8.into()))]);
    assert_l1(&actual[&2],&exact);
    assert!(actual[&2].get(&[3,0,0]).copied().unwrap_or(0.0)<1e-10);
}
#[test]
fn dense_fft_matches_exact_joint_oracle_including_nyquist_and_collisions() {
    let pieces=[[0,0,0],[2,1,1],[9,2,0],[10,0,2],[19,9,3],[21,3,1]];
    let input:Vec<_>=pieces.iter().map(|&p| fraction(p,1,6)).collect();
    let draw:Vec<_>=pieces.iter().map(|&p| (p,Q::new(1.into(),6.into()))).collect();
    let mut r=request(json!([law("dense",json!(input))]),json!([event(1,"dense",2)]),[9,9,9],[5,3,2]);
    let actual=through(&mut r,1);
    assert_l1(&actual[&1],&oracle([9,9,9],[5,3,2],&[draw.clone(),draw]));
    assert!(r.work.transform_coeffs>=HALF);
}
#[test]
fn full_point_fast_path_finite_override_and_safe_boundary() {
    let mut r=request(json!([law("regular-box-v1",json!([fraction([1,2,3],1,1)]))]),
        json!([event(1,"regular-box-v1",3),event(2,"deterministic:20,0,0",1)]),[9,8,7],[9;3]);
    let actual=through(&mut r,14);
    assert_eq!(actual[&1],BTreeMap::from([([1,1,1],1.0)]));
    assert_eq!(actual[&2],BTreeMap::from([([3,1,1],1.0)]));
    assert_eq!(r.work.ledger.scalar[Category::Forward as usize],0);
    assert_eq!(r.work.ledger.scalar[Category::Inverse as usize],0);
    assert_eq!(r.work.transform_coeffs,0);
    let mut boundary=request(json!([]),json!([event(1,&format!("deterministic:{SAFE},0,0"),1)]),[0;3],[0;3]);
    assert_eq!(through(&mut boundary,1)[&1],BTreeMap::from([([0,0,0],1.0)]));
}
#[test]
fn positive_underflow_support_still_rejects_raw_overflow_before_capping() {
    let d=BigInt::one()<<80usize;
    let mut r=request(json!([law("tiny",json!([row([0;3],&d-1,d.clone()),row([SAFE,0,0],1.into(),d)]))]),
        json!([event(1,"tiny",1),event(2,"deterministic:1,0,0",1)]),[0;3],[0;3]);
    r.next().unwrap();
    assert_eq!(r.next().unwrap_err(),"certified_law_raw_pieces_invalid");
    assert_eq!(r.last_acked,0); // Precomputation is inside the original request.
}
#[test]
fn ack_lifecycle_and_failures_preserve_last_ack_and_spent_work() {
    let mut r=request(json!([]),json!([]),[9;3],[1;3]);
    through(&mut r,1);
    loop { if word(&r.next().unwrap(),4)==5 { break; } }
    assert_eq!(r.ack(3),Err("joint_source_lifecycle"));
    assert_eq!(r.next().unwrap_err(),"joint_source_lifecycle");
    let spent=r.work.ledger.total;
    let peak=r.work.peak_bytes;
    match Session::Live(r).failed() {
        Session::Failed{last_acked,work}=>{assert_eq!(last_acked,1);assert_eq!(work.ledger.total,spent);assert_eq!(work.peak_bytes,peak);}
        _=>panic!("failure kept numerical source"),
    }
}
#[test]
fn work_memory_integer_and_deadline_refusals_are_not_successful_empty_sources() {
    let mut r=request(json!([]),json!([event(1,"deterministic:1,0,0",1)]),[0;3],[1;3]);
    r.work.ledger.charge(Category::Fold,1_600_000_000-r.work.ledger.total).unwrap();
    r.next().unwrap();
    assert_eq!(r.next().unwrap_err(),"joint_source_work_limit");
    assert_eq!(r.work.ledger.total,1_600_000_000);
    assert_eq!(r.last_acked,0);
    let mut w=Work::default();
    assert_eq!(w.admit(0,ROWS+1,f64::MAX),Err("joint_source_memory_limit"));
    assert_eq!(w.admit(BYTES,0,f64::MAX),Err("joint_source_memory_limit"));
    assert!(w.vector::<Complex>(usize::MAX,false,f64::MAX).is_err());
    let mut r=request(json!([]),json!([]),[0;3],[1;3]);
    r.work.byte_limit=Some(SCRATCH);
    assert_eq!(r.next().unwrap_err(),"joint_source_memory_limit");
    r.work.byte_limit=None;r.deadline=0.0;
    assert_eq!(r.next().unwrap_err(),"request_budget_exhausted");
    let d=BigInt::one()<<2049usize;
    let mut r=request(json!([law("wide",json!([row([0;3],&d-1,d.clone()),row([1,0,0],1.into(),d)]))]),json!([event(1,"wide",1)]),[0;3],[1;3]);
    r.next().unwrap();assert_eq!(r.next().unwrap_err(),"joint_source_integer_limit");
}
#[test]
fn aligned_negative_window_unwraps_before_stock_and_game_caps() {
    let mut r=request(json!([law("wrapped",json!([fraction([299,119,79],1,2),fraction([300,120,80],1,2)]))]),
        json!([event(1,"wrapped",1)]),[1,1,1],[100;3]);
    r.windows=[[9,9,9];14];
    let actual=through(&mut r,1);
    assert_l1(&actual[&1],&BTreeMap::from([([30,12,8],Q::one())]));
}
#[test]
fn nonreplacement_physical_board_remains_joint() {
    // Two classes, four tickets per class, four draws without replacement.
    let m=model_with_classes(json!([]),json!([event(1,"dispatch-board-v1",1)]),json!([
        {"weight":1,"keep":false,"raw":[3,0,0,0,0]},
        {"weight":1,"keep":false,"raw":[0,3,0,0,0]}]));
    let mut r=from_model(m,[9,9,0],[3;3]);
    let actual=through(&mut r,1);
    let mut exact=BTreeMap::new();
    for (n,p) in [1,16,36,16,1].into_iter().enumerate() {
        let units=[((9+3*n)/10) as u32,((9+3*(4-n))/10) as u32,0];
        *exact.entry(units).or_insert_with(Q::zero)+=Q::new(p.into(),70.into());
    }
    assert_l1(&actual[&1],&exact);
    assert!(r.work.ledger.scalar[Category::Physical as usize]>r.work.host);
}

#[test]
fn proportional_daily_schedules_share_products_without_changing_the_law() {
    let a=vec![([0,0,0],Q::new(1.into(),2.into())),([9,1,0],Q::new(1.into(),2.into()))];
    let b=vec![([0,0,0],Q::new(1.into(),2.into())),([1,0,9],Q::new(1.into(),2.into()))];
    let mut r=request(json!([
        law("a",json!([fraction([0;3],1,2),fraction([9,1,0],1,2)])),
        law("b",json!([fraction([0;3],1,2),fraction([1,0,9],1,2)]))]),
        json!([event(1,"a",2),event(1,"b",1),event(2,"a",2),event(2,"b",1),event(2,"deterministic:10,0,0",1)]),
        [9,9,9],[6,2,3]);
    let actual=through(&mut r,2);
    assert_l1(&actual[&1],&oracle([9,9,9],[6,2,3],&[a.clone(),a.clone(),b.clone()]));
    assert_l1(&actual[&2],&oracle([9,9,9],[6,2,3],&[a.clone(),a.clone(),b.clone(),a.clone(),a,b,vec![([10,0,0],Q::one())]]));
}

#[test]
fn exact_point_cohort_and_spectral_cohort_share_one_subprobability_budget() {
    let mut m=model(json!([{"id":"mixed","kind":"finite","outcomesByCohort":[
        [fraction([0;3],1,2),fraction([20,0,0],1,2)],
        [fraction([10,0,0],1,1)],
        [fraction([0;3],1,1)],
        [fraction([0;3],1,1)]
    ]}]),json!([event(1,"mixed",1),event(2,"mixed",1)]));
    m.priors=vec![wire(&Q::new(1.into(),2.into())),wire(&Q::new(1.into(),2.into())),wire(&Q::zero()),wire(&Q::zero())];
    let mut r=from_model(m,[0;3],[6;3]);
    let actual=through(&mut r,2);
    assert_eq!(r.points.len(),14);
    assert_l1(&actual[&2],&BTreeMap::from([
        ([0,0,0],Q::new(1.into(),8.into())),
        ([2,0,0],Q::new(3.into(),4.into())),
        ([4,0,0],Q::new(1.into(),8.into()))
    ]));
}

#[test]
fn constructor_admission_failure_retains_native_debits_and_refused_peaks() {
    let supply = supply::Supply::new(model(
        json!([law("one",json!([fraction([1,0,0],1,1)]))]),json!([])),f64::MAX).unwrap();
    let (model_bytes, model_rows) = supply.source_model_footprint().unwrap();
    let input = begin([0;3]);
    let host = input.host_performed_work;
    let mut session = Session::Failed { last_acked: 0, work: Work::host_debit(host) };
    let work = match &mut session {
        Session::Failed { work, .. } => work,
        _ => unreachable!(),
    };
    // Exercise the real constructor's Work::admit branch after its model
    // accounting, rather than injecting a synthetic constructor error.
    work.byte_limit = Some(SCRATCH);
    assert!(matches!(Request::new(supply,input,[1;3],f64::MAX,ROWS,work),
        Err("joint_source_memory_limit")));
    match session.failed() {
        Session::Failed { last_acked, work } => {
            let expected = host + (model_bytes / 4 + 256) as u64;
            assert_eq!(last_acked,0);
            assert_eq!(work.host,host);
            assert_eq!(work.ledger.total,expected);
            assert_eq!(work.ledger.scalar.iter().sum::<u64>(),expected);
            assert_eq!(work.peak_rows,model_rows);
            assert_eq!(work.peak_bytes,model_bytes+std::mem::size_of::<Request>()+SCRATCH);
            assert!(work.peak_bytes>work.byte_limit.unwrap());
        }
        _ => panic!("failed constructor retained a live source"),
    }
}

#[test]
fn capped_point_skips_spectra_but_preserves_full_stochastic_extrema() {
    let atoms: Vec<_> = (0..6).map(|n| fraction([n,2*n,3*n],1,6)).collect();
    let mut r=request(json!([law("stochastic",json!(atoms))]),json!([event(1,"stochastic",14)]),
        [20,30,40],[2,3,4]);
    let output=through(&mut r,14);
    for d in 1..=14 { assert_eq!(output[&d],BTreeMap::from([([2,3,4],1.0)])); }
    assert_eq!(r.minima[13],[0;3]);
    assert_eq!(r.maxima[13],[70,140,210]);
    for category in [Category::Roots,Category::Forward,Category::Powers,Category::Inverse] {
        assert_eq!(r.work.ledger.scalar[category as usize],0);
    }
    assert_eq!(r.work.transform_coeffs,0);
}

#[test]
fn shared_event_delta_graph_matches_exact_twenty_two_twelve_ten_draws() {
    let a=vec![([0;3],Q::new(1.into(),2.into())),([1,0,0],Q::new(1.into(),2.into()))];
    let b=vec![([0;3],Q::new(1.into(),2.into())),([0,2,0],Q::new(1.into(),2.into()))];
    let mut events=Vec::new();
    for d in 1..=14 {
        events.push(event(d,"daily",1));
        let count=match d { 1=>22,2=>12,8=>10,_=>0 };
        if count>0 { events.push(event(d,"boxes",count)); }
    }
    let mut r=request(json!([
        law("daily",json!([fraction([0;3],1,2),fraction([1,0,0],1,2)])),
        law("boxes",json!([fraction([0;3],1,2),fraction([0,2,0],1,2)]))
    ]),json!(events),[9,9,0],[3,10,1]);
    let output=through(&mut r,14);
    for d in [1,2,8,14] {
        let boxes=if d==1 {22} else if d<8 {34} else {44};
        let draws: Vec<_> = std::iter::repeat_n(a.clone(),d)
            .chain(std::iter::repeat_n(b.clone(),boxes)).collect();
        assert_l1(&output[&d],&oracle([9,9,0],[3,10,1],&draws));
    }
}

#[test]
fn initially_saturated_axis_keeps_the_other_axes_joint_not_independent() {
    let draw=vec![([0,10,0],Q::new(1.into(),2.into())),([9,0,10],Q::new(1.into(),2.into()))];
    let mut r=request(json!([law("correlated",json!([
        fraction([0,10,0],1,2),fraction([9,0,10],1,2)
    ]))]),json!([event(1,"correlated",2)]),[100_000,0,0],[1,2,2]);
    let output=through(&mut r,14);
    let expected=oracle([100_000,0,0],[1,2,2],&[draw.clone(),draw]);
    for d in 1..=14 { assert_l1(&output[&d],&expected); }
    assert!(output[&14].get(&[1,2,2]).copied().unwrap_or(0.0)<1e-10);
    // Only the x=0 raw plane remains; all y/z dependence is still present.
    assert!(r.work.ledger.scalar[Category::Fold as usize]<1_000_000);
}

#[test]
fn dated_axis_saturation_keeps_future_zero_mode_draws_and_residues() {
    let draw=vec![([0,9,0],Q::new(1.into(),2.into())),([9,0,9],Q::new(1.into(),2.into()))];
    let mut r=request(json!([law("joint",json!([
        fraction([0,9,0],1,2),fraction([9,0,9],1,2)
    ]))]),json!([event(1,"joint",1),event(2,"deterministic:10,10,0",1),event(3,"joint",1)]),
        [3,2,1],[1,1,3]);
    assert_eq!(r.marginal_stops(&[(0,0),(1,0)]).unwrap(),[1,1,14]);
    let output=through(&mut r,14);
    let mut draws=vec![draw.clone()];
    assert_l1(&output[&1],&oracle([3,2,1],[1,1,3],&draws));
    draws.push(vec![([10,10,0],Q::one())]);
    assert_l1(&output[&2],&oracle([3,2,1],[1,1,3],&draws));
    draws.push(draw);
    let expected=oracle([3,2,1],[1,1,3],&draws);
    for d in 3..=14 { assert_l1(&output[&d],&expected); }
    assert_eq!(r.minima[13],[10,10,0]);
    assert_eq!(r.maxima[13],[28,28,18]);
}

#[test]
fn marginalization_resolves_finite_overrides_and_exact_positive_priors() {
    let id="deterministic:10,10,0";
    let laws=json!([{"id":id,"kind":"finite","outcomesByCohort":[
        [fraction([10,10,0],1,2),fraction([20,10,10],1,2)],
        [fraction([0;3],1,1)],[fraction([0;3],1,1)],[fraction([0;3],1,1)]
    ]}]);
    let mut r=request(laws.clone(),json!([event(1,id,1)]),[3,2,1],[1,1,2]);
    assert_eq!(r.marginal_stops(&[(0,0)]).unwrap(),[0,0,14]);
    let output=through(&mut r,1);
    assert_l1(&output[&1],&BTreeMap::from([
        ([1,1,0],Q::new(1.into(),2.into())),([1,1,1],Q::new(1.into(),2.into()))
    ]));
    assert_eq!(r.minima[0],[10,10,0]); // zero-prior cohorts cannot lower the clamp

    let mut m=model(laws,json!([event(1,id,1)]));
    let denominator=BigInt::one()<<80usize;
    m.priors=vec![wire(&Q::new(&denominator-1,denominator.clone())),
        wire(&Q::new(1.into(),denominator)),wire(&Q::zero()),wire(&Q::zero())];
    let mut tiny=from_model(m,[3,2,1],[1,1,2]);
    // Cohort1 has a positive exact prior although its Q63 prior is zero.
    // The overridden law is NOT guaranteed to grant ten pieces in that cohort.
    assert_eq!(tiny.marginal_stops(&[(0,0)]).unwrap(),[14,14,14]);
}

fn point_cohorts(priors: [(i64,i64);4]) -> Request {
    let mut m = model(json!([{"id":"points","kind":"finite","outcomesByCohort":[
        [fraction([0,0,0],1,1)], [fraction([30,0,0],1,1)],
        [fraction([20,0,0],1,1)], [fraction([10,0,0],1,1)]
    ]}]), json!([event(1,"points",1)]));
    m.priors = priors.into_iter()
        .map(|(n,d)| wire(&Q::new(n.into(),d.into()))).collect();
    from_model(m,[0;3],[4;3])
}

fn unequal_point_cohorts() -> Request {
    point_cohorts([(1,3),(1,6),(1,4),(1,4)])
}

fn integer_distribution(rows: &[Projected]) -> BTreeMap<[u32;3],u64> {
    let result: BTreeMap<_,_> = rows.iter().map(|row| (row.units,row.weight)).collect();
    assert_eq!(result.len(), rows.len(), "projected units must be unique");
    result
}

#[test]
fn streamed_advisory_order_preserves_exact_q63_distribution_and_deficit() {
    let expected = BTreeMap::from([
        ([0,0,0],M/3), ([3,0,0],M/6), ([2,0,0],M/4), ([1,0,0],M/4)
    ]);
    let mut r = unequal_point_cohorts();
    assert_eq!(word(&r.next().unwrap(),4),1);
    assert_eq!(word(&r.next().unwrap(),4),2);
    assert_eq!(integer_distribution(&r.projected),expected);
    assert_eq!(r.projected.iter().map(|row| row.weight as u128).sum::<u128>(),u128::from(M)-1);
    assert_eq!(assert_ordering(&r.projected),0);
    // A fresh stream exercises rowCount, exact packet order and all ACKs.
    let mut stream = unequal_point_cohorts();
    let dates = through(&mut stream,14);
    let emitted: BTreeMap<_,_> = expected.into_iter()
        .map(|(units,weight)| (units,(weight as f64)*MASS_SCALE)).collect();
    for date in dates.values() { assert_eq!(date,&emitted); }
    assert_eq!(stream.last_acked,14);
    assert_eq!(stream.minima,[[0,0,0];14]);
    assert_eq!(stream.maxima,[[30,0,0];14]);
    // Capping merges two cohorts before mass ordering; it must retain their
    // exact integer sum and the same one-Q63-unit deficit, not renormalize.
    let mut capped = unequal_point_cohorts();
    capped.caps = [2;3];
    capped.project().unwrap();
    assert_eq!(integer_distribution(&capped.projected),BTreeMap::from([
        ([0,0,0],M/3), ([1,0,0],M/4), ([2,0,0],M/6+M/4)
    ]));
    assert_eq!(capped.projected.iter().map(|row| row.weight as u128).sum::<u128>(),u128::from(M)-1);
    assert_eq!(assert_ordering(&capped.projected),0);
    assert_eq!(capped.maxima,[[30,0,0];14]);
}

#[test]
fn mass_heapsort_matches_reference_without_allocating_or_losing_integer_mass() {
    // Empty/singleton, odd/even heaps, all ties, reverse canonical order and
    // maximum projected support. The large case spans many stream chunks.
    for len in [0,1,2,3,4,5,7,8,CHUNK+1,SMALL+4] {
        for tied in [false,true] {
            let mut rows: Vec<_> = (0..len).map(|i| Projected {
                units: [(len-i) as u32,(i%3) as u32,(i%2) as u32],
                weight: if tied { 3 } else { 1+((i*37)%17) as u64 },
            }).collect();
            let expected_mass = rows.iter().map(|row| row.weight as u128).sum::<u128>();
            let mut expected = rows.clone();
            expected.sort_by_key(mass_key);
            let pointer = rows.as_ptr();
            let capacity = rows.capacity();
            let mut ledger = Ledger::default();
            let mut polls = 0;
            sort_rows(&mut rows,mass_key,&mut ledger,|| { polls += 1; Ok(()) }).unwrap();
            assert_eq!(rows.as_ptr(),pointer);
            assert_eq!(rows.capacity(),capacity);
            assert_eq!(rows.iter().map(mass_key).collect::<Vec<_>>(),
                expected.iter().map(mass_key).collect::<Vec<_>>());
            assert_eq!(rows.iter().map(|row| row.weight as u128).sum::<u128>(),expected_mass);
            assert_eq!(ledger.total,ledger.scalar[Category::Conversion as usize]);
            let levels = usize::BITS - len.max(1).leading_zeros();
            assert!(ledger.total <= 256*(len.max(1) as u64)*u64::from(levels+1));
            assert!(polls >= len);
        }
    }
    // Binary64 can identify distinct Q63 masses: sort by the integers, not
    // converted packet masses, and use units only for genuinely equal masses.
    let mut rows = [
        Projected { units:[0;3],weight:M/2+2 },
        Projected { units:[1;3],weight:M/2+1 },
    ];
    assert_eq!(rows[0].weight as f64,rows[1].weight as f64);
    sort_rows(&mut rows,mass_key,&mut Ledger::default(),|| Ok(())).unwrap();
    assert_eq!(rows[0].weight,M/2+1);
}

#[test]
fn mass_sort_work_refusal_during_projection_keeps_previous_ack_and_all_atoms() {
    let mut probe = unequal_point_cohorts();
    through(&mut probe,1);
    assert_eq!(word(&probe.next().unwrap(),4),1);
    let before = probe.work.ledger.total;
    assert_eq!(word(&probe.next().unwrap(),4),2);
    let project_work = probe.work.ledger.total-before;
    let expected = integer_distribution(&probe.projected);
    let mut canonical = probe.projected.clone();
    canonical.sort_by_key(|row| row.units);
    let mut sort_work = Ledger::default();
    order_rows(&mut canonical,&mut sort_work,|| Ok(())).unwrap();
    assert!(project_work > sort_work.total);

    let mut r = unequal_point_cohorts();
    through(&mut r,1);
    assert_eq!(word(&r.next().unwrap(),4),1);
    // Allow every trim/merge operation, then refuse inside the mass heap.
    let allowance = project_work-sort_work.total+4;
    r.work.ledger.charge(Category::Physical,1_600_000_000-r.work.ledger.total-allowance).unwrap();
    let before_sort = r.work.ledger.total+project_work-sort_work.total;
    assert_eq!(r.next().unwrap_err(),"joint_source_work_limit");
    assert!(r.work.ledger.total > before_sort);
    assert!(r.work.ledger.total <= 1_600_000_000);
    assert_eq!(integer_distribution(&r.projected),expected);
    assert!(matches!(r.phase,Phase::Mixture));
    assert_eq!(r.ack(2),Err("joint_source_lifecycle"));
    let spent = r.work.ledger.total;
    match Session::Live(r).failed() {
        Session::Failed { last_acked,work } => {
            assert_eq!(last_acked,1);
            assert_eq!(work.ledger.total,spent);
            assert_eq!(work.ledger.total,work.ledger.scalar.iter().sum::<u64>());
        }
        _ => panic!("refused mass sort kept a live source"),
    }
}

#[test]
fn ordering_deadline_refusals_in_mass_heap_scan_and_suffix_keep_previous_ack() {
    let mut probe = unequal_point_cohorts();
    probe.project().unwrap();
    let mut mass_polls = 0;
    sort_rows(&mut probe.projected,mass_key,&mut Ledger::default(),|| {
        mass_polls += 1;
        Ok(())
    }).unwrap();
    // The no-prelude fixture has one scan poll, followed by suffix heap
    // entry/build/sift polls. Refuse within each of the three ordering stages.
    for stop in [4,mass_polls+1,mass_polls+5] {
        let mut r = unequal_point_cohorts();
        through(&mut r,1);
        assert_eq!(word(&r.next().unwrap(),4),1);
        r.project().unwrap(); // Pending date, without publishing it.
        let expected = integer_distribution(&r.projected);
        let before = r.work.ledger.total;
        let mut polls = 0;
        let result = order_rows(&mut r.projected,&mut r.work.ledger,|| {
            polls += 1;
            check(if polls == stop { 0.0 } else { f64::MAX })
        });
        assert_eq!(result,Err("request_budget_exhausted"));
        assert_eq!(polls,stop);
        assert_eq!(integer_distribution(&r.projected),expected);
        assert!(r.work.ledger.total > before);
        assert!(matches!(r.phase,Phase::Mixture));
        assert_eq!(r.ack(2),Err("joint_source_lifecycle"));
        let spent = r.work.ledger.total;
        match Session::Live(r).failed() {
            Session::Failed { last_acked,work } => {
                assert_eq!(last_acked,1);
                assert_eq!(work.ledger.total,spent);
            }
            _ => panic!("expired ordering kept a live source"),
        }
    }
    let mut empty: [Projected;0] = [];
    let mut ledger = Ledger::default();
    assert_eq!(order_rows(&mut empty,&mut ledger,|| check(0.0)),
        Err("request_budget_exhausted"));
    assert_eq!(ledger.total,0);
}

#[test]
fn low_mass_prelude_leaves_retained_endpoints_canonical_and_all_mass_intact() {
    const D: i64 = 1 << 24;
    let make = || point_cohorts([(D-21,D),(5,D),(8,D),(8,D)]);
    let mut r = make();
    assert_eq!(word(&r.next().unwrap(),4),1);
    assert_eq!(word(&r.next().unwrap(),4),2);
    let expected = BTreeMap::from([
        ([0,0,0],(D as u64-21)*(M/D as u64)), ([3,0,0],5*(M/D as u64)),
        ([2,0,0],8*(M/D as u64)), ([1,0,0],8*(M/D as u64))
    ]);
    assert_eq!(integer_distribution(&r.projected),expected);
    assert_eq!(r.projected.iter().map(|row| row.weight as u128).sum::<u128>(),u128::from(M));
    assert_eq!(assert_ordering(&r.projected),2);
    // The equal tiny masses straddle the cut: the canonical tie-break chooses
    // the prelude atom, and the large retained mass now precedes the other.
    assert_eq!(r.projected[..2].iter().map(|row| row.units).collect::<Vec<_>>(),
        vec![[3,0,0],[1,0,0]]);
    assert!(r.projected[2].weight > r.projected[3].weight);
    let mut stream = make();
    let dates = through(&mut stream,14);
    let emitted: BTreeMap<_,_> = expected.into_iter()
        .map(|(units,weight)| (units,(weight as f64)*MASS_SCALE)).collect();
    for date in dates.values() { assert_eq!(date,&emitted); }
    assert_eq!(stream.last_acked,14);
}

#[test]
fn advisory_prelude_uses_outward_wire_sum_not_plain_integer_sum() {
    let len = SMALL+4;
    let total = (ADVISORY_ORDERING_HINT*(M as f64)) as u64;
    let mut rows: Vec<_> = (0..len).map(|i| Projected {
        units: [(len-i) as u32,0,0],
        weight: total/(len as u64) + u64::from((i as u64) < total%(len as u64)),
    }).collect();
    let expected = integer_distribution(&rows);
    assert_eq!(rows.iter().map(|row| row.weight).sum::<u64>(),total);
    assert!((total as f64)*MASS_SCALE <= ADVISORY_ORDERING_HINT);
    let pointer = rows.as_ptr();
    let capacity = rows.capacity();
    let mut ledger = Ledger::default();
    let prelude = order_rows(&mut rows,&mut ledger,|| Ok(())).unwrap();
    // Repeated outward rounding must reject an atom even though the plain
    // sum fits. The rejected atom remains present, not truncated/normalized.
    assert!(prelude > 0 && prelude < len);
    assert_eq!(assert_ordering(&rows),prelude);
    assert_eq!(integer_distribution(&rows),expected);
    assert_eq!(rows.as_ptr(),pointer);
    assert_eq!(rows.capacity(),capacity);
    assert_eq!(ledger.total,ledger.scalar[Category::Conversion as usize]);

    for len in [0,1,CHUNK+1] {
        let mut tiny: Vec<_> = (0..len).map(|i| Projected {
            units: [(len-i) as u32,0,0],weight:1,
        }).collect();
        let expected = integer_distribution(&tiny);
        assert_eq!(order_rows(&mut tiny,&mut Ledger::default(),|| Ok(())).unwrap(),len);
        assert_eq!(assert_ordering(&tiny),len);
        assert_eq!(integer_distribution(&tiny),expected);
    }
}
