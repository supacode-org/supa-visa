// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalHostname, isInZone } from "../src/hostname.ts";
import { buildExpression, ExpressionError, MAX_EXPRESSION_LENGTH, zoneFor } from "../src/waf.ts";

// Strings an attacker might send as a hostname, aimed at closing the quoted
// string or the set and adding a clause that makes the block rule never match.
const INJECTIONS = [
  'a.example.com" or true or "',
  'a.example.com"} or ip.src in {0.0.0.0/0',
  'a.example.com"}) or (true',
  "a.example.com) or (http.host ne \"x\"",
  'a.example.com" "b.example.com',
  "a.example.com\\",
  'a.example.com\\"',
  "a.example.com\nor true",
  "a.example.com\r\n",
  "a.example.com or true",
  "a.example.com or true",
  "a.example.com\t",
  "a.example.com\u0000",
  "a.example.com'",
  "a.example.com$supa_visa",
  "a.example.com{",
  "a.example.com}",
  "a.example.com#",
  "*.example.com",
  "a.example.com:443",
  "a.example.com/path",
  "user@a.example.com",
  "[::1]",
  "http://a.example.com",
];

test("canonical hostnames are lowercase ASCII without a trailing dot", () => {
  assert.equal(canonicalHostname("NAS.Example.COM"), "nas.example.com");
  assert.equal(canonicalHostname("nas.example.com."), "nas.example.com");
  assert.equal(canonicalHostname("a-b.c1.example.com"), "a-b.c1.example.com");
  assert.equal(canonicalHostname("xn--fsq.example.com"), "xn--fsq.example.com");
  assert.equal(canonicalHostname("例.example.com"), "xn--fsq.example.com");
  assert.equal(canonicalHostname(`${"a".repeat(63)}.example.com`), `${"a".repeat(63)}.example.com`);
});

test("rejects anything that is not a plain hostname", () => {
  const bad = [
    "",
    ".",
    "localhost",
    "example",
    "203.0.113.7",
    "-a.example.com",
    "a-.example.com",
    "a..example.com",
    ".example.com",
    `${"a".repeat(64)}.example.com`,
    `${"a.".repeat(127)}com`,
    "a_b.example.com",
    " nas.example.com",
    "nas.example.com ",
    "例 .example.com",
    "例\".example.com",
    ...INJECTIONS,
  ];
  for (const text of bad) assert.equal(canonicalHostname(text), undefined, JSON.stringify(text));
});

test("builds a sorted, deduplicated expression", () => {
  assert.equal(
    buildExpression(["b.example.com", "a.example.com", "b.example.com"], "supa_visa"),
    '(http.host in {"a.example.com" "b.example.com"} and not ip.src in $supa_visa)',
  );
});

test("refuses injected hostnames even when the caller skipped validation", () => {
  for (const hostname of INJECTIONS) {
    assert.throws(() => buildExpression(["ok.example.com", hostname], "supa_visa"), ExpressionError, JSON.stringify(hostname));
  }
  assert.throws(() => buildExpression(["NAS.example.com"], "supa_visa"), ExpressionError, "must already be canonical");
  assert.throws(() => buildExpression([42 as unknown as string], "supa_visa"), ExpressionError);
});

test("refuses list names that could change the expression", () => {
  for (const name of ["", "Supa", "supa-visa", "supa visa", "supa_visa or true", "supa_visa)", "x".repeat(51), "$supa"]) {
    assert.throws(() => buildExpression(["a.example.com"], name), ExpressionError, name);
  }
});

test("refuses an empty set and an expression over the length limit", () => {
  assert.throws(() => buildExpression([], "supa_visa"), /at least one/);
  const many = Array.from({ length: 200 }, (_, index) => `service-${index}.example.com`);
  assert.throws(() => buildExpression(many, "supa_visa"), /exceed 4096/);
  const fits = many.slice(0, 100);
  assert.ok(buildExpression(fits, "supa_visa").length <= MAX_EXPRESSION_LENGTH);
});

test("finds the zone by the longest whole-label suffix", () => {
  const zones = [
    { id: "a", name: "example.com" },
    { id: "b", name: "home.example.com" },
    { id: "c", name: "badexample.com" },
  ];
  assert.equal(zoneFor("nas.home.example.com", zones)?.id, "b");
  assert.equal(zoneFor("example.com", zones)?.id, "a");
  assert.equal(zoneFor("www.example.com", zones)?.id, "a");
  assert.equal(zoneFor("www.badexample.com", zones)?.id, "c");
  assert.equal(zoneFor("example.net", zones), undefined);
  assert.equal(isInZone("badexample.com", "example.com"), false);
});
