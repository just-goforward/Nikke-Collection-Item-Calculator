// Controls, calibration and main released by Lead for the pinned serial plan.
export const RELEASE = Object.freeze({ controls: true, calibrate: true, main: true });
// Lead-approved serial-job ceiling: largest estimate 2538624064 / 0.8 fits.
export const HEAP_CAP_MIB = 4096;
export const NODE_VERSION = "v24.21.0";
// Worker asserts the Lead-observed Node 24.21.0 limit including this slack.
export const OBSERVED_HEAP_LIMIT_SLACK_MIB = 192;
// A containment ceiling, not a proved memory reservation or RSS guarantee.
// Main release additionally requires complete allocation/lifetime accounting.
export const RESOURCE_MODEL_DOCUMENTED = true;
export const MAIN_DEADLINES_CALIBRATED = true;
export const FRAME_BYTES = 65536;
export const CONTROL_MS = 60000;
export const OPERATOR_RULE = "Accept stdout only after supervisor clean close and authenticated pins. If parent/child close is not observed, result is NOTRUN; retain handles, do not retry, operator must inspect/terminate the exact PIDs and confirm cleanup before another run.";
// obligations.json is the sole job ledger and is pinned by identity.json.
// Accounting is complete as an explicit planning model, not a V8/RSS proof.
// Caps are refusal deadlines, NOT predicted runtimes.
export function admission(mode) {
  if (!Object.hasOwn(RELEASE, mode) || !RELEASE[mode])
    return { status: "NOTRUN", reason: "execution_not_released" };
  if (mode === "main" && !RESOURCE_MODEL_DOCUMENTED)
    return { status: "NOTRUN", reason: "resource_accounting_incomplete" };
  if (mode === "main" && !MAIN_DEADLINES_CALIBRATED)
    return { status: "NOTRUN", reason: "main_deadlines_await_B14_calibration" };
  return null;
}
