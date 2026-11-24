// Preparer/verifier only. No signer, artifact publisher, legacy-ID converter or switch authority.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createPublicKey, hash, verify} from 'node:crypto';
import {appendFileSync,lstatSync,mkdtempSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {coverage} from './hybrid-b-policy-coverage.mjs';
import {claimFor, checkControl, exitFor, validateReport} from './hybrid-b-policy-evidence.mjs';
import {loadApproval,validateObserved} from '../../e2e/operational-report.mjs';
import {inventoryDigest} from './hybrid-b-policy-inventory.mjs';

export const profile = 'production-root-pair-hybrid-b-release-v2';
const pin = s => { assert.equal(typeof s,'string'); assert.match(s,/^[a-f0-9]{64}$/); return s; };
const id = n => { assert(Number.isSafeInteger(n) && n > 0); return n; };
const text = s => assert(typeof s === 'string' && s.trim().length > 0 && s.length <= 4096);
const keys = (obj,names) => assert.deepEqual(Object.keys(obj).sort(),[...names].sort());

// Verify the digest-checked service ZIP snapshot on stdin, never extract paths.
export function archiveMembers(bytes, supplemental=false) {
  assert(bytes.length > 0 && bytes.length <= (supplemental?8*1024*1024+65536:1024*1024));
  const program = `
import hashlib,io,json,stat,sys,zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as z:
    entries=z.infolist()
    if not 1<=len(entries)<=8: raise ValueError('member count')
    out={}
    for i in entries:
        limit=8*1024*1024 if sys.argv[1]=='supplement' and i.filename=='report.json' else 16384
        if i.filename in out or i.file_size>limit or i.flag_bits&1 or stat.S_IFMT(i.external_attr>>16) not in (0,stat.S_IFREG): raise ValueError('invalid member')
        out[i.filename]=hashlib.sha256(z.read(i)).hexdigest()
    print(json.dumps(out))
`;
  return JSON.parse(execFileSync('python3',['-IB','-c',program,supplemental?'supplement':'small'],{input:bytes,maxBuffer:8192,timeout:5000}));
}

// Both independently enrolled environment keys sign these same exact bytes, NOT a transition grant.
export function policyAuthority(keyBytes, signatures, reviewSha256, repository, source, expiresAt, now=Date.now()) {
  const enrolled = JSON.parse(keyBytes); keys(enrolled,['owner','review']); keys(signatures,['owner','review']);
  const scope=['approve-preparation-policy-only-v3',profile,repository,source,pin(reviewSha256)];
  const reviewAt=signatures.review.signedAt,ownerAt=signatures.owner.signedAt;
  assert([reviewAt,ownerAt,expiresAt].every(Number.isSafeInteger) && 0<reviewAt && reviewAt<ownerAt &&
    ownerAt<=now && now<expiresAt && expiresAt-reviewAt<=86400000,'invalid attestation order or validity');
  assert.notEqual(enrolled.owner,enrolled.review);
  for (const role of ['review','owner']) {
    const x = enrolled[role]; keys(signatures[role],['signedAt','signature']);
    const {signedAt,signature}=signatures[role];
    const bytes=Buffer.from(JSON.stringify([...scope,role,signedAt,role==='review'?null:signatures.review.signature]));
    assert.match(x,/^[\w-]{43}$/); assert.equal(Buffer.from(x,'base64url').toString('base64url'),x);
    assert.match(signature,/^[A-Za-z0-9+/]{86}==$/);
    assert(verify(null,bytes,createPublicKey({format:'jwk',key:{kty:'OKP',crv:'Ed25519',x}}),Buffer.from(signature,'base64')),`missing authentic ${role} policy approval`);
  }
}

// Reviewed source policy, not a default waiver. Mixed obligations stay applicable; a row with a
// residual requires its own real corroborating observation, not merely a green related BA/BP ID.
const direct = new Set(['P001','P002','P003','P004','P005','P007','P008','A031']);
const disabledOnly = new Set(('A001 A002 A003 A004 A005 A006 A008 A009 A010 A011 A012 A013 A033 A035 A036 A037 A039 A040').split(' '));

// Native Playwright JSON output from the enrolled supplemental spec; a reviewer
// table or manually normalized 'passed' object cannot replace this first attempt.
function supplementalCases(report,expected,settings) {
  assert.deepEqual(report.errors,[]); assert.equal(report.config.workers,1); assert(!report.config.shard);
  assert.equal(report.config.projects.length,1);
  const [project]=report.config.projects; assert.equal(project.retries,0); assert.equal(project.repeatEach,1);
  assert.equal(project.name,settings.project); assert.equal(report.stats.expected,expected.length);
  for(const k of ['skipped','unexpected','flaky']) assert.equal(report.stats[k],0);
  const seen=new Set();
  function visit(suite) {
    for(const spec of suite.specs??[]) {
      assert.equal(spec.file,settings.file); assert.equal(spec.ok,true); assert(!seen.has(spec.title));
      assert(expected.includes(spec.title)); seen.add(spec.title); assert.equal(spec.tests.length,1);
      const [t]=spec.tests; assert.equal(t.projectName,settings.project); assert.equal(t.expectedStatus,'passed');
      assert.equal(t.status,'expected'); assert.equal(t.results.length,1);
      const [r]=t.results; assert.equal(r.retry,0); assert.equal(r.status,'passed'); assert.deepEqual(r.errors,[]);
    }
    for(const s of suite.suites??[]) visit(s);
  }
  visit(report); assert.equal(seen.size,expected.length);
}
export function checkObligations(rows,original) {
  const obligations = coverage(); assert.deepEqual(rows.map(r => r.id),obligations.map(r => r.id));
  for (const [i,r] of rows.entries()) {
    const o = obligations[i]; keys(r,['id','related','disposition','reason','proofSha256']);
    assert.deepEqual(r.related,o.related); text(r.reason);
    if (r.disposition === 'outside-disabled-profile') assert(disabledOnly.has(r.id),'applicable obligation cannot be waived');
    else if (r.disposition === 'verified-by-candidate') assert(direct.has(r.id),'candidate case does not cover residual');
    else assert.equal(r.disposition,'verified-by-supplement');
    // Original source/control proof of inapplicability OR independent, successful applicable test.
    // A digest, free-text reference or candidate report renamed as that proof is not the evidence.
    const proof = original(r.proofSha256);
    if (r.disposition === 'verified-by-supplement') {
      assert.equal(proof.profile,'hybrid-b-requirement-test-v1'); assert.equal(proof.id,r.id);
      assert.equal(proof.attempt,1); assert.equal(proof.outcome,'passed'); text(proof.assertion);
    } else if (r.disposition === 'outside-disabled-profile') {
      assert.equal(proof.profile,'hybrid-b-applicability-v1'); assert.equal(proof.id,r.id); text(proof.unreachablePath);
    } else { assert.equal(proof.profile,'hybrid-b-case-comparison-v1'); assert.equal(proof.id,r.id); text(proof.differences); }
  }
}

// read(name, digest) returns the exact pinned original bytes. No diagnostic inspect output is trusted.
export function qualify(raw, review, enrollment, read, checkPair, config, service) {
  const qualificationSha256=hash('sha256',raw);
  assert.equal(qualificationSha256,pin(config.qualificationSha256),'qualification byte pin mismatch');
  const q=JSON.parse(raw);
  const {source,repository,enrollmentContractSha256} = review;
  keys(q,['profile','source','packet','campaign','control','product','analytics','custody','obligations','rootNumerical','rootProduct','numerical']);
  assert.equal(q.profile,'hybrid-b-exact-campaign-qualification-v2'); assert.equal(q.source,source);
  const obj = (name,key) => JSON.parse(read(name,pin(key)));
  const packet = obj('qa/private-root-pair.json',q.packet); checkPair(review,packet);
  const {statementSha256} = packet.review; pin(statementSha256);
  assert.deepEqual(packet.review,{...JSON.parse(enrollment),source,contractSha256:enrollmentContractSha256,statementSha256});
  const campaign = obj('qa/hybrid-b-campaign.json',q.campaign);
  assert.match(campaign.id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.deepEqual(campaign,{profile:'hybrid-b-policy-campaign-v2',id:campaign.id,packetSha256:q.packet,harness:source,controlSha256:q.control,releaseAdmission:false});
  const control=checkControl(obj('qa/supply-readiness.json',q.control),source,q.packet);
  read(`proofs/${control.oracleSha256}.bin`,control.oracleSha256);
  const numerical=obj('numerical-boundary.json',q.numerical),approval=loadApproval('numerical-boundary');
  assert.deepEqual(numerical,{schemaVersion:1,suiteId:'numerical-boundary',inventoryDigest:approval.digest,cases:numerical.cases,complete:true});
  assert(validateObserved(approval.ids,numerical.cases,true).complete);
  for (const suite of ['product','analytics']) {
    const d = q[suite]; keys(d,['claim','report','exit']);
    const record = kind => obj(`qa/hybrid-b-${suite}-${kind}.json`,d[kind]);
    assert.deepEqual(record('claim'),claimFor(suite,q.packet,source,q.campaign));
    validateReport(record('report'),suite,d.claim);
    assert.deepEqual(record('exit'),exitFor(suite,d.claim,d.report,true));
  }
  // Service-observed owner allocation, never a claim of independent physical custody.
  const actualRepo=service(''); assert.equal(actualRepo.id,id(config.repositoryId));
  assert.equal(actualRepo.private,true); assert.equal(actualRepo.owner.id,id(config.ownerId));
  const c = obj('qa/custody.json',q.custody);
  assert.equal(c.profile,'owner-precommit-with-technical-review-v2'); assert.equal(c.independentCustody,false);
  assert.equal(c.releaseAdmission,false); assert.equal(c.repositoryId,id(config.repositoryId)); assert.equal(c.source,source);
  assert.equal(c.packet,q.packet); assert.equal(c.campaign,q.campaign); assert.equal(c.workflowAttempt,1);
  assert.deepEqual(c.product,q.product); assert.deepEqual(c.analytics,q.analytics);
  assert.equal(c.operatorId,id(config.ownerId)); assert.equal(c.builderId,c.operatorId);
  assert(!Object.hasOwn(c,'witnessId'));
  const rawTech=Buffer.from(config.technicalPublicKeyBase64,'base64');
  assert.equal(rawTech.length,32); assert.equal(rawTech.toString('base64'),config.technicalPublicKeyBase64);
  const technicalKeySha256=hash('sha256',rawTech);
  const phases=['build','open','suites','supplement'], locations=phases.map(phase=>c[phase]);
  const comments={},jobs={};
  for (const [i,loc] of locations.entries()) {
    const phase=phases[i];
    id(loc.run); id(loc.workflow); assert.equal(loc.attempt,1); id(loc.ordinal);
    assert.match(loc.qaSource,/^[a-f0-9]{40}$/); assert.equal(loc.qaSource,i?config.campaignSource:config.builderSource);
    const r = obj(`qa/${phase}-run.json`,loc.runSha256);
    const live=service(`actions/runs/${loc.run}/attempts/1`);
    for(const k of ['id','workflow_id','run_attempt','head_branch','head_sha','run_number','event','path','status','conclusion','created_at','display_title'])
      assert.deepEqual(r[k],live[k],`wrong service run ${k}`);
    for(const k of ['actor','triggering_actor','repository','head_repository']) assert.equal(r[k].id,live[k].id);
    assert.equal(r.id,loc.run); assert.equal(r.workflow_id,loc.workflow); assert.equal(r.run_attempt,1);
    assert.equal(r.repository.id,c.repositoryId); assert.equal(r.head_repository.id,c.repositoryId);
    assert.equal(r.repository.private,true); assert.equal(r.head_branch,'main'); assert.equal(r.head_sha,loc.qaSource);
    assert.equal(r.run_number,loc.ordinal); assert.equal(r.event,'workflow_dispatch');
    assert.equal(r.path,phase==='supplement'?config.supplementPath:i?config.campaignPath:config.builderPath);
    assert.equal(r.status,'completed'); assert.equal(r.conclusion,'success');
    assert.equal(r.actor.id,i ? c.operatorId : c.builderId); assert.equal(r.triggering_actor.id,r.actor.id);
    assert.equal(r.created_at,loc.createdAt); assert(Number.isFinite(Date.parse(loc.createdAt)));
    const j=obj(`qa/${phase}-job.json`,loc.jobSha256);
    const list=service(`actions/runs/${loc.run}/attempts/1/jobs?per_page=100`);
    assert.equal(list.total_count,1); assert.equal(list.jobs.length,1);
    for(const k of ['id','name','head_sha','run_id','run_attempt','status','conclusion','started_at','completed_at','steps'])
      assert.deepEqual(j[k],list.jobs[0][k],`wrong service job ${k}`);
    assert.equal(j.name,config.jobs[phase].name);
    const steps=config.jobs[phase].requiredSteps; assert(steps.length && new Set(steps).size===steps.length);
    for(const step of steps) assert.equal(j.steps.filter(s=>s.name===step && s.conclusion==='success').length,1);
    jobs[phase]=j;
    id(j.id); assert.equal(j.run_id,loc.run); assert.equal(j.run_attempt,1); assert.equal(j.head_sha,loc.qaSource);
    assert.equal(j.status,'completed'); assert.equal(j.conclusion,'success'); assert.equal(j.completed_at,loc.completedAt);
    assert(Date.parse(loc.createdAt)<=Date.parse(j.started_at) && Date.parse(j.started_at)<Date.parse(loc.completedAt));
    if(phase!=='build') {
      const name={open:'open-precommit',suites:'precommit',supplement:'supplement-precommit'}[phase];
      const comment=obj(`qa/${name}.json`,loc.commentSha256),cid=id(comment.id);
      const current=service(`comments/${cid}`);
      for(const k of ['id','commit_id','path','created_at','updated_at','body']) assert.deepEqual(current[k],comment[k]);
      assert.equal(current.user.id,c.operatorId); assert.equal(comment.user.id,c.operatorId); assert.equal(current.user.type,'User');
      assert.equal(comment.path,null); assert.equal(comment.commit_id,loc.qaSource);
      assert.equal(comment.created_at,comment.updated_at); assert(Date.parse(comment.created_at)<Date.parse(loc.createdAt));
      assert.equal(comment.author_association,'OWNER'); assert.equal(current.author_association,'OWNER');
      const body=JSON.parse(comment.body),bodySha=hash('sha256',comment.body);
      assert.equal(r.display_title,`owner-v1:${phase}:${cid}:${bodySha}`);
      assert.equal(body.phase,phase); assert.equal(body.source,source); assert.equal(body.repo,c.repositoryId);
      assert.equal(body.profile,'successor-first-use-v2'); assert.equal(body.independentCustody,false);
      assert.equal(body.workflow,loc.workflow); assert.equal(body.slot,loc.ordinal); assert.equal(body.attempt,1);
      assert.equal(body.qa,loc.qaSource); assert.equal(body.build.packetSha256,q.packet);
      const b=body.build;
      assert.equal(b.source,source); assert.equal(b.buildRun,c.build.run); assert.equal(b.buildAttempt,1);
      assert.equal(b.qaBuildSha,c.build.qaSource); assert.equal(b.artifactId,c.archives.builder.id); assert.equal(b.zipSha256,c.archives.builder.zipSha256);
      assert.equal(b.formalWorkflow,c.open.workflow); assert.equal(b.firstSlot,c.open.ordinal);
      assert.equal(b.supplementWorkflow,c.supplement.workflow); assert.equal(b.supplementSlot,c.supplement.ordinal);
      assert.deepEqual(body.material.control,control); assert.equal(body.releaseAdmission,false);
      if(phase==='open') {
        const {signature,...advisory}=body.material.review;
        assert.deepEqual(advisory,{profile:'automated-advisory-supply-review-v1',source,packetSha256:q.packet,controlSha256:q.control,
          oracleSha256:control.oracleSha256,technicalKeySha256,reviewedAt:advisory.reviewedAt,independentCustody:false,releaseAdmission:false});
        assert(Number.isSafeInteger(advisory.reviewedAt) && control.verifiedAt<=advisory.reviewedAt && advisory.reviewedAt<Date.parse(comment.created_at));
        assert.match(signature,/^[A-Za-z0-9+/]{86}==$/);
        assert(verify(null,Buffer.from(JSON.stringify(advisory,Object.keys(advisory).sort())),
          createPublicKey({format:'jwk',key:{kty:'OKP',crv:'Ed25519',x:rawTech.toString('base64url')}}),Buffer.from(signature,'base64')));
      } else assert.deepEqual(body.material,comments.open.body.material);
      comments[phase]={body,at:Date.parse(comment.created_at),cid,bodySha};
    }
  }
  assert(Date.parse(c.build.completedAt)<=control.verifiedAt && control.verifiedAt<comments.open.at);
  assert.equal(c.open.qaSource,c.suites.qaSource); assert.equal(c.open.ordinal+1,c.suites.ordinal);
  assert.equal(c.supplement.qaSource,c.suites.qaSource); assert.notEqual(c.supplement.workflow,c.suites.workflow);
  assert.equal(new Set(locations.map(l=>l.run)).size,4); assert.equal(c.open.workflow,c.suites.workflow);
  // Dedicated QA commit: even an unmatched/cancelled alternative self-precommit is
  // a conflict. Bounded complete listing; stop rather than silently truncate history.
  const thread=service(`commits/${c.open.qaSource}/comments?per_page=100`);
  assert(Array.isArray(thread) && thread.length<100);
  assert.deepEqual(thread.map(x=>x.id).sort((a,b)=>a-b),Object.values(comments).map(x=>x.cid).sort((a,b)=>a-b));
  for(const [role,expected] of [['build',[c.build]],['campaign',[c.open,c.suites]],['supplement',[c.supplement]]]) {
    const first=expected[0],before=config.priorRuns[role],ids=[...before,...expected.map(l=>l.run)];
    assert.equal(before.length+1,first.ordinal); assert.equal(new Set(ids).size,ids.length);
    const history=service(`actions/workflows/${first.workflow}/runs?per_page=100`);
    assert.equal(history.total_count,ids.length); assert.equal(history.workflow_runs.length,ids.length);
    const rows=[...history.workflow_runs].sort((a,b)=>a.run_number-b.run_number);
    for(const [i,r] of rows.entries()) {
      assert.equal(r.run_number,i+1); assert.equal(r.id,id(ids[i])); assert.equal(r.workflow_id,first.workflow); assert.equal(r.status,'completed');
      if(i>=before.length) assert.equal(r.run_attempt,1,'original slot was rerun');
    }
  }
  for (const [name,phase] of [['builder','build'],['open','open'],['product','suites'],['analytics','suites'],['supplement','supplement']]) {
    const loc=c[phase];
    const a = c.archives[name]; id(a.id); pin(a.zipSha256); assert.equal(a.run,loc.run);
    const m = obj(`qa/${name}-artifact.json`,a.metadataSha256);
    const current=service(`actions/artifacts/${a.id}`);
    for(const k of ['id','name','digest','created_at','workflow_run']) assert.deepEqual(m[k],current[k]);
    assert.equal(m.id,a.id); assert.equal(m.digest,`sha256:${a.zipSha256}`);
    assert.equal(m.workflow_run.id,loc.run); assert.equal(m.workflow_run.head_sha,loc.qaSource);
    assert.equal(m.workflow_run.repository_id,c.repositoryId); assert.equal(m.workflow_run.head_repository_id,c.repositoryId);
    assert.equal(m.name,a.name); assert.equal(m.name,`${config.artifactPrefixes[name]}-${loc.run}-1`);
    const at=Date.parse(m.created_at); assert(Date.parse(jobs[phase].started_at)<=at && at<=Date.parse(loc.completedAt));
    if (name !== 'builder') {
      const members = name === 'open' ? {'hybrid-b-campaign.json':q.campaign} : name==='supplement' ?
        {'report.json':pin(config.supplement.reportSha256),'supplemental.status':hash('sha256','0\n')} :
        Object.fromEntries([...['claim','report','exit'].map(k=>[`hybrid-b-${name}-${k}.json`,q[name][k]]),
          [`${name}.status`,hash('sha256','0\n')]]);
      assert.deepEqual(archiveMembers(read(`qa/${name}.zip`,a.zipSha256),name==='supplement'),members);
    }
  }
  assert.equal(new Set(Object.values(c.archives).map(a=>a.id)).size,5);
  const residual=q.obligations.filter(r=>r.disposition==='verified-by-supplement');
  const spec=config.supplement;
  assert.match(spec.file,/^[a-zA-Z0-9_/-]+\.spec\.[cm]?[jt]s$/);
  const originalSpec=read(`proofs/${pin(spec.specSha256)}.bin`,spec.specSha256);
  assert(originalSpec.length>0);
  const supplementalReport=JSON.parse(read(`proofs/${pin(spec.reportSha256)}.bin`,spec.reportSha256));
  supplementalCases(supplementalReport,residual.map(r=>'B-'+r.id),spec);
  const proof = key => {
    const p = obj(`proofs/${pin(key)}.json`,key);
    assert.equal(p.source,source); assert.equal(p.packet,q.packet); assert.equal(p.repository,repository);
    assert.equal(p.releaseAdmission,false); text(p.method);
    if(p.profile==='hybrid-b-requirement-test-v1') {
      assert.equal(p.specSha256,spec.specSha256); assert.equal(p.originalSha256,spec.reportSha256);
      assert.equal(p.case,'B-'+p.id);
    }
    // Actual underlying record, not just its self-described path.
    read(`proofs/${pin(p.originalSha256)}.bin`,p.originalSha256);
    return p;
  };
  assert.equal(comments.open.body.opened,null);
  const opened=comments.suites.body.opened; assert.equal(opened.run,c.open.run); assert.equal(opened.campaign,q.campaign);
  assert.equal(opened.artifact,c.archives.open.id); assert.equal(opened.zip,c.archives.open.zipSha256); assert.equal(opened.uuid,campaign.id);
  assert.equal(opened.comment,comments.open.cid); assert.equal(opened.bodySha,comments.open.bodySha);
  const allocation=opened.allocation;
  assert.deepEqual(allocation,{profile:'hybrid-b-first-use-allocation-v2',repositoryId:c.repositoryId,
    source,packet:q.packet,campaign:q.campaign,workflow:c.suites.workflow,ordinal:c.suites.ordinal,
    qaSource:c.suites.qaSource,controlSha256:q.control,attempt:1,operatorId:c.operatorId,technicalKeySha256,independentCustody:false,
    supplementSpecSha256:spec.specSha256,
    openRun:c.open.run,openArchiveSha256:c.archives.open.zipSha256,allocatedAt:allocation.allocatedAt,releaseAdmission:false});
  assert(Date.parse(c.open.completedAt)<Date.parse(allocation.allocatedAt) && Date.parse(allocation.allocatedAt)<comments.suites.at);
  const next=comments.supplement.body.opened;
  const {supplementAllocation:s,suitesComment,suitesCommentSha,...prior}=next;
  assert.deepEqual(prior,opened);
  assert.equal(suitesComment,comments.suites.cid); assert.equal(suitesCommentSha,comments.suites.bodySha);
  assert.deepEqual(s,{profile:'hybrid-b-supplement-allocation-v1',repositoryId:c.repositoryId,source,packet:q.packet,campaign:q.campaign,
    controlSha256:q.control,supplementSpecSha256:spec.specSha256,qaSource:c.supplement.qaSource,workflow:c.supplement.workflow,
    ordinal:c.supplement.ordinal,attempt:1,operatorId:c.operatorId,technicalKeySha256,independentCustody:false,
    openRun:c.open.run,suitesRun:c.suites.run,productArtifactId:c.archives.product.id,productArchiveSha256:c.archives.product.zipSha256,
    analyticsArtifactId:c.archives.analytics.id,analyticsArchiveSha256:c.archives.analytics.zipSha256,allocatedAt:s.allocatedAt,releaseAdmission:false});
  assert(Date.parse(c.suites.completedAt)<Date.parse(s.allocatedAt) && Date.parse(s.allocatedAt)<comments.supplement.at);
  const start=Date.parse(supplementalReport.stats.startTime),end=start+supplementalReport.stats.duration;
  assert(Number.isFinite(supplementalReport.stats.duration) && supplementalReport.stats.duration>0);
  assert(Date.parse(jobs.supplement.started_at)<=start && start<=end && end<=Date.parse(c.supplement.completedAt)+1000,'report outside allocated job');
  checkObligations(q.obligations,proof);
  for (const [key,name] of [['rootNumerical','root-numerical'],['rootProduct','root-product']]) {
    pin(q[key]);
    const p = obj(`${name}.json`,q[key]); assert.equal(p.profile,`hybrid-b-${name}-review-v2`);
    assert.equal(p.source,source); assert.equal(p.packet,q.packet); assert.equal(p.openBlockers,0);
    assert.equal(p.nativeWasmSha256,packet.review.nativeWasmSha256); assert.equal(p.serviceCodeHash,packet.review.serviceCodeHash);
    if (key==='rootNumerical') assert.equal(p.numericalBoundarySha256,q.numerical);
    else assert.deepEqual(p.locales,['ko','en','ja']);
    text(p.method); text(p.findings); assert.equal(p.releaseAdmission,false);
    read(`proofs/${pin(p.originalSha256)}.bin`,p.originalSha256);
  }
  return {profile:'hybrid-b-redacted-proof-v3',policy:'adaptive-next-batch-balanced-v1',source,repository,
    custody:'owner-precommit-with-technical-review-v2',independentCustody:false,technicalKeySha256,
    enrollmentContractSha256,headersSha256:review.headersSha256,forwardSha256:review.directions.forward.servedSha256,
    rollbackSha256:review.directions.rollback.servedSha256,nativeWasmSha256:packet.review.nativeWasmSha256,serviceCodeHash:packet.review.serviceCodeHash,
    qualificationSha256,supplyReadinessSha256:q.control,packetSha256:q.packet,
    numericalSha256:q.numerical,rootNumericalSha256:q.rootNumerical,rootProductSha256:q.rootProduct,
    inventories:{product:inventoryDigest('product'),analytics:inventoryDigest('analytics'),numerical:approval.digest},
    obligations:q.obligations.map(r=>[r.id,r.disposition]),complete:true,releaseAdmission:false};
}

// PUBLIC boundary: nothing accepted from the original QA bundle. The technical signer
// separately verifies those bytes and the service ledger in private before signing the pin.
export function checkRedaction(p,r,enrollment,technicalKeySha256) {
  const obligations=coverage(); assert.equal(p.obligations.length,obligations.length);
  for(const [i,row] of p.obligations.entries()) {
    const {id}=obligations[i]; assert(Array.isArray(row) && row.length===2 && row[0]===id);
    assert(row[1]==='verified-by-supplement' || (row[1]==='verified-by-candidate' && direct.has(id)) ||
      (row[1]==='outside-disabled-profile' && disabledOnly.has(id)));
  }
  const e=JSON.parse(enrollment);
  assert.notEqual(technicalKeySha256,hash('sha256',Buffer.from(e.publicKeyBase64,'base64')),'producer key cannot be advisory authority');
  assert.deepEqual(p,{profile:'hybrid-b-redacted-proof-v3',policy:'adaptive-next-batch-balanced-v1',source:r.source,repository:r.repository,
    custody:'owner-precommit-with-technical-review-v2',independentCustody:false,technicalKeySha256:pin(technicalKeySha256),
    enrollmentContractSha256:r.enrollmentContractSha256,headersSha256:r.headersSha256,forwardSha256:r.directions.forward.servedSha256,
    rollbackSha256:r.directions.rollback.servedSha256,nativeWasmSha256:e.nativeWasmSha256,serviceCodeHash:e.serviceCodeHash,
    ...Object.fromEntries(['qualificationSha256','supplyReadinessSha256','packetSha256','numericalSha256','rootNumericalSha256','rootProductSha256'].map(k=>[k,pin(p[k])])),
    inventories:{product:inventoryDigest('product'),analytics:inventoryDigest('analytics'),numerical:loadApproval('numerical-boundary').digest},
    obligations:p.obligations,complete:true,releaseAdmission:false});
}

// Private verification CLI; stdout is the strict redacted projection only. Protected
// configuration and original evidence stay outside the public carrier. No signing.
export function privateQualification([bundle,settings,...extra],checkPair,harnessSource,root) {
  function pinned(path,digest) {
    assert.equal(realpathSync(path),path); const st=lstatSync(path);
    assert(st.isFile() && st.size>0 && st.size<=8*1024*1024+(path.endsWith('/supplement.zip')?65536:0));
    const b=readFileSync(path); assert.equal(hash('sha256',b),pin(digest)); return b;
  }
  try {
    assert(!extra.length && realpathSync(bundle)===bundle);
    const bstat=lstatSync(bundle); assert(bstat.isDirectory() && (bstat.mode&0o077)===0 && bstat.uid===process.getuid());
    const cfg=JSON.parse(pinned(settings,process.env.ROOT_POLICY_QUALIFICATION_CONFIG_SHA256));
    const read=(name,digest)=>pinned(join(bundle,name),digest);
    const qualification=read('qualification.json',cfg.qualificationSha256);
    assert.equal(cfg.scope.source,harnessSource());
    const enrollment=readFileSync(join(root,'site-worker/production-root-release-v1.json'));
    assert.equal(cfg.scope.enrollmentContractSha256,hash('sha256',enrollment));
    assert.match(cfg.serviceRepository,/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/);
    // Require service records, not a transcript assembled by the operator.
    // No write flags, shell, arbitrary host, redirect logging or credential forwarding.
    const token=process.env.ROOT_POLICY_SERVICE_READ_TOKEN; assert(token,'private read-only service credential required');
    const snapshot=mkdtempSync(join(bundle,'service-originals-'));
    const service=path=>{
      const bytes=execFileSync('gh',['api','--hostname','github.com','--method','GET',
        `repos/${cfg.serviceRepository}${path?'/'+path:''}`],{env:{PATH:process.env.PATH,HOME:process.env.HOME,
          GH_TOKEN:token,GH_PROMPT_DISABLED:'1'},stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:4*1024*1024});
      const digest=hash('sha256',bytes);
      const file=hash('sha256',path)+'-'+digest+'.json';
      writeFileSync(join(snapshot,file),bytes,{flag:'wx',mode:0o600});
      appendFileSync(join(snapshot,'index.jsonl'),JSON.stringify({path,digest,file})+'\n',{mode:0o600});
      return JSON.parse(bytes);
    };
    const redacted=qualify(qualification,cfg.scope,enrollment,read,checkPair,cfg,service);
    checkRedaction(redacted,cfg.scope,enrollment,hash('sha256',Buffer.from(cfg.technicalPublicKeyBase64,'base64')));
    console.log(JSON.stringify(redacted));
  } catch { console.error('OWNER_CAMPAIGN_QUALIFICATION_WITHHELD'); process.exitCode=1; }
}
