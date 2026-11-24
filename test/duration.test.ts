// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { DAY, HOUR, MINUTE, SECOND, parseDuration } from "../src/duration.ts";

test("parses each unit", () => {
  assert.equal(parseDuration("90s"), 90 * SECOND);
  assert.equal(parseDuration("15m"), 15 * MINUTE);
  assert.equal(parseDuration("4h"), 4 * HOUR);
  assert.equal(parseDuration("7d"), 7 * DAY);
  assert.equal(parseDuration(" 2h "), 2 * HOUR);
});

test("rejects anything else", () => {
  for (const text of ["", "0h", "-1h", "1.5h", "1h30m", "10", "h", "01h", "1H", "1w", "1 h"]) {
    assert.equal(parseDuration(text), undefined, text);
  }
});

test("rejects values too large to represent exactly", () => {
  assert.equal(parseDuration("99999999999999999d"), undefined);
});
