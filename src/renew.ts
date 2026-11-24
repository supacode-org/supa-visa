// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import type { Clock } from "./clock.ts";
import { type ActivityClient, type ClientActivity, CloudflareError } from "./cloudflare.ts";
import { MINUTE } from "./duration.ts";
import { targetContains } from "./ip.ts";
import { errorMessage, type Logger } from "./log.ts";
import type { Notify } from "./notify.ts";
import type { VisaService } from "./service.ts";
import type { Services } from "./services.ts";
import type { Visa } from "./visa.ts";

// Minutes before expiry when a visa is checked, latest last.
export const CHECKPOINTS = [10 * MINUTE, 5 * MINUTE, 3 * MINUTE, 1 * MINUTE];
const LAST = CHECKPOINTS.at(-1) as number;

export interface RenewerOptions {
  readonly service: VisaService;
  readonly client: ActivityClient;
  readonly services: () => Services;
  readonly maxLifetime: number;
  readonly activeWindow: number;
  readonly renewBy: number;
  readonly ignorePaths: readonly string[];
  readonly clock: Clock;
  readonly logger: Logger;
  readonly notify?: Notify;
}

interface Progress {
  expiresAt: number;
  done: Set<number>;
  limitNotified: boolean;
}

// Renews visas at fixed points before they expire, from Cloudflare's request
// analytics: one query per zone per round, only when some visa reached a point.
export class Renewer {
  private readonly options: RenewerOptions;
  private readonly progress = new Map<string, Progress>();
  private available = true;
  private running: Promise<void> | undefined;

  constructor(options: RenewerOptions) {
    this.options = options;
  }

  get enabled(): boolean {
    return this.available;
  }

  // Turns renewal off when the token cannot read analytics, instead of failing
  // at every checkpoint.
  async probe(): Promise<void> {
    const zone = this.options.services()[0];
    if (zone === undefined) return;
    const now = this.options.clock();
    try {
      await this.options.client.activeClients(zone.zoneId, [zone.hostname], now - MINUTE, now, []);
    } catch (error) {
      if (error instanceof CloudflareError && error.kind === "auth") {
        this.available = false;
        this.options.logger.error("renew.unavailable", { error: errorMessage(error) });
      }
    }
  }

  tick(): Promise<void> {
    this.running ??= this.round().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async round(): Promise<void> {
    if (!this.available) return;
    const now = this.options.clock();
    const due: { visa: Visa; checkpoint: number }[] = [];
    const current = this.options.service.current;
    for (const id of this.progress.keys()) if (!current.some((visa) => visa.id === id)) this.progress.delete(id);
    for (const visa of current) {
      const left = visa.expiresAt - now;
      if (left <= 0) continue;
      let progress = this.progress.get(visa.id);
      if (progress === undefined || progress.expiresAt !== visa.expiresAt) {
        progress = { expiresAt: visa.expiresAt, done: new Set(), limitNotified: progress?.limitNotified ?? false };
        this.progress.set(visa.id, progress);
      }
      const reached = CHECKPOINTS.filter((point) => left <= point && !progress.done.has(point));
      if (reached.length === 0) continue;
      for (const point of reached) progress.done.add(point);
      due.push({ visa, checkpoint: Math.min(...reached) });
    }
    if (due.length === 0) return;

    const renewable = [];
    for (const item of due) {
      if (item.visa.expiresAt >= item.visa.issuedAt + this.options.maxLifetime) {
        const progress = this.progress.get(item.visa.id) as Progress;
        this.skip(item, "hard_limit", !progress.limitNotified);
        progress.limitNotified = true;
      } else {
        renewable.push(item);
      }
    }
    if (renewable.length === 0) return;

    let activity: ClientActivity[];
    try {
      activity = await this.activity(now);
    } catch (error) {
      for (const item of renewable) this.skip(item, "error", item.checkpoint === LAST, errorMessage(error));
      return;
    }
    for (const item of renewable) {
      const seen = activity.filter((client) => targetContains(item.visa.target, client.ip));
      if (seen.length === 0) {
        this.skip(item, "no_activity", item.checkpoint === LAST);
        continue;
      }
      const lastSeen = Math.max(...seen.map((client) => client.lastMinute));
      await this.options.service.renew(item.visa.id, now + this.options.renewBy, lastSeen);
    }
  }

  private async activity(now: number): Promise<ClientActivity[]> {
    const byZone = new Map<string, string[]>();
    for (const service of this.options.services()) {
      byZone.set(service.zoneId, [...(byZone.get(service.zoneId) ?? []), service.hostname]);
    }
    const results = await Promise.all(
      [...byZone].map(([zoneId, hosts]) =>
        this.options.client.activeClients(zoneId, hosts, now - this.options.activeWindow, now, this.options.ignorePaths),
      ),
    );
    return results.flat();
  }

  private skip(item: { visa: Visa; checkpoint: number }, reason: "hard_limit" | "no_activity" | "error", notify: boolean, error?: string): void {
    const minutesLeft = Math.max(1, Math.round((item.visa.expiresAt - this.options.clock()) / MINUTE));
    this.options.logger.info("visa.renew_skipped", {
      id: item.visa.id,
      target: item.visa.target,
      reason,
      minutesLeft,
      ...(error === undefined ? {} : { error }),
    });
    if (notify) this.options.notify?.({ type: "renew_failed", target: item.visa.target, reason, minutesLeft });
  }
}
