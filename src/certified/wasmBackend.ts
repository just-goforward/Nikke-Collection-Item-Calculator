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
    this.exports.certified_reset_heap_peak();
    if (this.exports.certified_abi_version() !== 1) throw new Error("certified_wasm_abi_mismatch");
    this.account();
  }
  get memoryBytes(): number {
    return this.exports.memory.buffer.byteLength;
  }
  get hasFailed(): boolean {
    return this.failed;
  }
  dispose(refreshEvidenceAccounting = false): void {
    // A trapped instance is never reused: Rust destructors may not have run.
    if (!this.failed) {
      this.exports.certified_release();
      // Final evidence consumers share this budget after return. Retire only
      // released Rust allocations, retaining any live ABI/cache allocation.
      if (refreshEvidenceAccounting)
        this.budget.setWasmPayload(this.exports.certified_heap_live());
      idleInstances.set(this.module, this.exports);
    }
  }
  private account(): void {
    this.budget.setWasmPayload(this.exports.certified_heap_peak());
  }
  private enterWasm<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      // V8 can surface stack exhaustion as RangeError, and host imports may
      // throw arbitrary values. None guarantees that Rust unwound its frames.
      this.failed = true;
      throw error;
    }
  }
  private call<T>(command: unknown, retainCompletedPayload = false): T {
    if (this.failed) throw new CertifiedLimit("certified_wasm_instance_failed");
    this.budget.check();
    const text = JSON.stringify(command);
    const bytes = new TextEncoder().encode(text);
    if (retainCompletedPayload) this.budget.check();
    const transient = text.length * 2 + bytes.byteLength;
    if (retainCompletedPayload) reserveTargetPayload(this.budget, transient);
    else this.budget.reserve(transient);
    try {
      this.exports.certified_heap_limit(
        Math.max(0, this.budget.maxManagedPayloadBytes - this.budget.hostPayloadBytes),
      );
      const pointer = this.enterWasm(() => this.exports.certified_input(bytes.byteLength));
      if (!pointer) throw new CertifiedLimit("managed_payload_ceiling");
      new Uint8Array(this.exports.memory.buffer, pointer, bytes.byteLength).set(bytes);
      this.enterWasm(() => this.exports.certified_call());
      // Evidence retention must compete with this command's Rust peak, not the
      // preceding command's peak. Preserve the historical opt-out ordering.
      if (retainCompletedPayload) this.account();
      const length = this.exports.certified_output_len();
      // Admit the retained parsed envelope and conversion workspace before decoding.
      // Unlike the ordinary call transient, this remains charged for the request.
      if (retainCompletedPayload) reserveTargetPayload(this.budget, 2048 + length * 16);
      if (retainCompletedPayload) reserveTargetPayload(this.budget, length * 3);
      else this.budget.reserve(length * 3);
      try {
        if (retainCompletedPayload) this.budget.check();
        const response = JSON.parse(
          new TextDecoder().decode(
            new Uint8Array(this.exports.memory.buffer, this.exports.certified_output_ptr(), length),
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
        this.account();
        if (response.error) throw new CertifiedLimit(response.error);
        if (retainCompletedPayload) this.budget.check();
        return response.value;
      } finally {
        this.budget.release(length * 3);
      }
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) {
        this.failed = true;
        this.account();
        throw new CertifiedLimit(
          this.exports.certified_allocation_denied()
            ? "managed_payload_ceiling"
            : "certified_wasm_trap",
        );
      }
      throw error;
    } finally {
      this.budget.release(transient);
    }
  }
  prepare(
    input: CertifiedInput,
    sid: number,
    priors: readonly Q[],
  ): NonNullable<CertifiedOutput["pricing"]> {
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
