// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { type ActivityClient, type ClientActivity, CloudflareError } from "../src/cloudflare.ts";
import { HOUR, MINUTE } from "../src/duration.ts";
import type { Notification } from "../src/notify.ts";
import { Renewer } from "../src/renew.ts";
import { VisaService } from "../src/service.ts";
import type { Service } from "../src/services.ts";
import { FakeClock, MemoryStore, RecordingSync, recordingLogger, sequentialIds, ZONE_A, ZONE_B } from "./helpers.ts";

const T0 = Date.parse("2026-11-22T10:00:00.000Z");

const SERVICES: Service[] = [
  { hostname: "drive.example.com", zoneId: ZONE_A.id, zoneName: ZONE_A.name, addedAt: T0 },
  { hostname: "photos.example.com", zoneId: ZONE_A.id, zoneName: ZONE_A.name, addedAt: T0 },
  { hostname: "nas.example.net", zoneId: ZONE_B.id, zoneName: ZONE_B.name, addedAt: T0 },
];

interface Query {
  zoneId: string;
  hosts: readonly string[];
  since: number;
  until: number;
  ignorePaths: readonly string[];
}

class FakeActivity implements ActivityClient {
  queries: Query[] = [];
  active: ClientActivity[] = [];
  failure: Error | undefined;

  async activeClients(zoneId: string, hosts: readonly string[], since: number, until: number, ignorePaths: readonly string[]) {
    this.queries.push({ zoneId, hosts, since, until, ignorePaths });
    if (this.failure !== undefined) throw this.failure;
    return this.active;
  }
}

async function setup(t: TestContext, options: { maxLifetime?: number; services?: Service[] } = {}) {
  const time = new FakeClock(T0);
  const { logger, entries } = recordingLogger(time.clock);
  const sync = new RecordingSync();
  const notifications: Notification[] = [];
  const notify = (notification: Notification) => notifications.push(notification);
  const maxLifetime = options.maxLifetime ?? 24 * HOUR;
  const store = new MemoryStore({ services: options.services ?? SERVICES });
  const service = new VisaService({
    maxLifetime,
    ownHostname: "visa.example.com",
    zones: async () => [ZONE_A, ZONE_B],
    store,
    sync,
    logger,
    clock: time.clock,
    newId: sequentialIds(),
    tickInterval: 24 * HOUR,
    notify,
  });
  t.after(() => service.stop());
  await service.start();
  const activity = new FakeActivity();
  const renewer = new Renewer({
    service,
    client: activity,
    services: () => service.registeredServices,
    maxLifetime,
    activeWindow: 15 * MINUTE,
    renewBy: 2 * HOUR,
    ignorePaths: ["/healthz"],
    clock: time.clock,
    logger,
    notify,
  });
  const at = async (offset: number) => {
    time.now = T0 + offset;
    await renewer.tick();
  };
  const issue = (target: string, duration = HOUR) => service.issue({ target, duration, manual: false });
  const renewNotes = () => notifications.filter((note) => note.type === "renew" || note.type === "renew_failed");
  return { time, entries, sync, service, activity, renewer, at, issue, renewNotes, store };
}

test("checks each visa once at 10, 5, 3 and 1 minutes before expiry", async (t) => {
  const { activity, at, issue, renewNotes, entries } = await setup(t);
  await issue("203.0.113.7");

  await at(50 * MINUTE - 1);
  assert.equal(activity.queries.length, 0, "nothing is due before 10 minutes are left");
  await at(50 * MINUTE);
  assert.equal(activity.queries.length, 2, "one query per zone");
  await at(50 * MINUTE + 30_000);
  assert.equal(activity.queries.length, 2, "each checkpoint only once");
  await at(55 * MINUTE);
  await at(57 * MINUTE);
  assert.equal(activity.queries.length, 6);
  assert.deepEqual(renewNotes(), [], "no failure notice before the last checkpoint");
  await at(59 * MINUTE);
  assert.equal(activity.queries.length, 8);
  assert.deepEqual(renewNotes(), [{ type: "renew_failed", target: "203.0.113.7", reason: "no_activity", minutesLeft: 1 }]);
  await at(59 * MINUTE + 50_000);
  assert.equal(activity.queries.length, 8);
  assert.equal(entries.filter((entry) => entry.event === "visa.renew_skipped").length, 4);
});

test("a round past several checkpoints checks once", async (t) => {
  const { activity, at, issue, renewNotes } = await setup(t);
  await issue("203.0.113.7");
  await at(58 * MINUTE);
  assert.equal(activity.queries.length, 2);
  assert.deepEqual(renewNotes(), []);
  await at(59 * MINUTE + 1);
  assert.equal(activity.queries.length, 4);
  assert.equal(renewNotes().length, 1);
});

test("batches due visas into one query per zone with the right hosts and window", async (t) => {
  const { activity, at, issue } = await setup(t);
  await issue("203.0.113.7");
  await issue("198.51.100.9");
  await at(50 * MINUTE);
  assert.deepEqual(activity.queries, [
    { zoneId: ZONE_A.id, hosts: ["drive.example.com", "photos.example.com"], since: T0 + 35 * MINUTE, until: T0 + 50 * MINUTE, ignorePaths: ["/healthz"] },
    { zoneId: ZONE_B.id, hosts: ["nas.example.net"], since: T0 + 35 * MINUTE, until: T0 + 50 * MINUTE, ignorePaths: ["/healthz"] },
  ]);
});

test("renews a visa in use, locally, and recomputes the checkpoints", async (t) => {
  const { activity, at, issue, renewNotes, service, sync, entries } = await setup(t);
  await issue("2001:db8:1:2::/64");
  const requests = sync.requests.length;
  activity.active = [
    { ip: "2001:db8:1:2:abcd::1", lastMinute: T0 + 46 * MINUTE },
    { ip: "2001:db8:1:3::1", lastMinute: T0 + 49 * MINUTE },
  ];
  await at(50 * MINUTE);
  const [visa] = service.current;
  assert.equal(visa?.target, "2001:db8:1:2::/64");
  assert.equal(visa?.expiresAt, T0 + 50 * MINUTE + 2 * HOUR);
  assert.equal(visa?.renewals, 1);
  assert.equal(visa?.lastSeen, T0 + 46 * MINUTE, "only addresses inside the visa count");
  assert.equal(sync.requests.length, requests, "renewal never touches the Cloudflare list");
  assert.deepEqual(renewNotes(), [{ type: "renew", target: "2001:db8:1:2::/64", expiresAt: T0 + 170 * MINUTE }]);
  assert.equal(entries.at(-1)?.event, "visa.renew");

  await at(55 * MINUTE);
  assert.equal(activity.queries.length, 2, "old checkpoints no longer apply");
  await at(160 * MINUTE);
  assert.equal(activity.queries.length, 4, "new expiry, new checkpoints");
  assert.equal(service.current[0]?.renewals, 2);
});

test("does not renew for activity from other addresses", async (t) => {
  const { activity, at, issue, service } = await setup(t);
  await issue("203.0.113.7");
  activity.active = [{ ip: "203.0.113.8", lastMinute: T0 + 49 * MINUTE }];
  await at(50 * MINUTE);
  assert.equal(service.current[0]?.renewals, 0);
  assert.equal(service.current[0]?.expiresAt, T0 + HOUR);
});

test("stops at the hard limit and says so once", async (t) => {
  const { activity, at, issue, renewNotes, service } = await setup(t, { maxLifetime: 2 * HOUR });
  await issue("203.0.113.7");
  activity.active = [{ ip: "203.0.113.7", lastMinute: T0 + 49 * MINUTE }];
  await at(50 * MINUTE);
  assert.equal(service.current[0]?.expiresAt, T0 + 2 * HOUR, "capped by the hard limit");
  const queries = activity.queries.length;
  for (const minute of [110, 115, 117, 119]) await at(minute * MINUTE);
  assert.equal(activity.queries.length, queries, "nothing to ask once at the limit");
  assert.deepEqual(renewNotes().slice(1), [{ type: "renew_failed", target: "203.0.113.7", reason: "hard_limit", minutesLeft: 10 }]);
  assert.equal(service.current[0]?.expiresAt, T0 + 2 * HOUR);
});

test("a failed query notifies only at the last checkpoint and the visa still expires", async (t) => {
  const { activity, at, issue, renewNotes, service, time, entries } = await setup(t);
  await issue("203.0.113.7");
  activity.failure = new CloudflareError("retryable", "analytics: HTTP 503", 503);
  await at(50 * MINUTE);
  assert.deepEqual(renewNotes(), []);
  assert.equal(entries.at(-1)?.reason, "error");
  await at(59 * MINUTE);
  assert.deepEqual(renewNotes(), [{ type: "renew_failed", target: "203.0.113.7", reason: "error", minutesLeft: 1 }]);
  time.now = T0 + HOUR;
  await service.tick();
  assert.deepEqual(service.current, []);
});

test("probing without analytics permission turns renewal off", async (t) => {
  const { activity, renewer, at, issue, entries } = await setup(t);
  activity.failure = new CloudflareError("auth", "analytics: HTTP 403", 403);
  await renewer.probe();
  assert.equal(renewer.enabled, false);
  assert.equal(entries.at(-1)?.event, "renew.unavailable");
  await issue("203.0.113.7");
  await at(50 * MINUTE);
  assert.equal(activity.queries.length, 1, "only the probe");
});

test("probing keeps renewal on for other failures and skips when no service exists", async (t) => {
  const first = await setup(t);
  first.activity.failure = new CloudflareError("retryable", "analytics: HTTP 503", 503);
  await first.renewer.probe();
  assert.equal(first.renewer.enabled, true);

  const second = await setup(t, { services: [] });
  await second.renewer.probe();
  assert.equal(second.activity.queries.length, 0);
  assert.equal(second.renewer.enabled, true);
});

test("the service never renews a missing or expired visa, nor shortens one", async (t) => {
  const { service, issue, time } = await setup(t);
  const { visa } = await issue("203.0.113.7");
  assert.equal(await service.renew("missing", T0 + 2 * HOUR, T0), undefined);
  assert.equal(await service.renew(visa.id, T0 + 30 * MINUTE, T0), undefined);
  time.now = T0 + HOUR;
  assert.equal(await service.renew(visa.id, T0 + 3 * HOUR, T0), undefined);
});
