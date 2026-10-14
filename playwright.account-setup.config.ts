import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";

/** A port no other process listens on right now; the preview binds it with strictPort. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("account_e2e_port_unavailable"));
      });
    });
  });
}

/**
 * Global setup of playwright.account.config.ts: builds the app into this run's own directory and
 * picks a free port for the specs' preview server.
 */
export default async function globalSetup() {
  const outDir = process.env["ACCOUNT_E2E_DIST"];
  if (!outDir) throw new Error("account_e2e_dist_unset");
  const vite = join("node_modules", "vite", "bin", "vite.js");
  const built = spawnSync(
    process.execPath,
    [vite, "build", "--configLoader", "native", "--outDir", outDir, "--emptyOutDir"],
    { stdio: "inherit" },
  );
  if (built.status !== 0) throw new Error(`account_e2e_build_failed: ${String(built.status)}`);
  process.env["ACCOUNT_E2E_PORT"] = String(await freePort());
}
