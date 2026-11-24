// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { networkBucketOf, RateLimiter, sourceOf } from "../src/ratelimit.ts";
import { FakeClock } from "./helpers.ts";

test("rate limit buckets: one IPv4 /24, or one IPv6 /48", () => {
  assert.equal(networkBucketOf("203.0.113.7"), "203.0.113.0/24");
  assert.equal(networkBucketOf("203.0.113.255"), "203.0.113.0/24");
  assert.equal(networkBucketOf("203.0.114.0"), "203.0.114.0/24");
  assert.equal(networkBucketOf("2001:db8:1:2:3:4:5:6"), "2001:db8:1::/48");
  assert.equal(networkBucketOf("2001:db8:1:ffff::1"), "2001:db8:1::/48");
  assert.equal(networkBucketOf("2001:db8:2::1"), "2001:db8:2::/48");
  assert.equal(networkBucketOf("::1"), "::/48");
  assert.equal(networkBucketOf(undefined), "unknown");
  assert.equal(networkBucketOf("not an address"), "unknown");
});

test("sources: one IPv4 address, or one IPv6 /64", () => {
  assert.equal(sourceOf("203.0.113.7"), "203.0.113.7");
  assert.equal(sourceOf("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::/64");
  assert.equal(sourceOf("2001:db8::1"), "2001:db8::/64");
  assert.equal(sourceOf("::1"), "::/64");
  assert.equal(sourceOf(undefined), "unknown");
});

test("a burst, then one request back every interval", () => {
  const time = new FakeClock(0);
  const limiter = new RateLimiter({ burst: 2, refillEvery: 1000, maxSources: 10, clock: time.clock });
  assert.deepEqual([limiter.take("a"), limiter.take("a"), limiter.take("a")], [true, true, false]);
  time.now = 999;
  assert.equal(limiter.take("a"), false);
  time.now = 2000;
  assert.equal(limiter.take("a"), true);
  assert.equal(limiter.take("b"), true);
});

test("forgets sources when the table is full, keeping limited ones longest", () => {
  const time = new FakeClock(0);
  const limiter = new RateLimiter({ burst: 1, refillEvery: 1000, maxSources: 3, clock: time.clock });
  limiter.take("limited");
  assert.equal(limiter.take("limited"), false);
  time.now = 5000;
  for (const source of ["a", "b", "c", "d"]) limiter.take(source);
  time.now = 5100;
  assert.equal(limiter.take("limited"), true, "refilled long ago, so forgetting it changes nothing");
});
