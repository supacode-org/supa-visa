// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import { isIP } from "node:net";

// One spelling per address or range, so local targets and the items Cloudflare
// returns compare equal. Cloudflare stores IPv6 lowercased without leading zeros.
export function canonicalTarget(text: string): string | undefined {
  // No trimming: input with stray whitespace is rejected, not repaired.
  const parts = text.split("/");
  if (parts.length > 2) return undefined;
  const [addressText = "", prefixText] = parts;

  const family = isIP(addressText);
  if (family === 0 || addressText.includes("%")) return undefined;
  const address = family === 6 ? canonicalIPv6(addressText) : addressText;
  if (address === undefined) return undefined;
  if (prefixText === undefined) return address;

  const bits = family === 4 ? 32 : 128;
  if (!/^[0-9]{1,3}$/.test(prefixText)) return undefined;
  const prefix = Number(prefixText);
  if (prefix > bits) return undefined;
  return prefix === bits ? address : `${address}/${prefix}`;
}

// The URL parser serializes IPv6 hosts in the RFC 5952 form.
function canonicalIPv6(address: string): string | undefined {
  const url = URL.parse(`http://[${address}]/`);
  return url === null ? undefined : url.hostname.slice(1, -1);
}

// IPv6 prefix lengths offered when issuing for an IPv6 address.
export const IPV6_PREFIXES = [128, 64, 56, 48] as const;
export type Ipv6Prefix = (typeof IPV6_PREFIXES)[number];

export function isIpv6Prefix(value: unknown): value is Ipv6Prefix {
  return typeof value === "number" && (IPV6_PREFIXES as readonly number[]).includes(value);
}

// The eight 16-bit groups of a canonical IPv6 address.
export function ipv6Groups(address: string): number[] | undefined {
  const [head = "", tail] = address.split("::");
  if (address.split("::").length > 2) return undefined;
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const missing = 8 - left.length - right.length;
  if ((tail === undefined && missing !== 0) || missing < 0) return undefined;
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right].map((group) =>
    /^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN,
  );
  return groups.some(Number.isNaN) ? undefined : groups;
}

function toBigInt(address: string): { value: bigint; bits: number } | undefined {
  if (address.includes(":")) {
    const groups = ipv6Groups(address);
    if (groups === undefined) return undefined;
    return { value: groups.reduce((sum, group) => (sum << 16n) | BigInt(group), 0n), bits: 128 };
  }
  const octets = address.split(".").map(Number);
  return { value: octets.reduce((sum, octet) => (sum << 8n) | BigInt(octet), 0n), bits: 32 };
}

function fromBigInt(value: bigint, bits: number): string {
  if (bits === 32) return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join(".");
  const groups = Array.from({ length: 8 }, (_, index) => ((value >> BigInt(112 - index * 16)) & 0xffffn).toString(16));
  return canonicalTarget(groups.join(":")) as string;
}

function mask(bits: number, prefix: number): bigint {
  return prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
}

// The canonical network (host bits cleared) of `ip` at `prefix`; a full-length
// prefix gives the address itself. Computed with integers, never by editing text.
export function networkOf(ip: string, prefix: number): string | undefined {
  const address = canonicalTarget(ip);
  if (address === undefined || address.includes("/")) return undefined;
  const parsed = toBigInt(address);
  if (parsed === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > parsed.bits) return undefined;
  const network = fromBigInt(parsed.value & mask(parsed.bits, prefix), parsed.bits);
  return canonicalTarget(prefix === parsed.bits ? network : `${network}/${prefix}`);
}

// Whether a visa's target (an address or a range) covers `ip`.
export function targetContains(target: string, ip: string): boolean {
  const [address = "", prefixText] = target.split("/");
  const subject = canonicalTarget(ip);
  if (subject === undefined || subject.includes("/")) return false;
  const range = toBigInt(address);
  const candidate = toBigInt(subject);
  if (range === undefined || candidate === undefined || range.bits !== candidate.bits) return false;
  const prefix = prefixText === undefined ? range.bits : Number(prefixText);
  const bitmask = mask(range.bits, prefix);
  return (range.value & bitmask) === (candidate.value & bitmask);
}

// Ranges that are never someone's public address. A reported address inside any
// of them is refused rather than issued.
const NOT_PUBLIC = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
  "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15",
  "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
  "::/128", "::1/128", "::ffff:0:0/96", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64",
  "2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20", "5f00::/16", "fc00::/7", "fe80::/10", "ff00::/8",
];

export function isPublicUnicast(address: string): boolean {
  const canonical = canonicalTarget(address);
  if (canonical === undefined || canonical !== address || canonical.includes("/")) return false;
  return !NOT_PUBLIC.some((range) => targetContains(range, canonical));
}

// Whether no address in the target is outside public unicast space. Two CIDRs of
// one family overlap exactly when one contains the other's network address.
export function isPublicRange(target: string): boolean {
  const canonical = canonicalTarget(target);
  const bounds = canonical === undefined ? undefined : rangeBounds(canonical);
  if (canonical === undefined || bounds === undefined) return false;
  return !NOT_PUBLIC.some((range) => targetContains(range, bounds.first) || targetContains(canonical, range.split("/")[0] as string));
}

// The first and last address of a target (an address is its own range).
export function rangeBounds(target: string): { first: string; last: string } | undefined {
  const canonical = canonicalTarget(target);
  if (canonical === undefined) return undefined;
  const [address = "", prefixText] = canonical.split("/");
  const parsed = toBigInt(address);
  if (parsed === undefined) return undefined;
  const prefix = prefixText === undefined ? parsed.bits : Number(prefixText);
  const bitmask = mask(parsed.bits, prefix);
  const all = (1n << BigInt(parsed.bits)) - 1n;
  return {
    first: fromBigInt(parsed.value & bitmask, parsed.bits),
    last: fromBigInt((parsed.value & bitmask) | (all ^ bitmask), parsed.bits),
  };
}
