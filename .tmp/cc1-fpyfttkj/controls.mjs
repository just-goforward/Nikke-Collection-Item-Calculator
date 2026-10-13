import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {evaluate,q,wire} from "./evaluator.mjs";
// Hand derivations: terminal consumes nothing; zero stock cannot act;
// SR14 EXP2900 completes after ANY action, so equal prices tie all colors.
// First tie is blue and its consumption vector is [10,0,0], NOT a tie average.
export async function controls() {
  let rows=0,elapsedMs=0;
  function timed(...args) {
    const started=performance.now(),result=evaluate(...args);
    elapsedMs+=performance.now()-started;rows+=result.rows;return result;
  }
  const cases=[
    {id:"terminal",grade:"SR",level:15,exp:0,stock:[0,0,0],P:1,B:0,C:0,v:[0,0,0],mask:0,chosen:-2},
    {id:"exhaustion",grade:"SR",level:14,exp:2900,stock:[0,0,0],P:0,B:0,C:0,v:[0,0,0],mask:0,chosen:-1},
    {id:"promotion",grade:"R",level:15,exp:0,stock:[0,0,0],P:0,B:0,C:0,v:[0,0,0],mask:0,chosen:-1},
    {id:"different_consumption_tie",grade:"SR",level:14,exp:2900,stock:[10,10,10],P:1,B:10,C:10,v:[10,0,0],mask:7,chosen:0},
  ];
  for(const c of cases) {
    const result=timed(c,[q(1),q(1),q(1)],[c],{rows:5000,live:5000,deadline:performance.now()+5000});
    assert.deepEqual(result.answers[c.id],wire({P:q(c.P),B:q(c.B),C:q(c.C),
      consumed:c.v.map(x=>q(x)),mask:c.mask,chosen:c.chosen}));
  }
  // Native TypeScript import is deferred until the authorized control run.
  const {solveOracle}=await import("../../scripts/certified-staging-oracle.ts");
  const tiny=[
    {id:"tiny_probability",grade:"SR",level:14,exp:0,stock:[10,0,0]},
    {id:"tiny_tie",grade:"SR",level:14,exp:2900,stock:[10,10,10]},
    {id:"tiny_promotion",grade:"R",level:15,exp:0,stock:[0,0,10]},
    {id:"certain_success",grade:"R",level:0,exp:0,stock:[0,0,50]},
  ];
  for(const input of tiny) {
    const prices=[q(1),q(1),q(1)];
    const expected=solveOracle({...input,prices});
    const colors=["blue","purple","yellow"];
    const mask=expected.ties.reduce((m,a)=>m|(colors.includes(a)?1<<colors.indexOf(a):0),0);
    const chosen=expected.action==="DONE"?-2:colors.indexOf(expected.action);
    const actual=timed(input,prices,[input],{rows:5000,live:5000,deadline:performance.now()+5000});
    assert.deepEqual(actual.answers[input.id],wire({
      P:expected.P,B:expected.B,C:expected.C,consumed:expected.consumed,mask,chosen,
    }));
  }
  for(const c of [
    {id:"B_decides",grade:"SR",level:14,exp:2900,stock:[10,10,0],prices:[q(1),q(1,2),q(1)],B:q(5)},
    {id:"C_decides_after_B_tie",grade:"SR",level:14,exp:2600,stock:[20,10,0],prices:[q(1),q(19,10),q(1)],B:q(19)},
  ]) {
    const actual=timed(c,c.prices,[c],{rows:5000,live:5000,deadline:performance.now()+5000});
    assert.deepEqual(actual.answers[c.id],wire({P:q(1),B:c.B,C:q(10),
      consumed:[q(0),q(10),q(0)],mask:2,chosen:1}));
  }
  const data=JSON.parse(readFileSync(new URL("./obligations.json",import.meta.url)));
  for(const item of [
    {grade:"R",level:0,exp:0,stock:[60,40,20],group:"B07"},
    {grade:"SR",level:0,exp:0,stock:[80,20,10],group:"B11"},
    {grade:"R",level:12,exp:0,stock:[60,40,20],group:"B13"},
  ]) {
    const prices=data.groups[item.group].prices.map(p=>q(p.numerator,p.denominator));
    const endpoints=[{...item,id:"root"},
      {grade:item.grade,level:item.level,exp:200,stock:[item.stock[0]-10,...item.stock.slice(1)],id:"failure"},
      ...(item.level===12?[{grade:"SR",level:5,exp:0,stock:[60,40,10],id:"promotion"}]:[])];
    const actual=timed(item,prices,endpoints,{rows:100000,live:100000,deadline:performance.now()+15000});
    for(const e of endpoints) {
      const expected=solveOracle({...e,prices}),colors=["blue","purple","yellow"];
      assert.deepEqual(actual.answers[e.id],wire({P:expected.P,B:expected.B,C:expected.C,consumed:expected.consumed,
        mask:expected.ties.reduce((m,a)=>m|(colors.includes(a)?1<<colors.indexOf(a):0),0),
        chosen:expected.action==="DONE"?-2:colors.indexOf(expected.action)}));
    }
  }
  return {status:"PASS",count:cases.length+tiny.length+2+7,throughput:{
    rows,elapsedMs,rowsPerSecond:elapsedMs>0?rows*1000/elapsedMs:null,
    certifying:false,scope:"small_controls_including_graph_setup_not_main_prediction",
  }};
}
