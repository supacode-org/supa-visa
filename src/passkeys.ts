// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

export type Transport = "ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb";

export const TRANSPORTS: readonly Transport[] = ["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"];

export interface Passkey {
  // The credential ID, base64url.
  readonly id: string;
  // The COSE public key, base64url.
  readonly publicKey: string;
  readonly counter: number;
  readonly transports: readonly Transport[];
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
}

export type Passkeys = readonly Passkey[];

export const MAX_CREDENTIAL_ID_LENGTH = 1024;
export const MAX_PUBLIC_KEY_LENGTH = 2048;

export function isBase64Url(value: string, minLength: number, maxLength: number): boolean {
  return value.length >= minLength && value.length <= maxLength && /^[A-Za-z0-9_-]+$/.test(value);
}

// Returns the rule a stored passkey breaks, or undefined when it is valid.
export function passkeyProblem(passkey: Record<string, unknown>): string | undefined {
  const { id, publicKey, counter, transports } = passkey;
  if (typeof id !== "string" || !isBase64Url(id, 16, MAX_CREDENTIAL_ID_LENGTH)) {
    return `id must be 16 to ${MAX_CREDENTIAL_ID_LENGTH} base64url characters`;
  }
  if (typeof publicKey !== "string" || !isBase64Url(publicKey, 16, MAX_PUBLIC_KEY_LENGTH)) {
    return `publicKey must be 16 to ${MAX_PUBLIC_KEY_LENGTH} base64url characters`;
  }
  if (typeof counter !== "number" || !Number.isSafeInteger(counter) || counter < 0) {
    return "counter must be a non-negative integer";
  }
  if (!Array.isArray(transports) || !transports.every((transport) => TRANSPORTS.includes(transport))) {
    return `transports must only contain ${TRANSPORTS.join(", ")}`;
  }
  if (new Set(transports).size !== transports.length) return "transports must not repeat";
  return undefined;
}

// Log lines name a passkey by a short prefix of its ID: enough to tell keys apart.
export function shortId(id: string): string {
  return id.slice(0, 8);
}
