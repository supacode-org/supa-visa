// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { chmodSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { RotatingLogFile } from "../src/logfile.ts";
import { FakeClock, temporaryDirectory } from "./helpers.ts";

const line = (index: number) => JSON.stringify({ index, padding: "x".repeat(90) });

test("keeps the newest lines within the size limit, oldest segments deleted first", async (t) => {
  const directory = join(await temporaryDirectory(t), "logs");
  const time = new FakeClock(Date.parse("2026-11-22T10:00:00.000Z"));
  const log = new RotatingLogFile({ directory, maxBytes: 8 * 1024, segments: 4, clock: time.clock });
  for (let index = 0; index < 500; index++) {
    time.now += 1;
    log.write(line(index));
  }
  log.close();
  const files = log.files();
  const total = files.reduce((sum, file) => sum + file.size, 0);
  assert.ok(total <= 8 * 1024, `total ${total}`);
  assert.ok(files.length >= 2 && files.length <= 4, `${files.length} segments`);
  const lines = files.flatMap((file) => readFileSync(join(directory, file.name), "utf8").trim().split("\n").map((entry) => JSON.parse(entry).index));
  assert.equal(lines.at(-1), 499, "the newest line is kept");
  assert.ok(lines[0] > 0, "the oldest lines were dropped");
  assert.deepEqual(lines, [...lines].sort((a, b) => a - b), "in order across segments");
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  for (const file of files) assert.equal(statSync(join(directory, file.name)).mode & 0o777, 0o600);
});

test("continues the newest segment after a restart", async (t) => {
  const directory = join(await temporaryDirectory(t), "logs");
  const time = new FakeClock(Date.parse("2026-11-22T10:00:00.000Z"));
  const first = new RotatingLogFile({ directory, maxBytes: 64 * 1024, clock: time.clock });
  first.write(line(1));
  first.close();
  time.now += 1000;
  const second = new RotatingLogFile({ directory, maxBytes: 64 * 1024, clock: time.clock });
  second.write(line(2));
  second.close();
  assert.equal(second.files().length, 1);
});

test("a failed write is reported and never thrown", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root ignores file permissions");
  const directory = join(await temporaryDirectory(t), "logs");
  const errors: unknown[] = [];
  const log = new RotatingLogFile({ directory, maxBytes: 2048, segments: 2, clock: () => Date.now(), onError: (error) => errors.push(error) });
  log.close();
  chmodSync(directory, 0o500);
  try {
    log.write(line(1));
  } finally {
    chmodSync(directory, 0o700);
  }
  assert.equal(errors.length, 1);
});

test("segments started in the same millisecond stay in order", async (t) => {
  const directory = join(await temporaryDirectory(t), "logs");
  const time = new FakeClock(Date.parse("2026-11-22T10:00:00.000Z"));
  const log = new RotatingLogFile({ directory, maxBytes: 64 * 1024 * 1024, segments: 8, clock: time.clock });
  const big = "y".repeat(8 * 1024 * 1024 - 200);
  for (let index = 0; index < 12; index++) log.write(JSON.stringify({ index, big }));
  log.close();
  const order = log.files().map((file) => JSON.parse(readFileSync(join(directory, file.name), "utf8").split("\n")[0] as string).index);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(log.files().every((file) => /-\d{4}\.log$/.test(file.name)));
});

test("the setup code stays out of the audit files", async () => {
  const { hideSetupCode } = await import("../src/log.ts");
  const line = JSON.stringify({ time: "t", level: "warn", event: "setup.code", code: "ABCD-EFGH", expiresAt: null });
  const hidden = hideSetupCode(line);
  assert.ok(!hidden.includes("ABCD"));
  assert.deepEqual(JSON.parse(hidden), { time: "t", level: "warn", event: "setup.code", code: "(hidden; see stdout)", expiresAt: null });
});
