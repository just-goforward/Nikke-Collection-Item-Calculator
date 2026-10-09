import type { CertifiedEngineProfile } from "../../shared/certifiedEngineProfile.ts";
import {
  assertCertifiedForecastIdentity,
  type CertifiedForecastIdentity,
  sameCertifiedForecastIdentity,
} from "../../shared/certifiedForecastIdentity.ts";
import {
  CERTIFIED_RESPONSE_METADATA_CEILING,
  CERTIFIED_RESPONSE_PAYLOAD_CEILING,
  CERTIFIED_RUNTIME_PAYLOAD_CEILING,
  CERTIFIED_TOTAL_DEADLINE_MS,
  type CertifiedMemory,
  type CertifiedRequest,
  type CertifiedResponse,
  type CertifiedTiming,
  payloadBytes,
  requireProfile,
} from "./protocol.ts";

export type CertifiedWorkerPort<I, O> = {
  runtime: "browser" | "node";
  postMessage(message: CertifiedRequest<I>): void;
  listen(
    message: (value: CertifiedResponse<O>) => void,
    error: (error: unknown) => void,
  ): () => void;
  terminate(): unknown;
};
export class CertifiedRuntimeError extends Error {
  constructor(
    readonly code:
      | "aborted"
      | "superseded"
      | "deadline"
      | "disposed"
      | "worker"
      | "profile"
      | "memory",
    message: string,
  ) {
    super(message);
    this.name = "CertifiedRuntimeError";
  }
}
type CertifiedClientResult<O> = {
  output: O;
  engineProfile: CertifiedEngineProfile;
  forecastIdentity?: CertifiedForecastIdentity;
  timing: CertifiedTiming;
  memory: CertifiedMemory;
  diagnostics: {
    observerCallbackFailureCount: number;
    observerFailureCode: "observer_callback_failure" | null;
  };
};
type Task<I, O> = {
  id: number;
  sessionId: string;
  input: I;
  profile: CertifiedEngineProfile;
  bytes: number;
  submitted: number;
  deadlineAt: number;
  deadlineMs: number;
  initStarted?: number;
  initFinished?: number;
  computeStarted?: number;
  responseReceived?: number;
  phase: "queued" | "init" | "compute" | "response";
  settled: boolean;
  observerCallbackFailureCount: number;
  partial?: { output: O };
  forecastIdentity?: CertifiedForecastIdentity;
  onCurrent?: (output: O) => void;
  timer?: ReturnType<typeof setTimeout>;
  removeAbort?: () => void;
  resolve: (result: CertifiedClientResult<O>) => void;
  reject: (error: unknown) => void;
};
type Live<I, O> = {
  port: CertifiedWorkerPort<I, O>;
  generation: number;
  ready: boolean;
  unlisten: () => void;
};
type OutputResponse<O> = Extract<CertifiedResponse<O>, { output: O }>;
type RunResponse<O> = Exclude<CertifiedResponse<O>, { type: "initComplete" }>;

class CertifiedClient<I, O> {
  private live: Live<I, O> | undefined;
  private active: Task<I, O> | undefined;
  private generation = 0;
  private nextId = 0;
  private disposed = false;
  private pumping = false;
  private workerBytes = 0;
  private workerBindingBytes = 0;
  private retiredBytes = 0;
  private responseBytes = 0;
  private workerResponseBytes = 0;
  private observerBytes = 0;
  private transientBytes = 0;
  private reservedResponseBytes = 0;
  private readonly bindings = new Map<number, { task: Task<I, O>; bytes: number }>();
  private readonly pendingBindings = new Set<Promise<CertifiedForecastIdentity>>();
  private terminationFailure: unknown;
  private barrier: Promise<void> = Promise.resolve();
  private idle: ReturnType<typeof setTimeout> | undefined;
  private readonly queue: Task<I, O>[] = [];
  private readonly payloadCeiling: number;
  constructor(private readonly options: CertifiedClientOptions<I, O>) {
    this.payloadCeiling = Math.min(
      options.maxPayloadBytes ?? CERTIFIED_RUNTIME_PAYLOAD_CEILING,
      CERTIFIED_RUNTIME_PAYLOAD_CEILING,
    );
    if (!Number.isSafeInteger(this.payloadCeiling) || this.payloadCeiling < 1)
      throw new Error("Invalid runtime payload ceiling.");
  }
  private admits = (extraBytes: number) =>
    this.memory().totalPayloadBytes + this.reservedResponseBytes + extraBytes <=
    this.payloadCeiling;
  memory = (): CertifiedMemory => {
    const queuedPayloadBytes = this.queue.reduce((n, task) => n + task.bytes, 0);
    const activePayloadBytes = this.active?.bytes ?? 0;
    const partialPayloadBytes = this.active?.partial ? payloadBytes(this.active.partial.output) : 0;
    const bindingPayloadBytes = [...this.bindings.values()].reduce(
      (sum, { task, bytes }) =>
        sum + bytes + (this.active === task || this.queue.includes(task) ? 0 : task.bytes),
      0,
    );
    return {
      queuedPayloadBytes,
      activePayloadBytes,
      workerPayloadBytes: this.workerBytes,
      retiredPayloadBytes: this.retiredBytes,
      partialPayloadBytes,
      responsePayloadBytes: this.responseBytes,
      workerResponsePayloadBytes: this.workerResponseBytes,
      observerPayloadBytes: this.observerBytes,
      transientPayloadBytes: this.transientBytes,
      bindingPayloadBytes,
      workerBindingPayloadBytes: this.workerBindingBytes,
      reservedResponseCapacityBytes: this.reservedResponseBytes,
      totalPayloadBytes:
        queuedPayloadBytes +
        activePayloadBytes +
        this.workerBytes +
        this.retiredBytes +
        partialPayloadBytes +
        this.responseBytes +
        this.workerResponseBytes +
        this.observerBytes +
        this.transientBytes +
        bindingPayloadBytes +
        this.workerBindingBytes,
    };
  };
  private finish = (task: Task<I, O>, error?: unknown, output?: O) => {
    if (task.settled) return;
    task.settled = true;
    clearTimeout(task.timer);
    task.removeAbort?.();
    delete task.removeAbort;
    delete task.onCurrent;
    if (error !== undefined) task.reject(error);
    else {
      const now = performance.now();
      const initStart = task.initStarted ?? now;
      const initEnd = task.initFinished ?? initStart;
      const computeStart = task.computeStarted ?? initEnd;
      const response = task.responseReceived ?? now;
      task.resolve({
        output: output as O,
        engineProfile: task.profile,
        ...(task.forecastIdentity ? { forecastIdentity: task.forecastIdentity } : {}),
        timing: {
          queuedMs: initStart - task.submitted,
          initMs: initEnd - initStart,
          computeMs: response - computeStart,
          responseMs: now - response,
          totalMs: now - task.submitted,
        },
        memory: this.memory(),
        diagnostics: {
          observerCallbackFailureCount: task.observerCallbackFailureCount,
          observerFailureCode: task.observerCallbackFailureCount
            ? "observer_callback_failure"
            : null,
        },
      });
    }
  };
  private retire = () => {
    const old = this.live;
    if (!old) return;
    this.live = undefined;
    old.unlisten();
    const bytes = this.workerBytes + this.workerResponseBytes + this.workerBindingBytes;
    this.workerBytes = 0;
    this.workerResponseBytes = 0;
    this.workerBindingBytes = 0;
    this.reservedResponseBytes = 0;
    this.retiredBytes += bytes;
    let completion: unknown;
    try {
      completion = old.port.terminate();
    } catch (error) {
      this.terminationFailure = error;
      return;
    }
    this.barrier = this.barrier.then(async () => {
      try {
        await completion;
        if (old.port.runtime === "node") this.retiredBytes = Math.max(0, this.retiredBytes - bytes);
      } catch (error) {
        this.terminationFailure = error;
      }
    });
  };
  private armIdle = () => {
    clearTimeout(this.idle);
    if (!this.disposed && !this.active && this.queue.length === 0 && this.live) {
      this.idle = setTimeout(() => {
        this.retire();
      }, this.options.idleTimeoutMs ?? 30_000);
    }
  };
  private cancel = (task: Task<I, O>, code: "aborted" | "superseded" | "deadline") => {
    if (task.settled) return;
    if (this.active === task) {
      this.retire();
    } else {
      const index = this.queue.indexOf(task);
      if (index >= 0) this.queue.splice(index, 1);
    }
    if ((code === "deadline" || code === "aborted") && task.partial) {
      const output =
        this.options.preservePartial?.(task.partial.output, code) ?? task.partial.output;
      this.responseBytes = payloadBytes(output);
      task.responseReceived = performance.now();
      this.finish(task, undefined, output);
      this.responseBytes = 0;
    } else
      this.finish(
        task,
        new CertifiedRuntimeError(code, `Certified solve ${code} during ${task.phase}.`),
      );
    if (this.active === task) this.active = undefined;
    void this.pump();
  };
  private failLive = (current: Live<I, O>, error: unknown, preserve?: "deadline" | "worker") => {
    if (this.live !== current) return;
    const task = this.active;
    this.retire();
    if (task?.partial && preserve) {
      const output =
        this.options.preservePartial?.(task.partial.output, preserve) ?? task.partial.output;
      this.responseBytes = payloadBytes(output);
      task.responseReceived = performance.now();
      this.finish(task, undefined, output);
      this.responseBytes = 0;
    } else if (task)
      this.finish(
        task,
        error instanceof CertifiedRuntimeError
          ? error
          : new CertifiedRuntimeError("worker", String(error)),
      );
    this.active = undefined;
    void this.pump();
  };
  private currentTask = (task: Task<I, O>, current: Live<I, O>) =>
    this.active === task && this.live === current && !task.settled;
  private trackBinding = (task: Task<I, O>, bytes: number) => {
    if (bytes === 0) {
      this.bindings.delete(task.id);
      return;
    }
    const prior = this.bindings.get(task.id)?.bytes ?? 0;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !this.admits(bytes - prior))
      throw new CertifiedRuntimeError(
        "memory",
        "Runtime payload capacity unavailable for forecast hash copies.",
      );
    this.bindings.set(task.id, { task, bytes });
  };
  private bindForecast = async (task: Task<I, O>, current: Live<I, O>) => {
    if (!this.options.bindForecastIdentity) return true;
    try {
      const binding = this.options.bindForecastIdentity(task.input, (bytes) =>
        this.trackBinding(task, bytes),
      );
      this.pendingBindings.add(binding);
      let forecastIdentity: CertifiedForecastIdentity;
      try {
        forecastIdentity = await binding;
      } finally {
        this.pendingBindings.delete(binding);
      }
      if (!this.currentTask(task, current)) return false;
      task.forecastIdentity = assertCertifiedForecastIdentity(forecastIdentity);
      const bytes = payloadBytes({ forecastIdentity: task.forecastIdentity });
      if (!this.admits(bytes))
        throw new CertifiedRuntimeError("memory", "Forecast identity exceeds runtime capacity.");
      task.bytes += bytes;
      return true;
    } catch (error) {
      if (this.currentTask(task, current)) this.failLive(current, error);
      return false;
    } finally {
      this.bindings.delete(task.id);
    }
  };
  private startCompute = async (task: Task<I, O>, current: Live<I, O>) => {
    if (!this.currentTask(task, current)) return;
    if (!(await this.bindForecast(task, current)) || !this.currentTask(task, current)) return;
    if (Date.now() >= task.deadlineAt) {
      this.cancel(task, "deadline");
      return;
    }
    task.initFinished = performance.now();
    task.phase = "compute";
    task.computeStarted = performance.now();
    const responseCapacity =
      6 * (CERTIFIED_RESPONSE_PAYLOAD_CEILING + CERTIFIED_RESPONSE_METADATA_CEILING);
    let bindingCapacity: number;
    try {
      bindingCapacity = this.options.forecastIdentityWorkspaceBound?.(task.input) ?? 0;
    } catch (error) {
      this.failLive(current, error);
      return;
    }
    if (
      !Number.isSafeInteger(bindingCapacity) ||
      bindingCapacity < 0 ||
      !this.admits(task.bytes + responseCapacity + bindingCapacity)
    ) {
      this.active = undefined;
      this.finish(
        task,
        new CertifiedRuntimeError(
          "memory",
          "Runtime payload capacity unavailable before worker clone.",
        ),
      );
      void this.pump();
      return;
    }
    this.reservedResponseBytes = responseCapacity;
    this.workerBytes = task.bytes;
    this.workerBindingBytes = bindingCapacity;
    try {
      current.port.postMessage({
        type: "solve",
        generation: current.generation,
        id: task.id,
        sessionId: task.sessionId,
        engineProfile: task.profile,
        ...(task.forecastIdentity ? { forecastIdentity: task.forecastIdentity } : {}),
        deadlineAt: task.deadlineAt,
        input: task.input,
      });
    } catch (error) {
      this.failLive(current, error);
    }
  };
  private completeInitialization = (current: Live<I, O>, profile: unknown) => {
    try {
      requireProfile(profile);
    } catch (error) {
      this.failLive(current, error);
      return;
    }
    if (current.ready) return;
    current.ready = true;
    this.retiredBytes = 0; // Browser termination has no completion signal: retain until replacement boots.
    if (this.active) void this.startCompute(this.active, current);
  };
  private expired = (task: Task<I, O>) =>
    Date.now() >= task.deadlineAt || performance.now() - task.submitted >= task.deadlineMs;
  private receiveCurrent = (task: Task<I, O>, current: Live<I, O>, output: O) => {
    if (!current.ready || task.phase !== "compute") return;
    if (this.expired(task)) {
      this.cancel(task, "deadline");
      return;
    }
    task.partial = { output: structuredClone(output) };
    try {
      this.observerBytes = task.onCurrent ? payloadBytes(output) : 0;
      task.onCurrent?.(structuredClone(output));
    } catch {
      task.observerCallbackFailureCount++;
    } finally {
      this.observerBytes = 0;
    }
  };
  private boundEnvelope = (task: Task<I, O>, current: Live<I, O>, message: RunResponse<O>) => {
    try {
      requireProfile(message.engineProfile);
      if (
        this.options.bindForecastIdentity &&
        !(
          message.type === "error" &&
          task.phase === "init" &&
          message.id === undefined &&
          !task.forecastIdentity
        ) &&
        (!task.forecastIdentity ||
          !sameCertifiedForecastIdentity(
            task.forecastIdentity,
            assertCertifiedForecastIdentity(message.forecastIdentity),
          ))
      )
        throw new Error("Worker forecast identity does not match submitted snapshot.");
      if (
        payloadBytes(message) - ("output" in message ? payloadBytes(message.output) : 0) >
        CERTIFIED_RESPONSE_METADATA_CEILING
      )
        throw new Error("Worker response metadata ceiling exceeded.");
    } catch (error) {
      this.failLive(current, error);
      return false;
    }
    return true;
  };
  private boundResponse = (task: Task<I, O>, current: Live<I, O>, message: OutputResponse<O>) => {
    try {
      if (task.forecastIdentity)
        this.options.validateOutputBinding?.(message.output, task.forecastIdentity);
    } catch (error) {
      this.failLive(current, error);
      return false;
    }
    return this.boundedOutput(current, message.output);
  };
  private acceptOutput = (task: Task<I, O>, current: Live<I, O>, message: OutputResponse<O>) => {
    if (!this.boundResponse(task, current, message)) return;
    if (message.type === "current") {
      this.workerResponseBytes = 2 * payloadBytes(message);
      this.transientBytes = payloadBytes(message);
      try {
        this.receiveCurrent(task, current, message.output);
      } finally {
        this.transientBytes = 0;
      }
      return;
    }
    if (!current.ready || task.phase !== "compute") return;
    if (this.expired(task)) {
      this.cancel(task, "deadline");
      return;
    }
    task.phase = "response";
    task.responseReceived = performance.now();
    this.responseBytes = payloadBytes(message);
    this.workerResponseBytes = 2 * this.responseBytes;
    this.finish(task, undefined, message.output);
    this.responseBytes = 0;
    this.active = undefined;
    this.workerBytes = 0;
    this.workerResponseBytes = 0;
    this.workerBindingBytes = 0;
    this.reservedResponseBytes = 0;
    void this.pump();
  };
  private identifiedRun = (task: Task<I, O>, current: Live<I, O>, message: RunResponse<O>) => {
    if (message.id !== undefined || (message.type === "error" && task.phase === "init"))
      return true;
    this.failLive(current, "Run response request identifier is missing.");
    return false;
  };
  private onMessage = (current: Live<I, O>, message: CertifiedResponse<O>) => {
    if (this.live !== current || message.generation !== current.generation) return;
    if (message.type === "initComplete") {
      this.completeInitialization(current, message.engineProfile);
      return;
    }
    const task = this.active;
    if (!task || task.settled || (message.id !== undefined && message.id !== task.id)) return;
    if (!this.identifiedRun(task, current, message)) return;
    if (!this.boundEnvelope(task, current, message)) return;
    if (message.type === "computeStarted") {
      this.workerBindingBytes = 0;
      return;
    }
    if (message.type === "error") {
      let preserve: "deadline" | "worker" | undefined;
      if (message.code === "request_total_deadline") {
        preserve = "deadline";
      } else if (message.code === "solver_execution_failure") {
        preserve = "worker";
      }
      this.failLive(current, `${message.code}: ${message.message}`, preserve);
      return;
    }
    this.acceptOutput(task, current, message);
  };
  private boundedOutput = (current: Live<I, O>, output: O) => {
    if (payloadBytes(output) <= CERTIFIED_RESPONSE_PAYLOAD_CEILING) return true;
    this.failLive(current, "Worker response payload ceiling exceeded.");
    return false;
  };
  private canPump = () => !this.pumping && !this.disposed && !this.active;
  private async pump() {
    if (!this.canPump()) return;
    this.pumping = true;
    clearTimeout(this.idle);
    try {
      let awaited: Promise<void>;
      do {
        awaited = this.barrier;
        await awaited;
      } while (awaited !== this.barrier);
      if (this.disposed || this.active) return;
      if (this.terminationFailure !== undefined) {
        for (const task of this.queue.splice(0))
          this.finish(
            task,
            new CertifiedRuntimeError(
              "worker",
              `Termination failed: ${String(this.terminationFailure)}`,
            ),
          );
        return;
      }
      const task = this.queue.shift();
      if (!task) {
        this.armIdle();
        return;
      }
      this.active = task;
      task.phase = "init";
      task.initStarted = performance.now();
      if (Date.now() >= task.deadlineAt) {
        this.cancel(task, "deadline");
        return;
      }
      if (!this.live) {
        const port = this.options.createWorker();
        const current: Live<I, O> = {
          port,
          generation: ++this.generation,
          ready: false,
          unlisten: () => {},
        };
        this.live = current;
        current.unlisten = port.listen(
          (message) => this.onMessage(current, message),
          (error) => this.failLive(current, error, "worker"),
        );
        port.postMessage({
          type: "init",
          generation: current.generation,
          engineProfile: task.profile,
        });
      } else if (this.live.ready) void this.startCompute(task, this.live);
    } catch (error) {
      const task = this.active;
      this.active = undefined;
      this.retire();
      if (task) this.finish(task, new CertifiedRuntimeError("worker", String(error)));
    } finally {
      this.pumping = false;
      if (this.queue.length && this.canPump()) void this.pump();
    }
  }
  request(
    input: I,
    request: {
      sessionId: string;
      engineProfile: CertifiedEngineProfile;
      signal?: AbortSignal;
      totalDeadlineMs?: number;
      onCurrent?: (output: O) => void;
    },
  ) {
    const submitted = performance.now();
    const submittedEpoch = Date.now();
    if (this.disposed)
      return Promise.reject(new CertifiedRuntimeError("disposed", "Certified client disposed."));
    let profile: CertifiedEngineProfile;
    let snapshot: I;
    let snapshotBytes: number;
    try {
      profile = structuredClone(requireProfile(request.engineProfile));
      snapshotBytes = payloadBytes({
        input,
        engineProfile: profile,
        sessionId: request.sessionId,
        type: "solve",
        id: 1,
        generation: 1,
        deadlineAt: 0,
      });
      if (!this.admits(2 * snapshotBytes))
        return Promise.reject(
          new CertifiedRuntimeError(
            "memory",
            "Runtime payload ceiling exceeded before input snapshot.",
          ),
        );
      snapshot = structuredClone(input);
    } catch (error) {
      return Promise.reject(new CertifiedRuntimeError("profile", String(error)));
    }
    if (!request.sessionId)
      return Promise.reject(new CertifiedRuntimeError("profile", "sessionId is required."));
    if (request.signal?.aborted)
      return Promise.reject(new CertifiedRuntimeError("aborted", "Certified solve aborted."));
    const deadlineMs = request.totalDeadlineMs ?? CERTIFIED_TOTAL_DEADLINE_MS;
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > CERTIFIED_TOTAL_DEADLINE_MS)
      return Promise.reject(
        new CertifiedRuntimeError("deadline", "Total deadline must be in (0, 15000] ms."),
      );
    if (performance.now() - submitted >= deadlineMs)
      return Promise.reject(
        new CertifiedRuntimeError("deadline", "Total deadline expired while snapshotting input."),
      );
    for (const old of [...this.queue])
      if (old.sessionId === request.sessionId) this.cancel(old, "superseded");
    if (this.active?.sessionId === request.sessionId) this.cancel(this.active, "superseded");
    return new Promise<CertifiedClientResult<O>>((resolve, reject) => {
      const task: Task<I, O> = {
        id: ++this.nextId,
        sessionId: request.sessionId,
        input: snapshot,
        profile,
        bytes: snapshotBytes,
        submitted,
        deadlineAt: submittedEpoch + deadlineMs,
        deadlineMs,
        phase: "queued",
        settled: false,
        observerCallbackFailureCount: 0,
        resolve,
        reject,
      };
      if (request.onCurrent) task.onCurrent = request.onCurrent;
      task.timer = setTimeout(
        () => this.cancel(task, "deadline"),
        Math.max(0, deadlineMs - (performance.now() - submitted)),
      );
      if (request.signal) {
        const signal = request.signal;
        const abort = () => this.cancel(task, "aborted");
        signal.addEventListener("abort", abort, { once: true });
        task.removeAbort = () => signal.removeEventListener("abort", abort);
      }
      this.queue.push(task);
      void this.pump();
    });
  }
  async dispose() {
    this.disposed = true;
    clearTimeout(this.idle);
    for (const task of this.queue.splice(0))
      this.finish(task, new CertifiedRuntimeError("disposed", "Certified client disposed."));
    if (this.active) {
      this.finish(this.active, new CertifiedRuntimeError("disposed", "Certified client disposed."));
      this.active = undefined;
    }
    this.retire();
    await this.barrier;
    await Promise.allSettled([...this.pendingBindings]);
  }
}

export type CertifiedClientOptions<I, O> = {
  createWorker: () => CertifiedWorkerPort<I, O>;
  idleTimeoutMs?: number;
  preservePartial?: (partial: O, interruption: "aborted" | "deadline" | "worker") => O;
  maxPayloadBytes?: number;
  bindForecastIdentity?: (
    input: I,
    trackTransientBytes: (bytes: number) => void,
  ) => Promise<CertifiedForecastIdentity>;
  forecastIdentityWorkspaceBound?: (input: I) => number;
  validateOutputBinding?: (output: O, identity: CertifiedForecastIdentity) => void;
};
export function createCertifiedClient<I, O>(options: CertifiedClientOptions<I, O>) {
  return new CertifiedClient(options);
}
