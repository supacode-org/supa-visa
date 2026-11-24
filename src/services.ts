// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import { isCanonicalHostname, isInZone } from "./hostname.ts";

export interface Service {
  readonly hostname: string;
  readonly zoneId: string;
  readonly zoneName: string;
  readonly addedAt: number;
}

export type Services = readonly Service[];

export const MAX_SERVICES = 100;

export function isValidZoneId(id: string): boolean {
  return /^[0-9a-f]{32}$/.test(id);
}

// Returns the rule a service breaks, or undefined when it is valid. Used on
// every load of the data file, not only on registration.
export function serviceProblem(service: Service): string | undefined {
  if (!isCanonicalHostname(service.hostname)) return "hostname must be a canonical hostname";
  if (!isValidZoneId(service.zoneId)) return "zoneId must be 32 lowercase hex characters";
  if (!isCanonicalHostname(service.zoneName)) return "zoneName must be a canonical hostname";
  if (!isInZone(service.hostname, service.zoneName)) return "hostname must be inside zoneName";
  return undefined;
}
