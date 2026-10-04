import { randomUUID } from "node:crypto";
import fs from "node:fs";

export function writeAtomicJson(destination: string, value: unknown) {
  // Keep failed temporary files as evidence. Never unlink the destination first.
  // Publishing a completed file is distinct from power-loss durability or CAS.
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, destination);
}
