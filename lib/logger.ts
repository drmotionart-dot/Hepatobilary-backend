// Structured JSON-line logger (spec 16.5): one object per line, so any log
// aggregator (Vercel, a sidecar, journald) can parse it without a pipeline.
// Every line carries a stable `event` + optional `correlationId`, making a
// single request traceable end-to-end. This module is Node-runtime only — the
// Edge middleware stays self-contained (console.log works there).

type Level = "info" | "warn" | "error";

interface LogFields {
  [key: string]: unknown;
}

function emit(level: Level, event: string, message: string, fields?: LogFields): void {
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    message,
    ...(fields ?? {}),
  };
  if (level === "error") console.error(JSON.stringify(line));
  else if (level === "warn") console.warn(JSON.stringify(line));
  else console.log(JSON.stringify(line));
}

export const logger = {
  info: (event: string, message: string, fields?: LogFields) => emit("info", event, message, fields),
  warn: (event: string, message: string, fields?: LogFields) => emit("warn", event, message, fields),
  error: (event: string, message: string, fields?: LogFields) => emit("error", event, message, fields),
};
