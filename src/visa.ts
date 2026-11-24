// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

export interface Visa {
  readonly id: string;
  readonly target: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly lastSeen: number | null;
  readonly note?: string;
  readonly manual: boolean;
  readonly renewals: number;
}

export type Visas = readonly Visa[];

export interface IssueRequest {
  readonly id: string;
  readonly target: string;
  readonly duration: number;
  readonly maxLifetime: number;
  readonly note?: string;
  readonly manual: boolean;
}

export function issue(
  visas: Visas,
  request: IssueRequest,
  now: number,
): { visas: Visas; visa: Visa; replaced: Visa | undefined } {
  const visa: Visa = {
    id: request.id,
    target: request.target,
    issuedAt: now,
    expiresAt: now + Math.min(request.duration, request.maxLifetime),
    lastSeen: null,
    ...(request.note === undefined ? {} : { note: request.note }),
    manual: request.manual,
    renewals: 0,
  };
  const replaced = visas.find((existing) => existing.target === request.target);
  const rest = visas.filter((existing) => existing.target !== request.target);
  return { visas: [...rest, visa], visa, replaced };
}

export function revoke(visas: Visas, id: string): { visas: Visas; revoked: Visa | undefined } {
  const revoked = visas.find((visa) => visa.id === id);
  if (revoked === undefined) return { visas, revoked };
  return { visas: visas.filter((visa) => visa.id !== id), revoked };
}

// A visa whose expiry equals now is already outside the allowed set (expiresAt > now).
export function expire(visas: Visas, now: number): { visas: Visas; expired: Visa[] } {
  const expired = visas.filter((visa) => visa.expiresAt <= now);
  if (expired.length === 0) return { visas, expired };
  return { visas: visas.filter((visa) => visa.expiresAt > now), expired };
}

export function activeTargets(visas: Visas, now: number): Set<string> {
  return new Set(visas.filter((visa) => visa.expiresAt > now).map((visa) => visa.target));
}
