// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import type { Clock } from "./clock.ts";
import { DAY } from "./duration.ts";
import { canonicalTarget, networkOf } from "./ip.ts";
import type { Logger } from "./log.ts";
import type { Notify } from "./notify.ts";
import { sourceOf } from "./ratelimit.ts";
import type { StateKeeper } from "./state.ts";

export interface Block {
  // A single IPv4 address or an IPv6 /64, the same unit as the rate limit.
  readonly source: string;
  readonly since: number;
  readonly until: number;
  readonly failures: number;
}

export type Blocks = readonly Block[];

export const MAX_FAILURES = 3;
export const FAILURE_WINDOW = DAY;
export const BLOCK_FOR = 7 * DAY;
export const MAX_BLOCKS = 10_000;
const MAX_COUNTED_SOURCES = 10_000;

// What a stored or typed source must look like: exactly what `sourceOf` makes
// from a client IP, so a tampered data file cannot widen a block or slip in text.
export function isValidBlockSource(source: string): boolean {
  if (canonicalTarget(source) !== source) return false;
  if (!source.includes(":")) return !source.includes("/");
  return source.endsWith("/64") && networkOf(source.slice(0, -3), 64) === source;
}

export interface BlocklistOptions {
  readonly keeper: StateKeeper;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly notify?: Notify;
}

// Blocks a source after more than MAX_FAILURES failed credential checks within
// FAILURE_WINDOW. Counting stays in memory; blocks are saved with the state.
export class Blocklist {
  private readonly options: BlocklistOptions;
  private readonly failures = new Map<string, number[]>();
  // Blocks decided but still waiting their turn to be saved: requests arriving in
  // the meantime are refused too.
  private readonly pending = new Map<string, number>();

  constructor(options: BlocklistOptions) {
    this.options = options;
  }

  // When the source's block ends, or undefined if it is not blocked.
  blockedUntil(source: string): number | undefined {
    const now = this.options.clock();
    const pending = this.pending.get(source);
    if (pending !== undefined && pending > now) return pending;
    const block = this.options.keeper.state.blocks.find((candidate) => candidate.source === source);
    return block !== undefined && block.until > now ? block.until : undefined;
  }

  get current(): Blocks {
    const now = this.options.clock();
    return this.options.keeper.state.blocks.filter((block) => block.until > now);
  }

  async fail(source: string, reason: string): Promise<void> {
    // Requests without a client IP only come from the host itself.
    if (source === "unknown" || !isValidBlockSource(source) || this.blockedUntil(source) !== undefined) return;
    const now = this.options.clock();
    const recent = (this.failures.get(source) ?? []).filter((time) => time > now - FAILURE_WINDOW);
    recent.push(now);
    this.failures.delete(source);
    if (recent.length <= MAX_FAILURES) {
      if (this.failures.size >= MAX_COUNTED_SOURCES) this.failures.delete(this.failures.keys().next().value as string);
      this.failures.set(source, recent);
      return;
    }
    const block: Block = { source, since: now, until: now + BLOCK_FOR, failures: recent.length };
    const { keeper, logger, notify } = this.options;
    this.pending.set(source, block.until);
    await keeper.exclusive(async () => {
      let blocks = keeper.state.blocks.filter((existing) => existing.until > now && existing.source !== source);
      if (blocks.length >= MAX_BLOCKS) {
        const soonest = blocks.reduce((first, candidate) => (candidate.until < first.until ? candidate : first));
        blocks = blocks.filter((existing) => existing !== soonest);
      }
      // Takes effect even if the disk fails, like expiry.
      await keeper.apply({ ...keeper.state, blocks: [...blocks, block] });
    }).finally(() => this.pending.delete(source));
    logger.warn("ip.block", { source, until: new Date(block.until).toISOString(), failures: block.failures, reason });
    notify?.({ type: "block", source, days: BLOCK_FOR / DAY, failures: block.failures });
  }

  // Lifts the block covering `target` (an IP or the /64 itself), or every block.
  async unblock(target: "all" | string): Promise<number> {
    const { keeper, logger, clock } = this.options;
    const now = clock();
    let source: string | undefined;
    if (target !== "all") {
      const canonical = canonicalTarget(target);
      source = canonical === undefined ? undefined : canonical.includes("/") ? canonical : sourceOf(canonical);
      if (source === undefined || !isValidBlockSource(source)) throw new Error("give a single IP address or an IPv6 /64");
    }
    const removed = await keeper.exclusive(async () => {
      const live = keeper.state.blocks.filter((block) => block.until > now);
      const kept = live.filter((block) => source !== undefined && block.source !== source);
      if (kept.length === keeper.state.blocks.length) return 0;
      await keeper.apply({ ...keeper.state, blocks: kept });
      return live.length - kept.length;
    });
    this.failures.clear();
    this.pending.clear();
    logger.info("ip.unblock", { target: source ?? "all", removed });
    return removed;
  }
}
