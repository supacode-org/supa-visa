// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import { isCanonicalHostname, isInZone } from "./hostname.ts";

export const RULE_REF = "supa-visa";
export const RULE_DESCRIPTION =
  "Supa Visa: only issued IPs may reach registered services. Managed automatically; manual edits are overwritten.";
export const MAX_EXPRESSION_LENGTH = 4096;

export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpressionError";
  }
}

export function isValidListName(name: string): boolean {
  return /^[a-z0-9_]{1,50}$/.test(name);
}

// The only place a rule expression is built. Every input is checked again here,
// whatever the caller already did: a value that slipped past validation upstream
// must not be able to turn the block rule into one that matches nothing.
export function buildExpression(hostnames: readonly string[], listName: string): string {
  if (!isValidListName(listName)) throw new ExpressionError("list name is not a valid Cloudflare list name");
  for (const hostname of hostnames) {
    if (typeof hostname !== "string" || !isCanonicalHostname(hostname)) {
      throw new ExpressionError("hostname is not a canonical hostname");
    }
  }
  const unique = [...new Set(hostnames)].sort();
  if (unique.length === 0) throw new ExpressionError("at least one hostname is required");
  const hosts = unique.map((hostname) => `"${hostname}"`).join(" ");
  const expression = `(http.host in {${hosts}} and not ip.src in $${listName})`;
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    throw new ExpressionError(`expression would exceed ${MAX_EXPRESSION_LENGTH} characters`);
  }
  return expression;
}

export interface Zone {
  readonly id: string;
  readonly name: string;
}

// The zone with the longest name containing the hostname.
export function zoneFor(hostname: string, zones: readonly Zone[]): Zone | undefined {
  let best: Zone | undefined;
  for (const zone of zones) {
    if (isInZone(hostname, zone.name) && (best === undefined || zone.name.length > best.name.length)) best = zone;
  }
  return best;
}
