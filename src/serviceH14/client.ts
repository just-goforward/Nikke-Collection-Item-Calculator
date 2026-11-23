import { assertPhysicalChild, auditedPriceParent, prefixSeal, priceSeal, samePriceScope, type PriceParent } from './priceChain.ts';
import { sameCertifiedForecastIdentity, type CertifiedForecastIdentity } from '../../shared/certifiedForecastIdentity.ts';
import type { CertifiedTargetBudget } from '../certified/types.ts';
import { CERTIFIED_RESPONSE_METADATA_CEILING, CERTIFIED_RESPONSE_PAYLOAD_CEILING, CERTIFIED_RUNTIME_PAYLOAD_CEILING, payloadBytes } from '../certifiedRuntime/protocol.ts';
import { assertServiceH14Output, isServiceH14ResourceReason, ServiceH14AuditBudgetError, ServiceH14PrefixBudgetError } from './binding.ts';
import { isCertifiedPrefixStop } from './source.ts';
import { ServiceH14DeadlineError, serviceH14DeadlineMs } from './deadline.ts';
import { admitServiceH14Input, serviceH14AdmissionWorkspaceBound, INPUT_SCAN_BYTES, scanServiceJson, type ServiceH14Admission } from './admission.ts';
import { SERVICE_H14_PROFILE, assertServiceH14Profile } from './profile.ts';
import type { ServiceH14Input, ServiceH14Output, ServiceH14Request, ServiceH14ClientResult, ServiceH14Receipt, ServiceH14RequestOptions } from './types.ts';
import type { ServiceH14RuntimeMessage, ServiceH14RuntimeRequest } from './workerHandler.ts';
import { PreviewSourceError } from '../lib/previewSourceError.ts';

export type ServiceH14WorkerPort = {
  runtime: 'browser' | 'node';
  postMessage(message: ServiceH14RuntimeRequest): void;
  listen(message: (value: ServiceH14RuntimeMessage) => void, error: (error: unknown) => void): () => void;
  terminate(): unknown;
};
export class ServiceH14RuntimeError extends Error {
  constructor(readonly code: 'aborted' | 'superseded' | 'deadline' | 'disposed' | 'worker' | 'binding' | 'resource' | 'memory' | 'source_advanced', message: string,
    readonly stage: 'client-admission' | 'worker-admission' | 'client-audit' | 'compute' | 'worker-channel' = 'worker-channel') {
    super(message);
    this.name = 'ServiceH14RuntimeError';
  }
}
export function isServiceH14Interruption(error: unknown): boolean {
  return error instanceof ServiceH14RuntimeError && (error.code === 'aborted' || error.code === 'deadline' || error.code === 'memory' || error.code === 'resource');
}

/** Only a locally typed allocation refusal can retain a previously validated
 * checkpoint. This does not validate, promote, or rewrite the checkpoint. */
export function preserveCurrentOnAuditRefusal(error: unknown, validatedCurrent: ServiceH14Output | undefined) {
  if (!(error instanceof ServiceH14AuditBudgetError) || !validatedCurrent) return undefined;
  return { output: validatedCurrent, interruption: 'memory' as const };
}
type PendingRequest = Omit<ServiceH14Request,'inputSha256'|'forecastIdentity'> & { inputSha256?: string; forecastIdentity?: CertifiedForecastIdentity };
type Task = {
  request: PendingRequest;
  priceParent: PriceParent | undefined;
  admission?: ServiceH14Admission;
  bytes: number;
  submitted: number;
  deadlineMs: number;
  started?: number;
  computeStarted?: number;
  phase: 'queued' | 'init' | 'binding' | 'compute' | 'audit';
  settled: boolean;
  currentSeen: boolean;
  computeAcknowledged: boolean;
  partial?: ServiceH14Output;
  onCurrent?: (output: ServiceH14Output) => void;
  observerFailures: number;
  timer?: ReturnType<typeof setTimeout>;
  removeAbort?: () => void;
  resolve: (result: ServiceH14ClientResult) => void;
  reject: (error: unknown) => void;
};
type Live = { port: ServiceH14WorkerPort; generation: number; ready: boolean; unlisten: () => void };

/** Separate protocol/profile; retains the exact Client's cancellation and termination ordering. */
export class ServiceH14Client {
  #live: Live | undefined;
  #active: Task | undefined;
  #auditing: Task | undefined;
  #queue: Task[] = [];
  #nextId = 0;
  readonly #priceKey = crypto.randomUUID();
  #priceParent: (PriceParent & {seal:string}) | undefined;
  #generation = 0;
  #disposed = false;
  #pumping = false;
  #barrier: Promise<void> = Promise.resolve();
  #terminationFailure: unknown;
  #idle: ReturnType<typeof setTimeout> | undefined;
  #workerBytes = 0;
  #workerBindingBytes = 0;
  #retiredBytes = 0;
  #workerResponseBytes = 0;
  #responseBytes = 0;
  #observerBytes = 0;
  #transientBytes = 0;
  #prefixSealBytes = 0;
  #reservedResponseBytes = 0;
  #retiredResponseCapacityBytes = 0;
  #bindings = new Map<Task, number>();
  #pendingBindings = new Set<Promise<ServiceH14Admission>>();
  constructor(private readonly options: { createWorker: () => ServiceH14WorkerPort; idleTimeoutMs?: number }) {}

  memory = () => {
    const queuedPayloadBytes = this.#queue.reduce((sum, task) => sum + task.bytes, 0);
    // A cancelled final still owns its message, input and checkpoint until the
    // retirement/audit barrier drains; settling its waiter does not free them.
    const auditing = this.#auditing !== this.#active ? this.#auditing : undefined;
    const activePayloadBytes = (this.#active?.bytes ?? 0) +
      (auditing && !this.#bindings.has(auditing) ? auditing.bytes : 0);
    const partialPayloadBytes = (this.#active?.partial ? payloadBytes(this.#active.partial) : 0) +
      (auditing?.partial ? payloadBytes(auditing.partial) : 0);
    let bindingPayloadBytes = 0;
    for (const [task, bytes] of this.#bindings) {
      bindingPayloadBytes += bytes + (this.#active === task || this.#queue.includes(task) ? 0 : task.bytes);
    }
    return {
      queuedPayloadBytes, activePayloadBytes, partialPayloadBytes, bindingPayloadBytes,
      workerPayloadBytes: this.#workerBytes, workerBindingPayloadBytes: this.#workerBindingBytes,
      retiredPayloadBytes: this.#retiredBytes, workerResponsePayloadBytes: this.#workerResponseBytes,
      responsePayloadBytes: this.#responseBytes, observerPayloadBytes: this.#observerBytes,
      transientPayloadBytes: this.#transientBytes + this.#prefixSealBytes, reservedResponseCapacityBytes: this.#reservedResponseBytes + this.#retiredResponseCapacityBytes,
      totalPayloadBytes: queuedPayloadBytes + activePayloadBytes + partialPayloadBytes + bindingPayloadBytes +
        this.#workerBytes + this.#workerBindingBytes + this.#retiredBytes + this.#workerResponseBytes +
        this.#responseBytes + this.#observerBytes + this.#transientBytes + this.#prefixSealBytes,
    };
  };
  #admits(bytes: number) {
    return Number.isSafeInteger(bytes) && this.memory().totalPayloadBytes +
      this.#reservedResponseBytes + this.#retiredResponseCapacityBytes + bytes <= CERTIFIED_RUNTIME_PAYLOAD_CEILING;
  }
  #expired(task: Task) {
    return Date.now() >= task.request.deadlineAt || performance.now() - task.submitted >= task.deadlineMs;
  }
  #owns(task: Task, live: Live) {
    return this.#active === task && this.#live === live && !task.settled;
  }
  #check(task: Task) {
    if (this.#expired(task)) throw new ServiceH14RuntimeError('deadline', 'service_h14_total_deadline');
  }
  #finish(task: Task, error?: unknown, output?: ServiceH14Output, interruption: ServiceH14Receipt['interruption'] = null, interruptionReason?: string, outputMode:ServiceH14Receipt['outputMode']=interruption?'current':'result') {
    if (task.settled) return;
    task.settled = true;
    clearTimeout(task.timer);
    task.removeAbort?.();
    delete task.removeAbort;
    delete task.onCurrent;
    if (task.admission) { task.admission.release(); delete task.admission; }
    if (error !== undefined) task.reject(error);
    else {
      const now = performance.now();
      const start = task.started ?? now;
      const compute = task.computeStarted ?? now;
      task.resolve({ output: output!, receipt: { outputMode, interruption, ...(interruptionReason ? {interruptionReason} : {}),
        requestId: task.request.id, generation: task.request.generation, sessionId: task.request.sessionId,
        deadlineAt: task.request.deadlineAt,
        timing: { totalMs: now - task.submitted, queuedMs: start - task.submitted,
          initAndBindingMs: compute - start, computeAndValidationMs: now - compute },
        memory: this.memory(), observerCallbackFailureCount: task.observerFailures } });
    }
  }
  #retire(finalReceived = false): Promise<void> {
    const old = this.#live;
    if (!old) return this.#barrier;
    this.#live = undefined;
    const bytes = this.#workerBytes + this.#workerBindingBytes + this.#workerResponseBytes;
    const capacity = this.#reservedResponseBytes;
    this.#workerBytes = this.#workerBindingBytes = this.#workerResponseBytes = this.#reservedResponseBytes = 0;
    this.#retiredBytes += bytes;
    this.#retiredResponseCapacityBytes += capacity;
    let completion: unknown;
    try { old.unlisten(); completion = old.port.terminate(); }
    catch (error) { this.#terminationFailure = error; return this.#barrier; }
    this.#barrier = this.#barrier.then(async () => {
      try {
        await completion;
        // A final closes the protocol's Current/result pair. After detaching and
        // stopping this port, its known payloads replace the speculative six
        // clone slots. Never do this on receipt alone or on failed termination.
        if (old.port.runtime === 'node' || finalReceived) this.#retiredResponseCapacityBytes -= capacity;
        // Browser terminate() is not a heap-reclamation acknowledgement. Keep
        // the actual Worker input, admission and both outputs until replacement init.
        if (old.port.runtime === 'node') this.#retiredBytes -= bytes;
      } catch (error) { this.#terminationFailure = error; }
    });
    return this.#barrier;
  }
  #cancel(task: Task, code: 'aborted' | 'superseded' | 'deadline') {
    if (task.settled) return;
    if (this.#active === task) this.#retire();
    else this.#queue = this.#queue.filter(queued => queued !== task);
    if ((code === 'deadline' || code === 'aborted') && task.partial) this.#finish(task, undefined, task.partial, code, `service_h14_${code}_${task.phase}`);
    else this.#finish(task, new ServiceH14RuntimeError(code, `service_h14_${code}_${task.phase}`));
    if (this.#active === task) this.#active = undefined;
    void this.#pump();
  }
  #fail(live: Live, error: unknown, preserve?: 'worker' | 'deadline' | 'memory') {
    if (this.#live !== live) return;
    const task = this.#active;
    this.#retire();
    if (task?.partial && preserve) this.#finish(task, undefined, task.partial, preserve, error instanceof Error ? error.message : undefined);
    else if (task) this.#finish(task, error instanceof ServiceH14RuntimeError || error instanceof PreviewSourceError ? error : new ServiceH14RuntimeError('worker', String(error)));
    this.#active = undefined;
    void this.#pump();
  }
  async #bindAndStart(task: Task, live: Live) {
    if (!this.#owns(task, live)) return;
    task.phase = 'binding';
    const check = () => {
      if (!this.#owns(task, live)) throw new ServiceH14RuntimeError('aborted', 'service_h14_binding_owner_lost');
      this.#check(task);
    };
    let admission: ServiceH14Admission | undefined;
    try {
      check();
      if (!this.#admits(INPUT_SCAN_BYTES)) throw new ServiceH14RuntimeError('memory','service_h14_scan_capacity');
      this.#bindings.set(task,INPUT_SCAN_BYTES);
      const bound = serviceH14AdmissionWorkspaceBound(task.request.input,check);
      if (!Number.isSafeInteger(bound) || bound < 0) throw new ServiceH14RuntimeError('memory', 'service_h14_admission_workspace');
      const binding = admitServiceH14Input(task.request.input, bytes => {
        if (bytes === 0) { this.#bindings.delete(task); return; }
        const old = this.#bindings.get(task) ?? 0;
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > bound || !this.#admits(bytes - old)) {
          throw new ServiceH14RuntimeError('memory', 'service_h14_admission_workspace');
        }
        this.#bindings.set(task, bytes);
      }, check);
      this.#pendingBindings.add(binding);
      try { admission = await binding; }
      finally { this.#pendingBindings.delete(binding); }
      check();
      task.admission = admission;
      task.request.inputSha256 = admission.inputSha256;
      task.request.forecastIdentity = admission.forecastIdentity;
      if(admission.portableToll)task.request.portableTollReady=true;
      const capacity = 6 * (CERTIFIED_RESPONSE_PAYLOAD_CEILING + CERTIFIED_RESPONSE_METADATA_CEILING);
      if (!this.#admits(task.bytes + capacity + bound)) throw new ServiceH14RuntimeError('memory', 'service_h14_worker_clone_capacity');
      this.#reservedResponseBytes = capacity;
      this.#workerBytes = task.bytes;
      this.#workerBindingBytes = bound;
      task.phase = 'compute';
      task.computeStarted = performance.now();
      live.port.postMessage(task.request as ServiceH14Request);
    } catch (error) {
      const advanced = task.phase === 'binding' && error instanceof Error && error.message === 'preview_source_advanced';
      if (this.#owns(task, live)) this.#fail(live, error instanceof PreviewSourceError ? error.at('client') :
        error instanceof ServiceH14RuntimeError ? error : new ServiceH14RuntimeError(advanced ? 'source_advanced' : 'binding',String(error),'client-admission'));
    } finally {
      if (!this.#owns(task,live)) { admission?.release(); this.#bindings.delete(task); }
    }
  }
  #validateOutput(task: Task, output: ServiceH14Output, mode: 'current' | 'final') {
    const budget: CertifiedTargetBudget & {checkPrefixTime():void} = {
      checkPrefixTime:()=>{
        // Leave time to authenticate the exact payload and its physical parent
        // even if this optional numerical comparison cannot finish.
        if(Date.now()>=task.request.deadlineAt-50||performance.now()-task.submitted>=task.deadlineMs-50)throw new ServiceH14PrefixBudgetError();
      },
      check: () => this.#check(task),
      reserve: bytes => {
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('service_h14_binding_reservation');
        const admitted = this.#admits(bytes);
        this.#transientBytes += bytes;
        if (!admitted) throw new ServiceH14AuditBudgetError();
      },
      release: bytes => { this.#transientBytes -= bytes; },
    };
    if (!task.admission) throw new Error('service_h14_missing_admission');
    assertServiceH14Output(output, task.request as ServiceH14Request, task.admission, mode, budget);
    this.#check(task);
  }
  #auditFinal(task: Task, output: ServiceH14Output, seal?:string, prefixProof?:string) {
    task.phase = 'audit';
    this.#auditing = task;
    const retirement = this.#retire(true);
    // Include audit cleanup in the same barrier used by replacement, queued
    // requests and dispose. A cancelled waiter cannot race a new response owner.
    this.#barrier = retirement.then(async () => {
      if (task.settled || this.#active !== task || this.#disposed) return;
      if (this.#terminationFailure !== undefined) throw new ServiceH14RuntimeError('worker', `service_h14_termination_failed: ${String(this.#terminationFailure)}`);
      let omitPrefix=false;
      try{this.#validateOutput(task, output, 'final');}
      catch(error){if(!(error instanceof ServiceH14PrefixBudgetError))throw error;omitPrefix=true;}
      if(task.partial){
        const a=task.partial.current,b=output.current;
        // Both checkpoints have independently passed rational canonicalization,
        // fixed-price algebra and display validation. Compare primitive wires
        // rather than allocating a second pair of serialized Current objects.
        const same=(x:{numerator:string;denominator:string},y:typeof x)=>x.numerator===y.numerator&&x.denominator===y.denominator;
        if(!a||!b||a.status!==b.status||a.kit!==b.kit||a.uses!==b.uses||a.optimalActionMask!==b.optimalActionMask||
           !same(a.value.successP,b.value.successP)||!a.value.expectedConsumed.every((v,k)=>same(v,b.value.expectedConsumed[k]!)))throw new Error('service_h14_final_current_binding');
      }
      this.#check(task);
      if(!task.partial && output.records.length>1 && output.status==='incomplete' && isServiceH14ResourceReason(output.reason))
        throw new Error('service_h14_missing_current_checkpoint');
      const reason=output.status==='incomplete'&&isServiceH14ResourceReason(output.reason)?output.reason:null;
      const interruption=!reason?null:reason==='request_budget_exhausted'?'deadline':
        reason==='certified_wasm_allocation_trap'?'memory':reason.startsWith('certified_wasm_')?'worker':/memory|payload|memo/.test(reason)?'memory':'resource';
      const prefix=isCertifiedPrefixStop(reason);
      if(prefix&&output.records.length){
        if(!prefixProof)throw new Error('service_h14_missing_prefix_seal');
        const bytes=6*payloadBytes(output)+1024;
        if(!this.#admits(bytes))throw new ServiceH14AuditBudgetError();
        this.#prefixSealBytes=bytes;
        try{if(prefixProof!==await prefixSeal(this.#priceKey,output))throw new Error('service_h14_prefix_seal');}
        finally{this.#prefixSealBytes=0;}
        if(task.settled||this.#active!==task||this.#disposed)return;
        this.#check(task);
      }else if(prefixProof!==undefined)throw new Error('service_h14_unexpected_prefix_seal');
      const currentAuthority=!!task.partial && task.request.input.computeWaiting!==false &&
        (task.admission?.conditionalUntil!==undefined || task.request.input.snapshot.coverage.future.complete);
      const parent=auditedPriceParent(task.request.input,output,prefix&&currentAuthority);
      if(parent){
        if(!seal||seal!==await priceSeal(this.#priceKey,parent))throw new Error('service_h14_price_seal');
        if(task.settled||this.#active!==task||this.#disposed)return;
        this.#check(task);
        this.#priceParent={...parent,seal};
      }else if(seal!==undefined)throw new Error('service_h14_unexpected_price_seal');
      // Verify both original seals first. Omission changes no metric, physical
      // action, or price authority and never surfaces an unaudited verdict.
      if(omitPrefix)delete output.prefixDecision;
      if(interruption&&reason&&(!output.current||!prefix)){
        if(task.partial)this.#finish(task,undefined,task.partial,interruption,reason);
        else this.#finish(task,new ServiceH14RuntimeError(interruption,reason));
      }else this.#finish(task,undefined,output,interruption,reason??undefined,prefix&&!currentAuthority?'current':'result');
    }).catch(error => {
      if (task.settled || this.#active !== task) return;
      if (error instanceof ServiceH14DeadlineError || (error instanceof ServiceH14RuntimeError && error.code === 'deadline')) {
        this.#cancel(task, 'deadline');
      } else {
        const checkpoint = preserveCurrentOnAuditRefusal(error, task.partial);
        if (checkpoint) this.#finish(task, undefined, checkpoint.output, checkpoint.interruption, (error as Error).message);
        else this.#finish(task, error instanceof ServiceH14RuntimeError ? error :
          new ServiceH14RuntimeError(error instanceof ServiceH14AuditBudgetError ? 'memory' : 'binding', error instanceof Error ? error.message : String(error),'client-audit'));
      }
    }).finally(() => {
      this.#responseBytes = 0;
      this.#auditing = undefined;
      if (this.#active === task) this.#active = undefined;
      void this.#pump();
    });
  }
  #onMessage(live: Live, message: ServiceH14RuntimeMessage) {
    if (this.#live !== live) return;
    const task = this.#active;
    if (!message || typeof message !== 'object') { this.#fail(live, 'service_h14_message_shape'); return; }
    try {
      if (!this.#admits(INPUT_SCAN_BYTES)) throw new ServiceH14RuntimeError('memory','service_h14_response_scan_capacity');
      this.#transientBytes += INPUT_SCAN_BYTES;
      try { scanServiceJson(message,() => { if(task)this.#check(task); },CERTIFIED_RESPONSE_PAYLOAD_CEILING+CERTIFIED_RESPONSE_METADATA_CEILING); }
      finally { this.#transientBytes -= INPUT_SCAN_BYTES; }
      if (message.generation !== live.generation) return;
      const keys = message.type === 'initComplete' ? ['type', 'generation', 'profile']
        : message.type === 'initError' ? ['type', 'generation', 'profile', 'message']
        : message.type === 'computeStarted' ? ['type', 'id', 'generation', 'sessionId', 'inputSha256', 'forecastIdentity', 'profile']
        : message.type === 'error' ? ['type', 'id', 'generation', 'sessionId', 'inputSha256', 'forecastIdentity', 'profile', 'code', 'message']
        : ['type', 'id', 'generation', 'sessionId', 'output', ...(['priceSeal','prefixSeal'] as const).filter(k=>message.type==='result' && typeof message[k]==='string' && /^[a-f0-9]{64}$/.test(message[k]!))];
      if (Object.keys(message).length !== keys.length || keys.some(key => !Object.hasOwn(message, key))) throw new Error('service_h14_response_keys');
      if (message.type === 'initComplete' || message.type === 'initError') {
        assertServiceH14Profile(message.profile);
        if (payloadBytes(message) > CERTIFIED_RESPONSE_METADATA_CEILING || live.ready || task?.phase !== 'init') throw new Error('service_h14_init_protocol');
        if (message.type === 'initError') {
          if (typeof message.message !== 'string' || message.message.length > 1024) throw new Error('service_h14_error_shape');
          throw new Error(message.message);
        }
        live.ready = true;
        this.#retiredBytes = 0;
        this.#retiredResponseCapacityBytes = 0;
        if (task) void this.#bindAndStart(task, live);
        return;
      }
      if (!task || task.settled) return;
      if (message.id !== task.request.id || message.sessionId !== task.request.sessionId) return;
      if (!live.ready || task.phase !== 'compute') throw new Error('service_h14_response_phase');
      this.#check(task);
      if (message.type === 'computeStarted' || message.type === 'error') {
        assertServiceH14Profile(message.profile);
        if (payloadBytes(message) > CERTIFIED_RESPONSE_METADATA_CEILING || message.inputSha256 !== task.request.inputSha256 || !sameCertifiedForecastIdentity(message.forecastIdentity, task.request.forecastIdentity!)) throw new Error('service_h14_response_context');
        if (message.type === 'computeStarted') {
          if (task.computeAcknowledged) throw new Error('service_h14_duplicate_compute_started');
          task.computeAcknowledged = true;
          if (!task.admission) throw new Error('service_h14_missing_admission');
          this.#workerBindingBytes = task.admission.retainedBytes;
          return;
        }
        if (!['protocol', 'deadline', 'memory', 'solver'].includes(message.code) ||
            typeof message.message !== 'string' || message.message.length > 1024) throw new Error('service_h14_error_shape');
        if (!task.computeAcknowledged && message.code === 'protocol') {
          const source = PreviewSourceError.fromWire(message.message);
          if (source?.boundary === 'worker') { this.#fail(live,source); return; }
        }
        if (!task.computeAcknowledged && message.code === 'protocol' && message.message === 'preview_source_advanced') {
          this.#fail(live, new ServiceH14RuntimeError('source_advanced', message.message)); return;
        }
        if (message.code === 'memory' && !['service_h14_admission_capacity','service_h14_binding_capacity','service_h14_response_ceiling','service_h14_audit_workspace','managed_payload_ceiling'].includes(message.message)) throw new Error('service_h14_memory_error_shape');
        const preserve = message.code === 'deadline' ? 'deadline' : message.code === 'solver' ? 'worker' : message.code === 'memory' ? 'memory' : undefined;
        this.#fail(live, new ServiceH14RuntimeError(message.code === 'memory' ? 'memory' : message.code === 'protocol' ? 'binding' : message.code === 'deadline' ? 'deadline' : 'worker', message.message,
          task.computeAcknowledged ? 'compute' : 'worker-admission'), preserve);
        return;
      }
      if (message.type !== 'current' && message.type !== 'result') throw new Error('service_h14_message_type');
      if (!task.computeAcknowledged) throw new Error('service_h14_output_before_admission');
      const outputBytes = payloadBytes(message.output);
      const messageBytes = payloadBytes(message);
      if (messageBytes - outputBytes > CERTIFIED_RESPONSE_METADATA_CEILING) throw new Error('service_h14_response_metadata');
      if (outputBytes > CERTIFIED_RESPONSE_PAYLOAD_CEILING) throw new ServiceH14RuntimeError('memory', 'service_h14_response_ceiling');
      if (message.type === 'current' && task.currentSeen) throw new Error('service_h14_duplicate_current');
      this.#responseBytes = messageBytes;
      // Current remains in the Worker while final is constructed and cloned.
      // Both actual output pairs remain owned through retirement.
      this.#workerResponseBytes += 2 * messageBytes;
      if (message.type === 'result') {
        this.#auditFinal(task, message.output, message.priceSeal, message.prefixSeal);
        return;
      }
      this.#validateOutput(task, message.output, 'current');
      if (message.type === 'current') {
        task.currentSeen = true;
        task.partial = structuredClone(message.output);
        try {
          if (task.onCurrent) {
            this.#observerBytes = outputBytes;
            task.onCurrent(structuredClone(message.output));
          }
        } catch { task.observerFailures++; }
        finally { this.#observerBytes = 0; }
      }
    } catch (error) {
      // Binding's independent original-deadline check may fire after this Client's check passed.
      if (task && (error instanceof ServiceH14DeadlineError || (error instanceof ServiceH14RuntimeError && error.code === 'deadline'))) this.#cancel(task, 'deadline');
      else if (error instanceof ServiceH14RuntimeError && error.code==='memory') this.#fail(live,error,'memory');
      else if(error instanceof ServiceH14AuditBudgetError){
        const checkpoint=preserveCurrentOnAuditRefusal(error,task?.partial);
        this.#fail(live,new ServiceH14RuntimeError('memory',error.message),checkpoint?.interruption);
      }
      else this.#fail(live, error instanceof ServiceH14RuntimeError ? error : new ServiceH14RuntimeError('binding', String(error)));
    } finally { if (!this.#auditing) this.#responseBytes = 0; }
  }
  async #pump() {
    if (this.#pumping || this.#disposed || this.#active) return;
    this.#pumping = true;
    clearTimeout(this.#idle);
    try {
      let barrier: Promise<void>;
      do { barrier = this.#barrier; await barrier; } while (barrier !== this.#barrier);
      if (this.#disposed || this.#active) return;
      if (this.#terminationFailure !== undefined) {
        for (const task of this.#queue.splice(0)) this.#finish(task, new ServiceH14RuntimeError('worker', `service_h14_termination_failed: ${String(this.#terminationFailure)}`));
        return;
      }
      const task = this.#queue.shift();
      if (!task) {
        if (this.#live) this.#idle = setTimeout(() => this.#retire(), this.options.idleTimeoutMs ?? 30_000);
        return;
      }
      this.#active = task;
      task.phase = 'init';
      task.started = performance.now();
      this.#check(task);
      if (!this.#live) {
        const live: Live = { port: this.options.createWorker(), generation: ++this.#generation, ready: false, unlisten: () => {} };
        this.#live = live;
        task.request.generation = live.generation;
        live.unlisten = live.port.listen(message => this.#onMessage(live, message), error => this.#fail(live, error, 'worker'));
        live.port.postMessage({ type: 'init', generation: live.generation, profile: task.request.profile, ...(task.request.input.forecastPublication?.artifact && !task.request.input.legacyD0 ? {priceKey:this.#priceKey} : {}), ...(task.priceParent ? {priceParent:task.priceParent} : {}) });
      } else {
        task.request.generation = this.#live.generation;
        if (this.#live.ready) void this.#bindAndStart(task, this.#live);
      }
    } catch (error) {
      const task = this.#active;
      this.#active = undefined;
      this.#retire();
      if (task) this.#finish(task, error);
    } finally {
      this.#pumping = false;
      if (this.#queue.length && !this.#active && !this.#disposed) void this.#pump();
    }
  }
  request(input: ServiceH14Input, options: ServiceH14RequestOptions): Promise<ServiceH14ClientResult> {
    const parent = this.#priceParent;
    this.#priceParent = undefined;
    let priceParent: PriceParent | undefined;
    const submitted = performance.now();
    const epoch = Date.now();
    if (!Number.isFinite(submitted) || !Number.isFinite(epoch) || submitted > performance.now() || epoch > Date.now()) {
      return Promise.reject(new ServiceH14RuntimeError('deadline', 'service_h14_start_clock'));
    }
    if (this.#disposed) return Promise.reject(new ServiceH14RuntimeError('disposed', 'service_h14_client_disposed'));
    if (options.signal?.aborted) return Promise.reject(new ServiceH14RuntimeError('aborted', 'service_h14_aborted'));
    let request: PendingRequest;
    let bytes: number;
    let deadlineMs: number;
    try {
      assertServiceH14Profile(SERVICE_H14_PROFILE);
      if (!options.sessionId || typeof options.sessionId !== 'string' || options.sessionId.length > 256) throw new Error('service_h14_request_context');
      if (!this.#admits(INPUT_SCAN_BYTES)) throw new ServiceH14RuntimeError('memory','service_h14_scan_capacity');
      this.#transientBytes += INPUT_SCAN_BYTES;
      scanServiceJson(input,() => { if (performance.now()-submitted>=Math.min(options.totalDeadlineMs??20_000,20_000)) throw new ServiceH14RuntimeError('deadline','service_h14_snapshot_deadline'); });
      const maximumDeadlineMs = serviceH14DeadlineMs(input);
      deadlineMs = options.totalDeadlineMs ?? maximumDeadlineMs;
      if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > maximumDeadlineMs) throw new ServiceH14RuntimeError('deadline', 'service_h14_deadline_range');
      if (input.priceParent !== undefined || input.priceBasisStock !== undefined) throw new Error('service_h14_injected_price_basis');
      if (options.parentInputHash !== undefined) {
        if (!parent || options.parentInputHash!==parent.hash) throw new Error('service_h14_price_parent_mismatch');
        assertPhysicalChild(input,{id:this.#nextId+1,generation:this.#generation+1,sessionId:options.sessionId},parent);
        if (samePriceScope(input,parent)) {
          const {seal,...receipt} = parent;
          priceParent = receipt;
          input = {...input,priceParent:seal,priceBasisStock:parent.basis};
        }
      }
      const source: PendingRequest = { type: 'calculate', id: ++this.#nextId, generation: 0, sessionId: options.sessionId,
        input,
        profile: SERVICE_H14_PROFILE, deadlineAt: epoch + deadlineMs };
      bytes = payloadBytes(source) + 1024; // Admission adds the full hash and forecast identity before the Worker clone.
      if (!this.#admits(2 * bytes)) throw new ServiceH14RuntimeError('memory', 'service_h14_input_snapshot_capacity');
      request = structuredClone(source);
      if (performance.now() - submitted >= deadlineMs) throw new ServiceH14RuntimeError('deadline', 'service_h14_snapshot_deadline');
    } catch (error) { return Promise.reject(error); } finally { this.#transientBytes = 0; }
    for (const old of [...this.#queue]) if (old.request.sessionId === options.sessionId) this.#cancel(old, 'superseded');
    if (this.#active?.request.sessionId === options.sessionId) this.#cancel(this.#active, 'superseded');
    let resolve!: Task['resolve'];
    let reject!: Task['reject'];
    const promise = new Promise<ServiceH14ClientResult>((resolveRequest, rejectRequest) => {
      resolve = resolveRequest;
      reject = rejectRequest;
    });
    const task: Task = { priceParent, request, bytes, submitted, deadlineMs, phase: 'queued', settled: false,
      currentSeen: false, computeAcknowledged: false, observerFailures: 0, resolve, reject, ...(options.onCurrent ? { onCurrent: options.onCurrent } : {}) };
    task.timer = setTimeout(() => this.#cancel(task, 'deadline'), Math.max(0, deadlineMs - (performance.now() - submitted)));
    if (options.signal) {
      const signal = options.signal;
      const abort = () => this.#cancel(task, 'aborted');
      signal.addEventListener('abort', abort, { once: true });
      task.removeAbort = () => signal.removeEventListener('abort', abort);
    }
    this.#queue.push(task);
    void this.#pump();
    return promise;
  }
  async dispose() {
    this.#disposed = true;
    clearTimeout(this.#idle);
    for (const task of this.#queue.splice(0)) this.#finish(task, new ServiceH14RuntimeError('disposed', 'service_h14_client_disposed'));
    if (this.#active) { this.#finish(this.#active, new ServiceH14RuntimeError('disposed', 'service_h14_client_disposed')); this.#active = undefined; }
    this.#retire();
    await this.#barrier;
    await Promise.allSettled([...this.#pendingBindings]);
  }
}

