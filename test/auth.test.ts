// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  AuthError,
  Authenticator,
  CHALLENGE_TTL,
  MAX_CHALLENGES_PER_SOURCE,
  MAX_PENDING_CHALLENGES,
  SETUP_CODE_TTL,
} from "../src/auth.ts";
import { StateKeeper } from "../src/state.ts";
import { FakeClock, MemoryStore, recordingLogger } from "./helpers.ts";
import { otherKey, SoftAuthenticator } from "./webauthn.ts";

const T0 = Date.parse("2026-11-22T10:00:00.000Z");
const RP_ID = "visa.example.com";
const ORIGIN = "https://visa.example.com";

type Action = { kind: string; target?: string };

async function setup(t: TestContext, setupToken?: string) {
  const time = new FakeClock(T0);
  const { logger, entries } = recordingLogger(time.clock);
  const store = new MemoryStore();
  const keeper = new StateKeeper(store, logger);
  await keeper.load();
  const auth = new Authenticator<Action>({ keeper, rpId: RP_ID, origin: ORIGIN, setupToken, logger, clock: time.clock });
  auth.start();
  const codes = () => entries.filter((entry) => entry.event === "setup.code").map((entry) => String(entry.code));
  const reasons = () => entries.filter((entry) => entry.event === "passkey.rejected").map((entry) => String(entry.reason));
  return { time, entries, store, keeper, auth, codes, reasons, t };
}

// Registers a first passkey through setup mode.
async function withPasskey(t: TestContext) {
  const context = await setup(t);
  const key = new SoftAuthenticator(RP_ID, ORIGIN);
  const ceremony = await context.auth.beginSetup(context.codes().at(-1));
  await context.auth.completeRegistration(ceremony.challengeId, key.register(ceremony.options));
  return { ...context, key };
}

const rejectsAuth = (promise: Promise<unknown>) => assert.rejects(promise, AuthError);

test("starts in setup mode and logs a readable one-time code", async (t) => {
  const { auth, codes, entries } = await setup(t);
  assert.equal(auth.setupState(), "active");
  assert.equal(codes().length, 1);
  assert.match(codes()[0] ?? "", /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  const entry = entries.find((candidate) => candidate.event === "setup.code");
  assert.equal(entry?.level, "warn");
  assert.equal(entry?.expiresAt, new Date(T0 + SETUP_CODE_TTL).toISOString());
});

test("accepts the code in either case and with or without the hyphen", async (t) => {
  for (const variant of [(code: string) => code, (code: string) => code.toLowerCase(), (code: string) => code.replace("-", "")]) {
    const { auth, codes } = await setup(t);
    const ceremony = await auth.beginSetup(variant(codes()[0] ?? ""));
    assert.equal(ceremony.options.rp.id, RP_ID);
    assert.equal(ceremony.options.authenticatorSelection?.userVerification, "required");
    assert.equal(ceremony.options.authenticatorSelection?.residentKey, "required");
    assert.equal(ceremony.options.attestation, "none");
  }
});

test("five wrong codes replace the code", async (t) => {
  const { auth, codes } = await setup(t);
  const first = codes()[0] ?? "";
  for (const wrong of ["AAAA-AAAA", `${first} `, `${first}-`, "", 12345678, null, "x".repeat(200)].slice(0, 4)) {
    await rejectsAuth(auth.beginSetup(wrong));
  }
  assert.equal(codes().length, 1, "still the same code after four mistakes");
  await rejectsAuth(auth.beginSetup("BBBB-BBBB"));
  assert.equal(codes().length, 2);
  await rejectsAuth(auth.beginSetup(first));
  await auth.beginSetup(codes()[1]);
});

test("a code expires after 10 minutes and is replaced when next needed", async (t) => {
  const { auth, codes, time } = await setup(t);
  const first = codes()[0];
  time.now = T0 + SETUP_CODE_TTL;
  await rejectsAuth(auth.beginSetup(first));
  assert.equal(codes().length, 2);
  await auth.beginSetup(codes()[1]);
});

test("registering the first passkey ends setup mode", async (t) => {
  const { auth, store, codes, entries } = await withPasskey(t);
  assert.equal(auth.setupState(), "inactive");
  assert.equal(store.state.passkeys.length, 1);
  assert.match(store.state.webauthnUserId ?? "", /^[A-Za-z0-9_-]{43}$/);
  const passkey = store.state.passkeys[0];
  assert.deepEqual(passkey?.transports, ["internal", "hybrid"]);
  assert.equal(passkey?.lastUsedAt, null);
  assert.deepEqual(entries.find((entry) => entry.event === "passkey.register"), {
    time: "2026-11-22T10:00:00.000Z",
    level: "info",
    event: "passkey.register",
    id: passkey?.id.slice(0, 8),
    total: 1,
  });
  await rejectsAuth(auth.beginSetup(codes()[0]));
});

test("refuses registrations that do not match this site or were not user-verified", async (t) => {
  const cases = [
    { origin: "https://evil.example.com" },
    { origin: "http://visa.example.com" },
    { rpId: "example.com" },
    { userVerified: false },
    { challenge: "c2VlbWluZ2x5LXZhbGlkLWNoYWxsZW5nZQ" },
    { type: "webauthn.get" },
  ];
  for (const overrides of cases) {
    const { auth, codes, store } = await setup(t);
    const ceremony = await auth.beginSetup(codes()[0]);
    const key = new SoftAuthenticator(RP_ID, ORIGIN);
    await rejectsAuth(auth.completeRegistration(ceremony.challengeId, key.register(ceremony.options, overrides)));
    assert.equal(store.state.passkeys.length, 0, JSON.stringify(overrides));
    // The challenge is gone even though the attempt failed.
    await rejectsAuth(auth.completeRegistration(ceremony.challengeId, key.register(ceremony.options)));
  }
});

test("a registration challenge expires after two minutes", async (t) => {
  const { auth, codes, time } = await setup(t);
  const ceremony = await auth.beginSetup(codes()[0]);
  time.now = T0 + CHALLENGE_TTL;
  await rejectsAuth(auth.completeRegistration(ceremony.challengeId, new SoftAuthenticator(RP_ID, ORIGIN).register(ceremony.options)));
});

test("only one setup can finish", async (t) => {
  const { auth, codes, store, reasons } = await setup(t);
  const first = await auth.beginSetup(codes()[0]);
  const second = await auth.beginSetup(codes()[0]);
  await auth.completeRegistration(first.challengeId, new SoftAuthenticator(RP_ID, ORIGIN).register(first.options));
  await rejectsAuth(auth.completeRegistration(second.challengeId, new SoftAuthenticator(RP_ID, ORIGIN).register(second.options)));
  assert.equal(store.state.passkeys.length, 1);
  assert.equal(reasons().at(-1), "setup already completed");
});

test("an action runs exactly as it was requested, once", async (t) => {
  const { auth, key, store, time, entries } = await withPasskey(t);
  const action = { kind: "issue", target: "203.0.113.7" };
  const ceremony = await auth.beginAction(action);
  assert.equal(ceremony.options.userVerification, "required");
  // Discoverable passkeys: nothing about them is handed to whoever asks for a challenge.
  assert.deepEqual(ceremony.options.allowCredentials, []);

  time.now = T0 + 1000;
  assert.equal(await auth.completeAction(ceremony.challengeId, key.authenticate(ceremony.options)), action);
  assert.equal(store.state.passkeys[0]?.counter, 1);
  assert.equal(store.state.passkeys[0]?.lastUsedAt, T0 + 1000);
  assert.equal(entries.at(-1)?.event, "passkey.use");

  await rejectsAuth(auth.completeAction(ceremony.challengeId, key.authenticate(ceremony.options)));
});

test("refuses authentications that are forged, replayed or out of place", async (t) => {
  const { auth, key, reasons, time } = await withPasskey(t);
  const stranger = new SoftAuthenticator(RP_ID, ORIGIN);
  const cases: [string, (options: { challenge: string }) => unknown][] = [
    ["wrong origin", (options) => key.authenticate(options, { origin: "https://evil.example.com" })],
    ["wrong rp id", (options) => key.authenticate(options, { rpId: "example.com" })],
    ["not user-verified", (options) => key.authenticate(options, { userVerified: false })],
    ["another challenge", (options) => key.authenticate(options, { challenge: "b3RoZXItY2hhbGxlbmdlLXZhbHVl" })],
    ["unknown credential", (options) => stranger.authenticate(options)],
    ["wrong signature", (options) => key.authenticate(options, { signingKey: otherKey() })],
    ["counter went back", (options) => key.authenticate(options, { counter: 1 })],
    ["registration type", (options) => key.authenticate(options, { type: "webauthn.create" })],
    ["not an object", () => "response"],
    ["missing fields", () => ({ id: key.id, rawId: key.id, type: "public-key", response: {} })],
    ["rawId differs", (options) => ({ ...key.authenticate(options), rawId: stranger.id })],
    ["non-base64url signature", (options) => {
      const response = key.authenticate(options);
      return { ...response, response: { ...response.response, signature: "not base64url!" } };
    }],
    ["oversized field", (options) => {
      const response = key.authenticate(options);
      return { ...response, response: { ...response.response, clientDataJSON: "A".repeat(20_000) } };
    }],
  ];
  // Move the counter forward first, so "counter went back" really goes back.
  const warmUp = await auth.beginAction({ kind: "warm-up" });
  await auth.completeAction(warmUp.challengeId, key.authenticate(warmUp.options, { counter: 5 }));

  for (const [name, respond] of cases) {
    const ceremony = await auth.beginAction({ kind: name });
    await assert.rejects(auth.completeAction(ceremony.challengeId, respond(ceremony.options)), AuthError, name);
  }
  assert.ok(reasons().some((reason) => reason.includes("counter")), "the counter check is the library's");

  const expired = await auth.beginAction({ kind: "late" });
  time.now = T0 + CHALLENGE_TTL;
  await rejectsAuth(auth.completeAction(expired.challengeId, key.authenticate(expired.options)));
  await rejectsAuth(auth.completeAction("not-a-challenge-id", {}));
  await rejectsAuth(auth.completeAction({ toString: () => "x" }, {}));
});

test("a challenge is good only for the kind of request it was made for", async (t) => {
  const { auth, key } = await withPasskey(t);
  const addPasskey = await auth.beginAddPasskey();
  await rejectsAuth(auth.completeAction(addPasskey.challengeId, key.authenticate(addPasskey.options)));
  const action = await auth.beginAction({ kind: "issue" });
  await rejectsAuth(auth.authorizeNewPasskey(action.challengeId, key.authenticate(action.options)));
  const another = await auth.beginAction({ kind: "issue" });
  await rejectsAuth(auth.completeRegistration(another.challengeId, key.register({ challenge: "x", user: { id: "AAAA" } })));
});

test("a second passkey needs the first one", async (t) => {
  const { auth, key, store } = await withPasskey(t);
  const proof = await auth.beginAddPasskey();
  const registration = await auth.authorizeNewPasskey(proof.challengeId, key.authenticate(proof.options));
  assert.deepEqual(registration.options.excludeCredentials?.map((credential) => credential.id), [key.id]);
  assert.equal(registration.options.user.id, store.state.webauthnUserId);

  const second = new SoftAuthenticator(RP_ID, ORIGIN);
  await auth.completeRegistration(registration.challengeId, second.register(registration.options));
  assert.equal(store.state.passkeys.length, 2);

  const again = await auth.beginAddPasskey();
  const duplicate = await auth.authorizeNewPasskey(again.challengeId, second.authenticate(again.options));
  await rejectsAuth(auth.completeRegistration(duplicate.challengeId, second.register(duplicate.options)));
  assert.equal(store.state.passkeys.length, 2);
});

test("keeps at most 1000 pending challenges, dropping the oldest", async (t) => {
  const { auth, key } = await withPasskey(t);
  const first = await auth.beginAction({ kind: "first" }, "203.0.113.1");
  for (let index = 0; index < MAX_PENDING_CHALLENGES; index++) await auth.beginAction({ kind: "spam" }, `source-${index}`);
  await rejectsAuth(auth.completeAction(first.challengeId, key.authenticate(first.options)));
});

test("a stranger cannot push out the owner's challenge", async (t) => {
  const { auth, key } = await withPasskey(t);
  const owner = await auth.beginAction({ kind: "revoke" }, "203.0.113.7");
  for (let index = 0; index < 100; index++) await auth.beginAction({ kind: "list" }, "198.51.100.66");
  assert.deepEqual(await auth.completeAction(owner.challengeId, key.authenticate(owner.options)), { kind: "revoke" });

  // A source that asks for more than its share pushes out its own oldest one.
  const mine = [];
  for (let index = 0; index <= MAX_CHALLENGES_PER_SOURCE; index++) mine.push(await auth.beginAction({ kind: `own-${index}` }, "203.0.113.7"));
  await rejectsAuth(auth.completeAction(mine[0]?.challengeId, key.authenticate(mine[0]!.options)));
  assert.deepEqual(await auth.completeAction(mine[1]?.challengeId, key.authenticate(mine[1]!.options)), { kind: "own-1" });
});

test("a registration racing a reset is refused", async (t) => {
  const { auth, key, store } = await withPasskey(t);
  const proof = await auth.beginAddPasskey();
  const registration = await auth.authorizeNewPasskey(proof.challengeId, key.authenticate(proof.options));
  const attacker = new SoftAuthenticator(RP_ID, ORIGIN);
  const action = await auth.beginAction({ kind: "issue" });

  const resetting = auth.reset();
  const sneaky = auth.completeRegistration(registration.challengeId, attacker.register(registration.options));
  const late = auth.completeAction(action.challengeId, key.authenticate(action.options));
  await resetting;
  await rejectsAuth(sneaky);
  await rejectsAuth(late);
  assert.deepEqual(store.state.passkeys, []);
  assert.equal(auth.setupState(), "active");
});

test("a challenge taken before a reset cannot complete after it", async (t) => {
  const { auth, key } = await withPasskey(t);
  const proof = await auth.beginAddPasskey();
  const registration = await auth.authorizeNewPasskey(proof.challengeId, key.authenticate(proof.options));
  await auth.reset();
  await rejectsAuth(auth.completeRegistration(registration.challengeId, new SoftAuthenticator(RP_ID, ORIGIN).register(registration.options)));
});

test("refuses responses made inside a cross-origin frame", async (t) => {
  const { auth, key, codes } = await withPasskey(t);
  const action = await auth.beginAction({ kind: "list" });
  await rejectsAuth(auth.completeAction(action.challengeId, key.authenticate(action.options, { crossOrigin: true })));
  const reset = await setup(t);
  const ceremony = await reset.auth.beginSetup(reset.codes()[0]);
  await assert.rejects(
    reset.auth.completeRegistration(ceremony.challengeId, new SoftAuthenticator(RP_ID, ORIGIN).register(ceremony.options, { crossOrigin: true })),
    AuthError,
  );
  assert.ok(codes().length > 0);
});

test("reset removes every passkey and returns to setup mode", async (t) => {
  const { auth, key, store, codes } = await withPasskey(t);
  const pending = await auth.beginAction({ kind: "issue" });
  await auth.reset();
  assert.deepEqual(store.state.passkeys, []);
  assert.equal(store.state.webauthnUserId, undefined);
  assert.equal(auth.setupState(), "active");
  assert.equal(codes().length, 2);
  await rejectsAuth(auth.completeAction(pending.challengeId, key.authenticate(pending.options)));
  await rejectsAuth(auth.beginAction({ kind: "issue" }));
});

test("a reset takes effect even when the data file cannot be written", async (t) => {
  const { auth, store, keeper } = await withPasskey(t);
  store.failures = 1;
  await auth.reset();
  assert.deepEqual(keeper.state.passkeys, []);
  assert.equal(store.state.passkeys.length, 1, "not saved yet");
  await keeper.exclusive(() => keeper.saveUnsaved());
  assert.deepEqual(store.state.passkeys, []);
});

test("a fixed SETUP_TOKEN never expires and locks after five mistakes", async (t) => {
  const { auth, codes, time } = await setup(t, "correct horse battery");
  assert.deepEqual(codes(), ["(SETUP_TOKEN)"]);
  time.now = T0 + 10 * SETUP_CODE_TTL;
  await auth.beginSetup("correct horse battery");
  await rejectsAuth(auth.beginSetup("CORRECT HORSE BATTERY"));
  for (let index = 0; index < 4; index++) await rejectsAuth(auth.beginSetup("wrong"));
  assert.equal(auth.setupState(), "locked");
  await rejectsAuth(auth.beginSetup("correct horse battery"));
  await auth.reset();
  assert.equal(auth.setupState(), "active");
});

test("tells the owner about every new passkey", async (t) => {
  const time = new FakeClock(T0);
  const { logger } = recordingLogger(time.clock);
  const keeper = new StateKeeper(new MemoryStore(), logger);
  await keeper.load();
  const sent: unknown[] = [];
  const auth = new Authenticator<Action>({ keeper, rpId: RP_ID, origin: ORIGIN, setupToken: "setup-token-for-test", logger, clock: time.clock, notify: (notification) => sent.push(notification) });
  auth.start();
  const key = new SoftAuthenticator(RP_ID, ORIGIN);
  const ceremony = await auth.beginSetup("setup-token-for-test");
  await auth.completeRegistration(ceremony.challengeId, key.register(ceremony.options));
  const proof = await auth.beginAddPasskey();
  const registration = await auth.authorizeNewPasskey(proof.challengeId, key.authenticate(proof.options));
  await auth.completeRegistration(registration.challengeId, new SoftAuthenticator(RP_ID, ORIGIN).register(registration.options));
  assert.deepEqual(sent, [
    { type: "passkey_register", total: 1 },
    { type: "passkey_register", total: 2 },
  ]);
});

test("a passkey check whose save is still running when a reset starts is refused", async (t) => {
  const { auth, key, store, codes } = await withPasskey(t);
  const save = store.save.bind(store);
  let release: (() => void) | undefined;
  store.save = async (state) => {
    await new Promise<void>((resolve) => (release = resolve));
    return save(state);
  };
  const proof = await auth.beginAddPasskey();
  const authorizing = auth.authorizeNewPasskey(proof.challengeId, key.authenticate(proof.options));
  while (release === undefined) await new Promise((resolve) => setImmediate(resolve));
  const resetting = auth.reset();
  store.save = save;
  release();
  await rejectsAuth(authorizing);
  await resetting;

  const owner = new SoftAuthenticator(RP_ID, ORIGIN);
  const setupCeremony = await auth.beginSetup(codes().at(-1));
  await auth.completeRegistration(setupCeremony.challengeId, owner.register(setupCeremony.options));
  assert.deepEqual(store.state.passkeys.map((passkey) => passkey.id), [owner.id]);
});

test("an action's passkey check is refused when a reset starts during its save", async (t) => {
  const { auth, key, store } = await withPasskey(t);
  const save = store.save.bind(store);
  let release: (() => void) | undefined;
  store.save = async (state) => {
    await new Promise<void>((resolve) => (release = resolve));
    return save(state);
  };
  const ceremony = await auth.beginAction({ kind: "issue" });
  const completing = auth.completeAction(ceremony.challengeId, key.authenticate(ceremony.options));
  while (release === undefined) await new Promise((resolve) => setImmediate(resolve));
  const resetting = auth.reset();
  store.save = save;
  release();
  await rejectsAuth(completing);
  await resetting;
});
