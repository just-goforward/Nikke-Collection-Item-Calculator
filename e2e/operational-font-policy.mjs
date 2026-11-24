import assert from 'node:assert/strict';

// Historical document literals, not the current application's first-party fonts.
const prefix='https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable';
const styles=new Map([['ko',''],['en','-std'],['ja','-jp']].map(([locale,suffix])=>[locale,`${prefix}${suffix}-dynamic-subset.min.css`]));

export function isExpectedBlockedFont({ url, method, resourceType }) {
  return method === "GET" && resourceType === "stylesheet" &&
    [...styles.values()].includes(url);
}

// Call bind only after independent verification of the document bytes. href is
// the exact navigation URL, key is the receipt path. Nothing here proxies traffic.
export function legacyFontAudit(context,origin) {
  const frames=new WeakMap(),pending=new Map(),evidence=[],documents=[];
  let bad=false;
  context.on('response',res=>{if(new URL(res.url()).origin!==origin)bad=true;});
  context.on('requestfailed',req=>{
    const entry=pending.get(req);if(!entry)return;
    if(!/^net::ERR_BLOCKED_BY_CLIENT(?:\.Inspector)?$/.test(req.failure()?.errorText??''))bad=true;
    else entry.requestfailed=true;
    pending.delete(req);
  });
  return {
    bind(frame,{role,tree,key,href,servedHash,legacyHash}) {
      assert(frame===frame.page().mainFrame() && ['old','new','witness'].includes(role));
      assert(tree==='forward'||tree==='rollback');
      frames.delete(frame);
      const m=/^\/(?:(en|ja)\/)?(index|privacy|terms|licenses)\.html$/.exec(key);
      assert(m && /^[a-f0-9]{64}$/.test(servedHash) && /^[a-f0-9]{64}$/.test(legacyHash));
      assert(href===origin+key || href===origin+key.replace(/index\.html$|\.html$/,''));
      if(m[2]==='index' && tree==='forward')return;
      assert.equal(servedHash,legacyHash,'not a verified historical document');
      const doc={role,tree,key,href,sha256:servedHash,locale:m[1]??'ko',limit:m[2]==='index'?2:1,count:0};
      frames.set(frame,doc);documents.push(doc);
    },
    async block(route) {
      const req=route.request(),url=req.url();
      if(!isExpectedBlockedFont({url,method:req.method(),resourceType:req.resourceType()}))return false;
      const frame=req.frame(),doc=frames.get(frame);
      if(!doc || doc.href!==frame.url() || styles.get(doc.locale)!==url || req.postDataBuffer()!==null ||
          req.redirectedFrom() || req.redirectedTo() || doc.count>=doc.limit)return false;
      doc.count++;
      const h=await req.allHeaders();
      assert(!('cookie' in h || 'authorization' in h || 'proxy-authorization' in h),'credentialed historical stylesheet');
      const entry={role:doc.role,tree:doc.tree,key:doc.key,sha256:doc.sha256,method:'GET',
        path:`legacy-cdn-stylesheet-${doc.locale}`,blocked:false,requestfailed:false};
      pending.set(req,entry);evidence.push(entry);
      await route.abort('blockedbyclient');entry.blocked=true;
      return true;
    },
    finish() {
      assert(!bad && !pending.size && evidence.every(x=>x.blocked && x.requestfailed),'unconfirmed block or external response');
      assert(documents.every(doc=>doc.count>0),'missing historical stylesheet observation');
      return evidence;
    }
  };
}
