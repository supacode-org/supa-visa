// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import type { Clock } from "./clock.ts";
import { CloudflareError, type ListsClient, type NewListItem, type RuleInput, type RulesClient } from "./cloudflare.ts";
import { HOUR, MINUTE, SECOND } from "./duration.ts";
import { canonicalTarget } from "./ip.ts";
import { errorMessage, type Logger } from "./log.ts";
import type { Notify } from "./notify.ts";
import type { Services } from "./services.ts";
import type { Visas } from "./visa.ts";
import { buildExpression, ExpressionError, isValidListName, RULE_DESCRIPTION, RULE_REF } from "./waf.ts";

export type SyncReason = "startup" | "issue" | "revoke" | "expire" | "services" | "reconcile" | "retry";

// Reasons that may have changed what the WAF rules should look like, or that
// check them against Cloudflare. Visa changes only touch the IP list.
const RULE_REASONS: ReadonlySet<SyncReason> = new Set(["startup", "services", "reconcile"]);

export interface SyncStatus {
  readonly lastSuccessAt: number | undefined;
  readonly failingSince: number | undefined;
  readonly lastError: string | undefined;
}

export interface Sync {
  // Resolves with whether an attempt that started after this call succeeded.
  request(reason: SyncReason): Promise<boolean>;
  // Called by the service loop: hourly reconcile and the long-failure alert.
  tick(): void;
  status(): SyncStatus;
  idle(): Promise<void>;
  stop(): Promise<void>;
}

export interface Timers {
  set(callback: () => void, delay: number): unknown;
  clear(handle: unknown): void;
}

const systemTimers: Timers = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface CloudflareSyncOptions {
  readonly client: ListsClient & RulesClient;
  // Target (canonical) to expiry time of every visa that should be on the list now.
  readonly desired: () => ReadonlyMap<string, number>;
  readonly services: () => Services;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly timers?: Timers;
  readonly sleep?: (delay: number) => Promise<void>;
  readonly pollInterval?: number;
  readonly pollTimeout?: number;
  readonly notify?: Notify;
}

export const RECONCILE_INTERVAL = HOUR;
export const FIRST_BACKOFF = 30 * SECOND;
export const MAX_BACKOFF = 10 * MINUTE;
export const FAILING_ALERT_AFTER = 10 * MINUTE;

export function desiredTargets(visas: Visas, now: number): Map<string, number> {
  const targets = new Map<string, number>();
  for (const visa of visas) {
    if (visa.expiresAt <= now) continue;
    // Defense in depth: targets are validated on issue and on load, but nothing
    // that is not a canonical IP or range may ever reach Cloudflare.
    const target = canonicalTarget(visa.target);
    if (target === undefined) continue;
    targets.set(target, Math.max(targets.get(target) ?? 0, visa.expiresAt));
  }
  return targets;
}

export function itemComment(expiresAt: number): string {
  return `supa-visa · expires ${new Date(expiresAt).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export class CloudflareSync implements Sync {
  private readonly options: CloudflareSyncOptions;
  private readonly timers: Timers;
  private running: Promise<boolean> | undefined;
  private queued: Promise<boolean> | undefined;
  private retryTimer: unknown;
  private backoff = 0;
  // When the last attempt that also checked the rules started. Visa changes sync
  // only the list, so they must not push the hourly rule check back.
  private lastReconcileAt: number | undefined;
  private lastSuccessAt: number | undefined;
  private failingSince: number | undefined;
  private failingAlerted = false;
  private lastError: string | undefined;
  private stopped = false;
  // Stays set until a rule sync succeeds, so a failed one is repeated by the next attempt.
  private rulesPending = false;
  private readonly abort = new AbortController();

  constructor(options: CloudflareSyncOptions) {
    this.options = options;
    this.timers = options.timers ?? systemTimers;
  }

  request(reason: SyncReason): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    // Set now, not when the attempt starts: an attempt already running checks
    // this flag after the list step, so it may pick the rules up itself.
    if (RULE_REASONS.has(reason)) this.rulesPending = true;
    return this.schedule(reason);
  }

  private schedule(reason: SyncReason): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    if (this.running === undefined) {
      const run = this.attempt(reason).finally(() => {
        if (this.running === run) this.running = undefined;
      });
      this.running = run;
      return run;
    }
    // One attempt at a time; requests made meanwhile share the next attempt,
    // which starts after the current one so it sees their changes.
    if (this.queued === undefined) {
      this.queued = this.running.then(() => {
        this.queued = undefined;
        return this.schedule(reason);
      });
    }
    return this.queued;
  }

  tick(): void {
    if (this.stopped) return;
    const now = this.options.clock();
    if (this.failingSince !== undefined && !this.failingAlerted && now - this.failingSince >= FAILING_ALERT_AFTER) {
      this.failingAlerted = true;
      this.options.logger.error("sync.failing", { since: new Date(this.failingSince).toISOString() });
      this.options.notify?.({ type: "sync_fail" });
    }
    const due = this.lastReconcileAt === undefined || now - this.lastReconcileAt >= RECONCILE_INTERVAL;
    if (!due) return;
    if (this.retryTimer !== undefined) {
      // A retry is already scheduled; let it include the rules instead of
      // sending another attempt into the backoff.
      this.rulesPending = true;
      return;
    }
    // Queued behind a running attempt if there is one, never skipped.
    void this.request("reconcile");
  }

  status(): SyncStatus {
    return { lastSuccessAt: this.lastSuccessAt, failingSince: this.failingSince, lastError: this.lastError };
  }

  async idle(): Promise<void> {
    while (this.running !== undefined || this.queued !== undefined) {
      await (this.queued ?? this.running);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearRetry();
    // Shutting down must not wait for a slow Cloudflare request; the next start syncs anyway.
    this.abort.abort();
    await this.idle();
  }

  private async attempt(reason: SyncReason): Promise<boolean> {
    const { client, logger, clock } = this.options;
    if (this.rulesPending) this.lastReconcileAt = clock();
    try {
      const desired = this.options.desired();
      const signal = this.abort.signal;
      const items = await client.listItems(signal);

      const kept = new Set<string>();
      const removals: string[] = [];
      for (const item of items) {
        const target = canonicalTarget(item.ip) ?? item.ip;
        if (desired.has(target) && !kept.has(target)) kept.add(target);
        else removals.push(item.id);
      }
      const additions: NewListItem[] = [...desired]
        .filter(([target]) => !kept.has(target))
        .map(([target, expiresAt]) => ({ ip: target, comment: itemComment(expiresAt) }));

      // Additions first, so a visa just issued takes effect as early as possible;
      // but a failed addition must never hold back a removal, which narrows access.
      let additionError: unknown;
      if (additions.length > 0) {
        try {
          await this.waitFor(await client.createItems(additions, signal));
        } catch (error) {
          additionError = error;
        }
      }
      if (removals.length > 0) await this.waitFor(await client.deleteItems(removals, signal));
      if (additionError !== undefined) throw additionError;

      logger.info("sync.complete", { reason, added: additions.length, removed: removals.length });

      // Rules after the list: a newly registered service starts blocking only
      // once the IPs that should pass are already on the list.
      if (this.rulesPending) {
        await this.syncRules(signal);
        this.rulesPending = false;
      }

      this.succeeded();
      return true;
    } catch (error) {
      this.failed(reason, error);
      return false;
    }
  }

  private async syncRules(signal: AbortSignal): Promise<void> {
    const { client, logger } = this.options;
    const listName = await client.listName(signal);
    if (!isValidListName(listName)) {
      throw new CloudflareError("rejected", "the IP list name is not a valid list name for rule expressions");
    }

    const byZone = new Map<string, string[]>();
    for (const service of this.options.services()) {
      byZone.set(service.zoneId, [...(byZone.get(service.zoneId) ?? []), service.hostname]);
    }

    let created = 0;
    let updated = 0;
    let deleted = 0;
    for (const [zoneId, hostnames] of byZone) {
      const rule: RuleInput = {
        ref: RULE_REF,
        action: "block",
        expression: buildExpression(hostnames, listName),
        description: RULE_DESCRIPTION,
        enabled: true,
      };
      const ruleset = await client.entrypoint(zoneId, signal);
      if (ruleset === undefined) {
        await client.createEntrypoint(zoneId, rule, signal);
        created++;
        continue;
      }
      const ours = ruleset.rules.filter((existing) => existing.ref === RULE_REF);
      const [first, ...duplicates] = ours;
      if (first === undefined) {
        await client.createRule(zoneId, ruleset.id, rule, signal);
        created++;
      } else if (
        ruleset.rules[0] !== first ||
        first.expression !== rule.expression ||
        first.action !== rule.action ||
        !first.enabled
      ) {
        await client.updateRule(zoneId, ruleset.id, first.id, rule, signal);
        updated++;
      }
      for (const duplicate of duplicates) {
        await client.deleteRule(zoneId, ruleset.id, duplicate.id, signal);
        deleted++;
      }
    }

    // Zones whose services were all removed still carry our rule; take it away.
    for (const zone of await client.listZones(signal)) {
      if (byZone.has(zone.id)) continue;
      let ruleset;
      try {
        ruleset = await client.entrypoint(zone.id, signal);
      } catch (error) {
        // Without WAF access to a zone we cannot have put a rule there.
        if (error instanceof CloudflareError && error.kind !== "retryable") continue;
        throw error;
      }
      for (const rule of ruleset?.rules ?? []) {
        if (rule.ref !== RULE_REF || ruleset === undefined) continue;
        await client.deleteRule(zone.id, ruleset.id, rule.id, signal);
        deleted++;
      }
    }

    logger.info("rules.complete", { created, updated, deleted });
  }

  private async waitFor(operationId: string): Promise<void> {
    const interval = this.options.pollInterval ?? SECOND;
    const polls = Math.max(1, Math.ceil((this.options.pollTimeout ?? MINUTE) / interval));
    const sleep = this.options.sleep ?? ((delay: number) => new Promise((resolve) => setTimeout(resolve, delay)));
    for (let poll = 0; poll < polls; poll++) {
      const result = await this.options.client.operationStatus(operationId, this.abort.signal);
      if (result.status === "completed") return;
      if (result.status === "failed") {
        throw new CloudflareError("retryable", `bulk operation failed: ${result.error}`);
      }
      await sleep(interval);
    }
    throw new CloudflareError("retryable", "bulk operation did not complete in time");
  }

  private succeeded(): void {
    const now = this.options.clock();
    if (this.failingAlerted && this.failingSince !== undefined) {
      this.options.logger.info("sync.recovered", { failedFor: now - this.failingSince });
      this.options.notify?.({ type: "sync_recovered" });
    }
    this.lastSuccessAt = now;
    this.failingSince = undefined;
    this.failingAlerted = false;
    this.lastError = undefined;
    this.backoff = 0;
    this.clearRetry();
  }

  private failed(reason: SyncReason, error: unknown): void {
    if (this.stopped) return;
    const { logger, clock } = this.options;
    const message = errorMessage(error);
    const kind =
      error instanceof CloudflareError ? error.kind : error instanceof ExpressionError ? "rejected" : "retryable";
    this.failingSince ??= clock();
    this.lastError = message;

    if (kind === "auth") {
      logger.error("sync.auth_failed", { reason, error: message });
      return;
    }
    if (kind === "rejected") {
      logger.error("sync.rejected", { reason, error: message });
      return;
    }

    this.backoff = this.backoff === 0 ? FIRST_BACKOFF : Math.min(this.backoff * 2, MAX_BACKOFF);
    // Retrying before Cloudflare's own hint only extends a rate limit.
    const hint = error instanceof CloudflareError ? error.retryAfter : undefined;
    if (hint !== undefined) this.backoff = Math.max(this.backoff, Math.min(hint, MAX_BACKOFF));
    logger.warn("sync.failed", { reason, error: message, retryIn: this.backoff });
    this.clearRetry();
    this.retryTimer = this.timers.set(() => {
      this.retryTimer = undefined;
      void this.request("retry");
    }, this.backoff);
  }

  private clearRetry(): void {
    if (this.retryTimer === undefined) return;
    this.timers.clear(this.retryTimer);
    this.retryTimer = undefined;
  }
}
