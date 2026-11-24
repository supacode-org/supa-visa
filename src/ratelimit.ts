// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import type { Clock } from "./clock.ts";
import { networkOf } from "./ip.ts";

// Who failed sign-ins and pending challenges count against. One IPv6 /64 is
// usually one customer, so an attacker cannot start afresh by walking their own /64.
export function sourceOf(ip: string | undefined): string {
  if (ip === undefined) return "unknown";
  if (!ip.includes(":")) return ip;
  // Canonical, so the same /64 is always the same key and can be stored as a block.
  return networkOf(ip, 64) ?? ip;
}

// The bucket a request is rate limited in: a whole IPv4 /24 or IPv6 /48. Renting
// many addresses in one /24, or walking one's own IPv6 prefix, is easy, so the
// limit is per network. The blocklist and the challenge quota keep the finer
// `sourceOf`: a neighbour in the same network must not get the owner blocked.
export function networkBucketOf(ip: string | undefined): string {
  if (ip === undefined) return "unknown";
  return networkOf(ip, ip.includes(":") ? 48 : 24) ?? "unknown";
}

export interface RateLimitOptions {
  readonly burst: number;
  // Milliseconds for one request to come back.
  readonly refillEvery: number;
  readonly maxSources: number;
  readonly clock: Clock;
}

// A token bucket per source.
export class RateLimiter {
  private readonly options: RateLimitOptions;
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(options: RateLimitOptions) {
    this.options = options;
  }

  take(source: string): boolean {
    const now = this.options.clock();
    const bucket = this.buckets.get(source);
    const tokens = bucket === undefined ? this.options.burst : this.refilled(bucket, now);
    if (tokens < 1) {
      this.buckets.set(source, { tokens, at: now });
      return false;
    }
    if (bucket === undefined && this.buckets.size >= this.options.maxSources) this.prune(now);
    this.buckets.set(source, { tokens: tokens - 1, at: now });
    return true;
  }

  private refilled(bucket: { tokens: number; at: number }, now: number): number {
    return Math.min(this.options.burst, bucket.tokens + (now - bucket.at) / this.options.refillEvery);
  }

  // Forgets full buckets first (they behave like new ones), then the oldest.
  private prune(now: number): void {
    for (const [source, bucket] of this.buckets) {
      if (this.refilled(bucket, now) >= this.options.burst) this.buckets.delete(source);
    }
    while (this.buckets.size >= this.options.maxSources) {
      this.buckets.delete(this.buckets.keys().next().value as string);
    }
  }
}
