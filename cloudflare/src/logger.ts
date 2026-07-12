type LogValue = string | number | boolean | null | LogValue[] | { [key: string]: LogValue };
type LogFields = Record<string, LogValue>;

function log(level: "error" | "info" | "warn", event: string, fields: LogFields = {}) {
  const line = JSON.stringify({
    level,
    event,
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

export function logError(event: string, fields?: LogFields) {
  log("error", event, fields);
}

export function logInfo(event: string, fields?: LogFields) {
  log("info", event, fields);
}

export function logWarn(event: string, fields?: LogFields) {
  log("warn", event, fields);
}

export function sanitizedError(error: unknown) {
  return error instanceof Error ? error.message : "unknown_error";
}
