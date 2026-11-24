// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { HOUR } from "../src/duration.ts";
import { activeTargets, expire, issue, revoke, type Visa } from "../src/visa.ts";

const T0 = Date.parse("2026-11-22T10:00:00.000Z");

function request(id: string, target: string, duration = 4 * HOUR) {
  return { id, target, duration, maxLifetime: 24 * HOUR, manual: false };
}

test("issues a visa that starts now", () => {
  const result = issue([], { ...request("a", "203.0.113.7"), note: "hotel" }, T0);
  assert.deepEqual(result.visa, {
    id: "a",
    target: "203.0.113.7",
    issuedAt: T0,
    expiresAt: T0 + 4 * HOUR,
    lastSeen: null,
    note: "hotel",
    manual: false,
    renewals: 0,
  });
  assert.deepEqual(result.visas, [result.visa]);
  assert.equal(result.replaced, undefined);
});

test("re-issuing for the same target replaces it and restarts the clock", () => {
  const first = issue([], request("a", "203.0.113.7"), T0);
  const other = issue(first.visas, request("b", "198.51.100.0/24"), T0);
  const second = issue(other.visas, request("c", "203.0.113.7", 1 * HOUR), T0 + 3 * HOUR);
  assert.equal(second.replaced?.id, "a");
  assert.deepEqual(
    second.visas.map((visa) => visa.id),
    ["b", "c"],
  );
  assert.equal(second.visa.issuedAt, T0 + 3 * HOUR);
  assert.equal(second.visa.expiresAt, T0 + 4 * HOUR);
});

test("the duration is cut to the hard limit", () => {
  const result = issue([], { ...request("a", "203.0.113.7", 48 * HOUR), maxLifetime: 24 * HOUR }, T0);
  assert.equal(result.visa.expiresAt, T0 + 24 * HOUR);
});

test("does not change its input", () => {
  const visas = Object.freeze([issue([], request("a", "203.0.113.7"), T0).visa]);
  issue(visas, request("b", "203.0.113.7"), T0);
  revoke(visas, "a");
  expire(visas, T0 + 5 * HOUR);
  assert.equal(visas.length, 1);
});

test("revokes by id", () => {
  const visas = issue([], request("a", "203.0.113.7"), T0).visas;
  assert.deepEqual(revoke(visas, "missing"), { visas, revoked: undefined });
  const result = revoke(visas, "a");
  assert.equal(result.revoked?.id, "a");
  assert.deepEqual(result.visas, []);
});

test("a visa expires when its expiry is reached", () => {
  let visas: readonly Visa[] = issue([], request("a", "203.0.113.7", 1 * HOUR), T0).visas;
  visas = issue(visas, request("b", "203.0.113.8", 2 * HOUR), T0).visas;

  const before = expire(visas, T0 + HOUR - 1);
  assert.deepEqual(before.expired, []);
  assert.equal(before.visas, visas);

  const at = expire(visas, T0 + HOUR);
  assert.deepEqual(
    at.expired.map((visa) => visa.id),
    ["a"],
  );
  assert.deepEqual(
    at.visas.map((visa) => visa.id),
    ["b"],
  );
});

test("active targets are those not yet expired", () => {
  let visas: readonly Visa[] = issue([], request("a", "203.0.113.7", 1 * HOUR), T0).visas;
  visas = issue(visas, request("b", "198.51.100.0/24", 2 * HOUR), T0).visas;
  assert.deepEqual(activeTargets(visas, T0), new Set(["203.0.113.7", "198.51.100.0/24"]));
  assert.deepEqual(activeTargets(visas, T0 + HOUR), new Set(["198.51.100.0/24"]));
  assert.deepEqual(activeTargets(visas, T0 + 2 * HOUR), new Set());
});
