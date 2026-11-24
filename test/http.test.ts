// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import type { Action } from "../src/actions.ts";
import { Authenticator } from "../src/auth.ts";
import { Blocklist } from "../src/blocklist.ts";
import { HOUR } from "../src/duration.ts";
import { GeoLookup } from "../src/geo.ts";
import { createHandler, loadAssets } from "../src/http.ts";
import type { Notification } from "../src/notify.ts";
import { RateLimiter } from "../src/ratelimit.ts";
import { VisaService } from "../src/service.ts";
import { MemoryStore, RecordingSync, recordingLogger, ZONE_A } from "./helpers.ts";
import { SoftAuthenticator } from "./webauthn.ts";

const RP_ID = "visa.example.com";
const ORIGIN = "https://visa.example.com";
const PHONE = "203.0.113.7";
const ELSEWHERE = "198.51.100.9";

interface Reply {
  status: number;
  headers: Headers;
  body: any;
}

async function start(t: TestContext, limits = { burst: 10_000, refillEvery: 1 }) {
  const clock = () => Date.now();
  let zoneLookups = 0;
  const ipinfoCalls: string[] = [];
  const notifications: Notification[] = [];
  const { logger, entries } = recordingLogger(clock);
  const store = new MemoryStore();
  const sync = new RecordingSync();
  const service = new VisaService({
    maxLifetime: 24 * HOUR,
    ownHostname: RP_ID,
    zones: async () => {
      zoneLookups++;
      return [ZONE_A];
    },
    store,
    sync,
    logger,
    clock,
    tickInterval: 24 * HOUR,
  });
  await service.start();
  const authenticator = new Authenticator<Action>({
    keeper: service.keeper,
    rpId: RP_ID,
    origin: ORIGIN,
    setupToken: undefined,
    logger,
    clock,
    narrowsAccess: (action) => action.kind === "revoke",
  });
  authenticator.start();
  const blocklist = new Blocklist({ keeper: service.keeper, clock, logger, notify: (notification) => notifications.push(notification) });
  const server = createServer(
    createHandler({
      service,
      authenticator,
      rpId: RP_ID,
      origin: ORIGIN,
      durations: [HOUR, 4 * HOUR, 12 * HOUR],
      maxLifetime: 24 * HOUR,
      ipv6Prefix: 64,
      manualIssue: { enabled: true, minPrefixV4: 24, minPrefixV6: 48 },
      assets: await loadAssets(),
      limiter: new RateLimiter({ ...limits, maxSources: 10_000, clock }),
      blocklist,
      geo: new GeoLookup({
        token: "ipinfoToken12345",
        plan: "lite",
        clock,
        logger,
        fetch: (async (url: string) => {
          ipinfoCalls.push(url);
          return Response.json({ country_code: "TW", country: "Taiwan", asn: "AS3462", as_name: "Chunghwa Telecom" });
        }) as unknown as typeof fetch,
      }),
      logger,
      clock,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await service.stop();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(method: string, path: string, options: { body?: unknown; ip?: string | null; headers?: Record<string, string>; raw?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.ip !== null) headers["cf-connecting-ip"] = options.ip ?? PHONE;
    if (method === "POST") {
      headers.origin ??= ORIGIN;
      headers["content-type"] ??= "application/json";
    }
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(method === "POST" ? { body: options.raw ?? JSON.stringify(options.body ?? {}) } : {}),
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: response.status, headers: response.headers, body };
  }

  const key = new SoftAuthenticator(RP_ID, ORIGIN);
  const setupCode = () => String(entries.filter((entry) => entry.event === "setup.code").at(-1)?.code);

  async function completeSetup() {
    const begin = await call("POST", "/setup/begin", { body: { code: setupCode() } });
    assert.equal(begin.status, 200);
    const done = await call("POST", "/setup/complete", { body: { challengeId: begin.body.challengeId, credential: key.register(begin.body.options) } });
    assert.deepEqual([done.status, done.body], [200, { passkeys: 1 }]);
  }

  // Requests a challenge for `action`, then answers it with the passkey.
  async function act(action: unknown, ip = PHONE, executeIp = ip): Promise<Reply> {
    const challenge = await call("POST", "/api/challenge", { body: { action }, ip });
    if (challenge.status !== 200) return challenge;
    return call("POST", "/api/actions", {
      body: { challengeId: challenge.body.challengeId, credential: key.authenticate(challenge.body.options) },
      ip: executeIp,
    });
  }

  return { call, act, completeSetup, key, store, sync, entries, service, zoneLookups: () => zoneLookups, ipinfoCalls, blocklist, notifications };
}

test("serves the page and its files with strict headers, and nothing else", async (t) => {
  const { call } = await start(t);
  const page = await call("GET", "/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.match(page.body, /<title>Supa Visa<\/title>/);
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'; script-src 'self'/);
  assert.match(
    page.headers.get("content-security-policy") ?? "",
    /connect-src 'self' https:\/\/api\.ipify\.org https:\/\/api6\.ipify\.org https:\/\/api-ipv4\.ip\.sb https:\/\/api-ipv6\.ip\.sb https:\/\/ipv4\.icanhazip\.com https:\/\/ipv6\.icanhazip\.com https:\/\/ipv4\.cloudflare-dns\.com https:\/\/ipv6\.cloudflare-dns\.com https:\/\/v4\.ident\.me https:\/\/v6\.ident\.me;/,
    "only the two address lookups besides the page itself",
  );
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.equal(page.headers.get("cache-control"), "no-store");
  for (const path of ["/app.js", "/app.css", "/vendor/webauthn.js"]) assert.equal((await call("GET", path)).status, 200, path);
  for (const path of ["/index.html", "/../package.json", "/public/app.js", "/%2e%2e/package.json", "/node_modules/x", "/api/nope"]) {
    assert.equal((await call("GET", path)).status, 404, path);
  }
  assert.equal((await call("DELETE", "/api/actions")).status, 405);
  assert.equal((await call("PUT", "/")).status, 405);
});

test("first-time setup, then the setup routes are gone", async (t) => {
  const { call, completeSetup, key } = await start(t);
  assert.deepEqual((await call("GET", "/api/me")).body.setup, "active");
  assert.deepEqual((await call("GET", "/setup")).body, { state: "active" });
  const wrong = await call("POST", "/setup/begin", { body: { code: "AAAA-AAAA" } });
  assert.deepEqual([wrong.status, wrong.body], [401, { error: "auth_failed" }]);
  assert.equal((await call("POST", "/setup/begin", { body: { code: "x", extra: 1 } })).status, 400);

  await completeSetup();
  assert.equal((await call("GET", "/setup")).status, 404);
  assert.equal((await call("POST", "/setup/begin", { body: { code: "anything" } })).status, 404);
  assert.equal((await call("POST", "/setup/complete", { body: {} })).status, 404);
  assert.equal((await call("GET", "/api/me")).body.setup, "inactive");
  assert.ok(key.id);
});

test("issues for the IP that asked for the challenge, whoever answers it", async (t) => {
  const { call, act, completeSetup, sync } = await start(t);
  await completeSetup();
  const issued = await act({ kind: "issue", duration: "4h" }, PHONE, ELSEWHERE);
  assert.equal(issued.status, 200);
  assert.equal(issued.body.result.visas[0].target, PHONE);
  assert.equal(issued.body.result.synced, true);
  assert.equal(Date.parse(issued.body.result.visas[0].expiresAt) - Date.parse(issued.body.result.visas[0].issuedAt), 4 * HOUR);
  assert.deepEqual(issued.body.state.visas.map((visa: { target: string }) => visa.target), [PHONE]);
  assert.equal(sync.requests.at(-1), "issue");

  const mine = (await call("GET", "/api/me", { ip: PHONE })).body;
  assert.equal(mine.ip, PHONE);
  assert.equal(mine.visa.expiresAt, issued.body.result.visas[0].expiresAt);
  assert.deepEqual(mine.durations, ["1h", "4h", "12h"]);
  const theirs = (await call("GET", "/api/me", { ip: ELSEWHERE })).body;
  assert.deepEqual(Object.keys(theirs).sort(), ["durations", "ip", "manual", "maxLifetime", "setup", "visa"]);
  assert.equal(theirs.visa, null);
});

test("refuses malformed actions before asking for a passkey", async (t) => {
  const { call, completeSetup, store } = await start(t);
  await completeSetup();
  const bad: [unknown, string | null, string][] = [
    [{ kind: "issue", duration: "5h" }, PHONE, "action.duration"],
    [{ kind: "issue", duration: 14400000 }, PHONE, "action.duration"],
    [{ kind: "issue", duration: "4h", target: "0.0.0.0/0" }, PHONE, "action.target"],
    [{ kind: "issue", duration: "4h" }, null, "ip"],
    [{ kind: "issue", duration: "4h" }, "not an ip", "ip"],
    [{ kind: "issue", duration: "4h" }, "198.51.100.0/24", "ip"],
    [{ kind: "drop-tables" }, PHONE, "action.kind"],
    [{ kind: "__proto__" }, PHONE, "action.kind"],
    [{ kind: "revoke", id: "../../etc" }, PHONE, "action.id"],
    [{ kind: "list", extra: true }, PHONE, "action.extra"],
    [{ kind: "add-service", hostname: 'a.example.com" or true or "' }, PHONE, "action.hostname"],
    [{ kind: "add-service", hostname: "visa.example.com" }, PHONE, "hostname"],
    ["issue", PHONE, "action"],
  ];
  for (const [action, ip, field] of bad) {
    const reply = await call("POST", "/api/challenge", { body: { action }, ip });
    assert.equal(reply.status, 400, JSON.stringify(action));
    assert.equal(reply.body.error, "invalid_input");
    assert.equal(reply.body.field, field, JSON.stringify(action));
  }
  assert.equal((await call("POST", "/api/challenge", { body: { action: { kind: "list" }, more: 1 } })).status, 400);
  assert.deepEqual(store.state.visas, []);
});

test("revoke, list, services and a second passkey", async (t) => {
  const { call, act, completeSetup, store, key } = await start(t);
  await completeSetup();
  const issued = await act({ kind: "issue", duration: "1h" });

  const listed = await act({ kind: "list" });
  assert.deepEqual(listed.body.result, { kind: "list" });
  assert.equal(listed.body.state.passkeys, 1);
  assert.deepEqual(listed.body.state.sync, { lastSuccessAt: null, failingSince: null, lastError: null });

  const revoked = await act({ kind: "revoke", id: issued.body.result.visas[0].id });
  assert.equal(revoked.body.result.visa.target, PHONE);
  assert.deepEqual(revoked.body.state.visas, []);
  assert.equal((await act({ kind: "revoke", id: issued.body.result.visas[0].id })).status, 404);

  const added = await act({ kind: "add-service", hostname: "NAS.example.com" });
  assert.deepEqual(added.body.result, { kind: "add-service", hostname: "nas.example.com", synced: true });
  assert.deepEqual(added.body.state.services.map((service: { hostname: string }) => service.hostname), ["nas.example.com"]);
  assert.equal((await act({ kind: "add-service", hostname: "nas.example.com" })).status, 400);
  assert.equal((await act({ kind: "remove-service", hostname: "nas.example.com" })).body.result.hostname, "nas.example.com");
  assert.equal((await act({ kind: "remove-service", hostname: "nas.example.com" })).status, 404);

  const proof = await call("POST", "/api/passkeys/challenge", { body: {} });
  const authorized = await call("POST", "/api/passkeys/authorize", {
    body: { challengeId: proof.body.challengeId, credential: key.authenticate(proof.body.options) },
  });
  assert.equal(authorized.status, 200);
  const second = new SoftAuthenticator(RP_ID, ORIGIN);
  const registered = await call("POST", "/api/passkeys", {
    body: { challengeId: authorized.body.challengeId, credential: second.register(authorized.body.options) },
  });
  assert.deepEqual(registered.body, { passkeys: 2 });
  assert.equal(store.state.passkeys.length, 2);
  // Registering without first proving an existing passkey is not possible.
  const fresh = await call("POST", "/api/passkeys/challenge", { body: {} });
  const third = new SoftAuthenticator(RP_ID, ORIGIN);
  const noProof = await call("POST", "/api/passkeys", {
    body: { challengeId: fresh.body.challengeId, credential: third.register({ challenge: fresh.body.options.challenge, user: { id: "AAAAAAAAAAAAAAAAAAAAAA" } }) },
  });
  assert.equal(noProof.status, 401);
});

test("authentication failures say nothing more than that", async (t) => {
  const { call, completeSetup, key } = await start(t);
  await completeSetup();
  const challenge = await call("POST", "/api/challenge", { body: { action: { kind: "list" } } });
  const forged = { ...key.authenticate(challenge.body.options, { origin: "https://evil.example.com" }) };
  const reply = await call("POST", "/api/actions", { body: { challengeId: challenge.body.challengeId, credential: forged } });
  assert.deepEqual([reply.status, reply.body], [401, { error: "auth_failed" }]);
  const reused = await call("POST", "/api/actions", { body: { challengeId: challenge.body.challengeId, credential: key.authenticate(challenge.body.options) } });
  assert.deepEqual([reused.status, reused.body], [401, { error: "auth_failed" }]);
  assert.equal((await call("POST", "/api/actions", { body: { challengeId: 1, credential: null } })).status, 401);
});

test("refuses cross-site, non-JSON and oversized requests", async (t) => {
  const { call } = await start(t);
  const action = JSON.stringify({ action: { kind: "list" } });
  const cases: [Parameters<typeof call>[2], number][] = [
    [{ raw: action, headers: { origin: "https://evil.example.com" } }, 403],
    [{ raw: action, headers: { origin: "null" } }, 403],
    [{ raw: action, headers: { origin: `${ORIGIN}/` } }, 403],
    [{ raw: action, headers: { "content-type": "text/plain" } }, 415],
    [{ raw: action, headers: { "content-type": "application/x-www-form-urlencoded" } }, 415],
    [{ raw: "{not json" }, 400],
    [{ raw: "[]" }, 400],
    [{ raw: "null" }, 400],
    [{ raw: JSON.stringify({ action: { kind: "list" }, padding: "x".repeat(70_000) }) }, 413],
  ];
  for (const [options, status] of cases) {
    assert.equal((await call("POST", "/api/challenge", options)).status, status, JSON.stringify(options?.headers ?? options?.raw?.slice(0, 20)));
  }
  const noOrigin = await fetch(`http://127.0.0.1:1/`).catch(() => null);
  assert.equal(noOrigin, null);
});

test("reports health without details", async (t) => {
  const { call } = await start(t);
  const health = await call("GET", "/healthz");
  assert.deepEqual(health.body, { status: "ok" });
});

test("nothing before the passkey reaches Cloudflare or tells registered hostnames apart", async (t) => {
  const { call, act, completeSetup, zoneLookups } = await start(t);
  // In setup mode, before any passkey exists.
  for (let index = 0; index < 20; index++) {
    await call("POST", "/api/challenge", { body: { action: { kind: "add-service", hostname: `x${index}.example.com` } } });
  }
  assert.equal(zoneLookups(), 0);

  await completeSetup();
  await act({ kind: "add-service", hostname: "nas.example.com" });
  const lookupsAfterOwner = zoneLookups();
  const answers = [];
  for (const hostname of ["nas.example.com", "new.example.com", "elsewhere.example.org"]) {
    const reply = await call("POST", "/api/challenge", { body: { action: { kind: "add-service", hostname } } });
    answers.push([reply.status, Object.keys(reply.body).sort().join(","), reply.body.options?.allowCredentials]);
  }
  assert.equal(zoneLookups(), lookupsAfterOwner, "anonymous challenges cause no lookups");
  assert.deepEqual(answers, [
    [200, "challengeId,options", []],
    [200, "challengeId,options", []],
    [200, "challengeId,options", []],
  ]);
  // The checks still happen, after the passkey.
  assert.equal((await act({ kind: "add-service", hostname: "nas.example.com" })).status, 400);
  assert.equal((await act({ kind: "add-service", hostname: "elsewhere.example.org" })).status, 400);
});

test("limits requests per network: an IPv4 /24 or an IPv6 /48", async (t) => {
  const { call } = await start(t, { burst: 3, refillEvery: 60_000 });
  const post = (ip: string) => call("POST", "/api/challenge", { body: { action: { kind: "list" } }, ip });
  for (let index = 0; index < 3; index++) assert.notEqual((await post(`203.0.113.${index + 1}`)).status, 429);
  const limited = await post("203.0.113.254");
  assert.deepEqual([limited.status, limited.body], [429, { error: "rate_limited" }], "every address in the /24 shares one allowance");
  assert.notEqual((await post("203.0.112.255")).status, 429, "the /24 below is not affected");
  assert.notEqual((await post("203.0.114.0")).status, 429, "the /24 above is not affected");

  for (let index = 0; index < 3; index++) await post(`2001:db8:1:${index}::1`);
  assert.equal((await post("2001:db8:1:ffff:ffff::9")).status, 429, "another /64 in the same /48");
  assert.notEqual((await post("2001:db8:2::1")).status, 429, "another /48");
  assert.notEqual((await post("2001:db8:0:ffff::1")).status, 429, "the /48 below");
  assert.equal((await call("GET", "/api/me", { ip: "203.0.113.1" })).status, 200, "reading is not limited");
});

test("a neighbour in the same /24 shares the rate limit but cannot get the owner blocked", async (t) => {
  const { call, completeSetup, key } = await start(t);
  await completeSetup();
  const neighbour = "198.51.100.77";
  for (let index = 0; index < 4; index++) {
    const challenge = await call("POST", "/api/challenge", { body: { action: { kind: "list" } }, ip: neighbour });
    const forged = key.authenticate(challenge.body.options, { origin: "https://evil.example.com" });
    await call("POST", "/api/actions", { body: { challengeId: challenge.body.challengeId, credential: forged }, ip: neighbour });
  }
  assert.notEqual((await call("GET", "/api/me", { ip: neighbour })).body.blocked, undefined);

  const owner = "198.51.100.78";
  assert.equal((await call("GET", "/api/me", { ip: owner })).body.blocked, undefined);
  const challenge = await call("POST", "/api/challenge", { body: { action: { kind: "list" } }, ip: owner });
  assert.equal(challenge.status, 200);
  const answer = await call("POST", "/api/actions", { body: { challengeId: challenge.body.challengeId, credential: key.authenticate(challenge.body.options) }, ip: owner });
  assert.equal(answer.status, 200);
});

test("IPv6 is issued for the requester's /64 by default, or a chosen prefix", async (t) => {
  const { call, act, completeSetup } = await start(t);
  await completeSetup();
  const phone = "2001:db8:3206:7d24:a1b2:c3d4:e5f6:7788";

  const me = (await call("GET", "/api/me", { ip: phone })).body;
  assert.deepEqual([me.ipv6Prefixes, me.ipv6Prefix], [[128, 64, 56, 48], 64]);
  assert.equal("ipv6Prefixes" in (await call("GET", "/api/me", { ip: PHONE })).body, false, "not for IPv4");

  const issued = await act({ kind: "issue", duration: "1h" }, phone);
  assert.equal(issued.body.result.visas[0].target, "2001:db8:3206:7d24::/64");

  // A new temporary address on the same network is still let in.
  const later = (await call("GET", "/api/me", { ip: "2001:db8:3206:7d24:1111:2222:3333:4444" })).body;
  assert.equal(later.visa.target, "2001:db8:3206:7d24::/64");
  assert.equal((await call("GET", "/api/me", { ip: "2001:db8:3206:7d25::1" })).body.visa, null);

  for (const [prefix, target] of [[128, phone], [56, "2001:db8:3206:7d00::/56"], [48, "2001:db8:3206::/48"]] as const) {
    assert.equal((await act({ kind: "issue", duration: "1h", ipv6Prefix: prefix }, phone)).body.result.visas[0].target, target);
  }
});

test("refuses prefixes outside the list, and any prefix for IPv4", async (t) => {
  const { call, completeSetup } = await start(t);
  await completeSetup();
  const phone = "2001:db8:3206:7d24:a1b2:c3d4:e5f6:7788";
  for (const ipv6Prefix of [60, 0, 129, "64", 64.5, null, "2001:db8::/32"]) {
    const reply = await call("POST", "/api/challenge", { body: { action: { kind: "issue", duration: "1h", ipv6Prefix } }, ip: phone });
    assert.deepEqual([reply.status, reply.body.field], [400, "action.ipv6Prefix"], JSON.stringify(ipv6Prefix));
  }
  const ipv4 = await call("POST", "/api/challenge", { body: { action: { kind: "issue", duration: "1h", ipv6Prefix: 64 } }, ip: PHONE });
  assert.deepEqual([ipv4.status, ipv4.body.field], [400, "action.ipv6Prefix"]);
});

test("issues both address families at once with one passkey", async (t) => {
  const { act, completeSetup, sync, store } = await start(t);
  await completeSetup();
  const phoneV6 = "2001:db8:3206:7d24:a1b2:c3d4:e5f6:7788";
  const before = sync.requests.length;
  const fromV6 = await act({ kind: "issue", duration: "4h", otherAddress: "9.9.9.9" }, phoneV6);
  assert.deepEqual(fromV6.body.result.visas.map((visa: { target: string }) => visa.target), ["2001:db8:3206:7d24::/64", "9.9.9.9"]);
  assert.equal(sync.requests.length, before + 1, "one sync for both");
  assert.equal(store.state.visas.length, 2);

  const fromV4 = await act({ kind: "issue", duration: "1h", otherAddress: "2606:4700:4700::1111", ipv6Prefix: 56 }, "9.9.9.9");
  assert.deepEqual(fromV4.body.result.visas.map((visa: { target: string }) => visa.target), ["9.9.9.9", "2606:4700:4700::/56"]);
});

test("refuses reported addresses that are not a single public address of the other family", async (t) => {
  const { call, completeSetup, store } = await start(t);
  await completeSetup();
  const phoneV6 = "2001:db8:3206:7d24:a1b2:c3d4:e5f6:7788";
  const cases: [unknown, string][] = [
    ["2606:4700:4700::1111", phoneV6],
    ["8.8.8.8", "9.9.9.9"],
    ["10.0.0.1", phoneV6],
    ["100.64.0.1", phoneV6],
    ["192.168.1.1", phoneV6],
    ["127.0.0.1", phoneV6],
    ["169.254.1.1", phoneV6],
    ["203.0.113.9", phoneV6],
    ["224.0.0.1", phoneV6],
    ["255.255.255.255", phoneV6],
    ["0.0.0.0", phoneV6],
    ["9.9.9.0/24", phoneV6],
    ["fe80::1", "9.9.9.9"],
    ["fd00::1", "9.9.9.9"],
    ["2001:db8::1", "9.9.9.9"],
    ["::ffff:9.9.9.9", "9.9.9.9"],
    ["64:ff9b::909:909", "9.9.9.9"],
    ["ff02::1", "9.9.9.9"],
    ["::1", "9.9.9.9"],
    ["2606:4700::/32", "9.9.9.9"],
    [" 9.9.9.9", phoneV6],
    ["9.9.9.9\n", phoneV6],
    ['9.9.9.9" or true', phoneV6],
    [9, phoneV6],
    [["9.9.9.9"], phoneV6],
    [null, phoneV6],
    ["x".repeat(100), phoneV6],
  ];
  for (const [otherAddress, ip] of cases) {
    const reply = await call("POST", "/api/challenge", { body: { action: { kind: "issue", duration: "1h", otherAddress } }, ip });
    assert.deepEqual([reply.status, reply.body.field], [400, "action.otherAddress"], JSON.stringify(otherAddress));
  }
  assert.deepEqual(store.state.visas, []);
});

test("logs every request with the Cloudflare client IP, and never a secret", async (t) => {
  const { call, act, completeSetup, entries, key } = await start(t);
  const requests = () => entries.filter((entry) => entry.event === "http.request");
  await call("GET", "/", { headers: { "user-agent": "Mozilla/5.0 test", "cf-ipcountry": "TW" } });
  assert.deepEqual(
    { ...requests().at(-1), time: undefined, ms: undefined },
    { time: undefined, ms: undefined, level: "info", event: "http.request", method: "GET", path: "/", status: 200, ip: PHONE, country: "TW", ua: "Mozilla/5.0 test", result: "ok" },
  );

  await call("POST", "/setup/begin", { body: { code: "WRONG-CODE-123" } });
  assert.deepEqual([requests().at(-1)?.action, requests().at(-1)?.result, requests().at(-1)?.reason], ["setup.begin", "auth_failed", "wrong setup code"]);

  await completeSetup();
  const issued = await act({ kind: "issue", duration: "1h" }, ELSEWHERE);
  assert.equal(issued.status, 200);
  const [challenge, action] = requests().slice(-2);
  assert.deepEqual([challenge?.action, challenge?.ip, challenge?.targets], ["challenge.issue", ELSEWHERE, [ELSEWHERE]]);
  assert.deepEqual([action?.action, action?.result, action?.targets], ["action.issue", "ok", [ELSEWHERE]]);

  const forged = await call("POST", "/api/challenge", { body: { action: { kind: "list" } } });
  await call("POST", "/api/actions", { body: { challengeId: forged.body.challengeId, credential: key.authenticate(forged.body.options, { origin: "https://evil.example.com" }) } });
  assert.equal(requests().at(-1)?.result, "auth_failed");
  assert.match(String(requests().at(-1)?.reason), /origin/);

  await call("GET", "/api/me", { ip: "not-an-ip\" or true" });
  assert.deepEqual([requests().at(-1)?.ip, requests().at(-1)?.ipHeader], ["invalid", 'not-an-ip" or true']);
  await call("POST", "/api/challenge", { body: {}, headers: { origin: "https://evil.example.com" } });
  assert.equal(requests().at(-1)?.result, "bad_origin");

  // The container's own health check is not logged.
  const before = requests().length;
  await call("GET", "/healthz", { ip: null });
  assert.equal(requests().length, before);

  const everything = JSON.stringify(entries);
  assert.ok(!everything.includes("WRONG-CODE-123"), "setup code input");
  assert.ok(!everything.includes(forged.body.challengeId), "challenge id");
  assert.ok(!everything.includes("clientDataJSON") && !everything.includes("signature"), "passkey responses");
});

test("a note travels with the visas, and bad notes are refused before the passkey", async (t) => {
  const { call, act, completeSetup, store } = await start(t);
  await completeSetup();
  const issued = await act({ kind: "issue", duration: "1h", note: "飯店 Wi-Fi", otherAddress: "2606:4700:4700::1111" }, "9.9.9.9");
  assert.deepEqual(issued.body.result.visas.map((visa: { note: string }) => visa.note), ["飯店 Wi-Fi", "飯店 Wi-Fi"]);
  assert.deepEqual(store.state.visas.map((visa) => visa.note), ["飯店 Wi-Fi", "飯店 Wi-Fi"]);
  for (const note of ["", " padded", "x".repeat(41), "line\nbreak", "tab\there", 42, null, ["a"]]) {
    const reply = await call("POST", "/api/challenge", { body: { action: { kind: "issue", duration: "1h", note } } });
    assert.deepEqual([reply.status, reply.body.field], [400, "action.note"], JSON.stringify(note));
  }
});

test("lists passkeys only after a passkey check, and deletes all but the last", async (t) => {
  const { call, act, completeSetup, key, store } = await start(t);
  await completeSetup();
  // A second passkey.
  const proof = await call("POST", "/api/passkeys/challenge", { body: {} });
  const authorized = await call("POST", "/api/passkeys/authorize", { body: { challengeId: proof.body.challengeId, credential: key.authenticate(proof.body.options) } });
  const second = new SoftAuthenticator(RP_ID, ORIGIN);
  await call("POST", "/api/passkeys", { body: { challengeId: authorized.body.challengeId, credential: second.register(authorized.body.options) } });

  const listed = await act({ kind: "list" });
  assert.deepEqual(listed.body.state.passkeyList.map((passkey: { id: string }) => passkey.id), [key.id, second.id]);
  assert.equal(JSON.stringify((await call("GET", "/api/me")).body).includes(key.id), false);

  assert.equal((await act({ kind: "delete-passkey", id: "A".repeat(43) })).status, 404);
  assert.equal((await call("POST", "/api/challenge", { body: { action: { kind: "delete-passkey", id: "not base64url!" } } })).status, 400);

  // Deleting the passkey that signs the request is fine while another remains.
  const deleted = await act({ kind: "delete-passkey", id: key.id });
  assert.deepEqual(deleted.body.result, { kind: "delete-passkey", remaining: 1 });
  assert.deepEqual(store.state.passkeys.map((passkey) => passkey.id), [second.id]);

  // The last one stays.
  const challenge = await call("POST", "/api/challenge", { body: { action: { kind: "delete-passkey", id: second.id } } });
  const last = await call("POST", "/api/actions", { body: { challengeId: challenge.body.challengeId, credential: second.authenticate(challenge.body.options) } });
  assert.deepEqual([last.status, last.body.field], [400, "id"]);
  assert.equal(store.state.passkeys.length, 1);
});

test("looks up where issued addresses are only after a passkey check", async (t) => {
  const { call, act, completeSetup, ipinfoCalls } = await start(t);
  await completeSetup();
  const challenge = await call("POST", "/api/challenge", { body: { action: { kind: "issue", duration: "1h", otherAddress: "9.9.9.9" } }, ip: "2001:db8:3206:7d24::1" });
  await call("GET", "/api/me");
  assert.equal(challenge.status, 200);
  assert.deepEqual(ipinfoCalls, [], "nothing anonymous reaches ipinfo");

  const issued = await act({ kind: "issue", duration: "1h", otherAddress: "9.9.9.9" }, "2001:db8:3206:7d24::1");
  assert.deepEqual(issued.body.state.visas.map((visa: { geo: { country: string } }) => visa.geo?.country), ["Taiwan", "Taiwan"]);
  assert.deepEqual(ipinfoCalls.sort(), ["https://api.ipinfo.io/lite/2001%3Adb8%3A3206%3A7d24%3A%3A", "https://api.ipinfo.io/lite/9.9.9.9"]);
});

test("issues for a typed address or range, strictly checked (F-15)", async (t) => {
  const { call, act, completeSetup, store } = await start(t);
  await completeSetup();
  assert.equal((await call("GET", "/api/me")).body.manual, true);
  for (const [manualTarget, expected] of [
    ["9.9.9.9", "9.9.9.9"],
    ["9.9.9.0/24", "9.9.9.0/24"],
    ["2606:4700:4700::1111", "2606:4700:4700::1111"],
    ["2606:4700:4700::/48", "2606:4700:4700::/48"],
  ] as const) {
    const issued = await act({ kind: "issue", duration: "1h", manualTarget, note: "office" });
    assert.deepEqual(issued.body.result.visas.map((visa: { target: string; manual: boolean }) => [visa.target, visa.manual]), [[expected, true]], manualTarget);
  }
  assert.ok(!store.state.visas.some((visa) => visa.target === PHONE), "the requester's own address is not added");

  for (const manualTarget of [
    "9.0.0.0/8",
    "0.0.0.0/0",
    "::/0",
    "2606:4700::/32",
    "9.9.9.5/24",
    "10.0.0.0/24",
    "192.168.1.1",
    "100.64.0.0/24",
    "203.0.113.0/24",
    "224.0.0.0/24",
    "fe80::/64",
    "2001:db8::/48",
    "not an ip",
    "9.9.9.9 or true",
    42,
  ]) {
    const reply = await call("POST", "/api/challenge", { body: { action: { kind: "issue", duration: "1h", manualTarget } } });
    assert.deepEqual([reply.status, reply.body.field], [400, "action.manualTarget"], JSON.stringify(manualTarget));
  }
  for (const extra of [{ otherAddress: "9.9.9.9" }, { ipv6Prefix: 64 }]) {
    const reply = await call("POST", "/api/challenge", { body: { action: { kind: "issue", duration: "1h", manualTarget: "8.8.8.8", ...extra } } });
    assert.deepEqual([reply.status, reply.body.field], [400, "action.manualTarget"]);
  }
});

test("revoking works while the data file cannot be written; other actions do not", async (t) => {
  const { act, completeSetup, store, service } = await start(t);
  await completeSetup();
  const issued = await act({ kind: "issue", duration: "1h" });
  store.failures = 1_000;
  const refused = await act({ kind: "issue", duration: "4h" });
  assert.equal(refused.status, 500);
  const revoked = await act({ kind: "revoke", id: issued.body.result.visas[0].id });
  assert.equal(revoked.status, 200);
  assert.deepEqual(service.current, []);
  store.failures = 0;
});

test("log lines stay short and printable whatever the request carries", async (t) => {
  const { call, entries } = await start(t);
  const requests = () => entries.filter((entry) => entry.event === "http.request");
  const reply = await call("POST", "/api/challenge", { raw: JSON.stringify({ ["k".repeat(60_000)]: 1 }) });
  assert.deepEqual([reply.status, reply.body.field], [400, "(unknown)"]);
  assert.ok(JSON.stringify(requests().at(-1)).length < 1_000);
  await call("GET", "/", { headers: { "user-agent": "evil\u009b[2J\u00e9" }, ip: "203.0.113.4\u0085x" });
  assert.deepEqual([requests().at(-1)?.ua, requests().at(-1)?.ipHeader], ["evil?[2J?", "203.0.113.4?x"]);
});

test("a source with more than three failed sign-ins is blocked from every POST (blocklist)", async (t) => {
  const { call, entries, notifications } = await start(t);
  const attacker = "198.51.100.66";
  for (let index = 0; index < 3; index++) {
    assert.equal((await call("POST", "/setup/begin", { body: { code: "AAAA-AAAA" }, ip: attacker })).status, 401);
  }
  assert.equal((await call("GET", "/api/me", { ip: attacker })).body.blocked, undefined);
  assert.equal((await call("POST", "/setup/begin", { body: { code: "BBBB-BBBB" }, ip: attacker })).status, 401, "the fourth failure itself is answered as usual");

  const blocked = await call("POST", "/setup/begin", { body: { code: "CCCC-CCCC" }, ip: attacker });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error, "blocked");
  assert.ok(Date.parse(blocked.body.until) > Date.now() + 6 * 24 * HOUR);
  assert.equal(entries.filter((entry) => entry.event === "http.request").at(-1)?.result, "blocked");
  for (let index = 0; index < 30; index++) {
    assert.equal((await call("POST", "/api/challenge", { body: { action: { kind: "list" } }, ip: attacker })).status, 403, "never rate limited instead");
  }
  const me = await call("GET", "/api/me", { ip: attacker });
  assert.deepEqual([me.status, me.body.blocked?.until], [200, blocked.body.until]);
  assert.equal((await call("GET", "/", { ip: attacker })).status, 200);
  assert.deepEqual(notifications.filter((notification) => notification.type === "block"), [{ type: "block", source: attacker, days: 7, failures: 4 }]);

  assert.equal((await call("POST", "/setup/begin", { body: { code: "AAAA-AAAA" } })).status, 401, "other sources are not affected");
});

test("only failures that tested a credential count towards a block", async (t) => {
  const { call, completeSetup, key } = await start(t);
  await completeSetup();
  const neighbour = "198.51.100.77";
  for (let index = 0; index < 10; index++) {
    const lost = await call("POST", "/api/actions", { body: { challengeId: "A".repeat(22), credential: {} }, ip: neighbour });
    assert.equal(lost.status, 401);
  }
  assert.equal((await call("GET", "/api/me", { ip: neighbour })).body.blocked, undefined);
  for (let index = 0; index < 4; index++) {
    const challenge = await call("POST", "/api/challenge", { body: { action: { kind: "list" } }, ip: neighbour });
    const forged = key.authenticate(challenge.body.options, { origin: "https://evil.example.com" });
    assert.equal((await call("POST", "/api/actions", { body: { challengeId: challenge.body.challengeId, credential: forged }, ip: neighbour })).status, 401);
  }
  assert.notEqual((await call("GET", "/api/me", { ip: neighbour })).body.blocked, undefined);
});
