import type { Page } from "@playwright/test";
import { installSnapshotReader } from "./modal-contrast-browser-snapshot";
import { installFontReaders, installStyleReaders } from "./modal-contrast-browser-style";
import type { BrowserSample, RegistryKey } from "./modal-contrast-types";

function installSettlementReader(key: RegistryKey) {
  const registry = window[key];
  if (!registry || registry.document !== document) throw new Error("Diagnostic document changed");
  const capture = registry.helpers.capture;
  if (!capture) throw new Error("Diagnostic snapshot reader missing");
  const nextFrame = (start: number) =>
    new Promise<boolean>((resolve) => {
      let animationFrame = 0;
      const timer = setTimeout(
        () => {
          cancelAnimationFrame(animationFrame);
          resolve(false);
        },
        Math.max(0, Math.min(100, 2_000 - (performance.now() - start))),
      );
      animationFrame = requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  registry.helpers.sample = async (settle): Promise<BrowserSample> => {
    const start = performance.now();
    let previous = "";
    let previousReady = false;
    let unchangedSince = start;
    let matchingFrames = 0;
    const timeline: BrowserSample["timeline"] = [];
    let frame = false;
    while (true) {
      const snapshot = capture();
      const signature = JSON.stringify({
        targets: snapshot.targets,
        elements: snapshot.elements.map(({ animations: _animations, ...element }) => element),
        fonts: snapshot.fonts,
      });
      const ready =
        snapshot.targetsComplete &&
        snapshot.animationIdle &&
        snapshot.entranceOpaque &&
        snapshot.fonts.status === "loaded" &&
        snapshot.fonts.checks.every((check) => check.available === true);
      if (!settle) return { state: "OBSERVED", snapshot, timeline, signature, ready };
      const same = signature === previous;
      if (!ready || !previousReady || !same) {
        unchangedSince = snapshot.completedAt;
        matchingFrames = 0;
      } else if (frame) matchingFrames++;
      timeline.push({ at: snapshot.completedAt, same, ready, frame });
      previous = signature;
      previousReady = ready;
      if (snapshot.completedAt - start >= 2_000)
        return { state: "NOT_SETTLED", snapshot, timeline, signature, ready };
      if (ready && matchingFrames >= 3 && snapshot.completedAt - unchangedSince >= 250)
        return { state: "SETTLED", snapshot, timeline, signature, ready };
      // Fallback bounds a throttled/missing rAF, but never counts as a frame.
      frame = await nextFrame(start);
    }
  };
  registry.installed = true;
  return { url: registry.url, timeOrigin: registry.timeOrigin, key };
}

// Call only in the loaded document, before any product interaction. No style read,
// font readiness wait, animation manipulation or CSS mutation occurs on install.
export async function installModalReaders(page: Page, key: RegistryKey) {
  await page.evaluate(installStyleReaders, key);
  await page.evaluate(installFontReaders, key);
  await page.evaluate(installSnapshotReader, key);
  return page.evaluate(installSettlementReader, key);
}

export async function sampleModal(page: Page, key: RegistryKey, settle = false) {
  const rpcStartedAt = performance.now();
  const value = await page.evaluate(
    ({ registryKey, shouldSettle }) => {
      const registry = window[registryKey];
      if (!registry || registry.document !== document || !registry.installed)
        throw new Error("Diagnostic installation missing or document changed");
      if (!registry.helpers.sample) throw new Error("Diagnostic sampler missing");
      return registry.helpers.sample(shouldSettle);
    },
    { registryKey: key, shouldSettle: settle },
  );
  return { rpcStartedAt, rpcCompletedAt: performance.now(), ...value };
}
