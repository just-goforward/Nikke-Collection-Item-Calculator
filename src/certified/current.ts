import { CertifiedLimit } from "./budget";
import { decode, EDGES, KIT_INDICES, type StateId, TERMINAL } from "./game";
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
  const kitIndex = KIT_INDICES.find((k) => (root.mask & (1 << k)) !== 0);
  const kit = kitIndex === undefined ? null : KITS[kitIndex];
  let uses = 0;
  let s = sid;
  const stock = [...input.stock] as [number, number, number];
  const start = decode(sid);
  if (kitIndex !== undefined) {
    const limit = input.batchLimit ?? 10;
    while (uses < limit) {
      try {
        const value = uses === 0 ? root : kernel.solve(s, stock);
        if (!(value.mask & (1 << kitIndex))) break;
        uses++;
        stock[kitIndex] = stock[kitIndex] - 10;
        const [p, , normal] = EDGES[s as StateId][kitIndex];
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
  let status: CertifiedCurrent["status"] = "preserve";
  if (sid === TERMINAL) status = "complete";
  else if (kit) status = "use_certified";
  return {
    status,
    value: certifiedValueView(kernel.actualValue(root)),
    kit,
    optimalActionMask: root.mask,
    uses,
    pieces: uses * 10,
    certification: "exact_rational_finite_inventory_v1",
  };
}
