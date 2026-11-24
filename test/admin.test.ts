// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { adminSocketPath, closeAdminServer, parseAdminCommand, sendAdminCommand, startAdminServer } from "../src/admin.ts";
import { FakeClock, recordingLogger, temporaryDirectory } from "./helpers.ts";

test("the socket sits next to the data file", () => {
  assert.equal(adminSocketPath("/data/visa.json"), "/data/admin.sock");
});

test("accepts exactly the reset command", () => {
  assert.deepEqual(parseAdminCommand('{"command":"reset-passkeys","revokeAll":true}'), {
    command: "reset-passkeys",
    revokeAll: true,
  });
  for (const line of [
    "",
    "reset-passkeys",
    "[]",
    "null",
    '{"command":"reset-passkeys"}',
    '{"command":"reset-passkeys","revokeAll":"yes"}',
    '{"command":"delete-everything","revokeAll":false}',
    '{"command":"reset-passkeys","revokeAll":false,"extra":1}',
  ]) {
    assert.equal(parseAdminCommand(line), undefined, line);
  }
});

test("accepts unblock with a bounded target", () => {
  assert.deepEqual(parseAdminCommand('{"command":"unblock","target":"2001:db8::1"}'), { command: "unblock", target: "2001:db8::1" });
  assert.deepEqual(parseAdminCommand('{"command":"unblock","target":"all"}'), { command: "unblock", target: "all" });
  for (const line of [
    '{"command":"unblock"}',
    '{"command":"unblock","target":7}',
    '{"command":"unblock","target":""}',
    '{"command":"unblock","target":"203.0.113.7 or true"}',
    `{"command":"unblock","target":"${"1".repeat(65)}"}`,
    '{"command":"unblock","target":"203.0.113.7","revokeAll":true}',
  ]) {
    assert.equal(parseAdminCommand(line), undefined, line);
  }
});

test("round trip through the socket, which only its owner can open", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "admin.sock");
  await writeFile(path, "left over from a crash");
  const { logger } = recordingLogger(new FakeClock(0).clock);
  const received: unknown[] = [];
  const server = await startAdminServer(
    path,
    async (command) => {
      received.push(command);
      return { ok: true, revokedVisas: 2 };
    },
    logger,
  );
  t.after(() => closeAdminServer(server, path));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await sendAdminCommand(path, { command: "reset-passkeys", revokeAll: true }), { ok: true, revokedVisas: 2 });
  assert.deepEqual(received, [{ command: "reset-passkeys", revokeAll: true }]);
});

test("garbage and oversized messages are refused without running anything", async (t) => {
  const path = join(await temporaryDirectory(t), "admin.sock");
  const { logger } = recordingLogger(new FakeClock(0).clock);
  let calls = 0;
  const server = await startAdminServer(path, async () => (calls++, { ok: true, revokedVisas: 0 }), logger);
  t.after(() => closeAdminServer(server, path));
  const send = (payload: string) =>
    new Promise<string>((resolve) => {
      const socket = createConnection(path, () => socket.write(payload));
      let reply = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => (reply += chunk));
      socket.on("end", () => resolve(reply));
      socket.on("error", () => resolve(reply));
    });
  assert.match(await send("rm -rf /\n"), /unknown command/);
  assert.match(await send(`${"x".repeat(5000)}`), /too long/);
  assert.equal(calls, 0);
});

test("a socket path too long for the system is refused with a clear error", async (t) => {
  const { logger } = recordingLogger(new FakeClock(0).clock);
  const path = join(await temporaryDirectory(t), "x".repeat(100), "admin.sock");
  await assert.rejects(startAdminServer(path, async () => ({ ok: true, revokedVisas: 0 }), logger), /longer than 103 bytes/);
});
