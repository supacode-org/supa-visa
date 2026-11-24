// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalTarget, networkOf, rangeBounds, targetContains } from "../src/ip.ts";

test("keeps canonical IPv4 addresses and ranges", () => {
  assert.equal(canonicalTarget("203.0.113.7"), "203.0.113.7");
  assert.equal(canonicalTarget("198.51.100.0/24"), "198.51.100.0/24");
  assert.equal(canonicalTarget("203.0.113.7/32"), "203.0.113.7");
});

test("writes IPv6 the way Cloudflare stores it", () => {
  assert.equal(canonicalTarget("2001:DB8:0000:0011::0002"), "2001:db8:0:11::2");
  assert.equal(canonicalTarget("2001:db8:0:0:1:0:0:1"), "2001:db8::1:0:0:1");
  assert.equal(canonicalTarget("2001:0db8:1234::/48"), "2001:db8:1234::/48");
  assert.equal(canonicalTarget("2001:db8::7/128"), "2001:db8::7");
  assert.equal(canonicalTarget("::ffff:203.0.113.7"), "::ffff:cb00:7107");
});

test("rejects what is not an address or range", () => {
  for (const text of [
    "",
    "example.com",
    "203.0.113",
    "203.0.113.256",
    "203.0.113.7/33",
    "203.0.113.7/",
    "203.0.113.7/-1",
    "203.0.113.7/24/1",
    "2001:db8::/129",
    "2001:db8::/0x10",
    "fe80::1%eth0",
    "2001:db8:::1",
    " 203.0.113.7",
    "203.0.113.7\n",
  ]) {
    assert.equal(canonicalTarget(text), undefined, text);
  }
});

test("the network of an address at a prefix, with host bits cleared", () => {
  const phone = "2001:db8:3206:7d24:a1b2:c3d4:e5f6:7788";
  assert.equal(networkOf(phone, 128), phone);
  assert.equal(networkOf(phone, 64), "2001:db8:3206:7d24::/64");
  assert.equal(networkOf(phone, 56), "2001:db8:3206:7d00::/56");
  assert.equal(networkOf(phone, 48), "2001:db8:3206::/48");
  assert.equal(networkOf("2001:DB8::1", 64), "2001:db8::/64");
  assert.equal(networkOf("::ffff:203.0.113.7", 128), "::ffff:cb00:7107");
  assert.equal(networkOf("203.0.113.7", 32), "203.0.113.7");
  assert.equal(networkOf("203.0.113.7", 24), "203.0.113.0/24");
  for (const [ip, prefix] of [["203.0.113.7", 33], ["2001:db8::1", 129], ["2001:db8::1", -1], ["2001:db8::1", 64.5], ["2001:db8::/64", 64], ["nope", 64]] as const) {
    assert.equal(networkOf(ip, prefix), undefined, `${ip} ${prefix}`);
  }
});

test("whether a target covers an address", () => {
  assert.equal(targetContains("2001:db8:3206:7d24::/64", "2001:db8:3206:7d24:1:2:3:4"), true);
  assert.equal(targetContains("2001:db8:3206:7d24::/64", "2001:db8:3206:7d25::1"), false);
  assert.equal(targetContains("2001:db8:3206::/48", "2001:db8:3206:ffff::1"), true);
  assert.equal(targetContains("203.0.113.7", "203.0.113.7"), true);
  assert.equal(targetContains("203.0.113.7", "203.0.113.8"), false);
  assert.equal(targetContains("198.51.100.0/24", "198.51.100.200"), true);
  assert.equal(targetContains("2001:db8::/32", "203.0.113.7"), false, "families never match");
  assert.equal(targetContains("203.0.113.0/24", "::ffff:203.0.113.7"), false);
  assert.equal(targetContains("2001:db8::/64", "2001:db8::/64"), false, "a range is not an address");
});

test("the first and last address of a range", () => {
  assert.deepEqual(rangeBounds("198.51.100.0/24"), { first: "198.51.100.0", last: "198.51.100.255" });
  assert.deepEqual(rangeBounds("203.0.113.7"), { first: "203.0.113.7", last: "203.0.113.7" });
  assert.deepEqual(rangeBounds("2001:db8:1::/48"), { first: "2001:db8:1::", last: "2001:db8:1:ffff:ffff:ffff:ffff:ffff" });
  assert.equal(rangeBounds("nope"), undefined);
});
