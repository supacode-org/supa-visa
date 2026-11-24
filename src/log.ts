// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import type { Clock } from "./clock.ts";

export type LogLevel = "info" | "warn" | "error";
export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export function createLogger(clock: Clock, write: (line: string) => void = writeStdout): Logger {
  const log = (level: LogLevel, event: string, fields: LogFields = {}) => {
    write(JSON.stringify({ time: new Date(clock()).toISOString(), level, event, ...fields }));
  };
  return {
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, fields) => log("error", event, fields),
  };
}

function writeStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The setup code is meant for whoever reads stdout right now; the audit files
// keep it out of the data volume.
export function hideSetupCode(line: string): string {
  const entry = JSON.parse(line) as Record<string, unknown>;
  return JSON.stringify({ ...entry, code: "(hidden; see stdout)" });
}
