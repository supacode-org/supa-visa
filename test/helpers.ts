// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  CloudflareError,
  type EntryRuleset,
  type ListItem,
  type ListsClient,
  type NewListItem,
  type OperationStatus,
  type RuleInput,
  type RulesClient,
  type ZoneRule,
} from "../src/cloudflare.ts";
import { createLogger, type Logger } from "../src/log.ts";
import { EMPTY_STATE, type State, type StateStore } from "../src/store.ts";
import type { Sync, SyncReason, SyncStatus, Timers } from "../src/sync.ts";
import type { Zone } from "../src/waf.ts";

export async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "supa-visa-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export class FakeClock {
  now: number;

  constructor(now: number) {
    this.now = now;
  }

  readonly clock = (): number => this.now;
}

export function recordingLogger(clock: () => number): { logger: Logger; entries: Record<string, unknown>[] } {
  const entries: Record<string, unknown>[] = [];
  const logger = createLogger(clock, (line) => entries.push(JSON.parse(line)));
  return { logger, entries };
}

export function sequentialIds(prefix = "visa"): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

type FakeMethod = keyof ListsClient | keyof RulesClient;

export interface FakeFailure {
  readonly method: FakeMethod;
  readonly error: Error;
  // Only fail calls for this zone.
  readonly zoneId?: string;
}

export const ZONE_A = { id: "a".repeat(32), name: "example.com" };
export const ZONE_B = { id: "b".repeat(32), name: "example.net" };

let fakeIds = 0;
export function fakeId(): string {
  return (++fakeIds).toString(16).padStart(32, "0");
}

// An in-memory Cloudflare: one IP list, zones, and their custom rules entry points.
// List operations stay "running" for `pendingPolls` polls.
export class FakeCloudflare implements ListsClient, RulesClient {
  listNameValue = "supa_visa";
  zones: Zone[] = [ZONE_A, ZONE_B];
  rulesets = new Map<string, { id: string; rules: ZoneRule[] }>();
  items: ListItem[] = [];
  calls: string[] = [];
  failures: FakeFailure[] = [];
  pendingPolls = 0;
  failOperation: string | undefined;
  private nextId = 0;
  private readonly operations = new Map<string, { polls: number; apply: () => void }>();

  constructor(ips: string[] = []) {
    for (const ip of ips) this.items.push({ id: this.newItemId(), ip });
  }

  get ips(): string[] {
    return this.items.map((item) => item.ip).sort();
  }

  async listItems(): Promise<ListItem[]> {
    this.record("listItems");
    return this.items.map((item) => ({ ...item }));
  }

  async createItems(items: readonly NewListItem[]): Promise<string> {
    this.record("createItems");
    return this.operation(() => {
      for (const item of items) this.items.push({ id: this.newItemId(), ...item });
    });
  }

  async deleteItems(ids: readonly string[]): Promise<string> {
    this.record("deleteItems");
    return this.operation(() => {
      this.items = this.items.filter((item) => !ids.includes(item.id));
    });
  }

  async operationStatus(id: string): Promise<OperationStatus> {
    this.record("operationStatus");
    const operation = this.operations.get(id);
    if (operation === undefined) throw new Error(`unknown operation ${id}`);
    if (operation.polls > 0) {
      operation.polls--;
      return { status: "running" };
    }
    if (this.failOperation !== undefined) return { status: "failed", error: this.failOperation };
    operation.apply();
    this.operations.delete(id);
    return { status: "completed" };
  }

  async listName(): Promise<string> {
    this.record("listName");
    return this.listNameValue;
  }

  async listZones(): Promise<Zone[]> {
    this.record("listZones");
    return [...this.zones];
  }

  async entrypoint(zoneId: string): Promise<EntryRuleset | undefined> {
    this.record("entrypoint", zoneId);
    const ruleset = this.rulesets.get(zoneId);
    return ruleset === undefined ? undefined : { id: ruleset.id, rules: ruleset.rules.map((rule) => ({ ...rule })) };
  }

  async createEntrypoint(zoneId: string, rule: RuleInput): Promise<void> {
    this.record("createEntrypoint", zoneId);
    if (this.rulesets.has(zoneId)) throw new CloudflareError("rejected", "entry point exists", 400);
    this.rulesets.set(zoneId, { id: fakeId(), rules: [toZoneRule(rule)] });
  }

  async createRule(zoneId: string, rulesetId: string, rule: RuleInput): Promise<void> {
    this.record("createRule", zoneId);
    this.ruleset(zoneId, rulesetId).rules.unshift(toZoneRule(rule));
  }

  async updateRule(zoneId: string, rulesetId: string, ruleId: string, rule: RuleInput): Promise<void> {
    this.record("updateRule", zoneId);
    const ruleset = this.ruleset(zoneId, rulesetId);
    const index = ruleset.rules.findIndex((existing) => existing.id === ruleId);
    if (index < 0) throw new CloudflareError("rejected", "no such rule", 404);
    ruleset.rules.splice(index, 1);
    ruleset.rules.unshift({ ...toZoneRule(rule), id: ruleId });
  }

  async deleteRule(zoneId: string, rulesetId: string, ruleId: string): Promise<void> {
    this.record("deleteRule", zoneId);
    const ruleset = this.ruleset(zoneId, rulesetId);
    ruleset.rules = ruleset.rules.filter((existing) => existing.id !== ruleId);
  }

  rulesOf(zoneId: string): ZoneRule[] {
    return this.rulesets.get(zoneId)?.rules ?? [];
  }

  private ruleset(zoneId: string, rulesetId: string): { id: string; rules: ZoneRule[] } {
    const ruleset = this.rulesets.get(zoneId);
    if (ruleset === undefined || ruleset.id !== rulesetId) throw new CloudflareError("rejected", "no such ruleset", 404);
    return ruleset;
  }

  private record(method: FakeMethod, zoneId?: string): void {
    this.calls.push(method);
    const index = this.failures.findIndex(
      (failure) => failure.method === method && (failure.zoneId === undefined || failure.zoneId === zoneId),
    );
    if (index >= 0) {
      const [failure] = this.failures.splice(index, 1);
      throw failure?.error;
    }
  }

  private operation(apply: () => void): string {
    const id = `op-${this.operations.size + 1}-${this.nextId}`;
    this.operations.set(id, { polls: this.pendingPolls, apply });
    return id;
  }

  private newItemId(): string {
    return String(++this.nextId).padStart(32, "0");
  }
}

function toZoneRule(rule: RuleInput): ZoneRule {
  return { id: fakeId(), ref: rule.ref, action: rule.action, expression: rule.expression, enabled: rule.enabled };
}

// Timers that only fire when the test says so.
export class FakeTimers implements Timers {
  readonly pending = new Map<number, { callback: () => void; delay: number }>();
  private next = 0;

  set(callback: () => void, delay: number): unknown {
    const handle = ++this.next;
    this.pending.set(handle, { callback, delay });
    return handle;
  }

  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  get delays(): number[] {
    return [...this.pending.values()].map((timer) => timer.delay);
  }

  fireAll(): void {
    const timers = [...this.pending.values()];
    this.pending.clear();
    for (const timer of timers) timer.callback();
  }
}

// A data file in memory; `failures` makes the next saves fail.
export class MemoryStore implements StateStore {
  state: State;
  saves = 0;
  failures = 0;

  constructor(state: Partial<State> = {}) {
    this.state = { ...EMPTY_STATE, ...state };
  }

  async load(): Promise<State> {
    return this.state;
  }

  async save(state: State): Promise<void> {
    if (this.failures > 0) {
      this.failures--;
      throw new Error("disk full");
    }
    this.state = state;
    this.saves++;
  }

  async flush(): Promise<void> {}
}

// A sync that records what it was asked to do and answers with `result`.
export class RecordingSync implements Sync {
  requests: SyncReason[] = [];
  ticks = 0;
  result = true;

  async request(reason: SyncReason): Promise<boolean> {
    this.requests.push(reason);
    return this.result;
  }

  tick(): void {
    this.ticks++;
  }

  status(): SyncStatus {
    return { lastSuccessAt: undefined, failingSince: undefined, lastError: undefined };
  }

  async idle(): Promise<void> {}

  async stop(): Promise<void> {}
}
