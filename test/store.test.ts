// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { Service } from "../src/services.ts";
import { decodeDataFile, EMPTY_STATE, encodeDataFile, FileStore, type State, StoreError } from "../src/store.ts";
import type { Visa } from "../src/visa.ts";
import { temporaryDirectory } from "./helpers.ts";

const VISA: Visa = {
  id: "a",
  target: "203.0.113.7",
  issuedAt: Date.parse("2026-11-22T10:00:00.000Z"),
  expiresAt: Date.parse("2026-11-22T14:00:00.000Z"),
  lastSeen: null,
  note: "hotel",
  manual: false,
  renewals: 0,
};

function only(visas: Visa[], services: Service[] = []): State {
  return { ...EMPTY_STATE, visas, services };
}

const SERVICE: Service = {
  hostname: "nas.example.com",
  zoneId: "a".repeat(32),
  zoneName: "example.com",
  addedAt: Date.parse("2026-11-22T09:00:00.000Z"),
};

const MANUAL: Visa = {
  id: "b",
  target: "198.51.100.0/24",
  issuedAt: Date.parse("2026-11-22T10:00:00.000Z"),
  expiresAt: Date.parse("2026-11-22T12:00:00.000Z"),
  lastSeen: Date.parse("2026-11-22T11:00:00.000Z"),
  manual: true,
  renewals: 2,
};

test("a missing file is an empty store", async (t) => {
  const store = new FileStore(join(await temporaryDirectory(t), "data", "visa.json"));
  assert.deepEqual(await store.load(), EMPTY_STATE);
});

test("saves and loads visas, creating the directory", async (t) => {
  const path = join(await temporaryDirectory(t), "nested", "data", "visa.json");
  await new FileStore(path).save(only([VISA, MANUAL]));
  assert.deepEqual(await new FileStore(path).load(), only([VISA, MANUAL]));

  const json = JSON.parse(await readFile(path, "utf8"));
  assert.equal(json.version, 1);
  assert.equal(json.visas[0].expiresAt, "2026-11-22T14:00:00.000Z");
  assert.equal(json.visas[0].lastSeen, null);
  assert.equal("note" in json.visas[1], false);
});

test("the file is readable by its owner only and no temporary file is left", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "visa.json");
  await new FileStore(path).save(only([VISA]));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), ["visa.json"]);
});

test("a corrupt file is refused and left untouched", async (t) => {
  const path = join(await temporaryDirectory(t), "visa.json");
  await writeFile(path, "{ not json");
  const store = new FileStore(path);
  await assert.rejects(store.load(), StoreError);
  assert.equal(await readFile(path, "utf8"), "{ not json");
});

test("explains which visa and field is wrong", () => {
  const good = JSON.parse(encodeDataFile(only([VISA, MANUAL])));
  const cases: [unknown, RegExp][] = [
    [[], /JSON object/],
    [{ ...good, version: 2 }, /version must be 1/],
    [{ version: 1 }, /visas must be an array/],
    [{ version: 1, visas: [good.visas[0], { ...good.visas[1], expiresAt: "tomorrow" }] }, /visas\[1\]\.expiresAt/],
    [{ version: 1, visas: [{ ...good.visas[0], id: "" }] }, /visas\[0\]\.id/],
    [{ version: 1, visas: [{ ...good.visas[0], manual: "no" }] }, /visas\[0\]\.manual/],
    [{ version: 1, visas: [{ ...good.visas[0], renewals: -1 }] }, /visas\[0\]\.renewals/],
    [{ version: 1, visas: [{ ...good.visas[0], lastSeen: 5 }] }, /visas\[0\]\.lastSeen/],
    [{ version: 1, visas: [{ ...good.visas[0], note: 3 }] }, /visas\[0\]\.note/],
    [{ version: 1, visas: [{ ...good.visas[0], expiresAt: "2026-11-22T09:00:00.000Z" }] }, /before issuedAt/],
    [{ version: 1, visas: ["a"] }, /visas\[0\] must be an object/],
    [{ version: 1, visas: [{ ...good.visas[0], target: '203.0.113.7" or true' }] }, /visas\[0\]\.target/],
    [{ version: 1, visas: [{ ...good.visas[0], target: "203.0.113.7/32" }] }, /visas\[0\]\.target must be a canonical/],
    [{ version: 1, visas: [{ ...good.visas[0], target: "2001:DB8::1" }] }, /visas\[0\]\.target must be a canonical/],
    [{ version: 1, visas: [{ ...good.visas[0], id: "../../etc" }] }, /visas\[0\]\.id/],
    [{ version: 1, visas: [{ ...good.visas[0], note: "a\u0000b" }] }, /visas\[0\]\.note/],
  ];
  for (const [value, message] of cases) {
    assert.throws(() => decodeDataFile(JSON.stringify(value)), message);
  }
});

test("keeps top-level fields it does not know", async (t) => {
  const path = join(await temporaryDirectory(t), "visa.json");
  await writeFile(path, JSON.stringify({ version: 1, visas: [], futureField: [{ id: "k" }] }));
  const store = new FileStore(path);
  await store.load();
  await store.save(only([VISA]));
  const json = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(json.futureField, [{ id: "k" }]);
  assert.equal(json.visas.length, 1);
});

test("a failed write keeps the previous file", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root ignores directory permissions");
  const directory = join(await temporaryDirectory(t), "data");
  await mkdir(directory);
  const path = join(directory, "visa.json");
  const store = new FileStore(path);
  await store.save(only([VISA]));
  const before = await readFile(path, "utf8");

  await chmod(directory, 0o500);
  try {
    await assert.rejects(store.save(only([VISA, MANUAL])));
  } finally {
    await chmod(directory, 0o700);
  }
  assert.equal(await readFile(path, "utf8"), before);
  assert.deepEqual(await readdir(directory), ["visa.json"]);

  await store.save(only([MANUAL]));
  assert.deepEqual(await store.load(), only([MANUAL]));
});

test("writes happen in call order", async (t) => {
  const path = join(await temporaryDirectory(t), "visa.json");
  const store = new FileStore(path);
  await Promise.all([store.save(only([VISA])), store.save(only([VISA, MANUAL])), store.save(only([MANUAL]))]);
  await store.flush();
  assert.deepEqual(await new FileStore(path).load(), only([MANUAL]));
});

test("saves and loads services", async (t) => {
  const path = join(await temporaryDirectory(t), "visa.json");
  await new FileStore(path).save(only([VISA], [SERVICE]));
  assert.deepEqual(await new FileStore(path).load(), only([VISA], [SERVICE]));
  const json = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(json.services, [
    { hostname: "nas.example.com", zoneId: "a".repeat(32), zoneName: "example.com", addedAt: "2026-11-22T09:00:00.000Z" },
  ]);
});

test("a file without services loads with none", () => {
  assert.deepEqual(decodeDataFile(JSON.stringify({ version: 1, visas: [] })).state, EMPTY_STATE);
});

test("refuses tampered services", () => {
  const good = JSON.parse(encodeDataFile(only([], [SERVICE]))).services[0];
  const cases: [unknown, RegExp][] = [
    [{ ...good, hostname: 'nas.example.com" or true or "' }, /services\[0\]\.hostname/],
    [{ ...good, hostname: "NAS.example.com" }, /services\[0\]\.hostname/],
    [{ ...good, hostname: "nas.example.net" }, /inside zoneName/],
    [{ ...good, zoneName: "example.com) or (true" }, /zoneName/],
    [{ ...good, zoneId: "../../zones" }, /zoneId/],
    [{ ...good, addedAt: "yesterday" }, /addedAt/],
    [{ ...good, hostname: 1 }, /string hostname/],
    ["nas.example.com", /must be an object/],
  ];
  for (const [service, message] of cases) {
    assert.throws(() => decodeDataFile(JSON.stringify({ version: 1, visas: [], services: [service] })), message);
  }
  assert.throws(() => decodeDataFile(JSON.stringify({ version: 1, visas: [], services: [good, good] })), /registered twice/);
  assert.throws(() => decodeDataFile(JSON.stringify({ version: 1, visas: [], services: {} })), /services must be an array/);
});

const PASSKEY = {
  id: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  publicKey: "pQECAyYgASFYIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  counter: 3,
  transports: ["internal"],
  createdAt: "2026-11-22T09:00:00.000Z",
  lastUsedAt: null,
};

test("saves and loads passkeys and the user handle", async (t) => {
  const path = join(await temporaryDirectory(t), "visa.json");
  await writeFile(path, JSON.stringify({ version: 1, visas: [], webauthnUserId: "c3VwYS12aXNhLXVzZXItaWQ", passkeys: [PASSKEY] }));
  const store = new FileStore(path);
  const state = await store.load();
  assert.equal(state.webauthnUserId, "c3VwYS12aXNhLXVzZXItaWQ");
  assert.deepEqual(state.passkeys, [{ ...PASSKEY, createdAt: Date.parse(PASSKEY.createdAt) }]);
  await store.save(state);
  const json = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(json.passkeys, [PASSKEY]);
  assert.equal(json.webauthnUserId, "c3VwYS12aXNhLXVzZXItaWQ");
});

test("refuses tampered passkeys", () => {
  const cases: [unknown, RegExp][] = [
    [{ ...PASSKEY, id: "short" }, /passkeys\[0\]\.id/],
    [{ ...PASSKEY, id: `${PASSKEY.id}=` }, /passkeys\[0\]\.id/],
    [{ ...PASSKEY, id: "A".repeat(1025) }, /passkeys\[0\]\.id/],
    [{ ...PASSKEY, publicKey: "not base64url!!!!!!" }, /publicKey/],
    [{ ...PASSKEY, counter: -1 }, /counter/],
    [{ ...PASSKEY, counter: 1.5 }, /counter/],
    [{ ...PASSKEY, counter: "3" }, /counter/],
    [{ ...PASSKEY, transports: ["internal", "telepathy"] }, /transports/],
    [{ ...PASSKEY, transports: ["usb", "usb"] }, /transports must not repeat/],
    [{ ...PASSKEY, transports: "usb" }, /transports/],
    [{ ...PASSKEY, createdAt: "now" }, /createdAt/],
    [{ ...PASSKEY, lastUsedAt: 0 }, /lastUsedAt/],
  ];
  for (const [passkey, message] of cases) {
    assert.throws(() => decodeDataFile(JSON.stringify({ version: 1, visas: [], passkeys: [passkey] })), message);
  }
  assert.throws(() => decodeDataFile(JSON.stringify({ version: 1, visas: [], passkeys: [PASSKEY, PASSKEY] })), /twice/);
  assert.throws(() => decodeDataFile(JSON.stringify({ version: 1, visas: [], passkeys: {} })), /passkeys must be an array/);
  for (const webauthnUserId of ["short", "x".repeat(65), 7, "has space in it..."]) {
    assert.throws(() => decodeDataFile(JSON.stringify({ version: 1, visas: [], webauthnUserId })), /webauthnUserId/);
  }
});

test("blocks round-trip and tampered ones are refused", () => {
  const block = { source: "2001:db8:1:2::/64", since: Date.parse("2026-11-22T10:00:00.000Z"), until: Date.parse("2026-11-29T10:00:00.000Z"), failures: 4 };
  const state: State = { ...EMPTY_STATE, blocks: [block, { ...block, source: "203.0.113.7" }] };
  assert.deepEqual(decodeDataFile(encodeDataFile(state)).state, state);
  const good = JSON.parse(encodeDataFile(state)).blocks[0];
  const cases: [unknown, RegExp][] = [
    [{ ...good, source: "2001:db8:1:2::1/64" }, /source/],
    [{ ...good, source: "2001:db8:1:2::1" }, /source/],
    [{ ...good, source: "203.0.113.0/24" }, /source/],
    [{ ...good, source: "203.0.113.7 or true" }, /source/],
    [{ ...good, source: "2001:DB8:1:2::/64" }, /source/],
    [{ ...good, until: good.since }, /until must be after since/],
    [{ ...good, since: "yesterday" }, /since/],
    [{ ...good, failures: 0 }, /failures/],
    [{ ...good, failures: 1.5 }, /failures/],
    [{ ...good, extra: 1 }, /unknown fields/],
    ["203.0.113.7", /must be an object/],
  ];
  for (const [item, message] of cases) {
    assert.throws(() => decodeDataFile(JSON.stringify({ version: 1, visas: [], blocks: [item] })), message);
  }
  assert.throws(() => decodeDataFile(JSON.stringify({ version: 1, visas: [], blocks: [good, good] })), /same source twice/);
  assert.throws(() => decodeDataFile(JSON.stringify({ version: 1, visas: [], blocks: {} })), /blocks must be an array/);
  assert.throws(
    () => decodeDataFile(JSON.stringify({ version: 1, visas: [], blocks: Array.from({ length: 10_001 }, () => good) })),
    /at most 10000/,
  );
});
