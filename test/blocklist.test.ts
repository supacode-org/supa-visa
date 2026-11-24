// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { BLOCK_FOR, Blocklist, FAILURE_WINDOW, isValidBlockSource } from "../src/blocklist.ts";
import { DAY, HOUR } from "../src/duration.ts";
import type { Notification } from "../src/notify.ts";
import { networkBucketOf } from "../src/ratelimit.ts";
import { StateKeeper } from "../src/state.ts";
import { FakeClock, MemoryStore, recordingLogger } from "./helpers.ts";

const T0 = Date.parse("2026-11-22T10:00:00.000Z");

async function setup(store = new MemoryStore()) {
  const time = new FakeClock(T0);
  const { logger, entries } = recordingLogger(time.clock);
  const keeper = new StateKeeper(store, logger);
  await keeper.load();
  const notifications: Notification[] = [];
  const blocklist = new Blocklist({ keeper, clock: time.clock, logger, notify: (notification) => notifications.push(notification) });
  return { time, entries, keeper, store, blocklist, notifications };
}

test("the fourth failure within a day blocks the source for seven days", async () => {
  const { time, blocklist, notifications, entries, store } = await setup();
  for (let index = 0; index < 3; index++) {
    time.now = T0 + index * HOUR;
    await blocklist.fail("203.0.113.0/24", "wrong setup code");
  }
  assert.equal(blocklist.blockedUntil("203.0.113.0/24"), undefined, "three failures are allowed");
  time.now = T0 + 23 * HOUR;
  await blocklist.fail("203.0.113.0/24", "authentication did not verify");
  assert.equal(blocklist.blockedUntil("203.0.113.0/24"), T0 + 23 * HOUR + BLOCK_FOR);
  assert.deepEqual(store.state.blocks, [{ source: "203.0.113.0/24", since: T0 + 23 * HOUR, until: T0 + 23 * HOUR + BLOCK_FOR, failures: 4 }]);
  assert.deepEqual(notifications, [{ type: "block", source: "203.0.113.0/24", days: 7, failures: 4 }]);
  assert.deepEqual(entries.at(-1), {
    time: new Date(T0 + 23 * HOUR).toISOString(),
    level: "warn",
    event: "ip.block",
    source: "203.0.113.0/24",
    until: new Date(T0 + 23 * HOUR + BLOCK_FOR).toISOString(),
    failures: 4,
    reason: "authentication did not verify",
  });

  time.now = T0 + 23 * HOUR + BLOCK_FOR - 1;
  assert.notEqual(blocklist.blockedUntil("203.0.113.0/24"), undefined);
  time.now = T0 + 23 * HOUR + BLOCK_FOR;
  assert.equal(blocklist.blockedUntil("203.0.113.0/24"), undefined, "lifted after seven days");
  assert.deepEqual(blocklist.current, []);
});

test("failures older than a day do not count", async () => {
  const { time, blocklist } = await setup();
  for (const at of [0, 1, 2]) {
    time.now = T0 + at * HOUR;
    await blocklist.fail("203.0.113.0/24", "x");
  }
  time.now = T0 + FAILURE_WINDOW + 1;
  await blocklist.fail("203.0.113.0/24", "x");
  assert.equal(blocklist.blockedUntil("203.0.113.0/24"), undefined, "the first failure fell out of the window");
  time.now = T0 + FAILURE_WINDOW + 2 * HOUR + 1;
  await blocklist.fail("203.0.113.0/24", "x");
  await blocklist.fail("203.0.113.0/24", "x");
  assert.equal(blocklist.blockedUntil("203.0.113.0/24"), undefined, "only three are within the last day");
  await blocklist.fail("203.0.113.0/24", "x");
  assert.notEqual(blocklist.blockedUntil("203.0.113.0/24"), undefined);
});

test("an IPv4 /24 and an IPv6 /48 each count as one source, separate from each other and their neighbours", async () => {
  const { blocklist } = await setup();
  for (const ip of ["2001:db8:1:2::1", "2001:db8:1:3::2", "2001:db8:1:ffff::9", "2001:db8:1:2::abcd"]) {
    await blocklist.fail(networkBucketOf(ip), "x");
  }
  assert.notEqual(blocklist.blockedUntil("2001:db8:1::/48"), undefined);
  assert.equal(blocklist.blockedUntil("2001:db8:2::/48"), undefined);
  for (const ip of ["192.0.2.1", "192.0.2.2", "192.0.2.200"]) await blocklist.fail(networkBucketOf(ip), "x");
  await blocklist.fail(networkBucketOf("198.51.100.1"), "x");
  assert.equal(blocklist.blockedUntil("192.0.2.0/24"), undefined, "three in this /24, one in another");
  await blocklist.fail(networkBucketOf("192.0.2.9"), "x");
  assert.notEqual(blocklist.blockedUntil("192.0.2.0/24"), undefined);
  assert.equal(blocklist.blockedUntil("198.51.100.0/24"), undefined);
});

test("never blocks requests without a client IP or a malformed source", async () => {
  const { blocklist, store } = await setup();
  for (let index = 0; index < 10; index++) {
    await blocklist.fail("unknown", "x");
    await blocklist.fail("2001:db8::1", "x");
    await blocklist.fail("2001:db8:1:2::/64", "x");
    await blocklist.fail("203.0.113.7", "x");
  }
  assert.deepEqual(store.state.blocks, []);
});

test("blocks survive a restart and take effect even when the disk fails", async () => {
  const first = await setup();
  first.store.failures = 10;
  for (let index = 0; index < 4; index++) await first.blocklist.fail("203.0.113.0/24", "x");
  assert.notEqual(first.blocklist.blockedUntil("203.0.113.0/24"), undefined, "applied in memory");
  first.store.failures = 0;
  for (let index = 0; index < 4; index++) await first.blocklist.fail("198.51.100.0/24", "x");
  const again = await setup(first.store);
  assert.notEqual(again.blocklist.blockedUntil("203.0.113.0/24"), undefined);
  assert.notEqual(again.blocklist.blockedUntil("198.51.100.0/24"), undefined);
});

test("unblock lifts one block, a /64 by any address in it, or every block", async () => {
  const { blocklist, entries } = await setup();
  for (const source of ["203.0.113.0/24", "198.51.100.0/24", "2001:db8:1::/48"]) {
    for (let index = 0; index < 4; index++) await blocklist.fail(source, "x");
  }
  assert.equal(await blocklist.unblock("203.0.113.99"), 1, "any address in the /24");
  assert.equal(blocklist.blockedUntil("203.0.113.0/24"), undefined);
  assert.equal(await blocklist.unblock("2001:db8:1:2::99"), 1, "any address in the /48");
  assert.equal(await blocklist.unblock("2001:db8:1::/48"), 0);
  assert.equal(await blocklist.unblock("192.0.2.0/24"), 0);
  assert.deepEqual(entries.at(-1), { time: new Date(T0).toISOString(), level: "info", event: "ip.unblock", target: "192.0.2.0/24", removed: 0 });
  for (const bad of ["", "not an ip", "203.0.113.0/25", "203.0.113.7/24", "2001:db8:1:2::/64", "2001:db8::/32", " 203.0.113.8"]) {
    await assert.rejects(blocklist.unblock(bad), /an IPv4 \/24 or an IPv6 \/48/, bad);
  }
  assert.equal(await blocklist.unblock("all"), 1);
  assert.deepEqual(blocklist.current, []);
});

test("unblocking also forgets counted failures", async () => {
  const { blocklist } = await setup();
  for (let index = 0; index < 3; index++) await blocklist.fail("203.0.113.0/24", "x");
  await blocklist.unblock("all");
  await blocklist.fail("203.0.113.0/24", "x");
  assert.equal(blocklist.blockedUntil("203.0.113.0/24"), undefined);
});

test("block sources are exactly what the rate limit counts", () => {
  for (const good of ["203.0.113.0/24", "2001:db8:1::/48", networkBucketOf("2001:db8::1"), networkBucketOf("198.51.100.7")]) {
    assert.ok(isValidBlockSource(good), good);
  }
  for (const bad of ["203.0.113.7", "203.0.113.7/24", "203.0.113.0/23", "2001:db8::1", "2001:db8:1:2::/64", "2001:db8::1/48", "2001:DB8::/48", "unknown", ""]) {
    assert.ok(!isValidBlockSource(bad), bad);
  }
  assert.equal(networkBucketOf("2001:db8:0:0:5::1"), "2001:db8::/48");
  assert.equal(networkBucketOf("198.51.100.7"), "198.51.100.0/24");
  assert.equal(DAY, FAILURE_WINDOW);
});

test("a block applies at once, before it is saved", async () => {
  const { blocklist, store, keeper } = await setup();
  for (let index = 0; index < 3; index++) await blocklist.fail("203.0.113.0/24", "x");
  let release: (() => void) | undefined;
  const busy = keeper.exclusive(() => new Promise<void>((resolve) => (release = resolve)));
  while (release === undefined) await new Promise((resolve) => setImmediate(resolve));
  const blocking = blocklist.fail("203.0.113.0/24", "x");
  assert.notEqual(blocklist.blockedUntil("203.0.113.0/24"), undefined);
  assert.deepEqual(store.state.blocks, []);
  release();
  await busy;
  await blocking;
  assert.equal(store.state.blocks.length, 1);
});
