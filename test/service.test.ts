// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { HOUR, MINUTE } from "../src/duration.ts";
import { VisaService } from "../src/service.ts";
import { EMPTY_STATE, FileStore, type State, type StateStore } from "../src/store.ts";
import { CloudflareSync, desiredTargets, type Sync, type SyncReason, type SyncStatus } from "../src/sync.ts";
import type { Notification } from "../src/notify.ts";
import { InvalidInputError } from "../src/validate.ts";
import { VERSION } from "../src/version.ts";
import type { Visas } from "../src/visa.ts";
import {
  FakeClock,
  FakeCloudflare,
  FakeTimers,
  RecordingSync as SharedRecordingSync,
  recordingLogger,
  sequentialIds,
  temporaryDirectory,
  ZONE_A,
  ZONE_B,
} from "./helpers.ts";

const T0 = Date.parse("2026-11-22T10:00:00.000Z");

// A store whose next saves can be made to fail.
class FlakyStore implements StateStore {
  // The visas of each successful save, which is what most tests look at.
  saved: Visas[] = [];
  states: State[] = [];
  failures = 0;
  private readonly initial: State;

  constructor(initial: Visas = [], services: State["services"] = []) {
    this.initial = { ...EMPTY_STATE, visas: initial, services };
  }

  async load(): Promise<State> {
    return this.initial;
  }

  async save(state: State): Promise<void> {
    if (this.failures > 0) {
      this.failures--;
      throw new Error("disk full");
    }
    this.saved.push(state.visas);
    this.states.push(state);
  }

  async flush(): Promise<void> {}
}

// Records sync requests and answers with `result`.
class RecordingSync implements Sync {
  requests: SyncReason[] = [];
  ticks = 0;
  result = true;
  stopped = false;

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

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

function setup(t: TestContext, store: StateStore, zones = [ZONE_A, ZONE_B]) {
  const time = new FakeClock(T0);
  const { logger, entries } = recordingLogger(time.clock);
  const sync = new RecordingSync();
  const service = new VisaService({
    maxLifetime: 24 * HOUR,
    ownHostname: "visa.example.com",
    zones: async () => zones,
    store,
    sync,
    logger,
    clock: time.clock,
    newId: sequentialIds(),
    tickInterval: 24 * HOUR,
  });
  t.after(() => service.stop());
  return { time, entries, service, sync, events: () => entries.map((entry) => entry.event) };
}

test("issue and revoke are saved and logged", async (t) => {
  const store = new FlakyStore();
  const { service, entries, sync } = setup(t, store);
  await service.start();

  const { visa, synced } = await service.issue({ target: "203.0.113.7", duration: 4 * HOUR, manual: false });
  assert.equal(visa.id, "visa-1");
  assert.equal(synced, true);
  assert.deepEqual(store.saved.at(-1), [visa]);
  assert.deepEqual(entries.at(-1), {
    time: "2026-11-22T10:00:00.000Z",
    level: "info",
    event: "visa.issue",
    id: "visa-1",
    target: "203.0.113.7",
    expiresAt: "2026-11-22T14:00:00.000Z",
    manual: false,
    replaced: null,
  });

  sync.result = false;
  const again = await service.issue({ target: "203.0.113.7/32", duration: 1 * HOUR, manual: false });
  assert.equal(again.synced, false);
  assert.equal(again.visa.target, "203.0.113.7", "stored in canonical form");
  assert.equal(entries.at(-1)?.replaced, "visa-1");
  assert.deepEqual(service.current, [again.visa]);

  assert.equal(await service.revoke("missing"), undefined);
  assert.deepEqual(await service.revoke(again.visa.id), { visa: again.visa, synced: false });
  assert.deepEqual(sync.requests, ["startup", "issue", "issue", "revoke"]);
  assert.deepEqual(store.saved.at(-1), []);
  assert.deepEqual(entries.at(-1), {
    time: "2026-11-22T10:00:00.000Z",
    level: "info",
    event: "visa.revoke",
    id: "visa-2",
    target: "203.0.113.7",
  });
});

test("expired visas are removed on each tick", async (t) => {
  const store = new FlakyStore();
  const { service, time, events } = setup(t, store);
  await service.start();
  await service.issue({ target: "203.0.113.7", duration: 1 * HOUR, manual: false });
  await service.issue({ target: "203.0.113.8", duration: 2 * HOUR, manual: false });
  const saves = store.saved.length;

  time.now = T0 + HOUR - 1;
  await service.tick();
  assert.equal(store.saved.length, saves, "nothing expired, nothing saved");

  time.now = T0 + HOUR;
  await service.tick();
  assert.deepEqual(
    service.current.map((visa) => visa.target),
    ["203.0.113.8"],
  );
  assert.deepEqual(store.saved.at(-1), service.current);
  assert.equal(events().filter((event) => event === "visa.expire").length, 1);
});

test("each tick drives the sync, and expiry requests a sync", async (t) => {
  const { service, time, sync } = setup(t, new FlakyStore());
  await service.start();
  await service.issue({ target: "203.0.113.7", duration: 1 * HOUR, manual: false });
  await service.tick();
  assert.deepEqual(sync.requests, ["startup", "issue"]);
  assert.equal(sync.ticks, 1);
  time.now = T0 + HOUR;
  await service.tick();
  assert.deepEqual(sync.requests, ["startup", "issue", "expire"]);
  assert.equal(sync.ticks, 2);
});

test("rejects invalid input before touching any state", async (t) => {
  const store = new FlakyStore();
  const { service, sync } = setup(t, store);
  await service.start();
  const bad = [
    { target: '203.0.113.7" or true or "', duration: HOUR, manual: false },
    { target: "203.0.113.7) or (ip.src ne 0.0.0.0", duration: HOUR, manual: false },
    { target: "203.0.113.7\n198.51.100.0/24", duration: HOUR, manual: false },
    { target: "example.com", duration: HOUR, manual: false },
    { target: "203.0.113.7/33", duration: HOUR, manual: false },
    { target: "203.0.113.7", duration: 0, manual: false },
    { target: "203.0.113.7", duration: Number.NaN, manual: false },
    { target: "203.0.113.7", duration: HOUR, note: "", manual: false },
    { target: "203.0.113.7", duration: HOUR, note: "x".repeat(41), manual: false },
    { target: "203.0.113.7", duration: HOUR, note: "line\nbreak", manual: false },
    { target: "203.0.113.7", duration: HOUR, note: " padded", manual: false },
  ];
  for (const input of bad) {
    await assert.rejects(service.issue(input), InvalidInputError, JSON.stringify(input));
  }
  assert.deepEqual(service.current, []);
  assert.deepEqual(store.saved, []);
  assert.deepEqual(sync.requests, ["startup"]);
  const { visa } = await service.issue({ target: "203.0.113.7", duration: HOUR, note: "飯店 Wi-Fi 🏨", manual: false });
  assert.equal(visa.note, "飯店 Wi-Fi 🏨");
});

test("start removes visas that expired while the service was down", async (t) => {
  const stale = { id: "old", target: "203.0.113.7", issuedAt: T0 - 5 * HOUR, expiresAt: T0 - HOUR, lastSeen: null, manual: false, renewals: 1 };
  const fresh = { ...stale, id: "new", target: "203.0.113.8", expiresAt: T0 + HOUR };
  const store = new FlakyStore([stale, fresh]);
  const { service, entries } = setup(t, store);
  await service.start();

  assert.deepEqual(service.current, [fresh]);
  assert.deepEqual(store.saved, [[fresh]]);
  const expired = entries.find((entry) => entry.event === "visa.expire");
  assert.deepEqual(expired, {
    time: "2026-11-22T10:00:00.000Z",
    level: "info",
    event: "visa.expire",
    id: "old",
    target: "203.0.113.7",
    issuedAt: "2026-11-22T05:00:00.000Z",
    renewals: 1,
  });
  assert.deepEqual(entries.at(-1), {
    time: "2026-11-22T10:00:00.000Z",
    level: "info",
    event: "service.start",
    version: VERSION,
    visas: 1,
  });
});

test("a failed save on issue leaves the state unchanged", async (t) => {
  const store = new FlakyStore();
  const { service, events, sync } = setup(t, store);
  await service.start();
  store.failures = 1;
  await assert.rejects(service.issue({ target: "203.0.113.7", duration: HOUR, manual: false }), /disk full/);
  assert.deepEqual(service.current, []);
  assert.equal(events().at(-1), "store.save_failed");
  assert.deepEqual(sync.requests, ["startup"], "nothing to sync when nothing changed");
});

test("a failed save on expiry still expires the visa and is retried", async (t) => {
  const store = new FlakyStore();
  const { service, time, events } = setup(t, store);
  await service.start();
  await service.issue({ target: "203.0.113.7", duration: HOUR, manual: false });

  store.failures = 1;
  time.now = T0 + HOUR;
  await service.tick();
  assert.deepEqual(service.current, []);
  assert.equal(events().at(-1), "store.save_failed");

  time.now = T0 + HOUR + MINUTE;
  await service.tick();
  assert.deepEqual(store.saved.at(-1), []);
  assert.equal(events().at(-1), "store.save_failed", "the retry succeeds silently");

  const saves = store.saved.length;
  await service.tick();
  assert.equal(store.saved.length, saves, "no further saves once it succeeded");
});

test("an issue racing a tick cannot bring back an expired visa", async (t) => {
  const store = new FlakyStore();
  const { service, time } = setup(t, store);
  await service.start();
  await service.issue({ target: "203.0.113.7", duration: HOUR, manual: false });
  time.now = T0 + HOUR;
  await Promise.all([service.tick(), service.issue({ target: "203.0.113.8", duration: HOUR, manual: false })]);
  assert.deepEqual(
    service.current.map((visa) => visa.target),
    ["203.0.113.8"],
  );
});

test("visas survive a restart", async (t) => {
  const path = join(await temporaryDirectory(t), "visa.json");
  const first = setup(t, new FileStore(path));
  await first.service.start();
  const { visa } = await first.service.issue({ target: "203.0.113.7", duration: HOUR, note: "hotel", manual: false });
  await first.service.stop();

  const second = setup(t, new FileStore(path));
  second.time.now = T0 + 30 * MINUTE;
  await second.service.start();
  assert.deepEqual(second.service.current, [visa]);
});

test("with the real sync, Cloudflare follows issue, revoke and expiry", async (t) => {
  const time = new FakeClock(T0);
  const { logger } = recordingLogger(time.clock);
  const client = new FakeCloudflare(["192.0.2.1"]);
  let service: VisaService | undefined;
  const sync = new CloudflareSync({
    client,
    desired: () => desiredTargets(service?.current ?? [], time.clock()),
    services: () => service?.registeredServices ?? [],
    clock: time.clock,
    logger,
    timers: new FakeTimers(),
    sleep: async () => {},
  });
  service = new VisaService({
    maxLifetime: 24 * HOUR,
    ownHostname: "visa.example.com",
    zones: () => client.listZones(),
    store: new FlakyStore(),
    sync,
    logger,
    clock: time.clock,
    tickInterval: 24 * HOUR,
  });
  t.after(() => service?.stop());

  await service.start();
  await sync.idle();
  assert.deepEqual(client.ips, [], "startup removes what is not issued");

  const a = await service.issue({ target: "203.0.113.7", duration: HOUR, manual: false });
  const b = await service.issue({ target: "2001:DB8::/48", duration: 2 * HOUR, manual: true });
  assert.equal(a.synced && b.synced, true);
  assert.deepEqual(client.ips, ["2001:db8::/48", "203.0.113.7"]);

  await service.revoke(b.visa.id);
  assert.deepEqual(client.ips, ["203.0.113.7"]);

  time.now = T0 + HOUR;
  await service.tick();
  await sync.idle();
  assert.deepEqual(client.ips, []);

  const registered = await service.addService("nas.example.com");
  assert.equal(registered.synced, true);
  assert.deepEqual(
    client.rulesOf(ZONE_A.id).map((rule) => rule.expression),
    ['(http.host in {"nas.example.com"} and not ip.src in $supa_visa)'],
  );
  await service.removeService("nas.example.com");
  assert.deepEqual(client.rulesOf(ZONE_A.id), []);
});

test("registers and removes services, syncing after each change", async (t) => {
  const store = new FlakyStore();
  const { service, sync, entries } = setup(t, store);
  await service.start();

  const added = await service.addService("NAS.Example.com.");
  assert.deepEqual(added, {
    service: { hostname: "nas.example.com", zoneId: ZONE_A.id, zoneName: "example.com", addedAt: T0 },
    synced: true,
  });
  assert.deepEqual(store.states.at(-1)?.services, [added.service]);
  assert.deepEqual(entries.at(-1), {
    time: "2026-11-22T10:00:00.000Z",
    level: "info",
    event: "service.add",
    hostname: "nas.example.com",
    zoneName: "example.com",
  });

  await service.addService("git.example.net");
  assert.deepEqual(
    service.registeredServices.map((registered) => [registered.hostname, registered.zoneName]),
    [
      ["nas.example.com", "example.com"],
      ["git.example.net", "example.net"],
    ],
  );

  assert.equal(await service.removeService("missing.example.com"), undefined);
  assert.equal((await service.removeService("nas.example.com"))?.service.hostname, "nas.example.com");
  assert.deepEqual(
    service.registeredServices.map((registered) => registered.hostname),
    ["git.example.net"],
  );
  assert.deepEqual(sync.requests, ["startup", "services", "services", "services"]);
});

test("refuses service registrations that are invalid, before changing anything", async (t) => {
  const store = new FlakyStore();
  const { service, sync } = setup(t, store);
  await service.start();
  await service.addService("nas.example.com");
  const before = { states: store.states.length, requests: sync.requests.length };

  const cases: [string, RegExp][] = [
    ['a.example.com" or true or "', /must be a hostname/],
    ["a.example.com) or (true", /must be a hostname/],
    ["*.example.com", /must be a hostname/],
    [" a.example.com", /must be a hostname/],
    ["203.0.113.7", /must be a hostname/],
    ["visa.example.com", /own hostname/],
    ["VISA.example.com.", /own hostname/],
    ["nas.example.com", /already registered/],
    ["Nas.Example.Com", /already registered/],
    ["a.example.org", /not in a zone/],
  ];
  for (const [hostname, message] of cases) {
    await assert.rejects(service.addService(hostname), (error: unknown) => {
      assert.ok(error instanceof InvalidInputError, hostname);
      assert.match(error.message, message, hostname);
      return true;
    });
  }
  await assert.rejects(service.removeService('nas.example.com" or "'), InvalidInputError);
  assert.equal(store.states.length, before.states);
  assert.equal(sync.requests.length, before.requests);
});

test("refuses a service that would make the zone's rule too long, and caps the count", async (t) => {
  const store = new FlakyStore();
  const { service } = setup(t, store);
  await service.start();
  let added = 0;
  let refusal: unknown;
  for (let index = 0; index < 150 && refusal === undefined; index++) {
    try {
      await service.addService(`service-${index}-with-a-fairly-long-name.example.com`);
      added++;
    } catch (error) {
      refusal = error;
    }
  }
  assert.ok(refusal instanceof InvalidInputError);
  assert.match(refusal.message, /too long/);
  assert.ok(added > 10 && added < 150);

  const many = new FlakyStore(
    [],
    Array.from({ length: 100 }, (_, index) => ({
      hostname: `s${index}.example.net`,
      zoneId: ZONE_B.id,
      zoneName: ZONE_B.name,
      addedAt: T0,
    })),
  );
  const second = setup(t, many);
  await second.service.start();
  await assert.rejects(second.service.addService("one-more.example.com"), /at most 100/);
});

test("a failed save leaves services unchanged", async (t) => {
  const store = new FlakyStore();
  const { service, sync } = setup(t, store);
  await service.start();
  store.failures = 1;
  await assert.rejects(service.addService("nas.example.com"), /disk full/);
  assert.deepEqual(service.registeredServices, []);
  assert.deepEqual(sync.requests, ["startup"]);
});

test("revoking everything takes effect even if the save fails, and syncs", async (t) => {
  const store = new FlakyStore();
  const { service, sync, events } = setup(t, store);
  await service.start();
  await service.issue({ target: "203.0.113.7", duration: HOUR, manual: false });
  await service.issue({ target: "203.0.113.8", duration: HOUR, manual: false });
  store.failures = 1;
  assert.deepEqual(await service.revokeAll(), { revoked: 2, synced: true });
  assert.deepEqual(service.current, []);
  assert.equal(events().filter((event) => event === "visa.revoke").length, 2);
  assert.equal(sync.requests.at(-1), "revoke");
  await service.tick();
  assert.deepEqual(store.saved.at(-1), [], "saved on the next tick");
});

test("tells the owner about issues, revocations, expiries and service changes", async (t) => {
  const store = new FlakyStore();
  const time = new FakeClock(T0);
  const { logger } = recordingLogger(time.clock);
  const sent: Notification[] = [];
  const service = new VisaService({
    maxLifetime: 24 * HOUR,
    ownHostname: "visa.example.com",
    zones: async () => [ZONE_A],
    store,
    sync: new SharedRecordingSync(),
    logger,
    clock: time.clock,
    newId: sequentialIds(),
    tickInterval: 24 * HOUR,
    notify: (notification) => sent.push(notification),
  });
  t.after(() => service.stop());
  await service.start();
  const { visa } = await service.issue({ target: "203.0.113.7", duration: HOUR, manual: false });
  const other = await service.issue({ target: "203.0.113.8", duration: 2 * HOUR, manual: false });
  await service.revoke(other.visa.id);
  time.now = T0 + HOUR;
  await service.tick();
  await service.addService("nas.example.com");
  await service.removeService("nas.example.com");
  await service.issue({ target: "203.0.113.9", duration: HOUR, manual: false });
  const beforeRevokeAll = sent.length;
  await service.revokeAll();
  assert.deepEqual(sent, [
    { type: "issue", target: "203.0.113.7", expiresAt: T0 + HOUR },
    { type: "issue", target: "203.0.113.8", expiresAt: T0 + 2 * HOUR },
    { type: "revoke", target: "203.0.113.8" },
    { type: "expire", target: "203.0.113.7", issuedAt: visa.issuedAt, expiredAt: T0 + HOUR, renewals: 0 },
    { type: "service_add", hostname: "nas.example.com" },
    { type: "service_remove", hostname: "nas.example.com" },
    { type: "issue", target: "203.0.113.9", expiresAt: T0 + 2 * HOUR },
  ]);
  assert.equal(sent.length, beforeRevokeAll, "revoking everything is announced once, by the reset");
});

test("a revocation takes effect even when the data file cannot be written", async (t) => {
  const store = new FlakyStore();
  const { service, sync, events } = setup(t, store);
  await service.start();
  const { visa } = await service.issue({ target: "203.0.113.7", duration: HOUR, manual: false });
  store.failures = 1;
  assert.equal((await service.revoke(visa.id))?.visa.id, visa.id);
  assert.deepEqual(service.current, []);
  assert.equal(sync.requests.at(-1), "revoke");
  assert.equal(events().at(-2), "store.save_failed");
  await service.tick();
  assert.deepEqual(store.saved.at(-1), [], "saved on the next tick");
});

test("issues several targets in one save and one sync, or none", async (t) => {
  const store = new FlakyStore();
  const { service, sync } = setup(t, store);
  await service.start();
  const { visas, synced } = await service.issueAll([
    { target: "2001:db8:1:2::/64", duration: HOUR, manual: false },
    { target: "203.0.113.7", duration: HOUR, manual: false },
  ]);
  assert.equal(synced, true);
  assert.deepEqual(visas.map((visa) => visa.target), ["2001:db8:1:2::/64", "203.0.113.7"]);
  assert.equal(store.states.length, 1, "one save");
  assert.deepEqual(sync.requests, ["startup", "issue"]);

  await assert.rejects(service.issueAll([]), InvalidInputError);
  await assert.rejects(service.issueAll([1, 2, 3].map(() => ({ target: "203.0.113.7", duration: HOUR, manual: false }))), InvalidInputError);
  await assert.rejects(
    service.issueAll([
      { target: "203.0.113.8", duration: HOUR, manual: false },
      { target: "203.0.113.8/32", duration: HOUR, manual: false },
    ]),
    /must not repeat/,
  );
  await assert.rejects(
    service.issueAll([
      { target: "203.0.113.8", duration: HOUR, manual: false },
      { target: "nope", duration: HOUR, manual: false },
    ]),
    InvalidInputError,
  );
  assert.equal(service.current.length, 2, "a rejected batch adds nothing");
});
