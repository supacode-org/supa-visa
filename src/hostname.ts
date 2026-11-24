// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Hostnames end up inside WAF rule expressions, so this is an allowlist: only
// lowercase ASCII labels survive, and nothing that could close a string or
// start a new clause (quotes, spaces, parentheses, backslashes) can pass.
export function canonicalHostname(text: string): string | undefined {
  // No trimming: input with stray whitespace is rejected, not repaired.
  let hostname = text.toLowerCase();
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  if (!/^[\x21-\x7e]*$/.test(hostname)) {
    // Internationalized names are accepted only through their punycode form,
    // which the URL parser produces; anything it would also accept beyond a
    // bare hostname is caught by the checks below.
    if (/[\s/?#@:\\[\]"'(){}<>]/u.test(hostname)) return undefined;
    const url = URL.parse(`http://${hostname}/`);
    if (url === null) return undefined;
    hostname = url.hostname;
  }
  return isCanonicalHostname(hostname) ? hostname : undefined;
}

export function isCanonicalHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 253) return false;
  const labels = hostname.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => LABEL.test(label))) return false;
  // A last label of digits only would make "203.0.113.7" a hostname.
  return !/^[0-9]+$/.test(labels.at(-1) as string);
}

// Whether `hostname` is `zone` or inside it. Comparing whole labels keeps
// "badexample.com" out of "example.com".
export function isInZone(hostname: string, zone: string): boolean {
  return hostname === zone || hostname.endsWith(`.${zone}`);
}
