import { fromWire, toWire, type Q } from '../../shared/certifiedRational.ts';
import { down,up } from './numeric.ts';
import { CertifiedLimit, reserveTargetPayload } from '../certified/budget.ts';
import { CAPS, type StateId } from '../certified/game.ts';
import type { Triple } from '../certified/types.ts';
import type { WasmKernel } from '../certified/wasmBackend.ts';
import type { ApproxDiagnostics, Bound, EndpointResult, EndpointSolver, ExactObjective } from './types.ts';

export class CurrentBatchContractError extends Error {}

export const FUSED_BATCH_SIZE = 32;
const MAX_RESPONSE = 4 * 1024 * 1024 + 8 + FUSED_BATCH_SIZE * 104;
const OWNER_BYTES = 256 * 1024; // single-root result and threshold overlap, including depth-600 exact evidence
type FusedExports = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  certified_input(n: number): number;
  certified_output_ptr(): number;
  certified_output_len(): number;
  certified_current_batch_version(): number;
  certified_current_batch_rows(count:number,day:number,kit:number,uses:number,thresholdTicks:number):number;
  certified_fused_version(): number;
  certified_fused_init(sid: number, blue: number, purple: number, yellow: number): number;
  certified_fused_batch(count: number, evidence: number): number;
  certified_fused_threshold(): number;
  certified_fused_clear(): void;
  certified_fused_stat(index: number): number;
};
const exportsOf = (value: WebAssembly.Exports): FusedExports => value as FusedExports;
export type BatchedEndpoints = EndpointSolver & {
  withBatch<T>(units: readonly Triple[], consume: (results: readonly EndpointResult[]) => T, evidence?: boolean | 'required'): T;
};
/** Streaming aggregation uses bounded native batches in original source order. */
export function withEndpointBatch<T>(solver: EndpointSolver, units: readonly Triple[], consume: (results: readonly EndpointResult[]) => T): T {
  if (!('withBatch' in solver)) throw new Error('fused_batch_required');
  return (solver as BatchedEndpoints).withBatch(units, consume);
}

/** Constant-date proof explicitly requests the actual exact root objective. */
export function solveEndpointEvidence(solver: EndpointSolver, units: Triple): EndpointResult {
  if (!('withBatch' in solver)) throw new Error('fused_batch_required');
  return (solver as BatchedEndpoints).withBatch([units], rows => rows[0]!, 'required');
}

export function createFusedEndpointSolver(kernel: WasmKernel, sid: number, max: Triple): BatchedEndpoints {
  const budget = kernel.budget;
  if (!Number.isInteger(sid) || sid < 0 || sid > 600 || max.length !== 3 ||
      [0, 1, 2].some(k => !Number.isSafeInteger(max[k]) || max[k]! < 0))
    throw new Error('fused_invalid_domain');
  const caps = CAPS[sid as StateId];
  if (budget.maxManagedPayloadBytes > 160 * 1024 * 1024) throw new CertifiedLimit('approx_endpoint_budget_ceiling');
  let disposed = false;
  let ownedBytes = OWNER_BYTES;
  let stats: ApproxDiagnostics = { endpointImplementation: 'native-fused-v1' };
  reserveTargetPayload(budget, OWNER_BYTES);
  const available = () => { if (disposed) throw new Error('approx_endpoint_disposed'); budget.checkNumerical(); };
  const output = <T>(consume: (view: DataView) => T): T => {
    const length = kernel.withRequestExports(e => e.certified_output_len());
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RESPONSE) throw new Error('fused_response_limit');
    const charge = 65536 + length * 16;
    reserveTargetPayload(budget, charge);
    try {
      const view = kernel.withRequestExports(e => {
        const ptr = e.certified_output_ptr();
        if (!Number.isSafeInteger(ptr) || ptr < 0 || ptr + length > e.memory.buffer.byteLength) throw new Error('fused_response_bounds');
        return new DataView(e.memory.buffer, ptr, length);
      });
      // Host resource refusals are not native traps; preserve normal cleanup.
      return consume(view);
    } finally { budget.release(charge); }
  };
  const status = (code: number) => {
    if (code === 0) return;
    if (code !== 1) throw new Error('fused_status');
    const reason = output(view => new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)));
    if (['request_budget_exhausted', 'managed_payload_ceiling', 'exact_memo_limit', 'fused_response_limit'].includes(reason)) throw new CertifiedLimit(reason);
    if(reason.startsWith('batch_regret_'))throw new CurrentBatchContractError(reason);
    throw new Error(reason);
  };
  const input = (bytes: Uint8Array, call: (e: FusedExports) => number) => {
    status(kernel.withBinaryRequest(raw => {
      const e = exportsOf(raw), ptr = e.certified_input(bytes.byteLength);
      if (!ptr || ptr + bytes.byteLength > e.memory.buffer.byteLength) throw new CertifiedLimit('managed_payload_ceiling');
      new Uint8Array(e.memory.buffer, ptr, bytes.byteLength).set(bytes);
      return call(e);
    }));
  };
  let initialized = false;
  try {
    status(kernel.withBinaryRequest(raw => {
      const e = exportsOf(raw);
      if (e.certified_fused_version() !== 3 || e.certified_current_batch_version() !== 2) throw new Error('fused_abi_version');
      const code = e.certified_fused_init(sid, Math.min(max[0], caps[0]), Math.min(max[1], caps[1]), Math.min(max[2], caps[2]));
      initialized = code === 0;
      return code;
    }));
    const required = kernel.withRequestExports(raw => exportsOf(raw).certified_fused_stat(11));
    if (!Number.isSafeInteger(required) || required < 0) throw new Error('fused_evidence_workspace');
    if (required > ownedBytes) {
      reserveTargetPayload(budget, required - ownedBytes);
      ownedBytes = required;
    }
  } catch (error) {
    try { if (initialized) kernel.cleanupSourcePart('fused'); }
    finally { budget.release(ownedBytes); }
    throw error;
  }
  const solver: BatchedEndpoints = {
    withBatch<T>(units: readonly Triple[], consume: (results: readonly EndpointResult[]) => T, evidence: boolean | 'required' = false): T {
      available();
      if (!units.length || units.length > FUSED_BATCH_SIZE) throw new Error('fused_batch_limit');
      reserveTargetPayload(budget, 16384);
      try {
        const bytes = new Uint8Array(units.length * 12), request = new DataView(bytes.buffer);
        units.forEach((u, i) => {
          if (u.length !== 3) throw new Error('fused_invalid_units');
          for (const k of [0, 1, 2] as const) {
            const v = u[k];
            if (!Number.isSafeInteger(v) || v < 0) throw new Error('fused_invalid_units');
            request.setUint32(i * 12 + k * 4, Math.min(v, caps[k]), true);
          }
        });
        input(bytes, e => e.certified_fused_batch(units.length, evidence === 'required' ? 2 : evidence ? 1 : 0));
        // Copy/decode all numeric records BEFORE invoking consumer; it may make
        // threshold calls and grow WASM memory. No view survives that boundary.
        return output(view => {
          if (view.byteLength < 8 || view.getUint32(0, true) !== units.length) throw new Error('fused_batch_count');
          const tailAt = 8 + units.length * 104;
          if (tailAt + view.getUint32(4, true) !== view.byteLength) throw new Error('fused_batch_length');
          const tail = JSON.parse(new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset + tailAt, view.byteLength - tailAt))) as {
            objectives: (ExactObjective | null)[]; stats: ApproxDiagnostics;
          };
          if (tail.objectives.length !== units.length) throw new Error('fused_evidence_count');
          const results: EndpointResult[] = [];
          for (let i = 0; i < units.length; i++) {
            const at = 8 + i * 104;
            const bound = (k: number): Bound => {
              const estimate = view.getFloat64(at + k * 24, true), lower = view.getFloat64(at + k * 24 + 8, true), upper = view.getFloat64(at + k * 24 + 16, true);
              if (![estimate, lower, upper].every(Number.isFinite) || lower < 0 || lower > estimate || estimate > upper || (k === 0 && upper > 1)) throw new Error('fused_invalid_bound');
              return { estimate, lower, upper };
            };
            const mask = view.getUint32(at + 96, true);
            if (mask > 7 || view.getUint32(at + 100, true) !== 0) throw new Error('fused_invalid_mask');
            const exact = tail.objectives[i];
            if (evidence === 'required' && !exact) throw new Error('fused_missing_root_evidence');
            let equalityKey: string | null = null;
            if (exact) {
              // Keep all exact-proof decoding checks, independently of metadata.
              fromWire(exact.p); fromWire(exact.b); fromWire(exact.c);
              // Request-local identity of the canonical capped units actually
              // submitted to the ABI. Cross-point ties use exactObjective.
              equalityKey = `point:${sid}:${request.getUint32(i * 12, true)},${request.getUint32(i * 12 + 4, true)},${request.getUint32(i * 12 + 8, true)}`;
            }
            results.push({ p: bound(0), consumed: [bound(1), bound(2), bound(3)], mask, equalityKey, ...(exact ? { exactObjective: exact } : {}) });
          }
          stats = { ...tail.stats, endpointImplementation: 'native-fused-v1' };
          budget.memoEntries = Number(stats['exactMemoEntries']);
          budget.exactTransitions = Number(stats['exactTransitions']);
          budget.checkNumerical();
          return consume(results);
        });
      } finally { budget.release(16384); }
    },
    batchRegrets(units,day,kit,uses,thresholdTicks) {
      available();
      if (!units.length || units.length>FUSED_BATCH_SIZE || !Number.isInteger(day) || day<1 || day>14 || !Number.isInteger(kit) || kit<0 || kit>2 || !Number.isSafeInteger(uses) || uses<1 || !Number.isInteger(thresholdTicks) || thresholdTicks<50 || thresholdTicks>400) throw new CurrentBatchContractError('batch_regret_input');
      const bytes=new Uint8Array(12*units.length), request=new DataView(bytes.buffer);
      units.forEach((row,i)=>{
        if(row.length!==3)throw new CurrentBatchContractError('batch_regret_units');
        row.forEach((v,k)=>{
        if(!Number.isSafeInteger(v)||v<0||v>max[k]!||v>caps[k]!)throw new CurrentBatchContractError('batch_regret_units');
          request.setUint32(i*12+k*4,v,true);
        });
      });
      input(bytes,e=>e.certified_current_batch_rows(units.length,day,kit,uses,thresholdTicks));
      return output(view=>{
        if(view.byteLength!==24+units.length*20 || [2,units.length,day,kit,uses,thresholdTicks].some((n,i)=>view.getUint32(i*4,true)!==n))throw new CurrentBatchContractError('batch_regret_header');
        return units.map((_,i)=>{
          const at=24+i*20,lower=view.getFloat64(at,true),upper=view.getFloat64(at+8,true),flag=view.getUint32(at+16,true);
          if(!(lower>=0 && lower<=upper && upper<=1) || flag>2 || (flag!==0 && upper<down(thresholdTicks/10000)) || (flag!==1 && lower>up(thresholdTicks/10000)))throw new CurrentBatchContractError('batch_regret_row');
          return {lower,upper,above:flag===2?null:flag===1};
        });
      });
    },
    solve(units) { return solver.withBatch([units], rows => rows[0]!, true); },
    compareProbability(units: Triple, threshold: Q): number {
      available();
      if (units.length !== 3 || [0, 1, 2].some(k => !Number.isSafeInteger(units[k]) || units[k]! < 0))
        throw new Error('fused_invalid_units');
      // Reserve before stringify/encoding, based on the exact limb input.
      const charge = 8192 + 8 * (threshold.n.toString(2).length + threshold.d.toString(2).length);
      reserveTargetPayload(budget, charge);
      try {
        input(new TextEncoder().encode(JSON.stringify({
          units: units.map((v, k) => Math.min(v, caps[k as 0 | 1 | 2])), threshold: toWire(threshold),
        })), e => e.certified_fused_threshold());
        return output(view => {
          if (view.byteLength !== 4) throw new Error('fused_threshold_length');
          const value = view.getInt32(0, true);
          if (value < -1 || value > 1) throw new Error('fused_threshold_order');
          return value;
        });
      } finally { budget.release(charge); }
    },
    diagnostics() {
      if (!disposed && !kernel.hasFailed) kernel.withRequestExports(raw => {
        const e = exportsOf(raw);
        ['endpointStates', 'endpointCacheHits', 'endpointTransitions', 'endpointPages', 'endpointPageBytes',
          'endpointExactRefinements', 'endpointThresholdRefinements', 'endpointRelativeError', 'endpointBatches',
          'exactMemoEntries', 'exactTransitions'].forEach((key, index) => { stats[key] = e.certified_fused_stat(index); });
        budget.memoEntries = Number(stats['exactMemoEntries']);
        budget.exactTransitions = Number(stats['exactTransitions']);
      });
      return { ...stats, endpointDisposed: disposed };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        // Release only FUSED; the shared source/Engine remains owned by the controller.
        kernel.cleanupSourcePart('fused');
      } finally { budget.release(ownedBytes); }
    },
  };
  return solver;
}
