import { CertifiedLimit } from "./budget";
import { decode, EDGES, TERMINAL } from "./game";
import type { FiniteKernel } from "./kernel";
import type { CertifiedCurrent, CertifiedInput } from "./types";
import type { ExactValue } from "./value";
import { certifiedValueView } from "./views";

const KITS = ["blue", "purple", "yellow"] as const;
export function currentView(
  sid: number,
  input: CertifiedInput,
  root: ExactValue,
  kernel: FiniteKernel,
): CertifiedCurrent {
  const kitIndex = KITS.findIndex((_, k) => (root.mask & (1 << k)) !== 0);
  const kit = kitIndex < 0 ? null : KITS[kitIndex]!;
  let uses = 0;
  let s = sid;
  const stock = [...input.stock] as [number, number, number];
  const start = decode(sid);
  if (kitIndex >= 0) {
    const limit = input.batchLimit ?? 10;
    while (uses < limit) {
      try {
        const value = uses === 0 ? root : kernel.solve(s, stock);
        if (!(value.mask & (1 << kitIndex))) break;
        uses++;
        stock[kitIndex] = stock[kitIndex]! - 10;
        const [p, , normal] = EDGES[s]![kitIndex]!;
        s = normal;
        const next = decode(s);
        if (
          p === 1000 ||
          s === TERMINAL ||
          next.grade !== start.grade ||
          next.level !== start.level
        )
          break;
      } catch (error) {
        if (error instanceof CertifiedLimit) break;
        throw error;
      }
    }
  }
  return {
    status: sid === TERMINAL ? "complete" : kit ? "use_certified" : "preserve",
    value: certifiedValueView(kernel.actualValue(root)),
    kit,
    optimalActionMask: root.mask,
    uses,
    pieces: uses * 10,
    certification: "exact_rational_finite_inventory_v1",
  };
}
