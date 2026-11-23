import { EDGES } from '../certified/game.ts';
import { BOX_LAWS, CERTIFIED_SUPPLY_LAWS, DISPATCH_CLASSES } from '../../shared/certifiedSupplyLaws.ts';
import { GAME_DAY_MS } from '../../shared/gameDay.ts';
import { isCertifiedEventClaimable } from '../../shared/certifiedSupply.ts';
import { futureEvents, eventOffset } from '../certified/events.ts';
import { portableTollPin as pin } from './generated/portableTollPin.ts';
import type { ServiceH14Input, JointSourcePlan } from './types.ts';
import type { Q } from '../../shared/certifiedRational.ts';

export async function portableSha256(bytes:Uint8Array<ArrayBuffer>) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)), x=>x.toString(16).padStart(2,'0')).join('');
}
// Call only after ordinary publication trust, validation and independent plan admission.
export async function matchesPortableLaw(input:ServiceH14Input,plan:JointSourcePlan,priors:readonly Q[]) {
  const s=input.snapshot;
  if(input.legacyD0 || !input.forecastPublication?.artifact || input.forecastSource || input.computeWaiting===false ||
    s.sourceStatus!=='healthy'||s.warnings.length||!s.coverage.future.complete||s.coverage.future.missing.length||
    s.version!=='certified-daily-v5'||s.futureLawSemantics!==pin.semantics||plan.descriptor.dependence!=='independent-days-given-cohort'||
    plan.dates.length!==15||plan.cohortCount!==3||priors.length!==3||s.laws.length!==CERTIFIED_SUPPLY_LAWS.length||
    !CERTIFIED_SUPPLY_LAWS.every(l=>s.laws.some(a=>a.id===l.id&&a.modelVersion===pin.model&&a.kind===l.kind&&Object.keys(a).length===3)))return false;
  const received=new Set(input.receivedEventIds);
  if(received.size!==(input.receivedEventIds?.length??0))return false;
  for(const e of s.events)if(isCertifiedEventClaimable(s,e,input.asOf)!==received.delete(e.id))return false;
  if(received.size)return false;
  const counts=Array.from({length:15},()=>[0,0,0,0]);
  const ids=['dispatch-board-v1','regular-box-v1','box-ii-v1','deterministic:10,10,0'];
  const events=futureEvents(input),start=Date.parse(input.asOf);
  if(events.length!==plan.descriptor.events.length)return false;
  for(const [i,e] of events.entries()){
    const d=eventOffset(input,e),entry=plan.descriptor.events[i]!;
    if(Date.parse(e.at)!==start+d*GAME_DAY_MS||entry.day!==d||entry.refs!==e.refs)return false;
    for(const r of e.refs){const k=ids.indexOf(r.lawId);if(k<0)return false;counts[d]![k]!+=r.count;}
  }
  const lines=[String(EDGES.length),...EDGES.map(row=>row.flat().join(' ')),String(DISPATCH_CLASSES.length),
    ...DISPATCH_CLASSES.map(c=>[c.weight,Number(c.keep),...c.raw].join(' '))];
  for(const law of [BOX_LAWS.regular,BOX_LAWS.boxII])lines.push(String(law.length),...law.map(a=>[...a.pieces,a.mass.n,a.mass.d].join(' ')));
  lines.push(...counts.map(c=>c.join(' ')),String(priors.length),...priors.map(p=>`${p.n} ${p.d}`));
  return await portableSha256(new TextEncoder().encode(lines.join('\n')+'\n'))===pin.physicalSha256;
}
