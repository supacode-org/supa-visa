// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidListItemId, isValidNote, isValidVisaId } from "../src/validate.ts";

test("notes are 1 to 40 printable characters without padding", () => {
  for (const note of ["hotel", "飯店 Wi-Fi", "🏨".repeat(40), "a b"]) assert.equal(isValidNote(note), true, note);
  for (const note of ["", " ", " hotel", "hotel ", "x".repeat(41), "a\nb", "a\rb", "a\tb", "a\u0000b", "a b", "a b", "a‮b", "a​b"]) {
    assert.equal(isValidNote(note), false, JSON.stringify(note));
  }
});

test("visa ids are short and plain", () => {
  assert.equal(isValidVisaId("6f1c0c2e-1d6a-4c4f-9a43-2b1f0d3e9a10"), true);
  for (const id of ["", "a/b", "a b", "x".repeat(65), "é"]) assert.equal(isValidVisaId(id), false, id);
});

test("Cloudflare list item ids are 32 lowercase hex characters", () => {
  assert.equal(isValidListItemId("0123456789abcdef0123456789abcd01"), true);
  for (const id of ["", "0123456789ABCDEF0123456789ABCD01", "0123456789abcdef0123456789abcd0", "../0123456789abcdef0123456789abc"]) {
    assert.equal(isValidListItemId(id), false, id);
  }
});
