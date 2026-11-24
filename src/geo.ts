// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import type { Clock } from "./clock.ts";
import { HOUR, MINUTE, SECOND } from "./duration.ts";
import { canonicalTarget } from "./ip.ts";
import type { Logger } from "./log.ts";

export interface Geo {
  readonly countryCode?: string;
  readonly country?: string;
  readonly city?: string;
  readonly asn?: string;
  readonly asName?: string;
}

export type IpinfoPlan = "lite" | "core";

export interface GeoLookupOptions {
  readonly token: string;
  readonly plan: IpinfoPlan;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly fetch?: typeof fetch;
  readonly timeout?: number;
}

const FOUND_FOR = 24 * HOUR;
const MISSING_FOR = 10 * MINUTE;
const MAX_CACHED = 1000;
const MAX_PARALLEL = 4;

// Looks addresses up with the owner's ipinfo token. Called only while building
// the owner's view after a passkey check, so strangers cannot spend the quota.
export class GeoLookup {
  private readonly options: GeoLookupOptions;
  private readonly cache = new Map<string, { geo: Geo | null; until: number }>();

  constructor(options: GeoLookupOptions) {
    this.options = options;
  }

  // What is known about each address; unknown ones are looked up, waiting at most
  // one timeout in all. Addresses that do not finish in time come back null.
  async lookUp(addresses: readonly string[]): Promise<Map<string, Geo | null>> {
    const now = this.options.clock();
    const results = new Map<string, Geo | null>();
    const missing: string[] = [];
    for (const address of new Set(addresses)) {
      const cached = this.cache.get(address);
      if (cached !== undefined && cached.until > now) results.set(address, cached.geo);
      else missing.push(address);
    }
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, this.options.timeout ?? 3 * SECOND).unref());
    const work = (async () => {
      for (let index = 0; index < missing.length; index += MAX_PARALLEL) {
        await Promise.all(missing.slice(index, index + MAX_PARALLEL).map((address) => this.fetchOne(address)));
      }
    })();
    await Promise.race([work, deadline]);
    for (const address of missing) results.set(address, this.cache.get(address)?.geo ?? null);
    return results;
  }

  private async fetchOne(address: string): Promise<void> {
    let geo: Geo | null = null;
    try {
      // The address is canonical (validated before it ever became a visa), so it
      // is safe in the path; encode it anyway.
      if (canonicalTarget(address) !== address || address.includes("/")) return;
      const base = this.options.plan === "core" ? "https://api.ipinfo.io/lookup/" : "https://api.ipinfo.io/lite/";
      const response = await (this.options.fetch ?? fetch)(`${base}${encodeURIComponent(address)}`, {
        headers: { authorization: `Bearer ${this.options.token}`, accept: "application/json" },
        signal: AbortSignal.timeout(this.options.timeout ?? 3 * SECOND),
      });
      if (!response.ok) {
        this.options.logger.warn("geo.failed", { status: response.status });
      } else {
        geo = parseGeo(await response.json(), this.options.plan);
      }
    } catch (error) {
      this.options.logger.warn("geo.failed", { status: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network" });
    } finally {
      this.remember(address, geo);
    }
  }

  private remember(address: string, geo: Geo | null): void {
    if (this.cache.size >= MAX_CACHED) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(address, { geo, until: this.options.clock() + (geo === null ? MISSING_FOR : FOUND_FOR) });
  }
}

// Keeps only fields of the expected shape; ipinfo's answer is still outside input.
export function parseGeo(body: unknown, plan: IpinfoPlan): Geo | null {
  if (typeof body !== "object" || body === null || (body as { bogon?: unknown }).bogon === true) return null;
  const value = body as Record<string, unknown>;
  const text = (input: unknown) =>
    typeof input === "string" && input.length > 0 && input.length <= 80 && !/[\p{Cc}<>]/u.test(input) ? input : undefined;
  const code = (input: unknown) => (typeof input === "string" && /^[A-Z]{2}$/.test(input) ? input : undefined);
  const asn = (input: unknown) => (typeof input === "string" && /^AS[0-9]{1,10}$/.test(input) ? input : undefined);
  const geoPart = plan === "core" && typeof value.geo === "object" && value.geo !== null ? (value.geo as Record<string, unknown>) : value;
  const asPart = plan === "core" && typeof value.as === "object" && value.as !== null ? (value.as as Record<string, unknown>) : undefined;
  const geo: Geo = {
    ...(code(geoPart.country_code) === undefined ? {} : { countryCode: code(geoPart.country_code) }),
    ...(text(geoPart.country) === undefined ? {} : { country: text(geoPart.country) }),
    ...(plan === "core" && text(geoPart.city) !== undefined ? { city: text(geoPart.city) } : {}),
    ...(asn(asPart?.asn ?? value.asn) === undefined ? {} : { asn: asn(asPart?.asn ?? value.asn) }),
    ...(text(asPart?.name ?? value.as_name) === undefined ? {} : { asName: text(asPart?.name ?? value.as_name) }),
  };
  return Object.keys(geo).length === 0 ? null : geo;
}
