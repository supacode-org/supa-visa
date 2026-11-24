// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAction } from "../src/actions.ts";
import { HOUR } from "../src/duration.ts";
import { InvalidInputError } from "../src/validate.ts";

const base = { clientIp: "9.9.9.9", durations: [HOUR], ipv6Prefix: 64 as const };

test("manual targets are refused while MANUAL_ISSUE_ENABLED is off", () => {
  for (const context of [base, { ...base, manual: { enabled: false, minPrefixV4: 24, minPrefixV6: 48 } }]) {
    assert.throws(() => parseAction({ kind: "issue", duration: "1h", manualTarget: "8.8.8.8" }, context), InvalidInputError);
  }
});

test("the minimum prefix is configurable", () => {
  const context = { ...base, manual: { enabled: true, minPrefixV4: 28, minPrefixV6: 56 } };
  assert.throws(() => parseAction({ kind: "issue", duration: "1h", manualTarget: "8.8.8.0/24" }, context), /\/28 or narrower/);
  assert.deepEqual(parseAction({ kind: "issue", duration: "1h", manualTarget: "8.8.8.0/28" }, context), {
    kind: "issue",
    targets: ["8.8.8.0/28"],
    duration: HOUR,
    manual: true,
  });
});

test("a manual range must not overlap any non-public range, even with wide prefixes allowed", () => {
  const context = { ...base, manual: { enabled: true, minPrefixV4: 8, minPrefixV6: 12 } };
  for (const manualTarget of ["100.0.0.0/8", "172.0.0.0/8", "192.0.0.0/8", "2000::/12", "2001:d00::/24"]) {
    assert.throws(() => parseAction({ kind: "issue", duration: "1h", manualTarget }, context), /public addresses only/, manualTarget);
  }
  for (const manualTarget of ["8.0.0.0/8", "2600::/12"]) {
    assert.deepEqual((parseAction({ kind: "issue", duration: "1h", manualTarget }, context) as { targets: readonly string[] }).targets, [manualTarget]);
  }
});

test("field names from the request are kept short and plain", () => {
  const long = "x".repeat(65_000);
  assert.throws(
    () => parseAction({ kind: "list", [long]: 1 }, base),
    (error: unknown) => error instanceof InvalidInputError && error.field === "(unknown)" && error.message.length < 100,
  );
  assert.throws(
    () => parseAction({ kind: "list", "a\u009b[31m": 1 }, base),
    (error: unknown) => error instanceof InvalidInputError && error.field === "(unknown)",
  );
  assert.throws(() => parseAction({ kind: "list", extra: 1 }, base), (error: unknown) => error instanceof InvalidInputError && error.field === "action.extra");
});
