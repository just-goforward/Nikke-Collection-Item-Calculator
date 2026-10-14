import { createBrowserCertifiedClient } from "./browserClient";
import {
  MINIMUM_WAIT_TIMING_CASES,
  MINIMUM_WAIT_TIMING_REPEATS,
  measureMinimumWaitRequest,
  summarizeMinimumWaitTimings,
} from "./minimumWaitTiming";

/** Standalone manual measurement page, not a calculator route or a saved session. */
export async function runMinimumWaitBrowserTiming() {
  const results: (Awaited<ReturnType<typeof measureMinimumWaitRequest>> & { repeat: number })[] =
    [];
  for (let repeat = 1; repeat <= MINIMUM_WAIT_TIMING_REPEATS; repeat++)
    for (const fixture of MINIMUM_WAIT_TIMING_CASES)
      results.push({
        repeat,
        ...(await measureMinimumWaitRequest(fixture.id, createBrowserCertifiedClient)),
      });
  return {
    environment: {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      devicePixelRatio: window.devicePixelRatio,
    },
    results,
    summary: summarizeMinimumWaitTimings(results),
  };
}

const button = document.querySelector<HTMLButtonElement>("#measure");
const output = document.querySelector<HTMLPreElement>("#results");
if (button && output) {
  button.addEventListener("click", async () => {
    button.disabled = true;
    output.textContent = "Measuring five repeats of six full requests. Keep this page visible…";
    try {
      output.textContent = JSON.stringify(await runMinimumWaitBrowserTiming(), null, 2);
    } catch (error) {
      output.textContent = String(error);
    } finally {
      button.disabled = false;
    }
  });
}
