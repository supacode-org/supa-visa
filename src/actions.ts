// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import { formatDuration } from "./duration.ts";
import { canonicalHostname } from "./hostname.ts";
import { canonicalTarget, type Ipv6Prefix, isIpv6Prefix, isPublicRange, isPublicUnicast, networkOf, rangeBounds } from "./ip.ts";
import { isBase64Url, MAX_CREDENTIAL_ID_LENGTH } from "./passkeys.ts";
import { InvalidInputError, isValidNote, isValidVisaId } from "./validate.ts";

// What an owner can ask for with a passkey. Parsed and checked when the challenge
// is created and stored with it, so the request that carries the passkey
// response cannot change what runs.
export type Action =
  | {
      readonly kind: "issue";
      readonly targets: readonly string[];
      readonly duration: number;
      readonly note?: string;
      // Issued for an address or range the owner typed, not for the requester.
      readonly manual?: true;
    }
  | { readonly kind: "delete-passkey"; readonly id: string }
  | { readonly kind: "revoke"; readonly id: string }
  | { readonly kind: "list" }
  | { readonly kind: "add-service"; readonly hostname: string }
  | { readonly kind: "remove-service"; readonly hostname: string };

export interface ActionContext {
  // The requester's IP, canonical, or undefined when it is not known.
  readonly clientIp: string | undefined;
  readonly durations: readonly number[];
  readonly ipv6Prefix: Ipv6Prefix;
  readonly manual?: { readonly enabled: boolean; readonly minPrefixV4: number; readonly minPrefixV6: number };
}

const FIELDS: Record<Action["kind"], readonly string[]> = {
  issue: ["kind", "duration", "ipv6Prefix", "otherAddress", "note", "manualTarget"],
  "delete-passkey": ["kind", "id"],
  revoke: ["kind", "id"],
  list: ["kind"],
  "add-service": ["kind", "hostname"],
  "remove-service": ["kind", "hostname"],
};

export function parseAction(input: unknown, context: ActionContext): Action {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new InvalidInputError("action", "must be an object");
  }
  const value = input as Record<string, unknown>;
  const kind = value.kind;
  if (typeof kind !== "string" || !Object.hasOwn(FIELDS, kind)) {
    throw new InvalidInputError("action.kind", "is not a known action");
  }
  const allowed = FIELDS[kind as Action["kind"]];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new InvalidInputError(`action.${key}`, "is not allowed for this action");
  }

  switch (kind as Action["kind"]) {
    case "issue": {
      const duration = context.durations.find((candidate) => formatDuration(candidate) === value.duration);
      if (duration === undefined) throw new InvalidInputError("action.duration", "must be one of the offered durations");
      if (value.note !== undefined && (typeof value.note !== "string" || !isValidNote(value.note))) {
        throw new InvalidInputError("action.note", "must be 1 to 40 printable characters without surrounding spaces");
      }
      const note = value.note === undefined ? {} : { note: value.note as string };
      if (value.manualTarget !== undefined) {
        return { kind: "issue", targets: [manualTarget(value, context)], duration, ...note, manual: true };
      }
      if (context.clientIp === undefined) throw new InvalidInputError("ip", "your IP address could not be determined");
      const isIpv6 = context.clientIp.includes(":");

      // The other family's address is what the page learned from ipify. The
      // server cannot see it, so it is trusted because a passkey must follow,
      // and only a single public unicast address of the other family is taken.
      let other: string | undefined;
      if (value.otherAddress !== undefined) {
        const reported = typeof value.otherAddress === "string" && value.otherAddress.length <= 45 ? canonicalTarget(value.otherAddress) : undefined;
        if (reported === undefined || reported.includes("/") || !isPublicUnicast(reported)) {
          throw new InvalidInputError("action.otherAddress", "must be a single public IP address");
        }
        if (reported.includes(":") === isIpv6) {
          throw new InvalidInputError("action.otherAddress", "must be of the other address family");
        }
        other = reported;
      }

      const anyIpv6 = isIpv6 || (other?.includes(":") ?? false);
      if (value.ipv6Prefix !== undefined && !anyIpv6) {
        throw new InvalidInputError("action.ipv6Prefix", "applies only to IPv6 addresses");
      }
      if (value.ipv6Prefix !== undefined && !isIpv6Prefix(value.ipv6Prefix)) {
        throw new InvalidInputError("action.ipv6Prefix", "must be 128, 64, 56 or 48");
      }
      const ipv6Prefix = (value.ipv6Prefix as Ipv6Prefix | undefined) ?? context.ipv6Prefix;
      // Ranges are computed here from the addresses; the page only picks how wide.
      const targets = [context.clientIp, ...(other === undefined ? [] : [other])].map((address) =>
        networkOf(address, address.includes(":") ? ipv6Prefix : 32),
      );
      if (targets.some((target) => target === undefined)) {
        throw new InvalidInputError("ip", "your IP address could not be determined");
      }
      return { kind: "issue", targets: targets as string[], duration, ...note };
    }
    case "revoke": {
      if (typeof value.id !== "string" || !isValidVisaId(value.id)) throw new InvalidInputError("action.id", "must be a visa id");
      return { kind: "revoke", id: value.id };
    }
    case "list":
      return { kind: "list" };
    case "delete-passkey": {
      if (typeof value.id !== "string" || !isBase64Url(value.id, 16, MAX_CREDENTIAL_ID_LENGTH)) {
        throw new InvalidInputError("action.id", "must be a passkey id");
      }
      return { kind: "delete-passkey", id: value.id };
    }
    case "add-service":
    case "remove-service": {
      const hostname = typeof value.hostname === "string" && value.hostname.length <= 253 ? canonicalHostname(value.hostname) : undefined;
      if (hostname === undefined) throw new InvalidInputError("action.hostname", "must be a hostname such as nas.example.com");
      return { kind: kind as "add-service" | "remove-service", hostname };
    }
  }
}

// An address or range the owner typed. Strict: no host bits, not too wide, and
// public from its first address to its last.
function manualTarget(value: Record<string, unknown>, context: ActionContext): string {
  const manual = context.manual;
  if (manual === undefined || !manual.enabled) {
    throw new InvalidInputError("action.manualTarget", "is turned off (MANUAL_ISSUE_ENABLED)");
  }
  if (value.otherAddress !== undefined || value.ipv6Prefix !== undefined) {
    throw new InvalidInputError("action.manualTarget", "cannot be combined with otherAddress or ipv6Prefix");
  }
  const text = value.manualTarget;
  const target = typeof text === "string" && text.length <= 64 ? canonicalTarget(text) : undefined;
  if (target === undefined) throw new InvalidInputError("action.manualTarget", "must be an IP address or CIDR range");
  const [address = "", prefixText] = target.split("/");
  const isIpv6 = address.includes(":");
  const prefix = prefixText === undefined ? (isIpv6 ? 128 : 32) : Number(prefixText);
  const minimum = isIpv6 ? manual.minPrefixV6 : manual.minPrefixV4;
  if (prefix < minimum) {
    throw new InvalidInputError("action.manualTarget", `must be a /${minimum} or narrower`);
  }
  if (networkOf(address, prefix) !== target) {
    throw new InvalidInputError("action.manualTarget", "must not have host bits set (use the network address)");
  }
  const bounds = rangeBounds(target);
  if (bounds === undefined || !isPublicUnicast(bounds.first) || !isPublicUnicast(bounds.last) || !isPublicRange(target)) {
    throw new InvalidInputError("action.manualTarget", "must be public addresses only");
  }
  return target;
}
