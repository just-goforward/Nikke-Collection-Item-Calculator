/** Explicit build-time development opt-in; never selected by a URL or user setting. */
export const SERVICE_CERTIFIED_SOLVER = import.meta.env["VITE_SERVICE_CERTIFIED_SOLVER"] === "true";
