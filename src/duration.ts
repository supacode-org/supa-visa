// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const UNITS: Record<string, number> = { s: SECOND, m: MINUTE, h: HOUR, d: DAY };

// Returns undefined for anything that is not a positive integer followed by one unit.
export function parseDuration(text: string): number | undefined {
  const match = /^([1-9][0-9]*)([smhd])$/.exec(text.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = UNITS[match[2] as string] as number;
  const milliseconds = amount * unit;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

// The shortest spelling parseDuration accepts for a value: 14400000 → "4h".
export function formatDuration(milliseconds: number): string {
  for (const [unit, size] of [["d", DAY], ["h", HOUR], ["m", MINUTE]] as const) {
    if (milliseconds % size === 0) return `${milliseconds / size}${unit}`;
  }
  return `${Math.round(milliseconds / SECOND)}s`;
}
