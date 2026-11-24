// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

export class InvalidInputError extends Error {
  readonly field: string;

  constructor(field: string, rule: string) {
    // Field names can come from the request body (an unknown key); a long or odd
    // one must not end up in the response or, many times over, in the log.
    const safe = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(field) ? field : "(unknown)";
    super(`${safe} ${rule}`);
    this.name = "InvalidInputError";
    this.field = safe;
  }
}

export const NOTE_MAX_LENGTH = 40;

// Printable text only: control characters, line breaks and the Unicode line and
// paragraph separators could forge log lines or notification layouts.
export function isValidNote(note: string): boolean {
  const length = [...note].length;
  return length >= 1 && length <= NOTE_MAX_LENGTH && note.trim() === note && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(note);
}

export function isValidVisaId(id: string): boolean {
  return /^[A-Za-z0-9-]{1,64}$/.test(id);
}

// Cloudflare list item IDs are 32 lowercase hex characters.
export function isValidListItemId(id: string): boolean {
  return /^[0-9a-f]{32}$/.test(id);
}
