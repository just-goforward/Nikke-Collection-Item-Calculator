import assert, { deepStrictEqual } from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { isExpectedBlockedFont, legacyFontAudit } from "./operational-font-policy.mjs";

const urls = [
  "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css",
  "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-std-dynamic-subset.min.css",
  "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-jp-dynamic-subset.min.css",
];
test("only existing exact locale stylesheet GETs receive the blocked-font classification", () => {
  for (const url of urls)
    deepStrictEqual(isExpectedBlockedFont({ url, method: "GET", resourceType: "stylesheet" }), true);
});
test("mutations, other resource types and nonexact external URLs remain unexpected", () => {
  for (const method of ["POST", "PUT", "HEAD"])
    deepStrictEqual(isExpectedBlockedFont({ url: urls[0], method, resourceType: "stylesheet" }), false);
  for (const resourceType of ["font", "fetch", "script", "image"])
    deepStrictEqual(isExpectedBlockedFont({ url: urls[0], method: "GET", resourceType }), false);
  for (const url of [urls[0] + "?extra=1", urls[0].replace("@v1.3.9", "@latest"),
    "https://cdn.jsdelivr.net/unrelated.css", "https://other.invalid/font.css",
    "http://127.0.0.1:4290/api/stats"])
    deepStrictEqual(isExpectedBlockedFont({ url, method: "GET", resourceType: "stylesheet" }), false);
});

const site='https://nikkecollection.com',sha='a'.repeat(64);
function fixture(key='/en/privacy.html',tree='forward') {
  const ctx=new EventEmitter(), audit=legacyFontAudit(ctx,site);
  const href=site+key, frame={url:()=>href,page:()=>({mainFrame:()=>frame})};
  const doc={role:'new',tree,key,href,servedHash:sha,legacyHash:sha};
  const req={frame:()=>frame,url:()=>urls[1],method:()=>'GET',resourceType:()=>'stylesheet',postDataBuffer:()=>null,
    redirectedFrom:()=>null,redirectedTo:()=>null,allHeaders:async()=>({}),failure:()=>({errorText:'net::ERR_BLOCKED_BY_CLIENT'})};
  const route={request:()=>req,abort:async reason=>{assert.equal(reason,'blockedbyclient');ctx.emit('requestfailed',req);}};
  return {ctx,audit,frame,doc,req,route};
}
test('only verified legacy documents can record a matching failed request, with bounded multiplicity',async()=>{
  for(const [key,tree,count] of [['/en/privacy.html','forward',1],['/en/terms.html','rollback',1],['/en/index.html','rollback',2]]) {
    const {audit,doc,frame,route}=fixture(key,tree);audit.bind(frame,doc);
    for(let i=0;i<count;i++)assert.equal(await audit.block(route),true);
    assert.equal(await audit.block(route),false);const rows=audit.finish();assert.equal(rows.length,count);
    assert(rows.every(r=>r.key===key && r.role==='new' && r.tree===tree && r.blocked && r.requestfailed && r.sha256===sha));
  }
});
test('unbound, current, tampered, wrong frame/locale, redirected and credentialed requests cannot pass',async()=>{
  const f=fixture();assert.equal(await f.audit.block(f.route),false);
  assert.throws(()=>f.audit.bind(f.frame,{...f.doc,servedHash:'b'.repeat(64)}));
  const fw=fixture('/en/index.html');fw.audit.bind(fw.frame,fw.doc);assert.equal(await fw.audit.block(fw.route),false);
  for(const override of [{url:()=>urls[0]},{url:()=>urls[1]+'?v=x'},{url:()=>urls[1]+'#x'},{frame:()=>({})},
    {method:()=>'POST'},{resourceType:()=>'fetch'},{postDataBuffer:()=>Buffer.from('x')},{redirectedFrom:()=>({})}]){
    const x=fixture();x.audit.bind(x.frame,x.doc);Object.assign(x.req,override);assert.equal(await x.audit.block(x.route),false);
  }
  for(const key of ['authorization','cookie','proxy-authorization']){
    const x=fixture();x.audit.bind(x.frame,x.doc);x.req.allHeaders=async()=>({[key]:'x'});await assert.rejects(x.audit.block(x.route));
  }
});
test('abort completion alone, a different failed Request, cancellation or external response is insufficient',async()=>{
  for(const mode of ['missing','other-request','cancelled','response','abort-failed']){
    const x=fixture();x.audit.bind(x.frame,x.doc);
    if(mode==='missing')x.route.abort=async()=>{};
    if(mode==='other-request')x.route.abort=async()=>{x.ctx.emit('requestfailed',{...x.req});};
    if(mode==='cancelled')x.req.failure=()=>({errorText:'net::ERR_ABORTED'});
    if(mode==='response')x.ctx.emit('response',{url:()=>urls[1]});
    if(mode==='abort-failed'){x.route.abort=async()=>{throw Error('closed');};await assert.rejects(x.audit.block(x.route));}
    else await x.audit.block(x.route);
    assert.throws(()=>x.audit.finish());
  }
});
