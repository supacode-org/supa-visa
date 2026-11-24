// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { CloudflareError } from "../src/cloudflare.ts";
import { HOUR, MINUTE, SECOND } from "../src/duration.ts";
import { CloudflareSync, desiredTargets, itemComment } from "../src/sync.ts";
import type { Service } from "../src/services.ts";
import type { Visa } from "../src/visa.ts";
import { RULE_REF } from "../src/waf.ts";
import { FakeClock, FakeCloudflare, FakeTimers, fakeId, recordingLogger, ZONE_A, ZONE_B } from "./helpers.ts";

const T0 = Date.parse("2026-11-22T10:00:00.000Z");

function setup(t: TestContext, initial: string[] = [], desired = new Map<string, number>()) {
  const time = new FakeClock(T0);
  const client = new FakeCloudflare(initial);
  const timers = new FakeTimers();
  const { logger, entries } = recordingLogger(time.clock);
  const state: { desired: Map<string, number>; services: Service[] } = { desired, services: [] };
  const sleeps: number[] = [];
  const sync = new CloudflareSync({
    client,
    desired: () => state.desired,
    services: () => state.services,
    clock: time.clock,
    logger,
    timers,
    sleep: async (delay) => {
      sleeps.push(delay);
    },
  });
  t.after(() => sync.stop());
  const events = () => entries.map((entry) => entry.event);
  return { time, client, timers, entries, events, state, sync, sleeps };
}

const retryable = () => new CloudflareError("retryable", "HTTP 503");

function visa(target: string, expiresAt: number): Visa {
  return { id: target, target, issuedAt: T0, expiresAt, lastSeen: null, manual: false, renewals: 0 };
}

test("desired targets are the canonical targets of unexpired visas", () => {
  const visas = [
    visa("203.0.113.7", T0 + HOUR),
    visa("198.51.100.0/24", T0),
    visa("2001:db8::1", T0 + 2 * HOUR),
    visa("not an ip\" or true", T0 + HOUR),
  ];
  assert.deepEqual(
    desiredTargets(visas, T0),
    new Map([
      ["203.0.113.7", T0 + HOUR],
      ["2001:db8::1", T0 + 2 * HOUR],
    ]),
  );
});

test("comments name the expiry in UTC", () => {
  assert.equal(itemComment(Date.parse("2026-11-22T14:00:59.999Z")), "supa-visa · expires 2026-11-22 14:00 UTC");
});

test("adds missing targets and removes extra items", async (t) => {
  const { client, sync, entries } = setup(
    t,
    ["203.0.113.7", "192.0.2.1"],
    new Map([
      ["203.0.113.7", T0 + HOUR],
      ["198.51.100.0/24", T0 + 2 * HOUR],
    ]),
  );
  assert.equal(await sync.request("issue"), true);
  assert.deepEqual(client.ips, ["198.51.100.0/24", "203.0.113.7"]);
  assert.equal(
    client.items.find((item) => item.ip === "198.51.100.0/24")?.comment,
    "supa-visa · expires 2026-11-22 12:00 UTC",
  );
  assert.deepEqual(client.calls, ["listItems", "createItems", "operationStatus", "deleteItems", "operationStatus"]);
  assert.deepEqual(entries.at(-1), {
    time: "2026-11-22T10:00:00.000Z",
    level: "info",
    event: "sync.complete",
    reason: "issue",
    added: 1,
    removed: 1,
  });
  assert.deepEqual(sync.status(), { lastSuccessAt: T0, failingSince: undefined, lastError: undefined });
});

test("writes nothing when the list already matches", async (t) => {
  const { client, sync } = setup(t, ["2001:DB8:0:0::1"], new Map([["2001:db8::1", T0 + HOUR]]));
  assert.equal(await sync.request("issue"), true);
  assert.deepEqual(client.calls, ["listItems"]);
});

test("removes duplicates and items it cannot parse", async (t) => {
  const { client, sync } = setup(t, ["203.0.113.7", "203.0.113.7/32", "garbage"], new Map([["203.0.113.7", T0 + HOUR]]));
  await sync.request("reconcile");
  assert.deepEqual(client.ips, ["203.0.113.7"]);
});

test("polls until the operation completes", async (t) => {
  const { client, sync, sleeps } = setup(t, [], new Map([["203.0.113.7", T0 + HOUR]]));
  client.pendingPolls = 3;
  assert.equal(await sync.request("issue"), true);
  assert.deepEqual(sleeps, [SECOND, SECOND, SECOND]);
  assert.deepEqual(client.ips, ["203.0.113.7"]);
});

test("an operation that never completes is a retryable failure", async (t) => {
  const { client, sync, timers, events } = setup(t, [], new Map([["203.0.113.7", T0 + HOUR]]));
  client.pendingPolls = 1000;
  assert.equal(await sync.request("issue"), false);
  assert.equal(events().at(-1), "sync.failed");
  assert.match(sync.status().lastError ?? "", /did not complete in time/);
  assert.deepEqual(timers.delays, [30 * SECOND]);
});

test("a failed operation is a retryable failure", async (t) => {
  const { client, sync, entries } = setup(t, [], new Map([["203.0.113.7", T0 + HOUR]]));
  client.failOperation = "This list is at the maximum number of items";
  assert.equal(await sync.request("issue"), false);
  assert.match(String(entries.at(-1)?.error), /maximum number of items/);
});

test("backs off from 30 seconds to 10 minutes and resets after success", async (t) => {
  const { client, sync, timers, entries, state } = setup(t);
  state.desired = new Map([["203.0.113.7", T0 + HOUR]]);
  const delays: number[] = [];
  for (let attempt = 0; attempt < 7; attempt++) {
    client.failures.push({ method: "listItems", error: retryable() });
    await (attempt === 0 ? sync.request("issue") : (timers.fireAll(), sync.idle()));
    delays.push(...timers.delays);
  }
  assert.deepEqual(delays, [30, 60, 120, 240, 480, 600, 600].map((seconds) => seconds * SECOND));
  assert.equal(entries.at(-1)?.reason, "retry");

  timers.fireAll();
  await sync.idle();
  assert.deepEqual(client.ips, ["203.0.113.7"]);
  assert.deepEqual(timers.delays, []);

  client.failures.push({ method: "listItems", error: retryable() });
  await sync.request("revoke");
  assert.deepEqual(timers.delays, [30 * SECOND]);
});

test("auth and rejected errors are not retried on a timer", async (t) => {
  const { client, sync, timers, events } = setup(t, [], new Map([["203.0.113.7", T0 + HOUR]]));
  client.failures.push({ method: "listItems", error: new CloudflareError("auth", "HTTP 401") });
  assert.equal(await sync.request("startup"), false);
  assert.equal(events().at(-1), "sync.auth_failed");
  assert.deepEqual(timers.delays, []);

  client.failures.push({ method: "createItems", error: new CloudflareError("rejected", "HTTP 404") });
  assert.equal(await sync.request("issue"), false);
  assert.equal(events().at(-1), "sync.rejected");
  assert.deepEqual(timers.delays, []);

  assert.equal(await sync.request("issue"), true, "the next change tries again");
});

test("alerts once after 10 minutes of failures and logs the recovery", async (t) => {
  const { client, sync, time, timers, events, entries } = setup(t, [], new Map([["203.0.113.7", T0 + HOUR]]));
  client.failures.push({ method: "listItems", error: new CloudflareError("auth", "HTTP 403") });
  await sync.request("startup");

  time.now = T0 + 10 * MINUTE - 1;
  sync.tick();
  assert.ok(!events().includes("sync.failing"));

  time.now = T0 + 10 * MINUTE;
  sync.tick();
  sync.tick();
  assert.equal(events().filter((event) => event === "sync.failing").length, 1);
  assert.equal(entries.find((entry) => entry.event === "sync.failing")?.since, "2026-11-22T10:00:00.000Z");

  time.now = T0 + 15 * MINUTE;
  await sync.request("issue");
  assert.deepEqual(entries.find((entry) => entry.event === "sync.recovered"), {
    time: "2026-11-22T10:15:00.000Z",
    level: "info",
    event: "sync.recovered",
    failedFor: 15 * MINUTE,
  });
  assert.deepEqual(timers.delays, []);
});

test("reconciles once an hour has passed since the last attempt", async (t) => {
  const { client, sync, time, entries } = setup(t, [], new Map([["203.0.113.7", T0 + 3 * HOUR]]));
  await sync.request("startup");
  client.items = [];

  time.now = T0 + HOUR - 1;
  sync.tick();
  await sync.idle();
  assert.deepEqual(client.ips, []);

  time.now = T0 + HOUR;
  sync.tick();
  await sync.idle();
  assert.deepEqual(client.ips, ["203.0.113.7"]);
  assert.equal(entries.findLast((entry) => entry.event === "sync.complete")?.reason, "reconcile");
});

test("does not reconcile while a retry is scheduled", async (t) => {
  const { client, sync, time, timers } = setup(t, [], new Map([["203.0.113.7", T0 + 3 * HOUR]]));
  client.failures.push({ method: "listItems", error: retryable() });
  await sync.request("startup");
  const calls = client.calls.length;
  time.now = T0 + 2 * HOUR;
  sync.tick();
  await sync.idle();
  assert.equal(client.calls.length, calls);
  assert.equal(timers.pending.size, 1);
});

test("requests made during a sync share one follow-up sync that sees their changes", async (t) => {
  const { client, sync, state } = setup(t, [], new Map([["203.0.113.7", T0 + HOUR]]));
  client.pendingPolls = 1;
  const first = sync.request("issue");
  state.desired = new Map([
    ["203.0.113.7", T0 + HOUR],
    ["203.0.113.8", T0 + HOUR],
  ]);
  const second = sync.request("issue");
  const third = sync.request("revoke");
  assert.equal(second, third);
  assert.deepEqual(await Promise.all([first, second, third]), [true, true, true]);
  assert.deepEqual(client.ips, ["203.0.113.7", "203.0.113.8"]);
  assert.equal(client.calls.filter((call) => call === "listItems").length, 2);
});

test("stopping cancels the retry and ignores later requests", async (t) => {
  const { client, sync, timers } = setup(t, [], new Map([["203.0.113.7", T0 + HOUR]]));
  client.failures.push({ method: "listItems", error: retryable() });
  await sync.request("startup");
  assert.equal(timers.pending.size, 1);
  await sync.stop();
  assert.equal(timers.pending.size, 0);
  const calls = client.calls.length;
  assert.equal(await sync.request("issue"), false);
  sync.tick();
  assert.equal(client.calls.length, calls);
});

function service(hostname: string, zone = ZONE_A): Service {
  return { hostname, zoneId: zone.id, zoneName: zone.name, addedAt: T0 };
}

const EXPRESSION_A = '(http.host in {"a.example.com" "b.example.com"} and not ip.src in $supa_visa)';

test("visa changes sync only the list; services, startup and reconcile sync the rules", async (t) => {
  const { client, sync, state } = setup(t);
  state.services = [service("a.example.com")];
  for (const reason of ["issue", "revoke", "expire"] as const) {
    client.calls = [];
    await sync.request(reason);
    assert.deepEqual(client.calls, ["listItems"], reason);
  }
  for (const reason of ["services", "startup", "reconcile"] as const) {
    client.calls = [];
    await sync.request(reason);
    assert.ok(client.calls.includes("listName"), reason);
  }
});

test("creates the entry point with our rule when the zone has none", async (t) => {
  const { client, sync, state, entries } = setup(t);
  state.services = [service("b.example.com"), service("a.example.com")];
  assert.equal(await sync.request("services"), true);
  assert.deepEqual(client.rulesOf(ZONE_A.id).map(({ ref, action, expression, enabled }) => ({ ref, action, expression, enabled })), [
    { ref: RULE_REF, action: "block", expression: EXPRESSION_A, enabled: true },
  ]);
  assert.deepEqual(entries.at(-1), {
    time: "2026-11-22T10:00:00.000Z",
    level: "info",
    event: "rules.complete",
    created: 1,
    updated: 0,
    deleted: 0,
  });
});

test("adds our rule first and leaves other rules alone", async (t) => {
  const { client, sync, state } = setup(t);
  const theirs = { id: fakeId(), ref: "their-rule", action: "skip", expression: "true", enabled: true };
  client.rulesets.set(ZONE_A.id, { id: fakeId(), rules: [theirs] });
  state.services = [service("a.example.com"), service("b.example.com")];
  await sync.request("services");
  const rules = client.rulesOf(ZONE_A.id);
  assert.equal(rules[0]?.ref, RULE_REF);
  assert.deepEqual(rules[1], theirs);
});

test("rewrites our rule when it was edited, disabled or moved, and leaves it when correct", async (t) => {
  const { client, sync, state, entries } = setup(t);
  state.services = [service("a.example.com"), service("b.example.com")];
  const theirs = { id: fakeId(), ref: "theirs", action: "skip", expression: "true", enabled: true };
  const tampered = [
    { expression: "(http.host in {\"a.example.com\"} and not ip.src in $supa_visa) or true", enabled: true, first: true },
    { expression: EXPRESSION_A, enabled: false, first: true },
    { expression: EXPRESSION_A, enabled: true, first: false },
  ];
  for (const { expression, enabled, first } of tampered) {
    const ours = { id: fakeId(), ref: RULE_REF, action: "block", expression, enabled };
    client.rulesets.set(ZONE_A.id, { id: fakeId(), rules: first ? [ours, theirs] : [theirs, ours] });
    await sync.request("reconcile");
    const rules = client.rulesOf(ZONE_A.id);
    assert.deepEqual([rules[0]?.ref, rules[0]?.expression, rules[0]?.enabled, rules[0]?.id], [RULE_REF, EXPRESSION_A, true, ours.id]);
    assert.equal(rules.length, 2);
    assert.equal(entries.at(-1)?.updated, 1);
  }
  client.calls = [];
  await sync.request("reconcile");
  assert.ok(!client.calls.some((call) => ["createRule", "updateRule", "deleteRule", "createEntrypoint"].includes(call)));
});

test("removes duplicate rules of ours", async (t) => {
  const { client, sync, state } = setup(t);
  state.services = [service("a.example.com"), service("b.example.com")];
  const rule = () => ({ id: fakeId(), ref: RULE_REF, action: "block", expression: EXPRESSION_A, enabled: true });
  client.rulesets.set(ZONE_A.id, { id: fakeId(), rules: [rule(), rule()] });
  await sync.request("reconcile");
  assert.equal(client.rulesOf(ZONE_A.id).length, 1);
});

test("removes our rule from zones that no longer have services, skipping zones it cannot read", async (t) => {
  const { client, sync, state } = setup(t);
  const theirs = { id: fakeId(), ref: "theirs", action: "skip", expression: "true", enabled: true };
  state.services = [service("a.example.com"), service("x.example.net", ZONE_B)];
  await sync.request("services");
  client.rulesets.get(ZONE_B.id)?.rules.push(theirs);
  client.zones.push({ id: "c".repeat(32), name: "example.org" });

  state.services = [service("a.example.com")];
  client.failures.push({ method: "entrypoint", zoneId: "c".repeat(32), error: new CloudflareError("auth", "HTTP 403", 403) });
  assert.equal(await sync.request("services"), true);
  assert.deepEqual(client.rulesOf(ZONE_B.id), [theirs]);
  assert.equal(client.rulesOf(ZONE_A.id).length, 1);

  state.services = [];
  await sync.request("services");
  assert.deepEqual(client.rulesOf(ZONE_A.id), []);
});

test("an invalid list name stops the rule sync before anything is written", async (t) => {
  const { client, sync, state, events } = setup(t);
  state.services = [service("a.example.com")];
  for (const name of ["supa-visa", "supa_visa or true", "Supa_Visa", ""]) {
    client.listNameValue = name;
    assert.equal(await sync.request("services"), false, name);
    assert.equal(events().at(-1), "sync.rejected");
  }
  assert.equal(client.rulesets.size, 0);
});

test("a tampered hostname in memory never reaches a rule", async (t) => {
  const { client, sync, state, events, timers } = setup(t);
  state.services = [service('a.example.com" or true or "')];
  assert.equal(await sync.request("services"), false);
  assert.equal(events().at(-1), "sync.rejected");
  assert.equal(client.rulesets.size, 0);
  assert.deepEqual(timers.delays, [], "not retried on a timer");
});

test("a failed rule sync is repeated by the next attempt, even for a visa change", async (t) => {
  const { client, sync, state } = setup(t);
  state.services = [service("a.example.com")];
  client.failures.push({ method: "entrypoint", error: new CloudflareError("retryable", "HTTP 503", 503) });
  assert.equal(await sync.request("services"), false);
  assert.equal(client.rulesets.size, 0);
  assert.equal(await sync.request("issue"), true);
  assert.equal(client.rulesOf(ZONE_A.id).length, 1);
});

test("frequent visa changes do not postpone the hourly rule check", async (t) => {
  const { client, sync, state, time } = setup(t);
  state.services = [service("a.example.com")];
  await sync.request("startup");
  const ruleChecks = () => client.calls.filter((call) => call === "listName").length;
  assert.equal(ruleChecks(), 1);

  for (let minutes = 20; minutes < 60; minutes += 20) {
    time.now = T0 + minutes * MINUTE;
    await sync.request("issue");
    sync.tick();
    await sync.idle();
  }
  assert.equal(ruleChecks(), 1, "not due yet");

  // The tick that finds the hour has passed starts while an expiry sync is running.
  time.now = T0 + HOUR;
  const expiry = sync.request("expire");
  sync.tick();
  await expiry;
  await sync.idle();
  assert.equal(ruleChecks(), 2);
});

test("a rule check that failed without a retry is tried again after an hour", async (t) => {
  const { client, sync, state, time, timers } = setup(t);
  state.services = [service("a.example.com")];
  client.failures.push({ method: "listName", error: new CloudflareError("auth", "HTTP 403", 403) });
  assert.equal(await sync.request("startup"), false);
  assert.deepEqual(timers.delays, []);
  time.now = T0 + HOUR;
  sync.tick();
  await sync.idle();
  assert.equal(client.rulesOf(ZONE_A.id).length, 1);
});

test("tells the owner when syncing has failed for 10 minutes, and when it works again", async (t) => {
  const time = new FakeClock(T0);
  const { logger } = recordingLogger(time.clock);
  const client = new FakeCloudflare();
  const sent: string[] = [];
  const sync = new CloudflareSync({
    client,
    desired: () => new Map([["203.0.113.7", T0 + HOUR]]),
    services: () => [],
    clock: time.clock,
    logger,
    timers: new FakeTimers(),
    sleep: async () => {},
    notify: (notification) => sent.push(notification.type),
  });
  t.after(() => sync.stop());
  client.failures.push({ method: "listItems", error: new CloudflareError("auth", "HTTP 403", 403) });
  await sync.request("issue");
  time.now = T0 + 10 * MINUTE;
  sync.tick();
  sync.tick();
  await sync.request("issue");
  assert.deepEqual(sent, ["sync_fail", "sync_recovered"]);
});

test("a rejected addition does not hold back removals", async (t) => {
  const { client, sync, state } = setup(t, ["198.51.100.9"]);
  state.desired = new Map([["203.0.113.7", T0 + HOUR]]);
  client.failures.push({ method: "createItems", error: new CloudflareError("rejected", "HTTP 400", 400) });
  assert.equal(await sync.request("revoke"), false);
  assert.deepEqual(client.ips, [], "198.51.100.9 is gone even though 203.0.113.7 was refused");
});

test("waits at least as long as Cloudflare's Retry-After", async (t) => {
  const { client, sync, timers, state } = setup(t);
  state.desired = new Map([["203.0.113.7", T0 + HOUR]]);
  client.failures.push({ method: "listItems", error: new CloudflareError("retryable", "HTTP 429", 429, 300 * SECOND) });
  await sync.request("issue");
  assert.deepEqual(timers.delays, [300 * SECOND]);
});
