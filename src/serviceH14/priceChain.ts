import { conditionalCurrent, type ConditionalActionKind } from '../../shared/conditionalCurrent.ts';
import { receiptDay } from '../../shared/receiptClock.ts';
import { gameDayStartMs } from '../../shared/gameDay.ts';
import { isCertifiedEventClaimable, isCertifiedEventModeled } from '../../shared/certifiedSupply.ts';
import { EDGES, TERMINAL, encode, type KitIndex, type StateId } from '../certified/game.ts';
import type { Triple } from '../certified/types.ts';
import type { ServiceH14Input, ServiceH14Output } from './types.ts';

// A replacement Worker is initialized by the trusted client, not by the input
// submitter. Transfer only the batch receipt from its audited predecessor.
export type PriceParent = {
  id: number; generation: number; sessionId: string; hash: string; authority: string;
  basis: Triple; stock: Triple; sid: number; kit: KitIndex; maxUses: number;
  actionKind: ConditionalActionKind;
};
function authority(input: ServiceH14Input): string | undefined {
  const publication = input.forecastPublication;
  if (input.legacyD0 || !publication?.artifact || input.forecastSource || input.cohortWeights !== undefined) return;
  const now = Date.parse(input.asOf), snapshot = input.snapshot;
  // Artifact authorization binds channel, environment, key, candidate and content.
  // Pointer renewal/transport lease and exact request asOf are not price changes.
  return JSON.stringify([publication.artifact.authorization.signature, gameDayStartMs(now),
    ...(input.previewJoint ? [input.snapshot.sourceHash,input.previewJoint.timedOff?.pointer.signature ?? 'production-conditional-v1'] : []),
    snapshot.events.map(event => [event.id,Math.max(0,Math.min(15,receiptDay(now,Date.parse(event.at)))),isCertifiedEventClaimable(snapshot,event,input.asOf),isCertifiedEventModeled(snapshot,event,input.asOf)]),input.receivedEventIds]);
}
export function auditedPriceParent(input: ServiceH14Input, out: ServiceH14Output, verifiedPrefix = false): PriceParent | undefined {
  const action = conditionalCurrent(out, input, input.stock, {verifiedPrefix,batchLimit:input.batchLimit ?? 10});
  if (!action) return;
  const kit = ({blue:0,purple:1,yellow:2} as const)[action.kit];
  const scope = authority(input);
  if (!scope) return;
  return { ...out.request, hash:out.inputSha256, authority:scope, basis:[...(input.priceBasisStock ?? input.stock)], stock:[...input.stock],
    sid:encode(input.grade,input.level,input.exp), kit,maxUses:action.uses,actionKind:action.kind };
}
// The key is per client, transferred only during private Worker initialization.
// A request cannot mint a predecessor, even if all of its public fields are known.
export async function priceSeal(key:string, p:PriceParent): Promise<string> {
  return signReceipt(key,['adaptive-price-chain-v4',p.id,p.generation,p.sessionId,p.hash,p.authority,p.basis,p.stock,p.sid,p.kit,p.maxUses,p.actionKind]);
}
export function prefixSeal(key:string,output:ServiceH14Output):Promise<string> {
  return signReceipt(key,['certified-resource-prefix-v1',output]);
}
async function signReceipt(key:string, fields:unknown[]):Promise<string> {
  const encoder = new TextEncoder();
  const secret = await crypto.subtle.importKey('raw',encoder.encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signed = await crypto.subtle.sign('HMAC',secret,encoder.encode(JSON.stringify(fields)));
  return Array.from(new Uint8Array(signed),b=>b.toString(16).padStart(2,'0')).join('');
}
export function samePriceScope(input: ServiceH14Input, parent: PriceParent): boolean { return authority(input) === parent.authority; }
export function assertPriceChild(input: ServiceH14Input, request: {id:number;generation:number;sessionId:string}, parent?: PriceParent, seal?:string): void {
  if (!parent && input.priceParent === undefined && input.priceBasisStock === undefined) return;
  const reject = () => { throw new Error('service_h14_price_lineage'); };
  if (!parent || !seal || input.priceParent !== seal || !samePriceScope(input,parent) ||
      !input.priceBasisStock?.every((v,k)=>v===parent.basis[k]) || input.priceBasisStock.length!==3) return reject();
  assertPhysicalChild(input,request,parent);
}

/** A changed supply can end price inheritance, never legitimize a replay or a different stock transition. */
export function assertPhysicalChild(input: ServiceH14Input, request: {id:number;generation:number;sessionId:string}, parent: PriceParent): void {
  const reject = () => { throw new Error('service_h14_price_lineage'); };
  if (request.sessionId !== parent.sessionId || request.id !== parent.id+1 || request.generation !== parent.generation+1 ||
      input.stock.length!==3 || !input.stock.every((v,k)=>v>=0 && (parent.kit===k || v===parent.stock[k]))) return reject();
  const used = (parent.stock[parent.kit] - input.stock[parent.kit]) / 10;
  if (!Number.isSafeInteger(used) || used < 1 || used > parent.maxUses) return reject();
  const target = encode(input.grade,input.level,input.exp);
  let sid = parent.sid;
  for (let j=1; j<=used; j++) {
    if (sid===TERMINAL) return reject();
    const [p,great,normal]: readonly [number,number,number] = EDGES[sid as StateId][parent.kit];
    if (j===used && p>0 && target===great) return;
    if (p===1000) return reject();
    sid=normal;
  }
  if (used!==parent.maxUses || target!==sid) reject();
}
