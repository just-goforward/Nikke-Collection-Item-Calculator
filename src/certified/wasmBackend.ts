import { DISPATCH_EXPECTED_PIECES } from "../../shared/certifiedDispatchExpectations";
import { div, fromWire, type Q, q, toWire, type WireQ } from "../../shared/certifiedRational";
import { DISPATCH_CLASSES } from "../../shared/certifiedSupplyLaws";
import {
  DEFAULT_PERSONAL_COHORT_WEIGHTS,
  dateStart,
  FIXED_DISPATCH_COHORT_WEIGHTS,
  ruleAt,
} from "../../shared/certifiedSupplyModel";
import { certifiedVersionPolicy } from "../../shared/certifiedVersionPolicy";
import { CERTIFIED_WASM_HASH } from "../../shared/generated/certifiedWasmBuild";
import { CERTIFIED_WASM_ASSET } from "../../shared/generated/wasmRuntimeAssets";
import { assertWasmAssetBytes, fetchVerifiedWasmAsset } from "../../shared/wasmAssetBytes";
import {
  assertMinimumWaitBinding,
  assertMinimumWaitTie,
  minimumWaitBase,
} from "../certifiedRuntime/minimumWait";
import { CertifiedLimit, reserveTargetPayload, type WorkBudget } from "./budget";
import { completedEvidenceRequested } from "./completedEvidence";
import { decodeRiskSummaries } from "./riskSummary";
import type { CertifiedRiskSummaries } from "./types";
import { eventOffset, futureEvents } from "./events";
import { CAPS, capUnits, EDGES } from "./game";
import type {
  CertifiedCurrent,
  CertifiedInput,
  CertifiedMinimumWait,
  CertifiedMinimumWaitProbe,
  CertifiedOutput,
  CertifiedWaiting,
  CompletedDate,
  Triple,
} from "./types";
import type { ExactValue } from "./value";
import { certifiedValueView } from "./views";
import { decodeCompletedDates } from "./target";
import { liveJsonWorkspace } from "../certifiedRecommendation/liveRuntime";

type Exports = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  certified_abi_version(): number;
  certified_input(length: number): number;
  certified_call(): void;
  certified_output_ptr(): number;
  certified_output_len(): number;
  certified_heap_live(): number;
  certified_heap_peak(): number;
  certified_heap_limit(bytes: number): void;
  certified_allocation_denied(): number;
  certified_release(): void;
  certified_reset_heap_peak(): void;
};
const idleInstances = new WeakMap<WebAssembly.Module, Exports>();
type WireValue = { p: WireQ; b: WireQ; c: WireQ; consumed: [WireQ, WireQ, WireQ]; mask: number };
type BackendCurrent = Omit<CertifiedCurrent, "value"> & { value: WireValue };
type BackendWitness = NonNullable<CertifiedWaiting["strictBoundaryWitness"]>;
type BackendWaiting = Omit<CertifiedWaiting, "value" | "strictBoundaryWitness"> & {
  riskSummaries?: CertifiedRiskSummaries;
  completedDates?: { schemaVersion: 1; records: { day: number; value: WireValue }[] };
  value: WireValue | null;
  strictBoundaryWitness?: Omit<BackendWitness, "beforeValue" | "afterValue"> & {
    beforeValue: WireValue;
    afterValue: WireValue;
  };
};
const valueFromWire = (value: WireValue): ExactValue => ({
  p: fromWire(value.p),
  b: fromWire(value.b),
  c: fromWire(value.c),
  consumed: value.consumed.map(fromWire) as [Q, Q, Q],
  mask: value.mask,
});

/** Called only inside the lazily-created certified Worker. No fallback. */
export async function loadCertifiedWasm(
  readBytes?: () => Promise<Uint8Array>,
): Promise<WebAssembly.Module> {
  const bytes = readBytes
    ? await assertWasmAssetBytes(await readBytes(), CERTIFIED_WASM_ASSET, "certified_wasm")
    : await fetchVerifiedWasmAsset(
        `/${CERTIFIED_WASM_ASSET.file}`,
        CERTIFIED_WASM_ASSET, "certified_wasm", { cache: "no-cache" },
      );
  if (CERTIFIED_WASM_ASSET.sha256 !== CERTIFIED_WASM_HASH)
    throw new Error("certified_wasm_hash_mismatch");
  const module = await WebAssembly.compile(new Uint8Array(bytes));
  const imports = WebAssembly.Module.imports(module);
  if (imports.length !== 1 || imports[0]?.module !== "certified" || imports[0]?.name !== "now_ms")
    throw new Error("certified_wasm_import_contract");
  return module;
}

/** Request-owned memo and supply state; an explicitly cleared idle instance
 * reuses linear memory without relying on GC between sequential Worker requests. */
export class WasmKernel {
  riskSummaries: CertifiedRiskSummaries | undefined;
  completedDates: CompletedDate[] = [];
  readonly exports: Exports;
  private scale = q(1);
  private failed = false;
  private sourceRequestFinished = false;
  private preparedSourceInput: CertifiedInput | null = null;
  private preparedSourceBytes = 0;
  constructor(
    private readonly module: WebAssembly.Module,
    readonly budget: WorkBudget,
  ) {
    this.exports =
      idleInstances.get(module) ??
      (new WebAssembly.Instance(module, {
        certified: { now_ms: () => performance.now() },
      }).exports as Exports);
    idleInstances.delete(module);
    this.enterWasm(() => {
      this.exports.certified_reset_heap_peak();
      this.exports.certified_heap_limit(
        Math.max(0, this.budget.maxManagedPayloadBytes - this.budget.hostPayloadBytes),
      );
      if (this.exports.certified_abi_version() !== 1) throw new Error("certified_wasm_abi_mismatch");
    });
    this.account();
  }
  get memoryBytes(): number {
    return this.exports.memory.buffer.byteLength;
  }
  get hasFailed(): boolean {
    return this.failed;
  }
  /** Borrowed ABI access; callers must copy OUTPUT before nested native calls.
   * Host workspace must be admitted before entry and held until return. */
  withRequestExports<T>(operation: (exports: Exports) => T): T {
    this.assertRequestAvailable();
    this.budget.check();
    this.setHeapLimit();
    const result = this.enterWasm(() => operation(this.exports));
    this.account();
    return result;
  }
  /** Binary extensions share the exact Engine, allocator, clock and trap owner.
   * Admit host input/copy/decode workspace before entry; release after return. */
  withBinaryRequest<T>(operation: (exports: Exports) => T): T {
    this.assertRequestAvailable();
    this.budget.checkNumerical();
    this.setHeapLimit();
    const result = this.enterWasm(() => operation(this.exports));
    this.account();
    this.budget.checkNumerical();
    return result;
  }
  /** Successful native ack is an allocation-free commit. All fallible host
   * admission precedes it; Source and the aggregator must then commit their
   * pre-admitted date synchronously, without a post-success deadline check. */
  ackSourceDate(day: number): number {
    this.assertRequestAvailable();
    if (!Number.isInteger(day) || day < 1 || day > 14)
      throw new Error("joint_source_lifecycle");
    this.budget.checkNumerical();
    this.account();
    const ack = this.exports["certified_joint_ack"];
    if (typeof ack !== "function") throw new Error("certified_wasm_missing_export:certified_joint_ack");
    this.setHeapLimit();
    const status = this.enterWasm(() => ack(day) as number);
    // Only a failed ack may allocate an error envelope. Successful commit
    // must remain free of fallible post-ack accounting/deadline checks.
    if (status !== 0) this.account();
    return status;
  }
  /** The only deadline-free extension boundary: release one named owner only. */
  cleanupSourcePart(part: "joint" | "fused"): void {
    if (this.failed || this.sourceRequestFinished) return;
    const name = part === "joint" ? "certified_joint_clear" : "certified_fused_clear";
    const clear = this.exports[name];
    if (typeof clear !== "function") throw new Error(`certified_wasm_missing_export:${name}`);
    this.enterWasm(() => clear());
    this.account();
  }
  /** Borrowed immutable input actually sent to native preparation, not the
   * caller's mutable object. Valid only while this request owner is live. */
  getPreparedSourceInput(): Readonly<CertifiedInput> {
    this.assertRequestAvailable();
    this.budget.checkNumerical();
    if (!this.preparedSourceInput) throw new Error("certified_source_not_prepared");
    return this.preparedSourceInput;
  }
  private clearPreparedSourceInput(): void {
    this.preparedSourceInput = null;
    this.budget.release(this.preparedSourceBytes);
    this.preparedSourceBytes = 0;
  }
  private captureSourceInput(input: CertifiedInput): CertifiedInput {
    this.clearPreparedSourceInput();
    // Legacy exact modules do not expose a joint source or pay this ownership cost.
    if (typeof this.exports["certified_joint_begin"] !== "function") return input;
    const { forecastPublication: _publication, ...sourceInput } = input;
    const bytes = 256 + liveJsonWorkspace(sourceInput);
    reserveTargetPayload(this.budget, bytes);
    try {
      const captured = structuredClone(sourceInput);
      const freeze = (value: unknown): void => {
        if (value === null || typeof value !== "object") return;
        this.budget.tick();
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      };
      freeze(captured);
      this.budget.checkNumerical();
      this.preparedSourceInput = captured;
      this.preparedSourceBytes = bytes;
      return captured;
    } catch (error) {
      this.budget.release(bytes);
      throw error;
    }
  }
  /** Outer source controller consumes the request once; never pool this instance. */
  finishSourceRequest(): void {
    if (this.sourceRequestFinished) return;
    this.sourceRequestFinished = true;
    this.clearPreparedSourceInput();
    if (this.failed) return;
    const live = this.enterWasm(() => {
      this.exports.certified_release();
      return this.exports.certified_heap_live();
    });
    this.budget.setWasmPayload(live);
  }
  private assertRequestAvailable(): void {
    if (this.failed) throw new CertifiedLimit("certified_wasm_instance_failed");
    if (this.sourceRequestFinished) throw new CertifiedLimit("certified_wasm_source_request_finished");
  }
  dispose(refreshEvidenceAccounting = false): void {
    this.clearPreparedSourceInput();
    // A trapped instance is never reused: Rust destructors may not have run.
    if (!this.failed && !this.sourceRequestFinished) {
      this.sourceRequestFinished = true;
      const live = this.enterWasm(() => {
        this.exports.certified_release();
        return this.exports.certified_heap_live();
      });
      if (refreshEvidenceAccounting) this.budget.setWasmPayload(live);
      idleInstances.set(this.module, this.exports);
    }
  }
  /** Consume one synchronous allocation window while its host reservations are
   * still held. The request peak belongs to the budget's historical diagnostic,
   * not to its live reservation: later host work overlaps only retained native
   * allocations. Callers must account before releasing or adding host workspace.
   */
  private account(): void {
    if (this.exports.memory.buffer.byteLength > 192 * 1024 * 1024)
      throw new CertifiedLimit("wasm_linear_memory_ceiling");
    const peak = this.enterWasm(() => this.exports.certified_heap_peak());
    const live = this.enterWasm(() => this.exports.certified_heap_live());
    this.enterWasm(() => {
      // The ABI reset also restores LIMIT to 192 MiB. Restore this request's
      // host-adjusted ceiling immediately, with no callback/allocation between.
      this.exports.certified_reset_heap_peak();
      this.exports.certified_heap_limit(
        Math.max(0, this.budget.maxManagedPayloadBytes - this.budget.hostPayloadBytes),
      );
    });
    try {
      this.budget.setWasmPayload(Math.max(peak, live));
    } finally {
      // Even rejected transient work must not leave a historical reservation.
      this.budget.setWasmPayload(live);
    }
  }
  private setHeapLimit(): void {
    this.enterWasm(() => this.exports.certified_heap_limit(
      Math.max(0, this.budget.maxManagedPayloadBytes - this.budget.hostPayloadBytes),
    ));
  }
  private enterWasm<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      // Quarantine on every escape, including RangeError and host exceptions.
      // The only recovery read is the existing allocator's allocation-free
      // AtomicBool getter. Never call account/reset, release, or resume Rust.
      this.failed = true;
      if (error instanceof WebAssembly.RuntimeError) {
        let denied = false;
        try { denied = this.exports.certified_allocation_denied() === 1; }
        catch { /* A failed observation is not evidence of allocation denial. */ }
        if (!denied) throw new CertifiedLimit("certified_wasm_trap");
        // Legacy callers classify a denial as a limit. A trapped H14 owner,
        // unlike an orderly refusal, can never certify a date prefix.
        throw new CertifiedLimit(typeof this.exports["certified_joint_begin"] === "function"
          ? "certified_wasm_allocation_trap" : "managed_payload_ceiling");
      }
      throw error;
    }
  }
  private call<T>(command: unknown, retainCompletedPayload = false): T {
    this.assertRequestAvailable();
    this.budget.checkNumerical();
    const text = JSON.stringify(command);
    const bytes = new TextEncoder().encode(text);
    if (retainCompletedPayload) this.budget.check();
    const transient = text.length * 2 + bytes.byteLength;
    if (retainCompletedPayload) reserveTargetPayload(this.budget, transient);
    else this.budget.reserve(transient);
    try {
      this.setHeapLimit();
      const pointer = this.enterWasm(() => this.exports.certified_input(bytes.byteLength));
      if (!pointer) throw new CertifiedLimit("managed_payload_ceiling");
      new Uint8Array(this.exports.memory.buffer, pointer, bytes.byteLength).set(bytes);
      this.enterWasm(() => this.exports.certified_call());
      // Close the native window before admitting host decoding/evidence. Those
      // allocations coexist with live OUTPUT/cache, not freed native workspace.
      this.account();
      const length = this.enterWasm(() => this.exports.certified_output_len());
      // Admit the retained parsed envelope and conversion workspace before decoding.
      // Unlike the ordinary call transient, this remains charged for the request.
      if (retainCompletedPayload) reserveTargetPayload(this.budget, 2048 + length * 16);
      if (retainCompletedPayload) reserveTargetPayload(this.budget, length * 3);
      else this.budget.reserve(length * 3);
      try {
        if (retainCompletedPayload) this.budget.check();
        const response = JSON.parse(
          new TextDecoder().decode(
            new Uint8Array(this.exports.memory.buffer, this.enterWasm(() => this.exports.certified_output_ptr()), length),
          ),
        ) as {
          value: T;
          error?: string;
          stats?: {
            memoEntries: number;
            exactTransitions: number;
            supportPeakPoints: number;
            kernelCalls: number;
          };
        };
        if (response.stats) {
          this.budget.memoEntries = response.stats.memoEntries;
          this.budget.exactTransitions = response.stats.exactTransitions;
          this.budget.supportPeakPoints = Math.max(
            this.budget.supportPeakPoints,
            response.stats.supportPeakPoints,
          );
          this.budget.kernelCalls = response.stats.kernelCalls;
        }
        if (response.error) throw new CertifiedLimit(response.error);
        if (retainCompletedPayload) this.budget.check();
        return response.value;
      } finally {
        this.budget.release(length * 3);
      }
    } finally {
      this.budget.release(transient);
    }
  }
  prepare(
    input: CertifiedInput,
    sid: number,
    priors: readonly Q[],
  ): NonNullable<CertifiedOutput["pricing"]> {
    this.assertRequestAvailable();
    this.budget.checkNumerical();
    input = this.captureSourceInput(input);
    try {
      const rule = ruleAt(input.snapshot.rules, dateStart(input.snapshot.coverage.currentDay));
      if (!rule) throw new Error("certified_current_supply_rule_missing");
      return this.call({
        op: "configureSupply",
        basis: input.priceBasisStock ?? input.stock,
        stock: input.stock,
        sid,
        deadline: this.budget.deadlineAt,
        model: {
          snapshotVersion: input.snapshot.version,
          events: futureEvents(input).map((event) => ({
            id: event.id,
            day: eventOffset(input, event),
            refs: event.refs,
          })),
          laws: input.snapshot.laws,
          priors: priors.map(toWire),
          populationPrior: certifiedVersionPolicy(input.snapshot.version).fixedDispatch
            ? FIXED_DISPATCH_COHORT_WEIGHTS
            : DEFAULT_PERSONAL_COHORT_WEIGHTS,
          dispatch: rule.dispatch,
          shop: [...rule.normalShop, ...(rule.weeklyFixed ?? [])],
          solo: rule.soloDays.flat(),
          cadence: {
            numerator: String(input.snapshot.cadence.numerator),
            denominator: String(input.snapshot.cadence.denominator),
          },
          dispatchExpected: DISPATCH_EXPECTED_PIECES.slice(0, priors.length).map((row) =>
            row.map(toWire),
          ),
          classes: DISPATCH_CLASSES,
        },
      });
    } catch (error) {
      this.clearPreparedSourceInput();
      throw error;
    }
  }
  current(sid: number, input: CertifiedInput): CertifiedCurrent {
    const result = this.call<BackendCurrent>({
      op: "current",
      sid,
      stock: input.stock,
      batch: input.batchLimit ?? 10,
    });
    return { ...result, value: certifiedValueView(valueFromWire(result.value)) };
  }
  minimumWait(
    sid: number,
    input: CertifiedInput,
    previous: CertifiedCurrent,
  ): { current: CertifiedCurrent; minimumWait: CertifiedMinimumWait } {
    const result = this.call<{ current: BackendCurrent; minimumWait: unknown }>({
      op: "minimumWait",
      sid,
      stock: input.stock,
      complete: input.snapshot.coverage.future.complete,
    });
    const current = {
      ...result.current,
      value: certifiedValueView(valueFromWire(result.current.value)),
    };
    assertMinimumWaitTie(previous, current, input);
    assertMinimumWaitBinding(result.minimumWait, current);
    return { current, minimumWait: result.minimumWait };
  }
  minimumWaitProbe(
    sid: number,
    input: CertifiedInput,
    current: CertifiedCurrent,
  ): CertifiedMinimumWaitProbe {
    const caps = CAPS[sid];
    if (!caps) throw new CertifiedLimit("invalid_state");
    if (current.kit === null) {
      return {
        version: "certified-minimum-wait-probe-v1",
        status: "NOTRUN",
        recommendation: { kit: null, uses: 0 },
        label: "unknown",
        certificateApplies: false,
        certificateShortcutUsed: false,
        classifierCaps: caps,
        supportUnitsCapped: false,
        reason: "no_recommended_batch",
        complete: false,
        perDay: [],
        minimumWait: minimumWaitBase(current, "not_applicable", "no_recommended_batch"),
      };
    }
    const result = this.call<CertifiedMinimumWaitProbe>({
      op: "minimumWaitProbe",
      sid,
      stock: input.stock,
      kit: ["blue", "purple", "yellow"].indexOf(current.kit),
      uses: current.uses,
      complete: input.snapshot.coverage.future.complete,
    });
    if (
      result.version !== "certified-minimum-wait-probe-v1" ||
      result.recommendation.kit !== current.kit ||
      result.recommendation.uses !== current.uses
    )
      throw new CertifiedLimit("minimum_wait_binding_mismatch");
    assertMinimumWaitBinding(result.minimumWait, current);
    return result;
  }
  waiting(sid: number, input: CertifiedInput): CertifiedWaiting {
    this.riskSummaries = undefined;
    this.completedDates = [];
    const includeCompletedDates = completedEvidenceRequested(input);
    const result = this.call<BackendWaiting>({
      op: "waiting",
      sid,
      stock: input.stock,
      complete: input.snapshot.coverage.future.complete,
      ...(includeCompletedDates ? { includeCompletedDates: true } : {}),
      ...(input.riskSummary === true ? { includeRiskSummaries: true } : {}),
    }, includeCompletedDates);
    const { strictBoundaryWitness: witness, completedDates, riskSummaries, ...rest } = result;
    if (includeCompletedDates) {
      this.completedDates = decodeCompletedDates(completedDates, {
        check: this.budget.check,
        reserve: bytes => reserveTargetPayload(this.budget, bytes),
      },
        value => certifiedValueView(valueFromWire(value)));
    }
    this.riskSummaries = decodeRiskSummaries(riskSummaries, input.riskSummary === true,
      this.completedDates, this.budget);
    return {
      ...rest,
      value: result.value ? certifiedValueView(valueFromWire(result.value)) : null,
      ...(witness
        ? {
            strictBoundaryWitness: {
              ...witness,
              beforeValue: certifiedValueView(valueFromWire(witness.beforeValue)),
              afterValue: certifiedValueView(valueFromWire(witness.afterValue)),
            },
          }
        : {}),
    };
  }
  initialize(weights: readonly [Q, Q, Q]): void {
    this.scale = q(weights[0].d * weights[1].d * weights[2].d);
    this.call({
      op: "init",
      input: {
        edges: EDGES,
        caps: CAPS,
        weights: weights.map(toWire),
        deadlineAt: this.budget.deadlineAt,
        maxMemoEntries: this.budget.maxMemoEntries,
        maxSupportPoints: this.budget.maxSupportPoints,
      },
    });
  }
  actualValue(value: ExactValue): ExactValue {
    return { ...value, b: div(value.b, this.scale) };
  }
  value(sid: number, units: Triple, enumerateRootActions = false): ExactValue {
    return valueFromWire(
      this.call<WireValue>({ op: "value", sid, units, root: enumerateRootActions }),
    );
  }
  solve(sid: number, raw: Triple): ExactValue {
    this.budget.kernelCalls++;
    return this.value(sid, capUnits(sid, raw), true);
  }
  unlimited(sid: number): { value: ExactValue; bound: Triple } {
    const result = this.call<{ value: WireValue; bound: Triple }>({ op: "unlimited", sid });
    return { value: valueFromWire(result.value), bound: result.bound };
  }
}
