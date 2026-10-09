import { DISPATCH_EXPECTED_PIECES } from "../../shared/certifiedDispatchExpectations";
import { div, fromWire, type Q, q, toWire, type WireQ } from "../../shared/certifiedRational";
import { DISPATCH_CLASSES } from "../../shared/certifiedSupplyLaws";
import { dateStart, ruleAt } from "../../shared/certifiedSupplyModel";
import { CERTIFIED_WASM_HASH } from "../../shared/generated/certifiedWasmBuild";
import { CertifiedLimit, type WorkBudget } from "./budget";
import { eventOffset, futureEvents } from "./events";
import { CAPS, capUnits, EDGES } from "./game";
import type {
  CertifiedCurrent,
  CertifiedInput,
  CertifiedOutput,
  CertifiedWaiting,
  Triple,
} from "./types";
import type { ExactValue } from "./value";
import { certifiedValueView } from "./views";

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
    ? await readBytes()
    : await (async () => {
        const response = await fetch(
          new URL("../../public/certified_solver.wasm", import.meta.url),
          { cache: "no-cache" },
        );
        if (!response.ok) throw new Error("certified_wasm_fetch_failed");
        return new Uint8Array(await response.arrayBuffer());
      })();
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  const actual = [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, "0")).join("");
  if (actual !== CERTIFIED_WASM_HASH) throw new Error("certified_wasm_hash_mismatch");
  const module = await WebAssembly.compile(new Uint8Array(bytes));
  const imports = WebAssembly.Module.imports(module);
  if (imports.length !== 1 || imports[0]?.module !== "certified" || imports[0]?.name !== "now_ms")
    throw new Error("certified_wasm_import_contract");
  return module;
}

/** Request-owned memo and supply state; an explicitly cleared idle instance
 * reuses linear memory without relying on GC between sequential Worker requests. */
export class WasmKernel {
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
  dispose(): void {
    // A trapped instance is never reused: Rust destructors may not have run.
    if (!this.failed) {
      this.exports.certified_release();
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
  private call<T>(command: unknown): T {
    if (this.failed) throw new CertifiedLimit("certified_wasm_instance_failed");
    this.budget.check();
    const text = JSON.stringify(command);
    const bytes = new TextEncoder().encode(text);
    const transient = text.length * 2 + bytes.byteLength;
    this.budget.reserve(transient);
    try {
      this.exports.certified_heap_limit(
        Math.max(0, this.budget.maxManagedPayloadBytes - this.budget.hostPayloadBytes),
      );
      const pointer = this.enterWasm(() => this.exports.certified_input(bytes.byteLength));
      if (!pointer) throw new CertifiedLimit("managed_payload_ceiling");
      new Uint8Array(this.exports.memory.buffer, pointer, bytes.byteLength).set(bytes);
      this.enterWasm(() => this.exports.certified_call());
      const length = this.exports.certified_output_len();
      this.budget.reserve(length * 3);
      try {
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
    priors: readonly [Q, Q, Q],
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
        events: futureEvents(input).map((event) => ({
          id: event.id,
          day: eventOffset(input, event),
          refs: event.refs,
        })),
        laws: input.snapshot.laws,
        priors: priors.map(toWire),
        dispatch: rule.dispatch,
        shop: rule.normalShop,
        solo: rule.soloDays.flat(),
        cadence: {
          numerator: String(input.snapshot.cadence.numerator),
          denominator: String(input.snapshot.cadence.denominator),
        },
        dispatchExpected: DISPATCH_EXPECTED_PIECES.map((row) => row.map(toWire)),
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
  waiting(sid: number, input: CertifiedInput): CertifiedWaiting {
    const result = this.call<BackendWaiting>({
      op: "waiting",
      sid,
      stock: input.stock,
      complete: input.snapshot.coverage.future.complete,
    });
    const { strictBoundaryWitness: witness, ...rest } = result;
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
