// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { Heartbeat } from "../src/heartbeat.ts";
import type { SyncStatus } from "../src/sync.ts";
import { FakeClock, recordingLogger } from "./helpers.ts";

const URL_WITH_SECRET = "https://monitor.example.com/push/secret-push-token";

test("beats only while syncing works, and never logs the URL", async () => {
  const { logger, entries } = recordingLogger(new FakeClock(0).clock);
  let status: SyncStatus = { lastSuccessAt: undefined, failingSince: undefined, lastError: undefined };
  const calls: string[] = [];
  let answer = 200;
  const heartbeat = new Heartbeat({
    url: URL_WITH_SECRET,
    status: () => status,
    logger,
    fetch: (async (url: string) => {
      calls.push(url);
      return new Response("", { status: answer });
    }) as unknown as typeof fetch,
  });
  assert.equal(await heartbeat.beat(), false, "never synced yet");
  status = { lastSuccessAt: 1, failingSince: undefined, lastError: undefined };
  assert.equal(await heartbeat.beat(), true);
  status = { lastSuccessAt: 1, failingSince: 2, lastError: "HTTP 503" };
  assert.equal(await heartbeat.beat(), false, "silent while failing, so the monitor alarms");
  assert.deepEqual(calls, [URL_WITH_SECRET]);

  status = { lastSuccessAt: 3, failingSince: undefined, lastError: undefined };
  answer = 500;
  assert.equal(await heartbeat.beat(), false);
  assert.equal(entries.at(-1)?.event, "heartbeat.failed");
  assert.ok(!JSON.stringify(entries).includes("secret-push-token"));
});
