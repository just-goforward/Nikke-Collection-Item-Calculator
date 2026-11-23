import {rootCandidate,assertRootCandidateOrigin} from "./rootCandidate";
import { readBoundedJson } from '../../shared/boundedHttp.ts';
import { canonicalPublicationJson as json } from '../../shared/canonicalPublicationJson.ts';
import { certifiedCohortWeights, type CertifiedSupplyEvent, type CertifiedSupplySnapshot } from '../../shared/certifiedSupply.ts';
import { ruleAt } from '../../shared/certifiedSupplyModel.ts';
import { toWire } from '../../shared/certifiedRational.ts';
import { gameDayKey, gameDayStartMs, GAME_DAY_MS } from '../../shared/gameDay.ts';
import { nextReceiptPhase } from '../../shared/receiptClock.ts';
import { decodePublicationBase64, verifyPublicationSignature, type PublicationBytes } from '../../shared/forecastPublicationBytes.ts';
import { publicationBytesHash } from '../../shared/publicationBytesHash.ts';
import { runtimeForecastConfig } from './runtimeForecastConfig.ts';
const trust = rootCandidate ? {environment:'production',keyId:'production-conditional-v1',publicKeyBase64:import.meta.env.VITE_ROOT_CONDITIONAL_PUBLIC_KEY} : runtimeForecastConfig.trust;
import { previewLegacyD0Enabled } from './runtimeForecastConfig.ts';
import { PreviewSourceError } from './previewSourceError';

const omissions=['claim-history','unannounced-solo','collaboration-premium','mail-and-grants'];
const iso=(ms:number)=>new Date(ms).toISOString();
const demand=(ok:unknown)=>{if(!ok)throw Error('preview_joint_invalid');};
const fields=(x:unknown,keys:string)=>!!x&&typeof x==='object'&&Object.keys(x).sort().join(',')===keys;
let sequence=0,statement='';

export type PreviewJoint = { snapshot: CertifiedSupplySnapshot; sequence: number; until: number; wallUntil: number };

/** Re-fetch the primary in each JS realm. A caller cannot supply a lease, snapshot, or alternate key. */
export async function readPreviewJoint(base:CertifiedSupplySnapshot,publication:PublicationBytes,signal:AbortSignal,timedOff:PublicationBytes|null): Promise<PreviewJoint | null> {
  try { return await verifyJoint(base,publication,signal,timedOff); }
  catch (error) {
    if (signal.aborted && signal.reason?.name === 'TimeoutError') throw new PreviewSourceError('joint','timeout');
    signal.throwIfAborted();
    if (error instanceof PreviewSourceError || (error instanceof Error && error.message === 'preview_source_advanced')) throw error;
    throw new PreviewSourceError('joint','invalid');
  }
}
async function verifyJoint(base:CertifiedSupplySnapshot,publication:PublicationBytes,signal:AbortSignal,timedOff:PublicationBytes|null) {
  assertRootCandidateOrigin();
  demand(rootCandidate ? timedOff === null : previewLegacyD0Enabled && !!timedOff);
  const start=performance.now(), wallStart=Date.now();
  const response=await fetch(rootCandidate ? '/api/joint-supply/v2' : '/preview/api/joint-supply/v2',{credentials:'omit',cache:'no-store',redirect:'error',signal})
    .catch(() => { throw new PreviewSourceError('joint','network'); });
  if(response.status!==200){await response.body?.cancel();if(response.status===503||response.status===404)return null;
    throw new PreviewSourceError('joint',[502,504].includes(response.status)?'network':'missing');}
  demand(response.headers.get('content-type')?.split(';')[0]==='application/json');
  const wire=await readBoundedJson(response,65536,'preview_joint_size') as {statement:string;signature:string;remainingMs:number};
  demand(fields(wire,'remainingMs,signature,statement')&&Number.isSafeInteger(wire.remainingMs)&&wire.remainingMs>=0&&wire.remainingMs<=60000);
  const key=await crypto.subtle.importKey('raw',decodePublicationBase64(trust.publicKeyBase64),'Ed25519',false,['verify']);
  await verifyPublicationSignature({statement:wire.statement,signature:wire.signature},key);
  const doc=JSON.parse(wire.statement), p=JSON.parse(publication.pointer.statement),asOf=Date.parse(base.asOf),reset=gameDayStartMs(asOf);
  demand(json(doc)===wire.statement&&fields(doc,'basis,cohortPriors,days,domain,environment,events,expiresAt,futureLawSemantics,gameDay,issuedAt,keyId,laws,omissions,sequence,status,version')&&doc.domain===(rootCandidate ? 'nikke.production.conditional-joint-supply.v2' : 'nikke.preview.conditional-joint-supply.v2')&&doc.keyId===trust.keyId&&doc.environment===trust.environment&&doc.status==='partial'&&doc.version===base.version&&base.version==='certified-daily-v4'&&doc.futureLawSemantics===base.futureLawSemantics&&json(doc.laws)===json(base.laws)&&json(doc.cohortPriors)===json(certifiedCohortWeights(undefined,base.version).map(toWire))&&json(doc.omissions)===json(omissions));
  const rule=base.rules[0]!;
  demand(base.rules.length===1&&rule.id==='schedule-kit-v4:documented-physical-supply-v2'&&
    fields(doc.basis,'candidateId,contentHash,ruleId,sequence')&&doc.basis.ruleId===rule.id&&
    Number.isSafeInteger(doc.basis.sequence)&&doc.basis.sequence>=p.sequence&&
    typeof doc.basis.candidateId==='string'&&/^forecast-[a-z0-9-]{8,120}$/.test(doc.basis.candidateId)&&
    typeof doc.basis.contentHash==='string'&&/^[a-f0-9]{64}$/.test(doc.basis.contentHash));
  if(doc.basis.sequence===p.sequence)demand(doc.basis.candidateId===p.candidateId&&doc.basis.contentHash===p.contentHash);
  demand(Number.isSafeInteger(doc.sequence)&&doc.sequence===doc.issuedAt&&doc.sequence>0&&Number.isSafeInteger(doc.expiresAt)&&doc.expiresAt>doc.issuedAt&&doc.expiresAt<=Math.min(reset+GAME_DAY_MS,doc.issuedAt+900000)&&doc.gameDay===gameDayKey(reset)&&doc.gameDay===gameDayKey(doc.issuedAt)&&Array.isArray(doc.days)&&doc.days.length===15&&Array.isArray(doc.events)&&doc.events.length<=64);
  if(asOf>Date.now()||doc.issuedAt>Date.now())throw new PreviewSourceError('joint','clock');
  const events:CertifiedSupplyEvent[]=[];
  demand(doc.events.length>0&&rule.weeklyFixed?.length&&rule.soloDays.length===7);
  const endsByKind=new Map<string,string>();
  for(const e of doc.events){
    demand(fields(e,'endsAt,kind,sourceHash,sourceUrl,startsAt')&&['solo','cooperation'].includes(e.kind)&&iso(Date.parse(e.startsAt))===e.startsAt&&iso(Date.parse(e.endsAt))===e.endsAt&&e.startsAt<e.endsAt&&typeof e.sourceUrl==='string'&&/^https:\/\/game\.naver\.com\/lounge\/nikke\/board\/detail\/[1-9]\d{0,19}$/.test(e.sourceUrl)&&typeof e.sourceHash==='string'&&/^[a-f0-9]{64}$/.test(e.sourceHash));
    demand(e.startsAt>(endsByKind.get(e.kind)??'')&&Date.parse(e.endsAt)>=reset-7*GAME_DAY_MS&&Date.parse(e.startsAt)<reset+15*GAME_DAY_MS);
    endsByKind.set(e.kind,e.endsAt);
  }
  let phaseUntil=reset+GAME_DAY_MS;
  const ids=new Set<string>();
  for(let day=0;day<=14;day++){
    const at=reset+day*GAME_DAY_MS,gameDay=gameDayKey(at),row=doc.days[day],weekday=new Date(at+9*3600000).getUTCDay();
    demand(ruleAt(base.rules,at)===rule&&ruleAt(base.rules,at+GAME_DAY_MS-1)===rule);
    const expected:{source:string;at:string;refs:CertifiedSupplyEvent['refs']}[]=[];
    const append=(source:string,kind:CertifiedSupplyEvent['kind'],refs:CertifiedSupplyEvent['refs'],time=at,extra:Partial<CertifiedSupplyEvent>={})=>{
      expected.push({source,at:iso(time),refs});
      if(!refs.some(r=>r.count>0))return;
      phaseUntil=Math.min(phaseUntil,nextReceiptPhase(asOf,time));
      const event:CertifiedSupplyEvent={kind,id:`${kind}:${gameDay}`,gameDate:gameDay,at:iso(time),status:'confirmed',refs,ruleId:rule.id,...extra};
      demand(!ids.has(event.id));ids.add(event.id);events.push(event);};
    append('dispatch','dispatch',rule.dispatch);
    if(weekday===2)append('normal-shop','shop',rule.normalShop);
    if(weekday===3)append('weekly','weekly-kits',rule.weeklyFixed!,at,{expiresAt:iso(at+6*GAME_DAY_MS)});
    for(const e of doc.events){if(e.kind!=='solo')continue;const opening=Date.parse(e.startsAt),index=(at-gameDayStartMs(opening))/GAME_DAY_MS,time=Math.max(at,opening);
      if(index>=0&&index<7&&time<Date.parse(e.endsAt)){
        // The snapshot adapter needs a stable positive round key, not an inferred official season.
        const round=Math.floor(opening/GAME_DAY_MS),dayNumber=index+1;
        append('solo','solo',rule.soloDays[index]!,time,{round,dayNumber,id:`solo:r${round}:day${dayNumber}`,sourceIds:[e.sourceUrl]});}}
    demand(fields(row,'day,gameDay,occurrences')&&row.day===day&&row.gameDay===gameDay&&json(row.occurrences)===json(expected));
  }
  const hash=await publicationBytesHash(wire.statement),wallUntil=Math.min(doc.expiresAt,wallStart+wire.remainingMs,phaseUntil);
  const until=Math.min(start+(wallUntil-wallStart),performance.now()+wallUntil-Date.now());
  signal.throwIfAborted();
  demand(doc.sequence>=sequence&&(doc.sequence!==sequence||wire.statement===statement));
  if(Date.now()<wallStart)throw new PreviewSourceError('joint','clock');
  if(performance.now()>=until||Date.now()>=wallUntil)throw new PreviewSourceError('joint','expired');
  // Both documents are published in the same primary transaction. A newer
  // authenticated joint invites reacquisition; an older one is not that slot.
  if (rootCandidate) {
    if(doc.basis.sequence>p.sequence)throw new Error('preview_source_advanced');
    demand(doc.basis.sequence===p.sequence);
  } else {
  const off = JSON.parse(timedOff!.pointer.statement);
  demand(!timedOff!.artifact && off.mode==='off' && off.keyId===doc.keyId && off.environment===doc.environment);
  demand(doc.sequence>=off.sequence);
  if(doc.sequence>off.sequence||doc.basis.sequence>p.sequence)throw new Error('preview_source_advanced');
  }
  sequence=doc.sequence;statement=wire.statement;
  const partial=(w:CertifiedSupplySnapshot['coverage']['future'])=>({...w,complete:false,missing:['outside-conditional-model']});
  const snapshot:CertifiedSupplySnapshot={...base,revision:`${rootCandidate ? 'production' : 'preview'}-conditional-${sequence}`,sourceHash:hash,sourceStatus:'uncertain',events,soloRounds:[],coverage:{...base.coverage,from:iso(reset),until:iso(reset+15*GAME_DAY_MS),past:partial(base.coverage.past),future:partial(base.coverage.future)},warnings:[...omissions],provenance:[doc.domain,doc.basis.contentHash]};
  delete snapshot.sourceAuthority;
  return {snapshot,sequence:doc.sequence,until,wallUntil};
}
