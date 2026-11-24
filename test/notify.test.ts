// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import type { NotifyEvent } from "../src/config.ts";
import { HOUR, MINUTE } from "../src/duration.ts";
import { BarkChannel, type Channel, compose, formatTime, type Message, type Notification, Notifier, RETRY_DELAYS } from "../src/notify.ts";
import { FakeClock, recordingLogger } from "./helpers.ts";

const T = Date.parse("2026-11-22T06:30:00.000Z");
const ALL: NotifyEvent[] = ["issue", "manual_issue", "expire", "revoke", "sync_fail"];

class RecordingChannel implements Channel {
  sent: Message[] = [];
  failures = 0;
  attempts = 0;

  async send(message: Message): Promise<void> {
    this.attempts++;
    if (this.failures > 0) {
      this.failures--;
      throw new Error("offline");
    }
    this.sent.push(message);
  }
}

function notifier(channel: Channel | undefined, events = ALL) {
  const { logger, entries } = recordingLogger(new FakeClock(T).clock);
  const sleeps: number[] = [];
  const instance = new Notifier({ channel, events, lang: "zh-Hant", timeZone: "Asia/Taipei", logger, sleep: async (delay) => void sleeps.push(delay) });
  return { notifier: instance, entries, sleeps };
}

const EVERY: Notification[] = [
  { type: "issue", target: "203.0.113.7", expiresAt: T },
  { type: "manual_issue", target: "198.51.100.0/24", expiresAt: T },
  { type: "expire", target: "203.0.113.7", issuedAt: T - 6 * HOUR, expiredAt: T, renewals: 2 },
  { type: "revoke", target: "203.0.113.7" },
  { type: "sync_fail" },
  { type: "sync_recovered" },
  { type: "passkey_register", total: 2 },
  { type: "passkeys_reset", revokedVisas: 3 },
  { type: "passkey_delete", remaining: 1 },
  { type: "service_add", hostname: "nas.example.com" },
  { type: "service_remove", hostname: "nas.example.com" },
];

test("messages in Traditional Chinese and English", () => {
  const zh = EVERY.map((notification) => compose(notification, "zh-Hant", "Asia/Taipei"));
  assert.deepEqual(
    zh.map((message) => [message.body, message.level]),
    [
      ["已簽發 203.0.113.7，到期 14:30", "active"],
      ["已手動簽發 198.51.100.0/24，到期 14:30", "timeSensitive"],
      ["203.0.113.7 已過期，共使用 6 小時（含 2 次續簽）", "passive"],
      ["203.0.113.7 已被撤銷", "passive"],
      ["Cloudflare 同步已失敗 10 分鐘，過期的 IP 可能還沒移除", "timeSensitive"],
      ["Cloudflare 同步已恢復", "passive"],
      ["已註冊新的 passkey，共 2 把", "timeSensitive"],
      ["所有 passkey 已重置，回到設定模式（撤銷了 3 張簽證）", "timeSensitive"],
      ["已刪除一把 passkey，剩 1 把", "timeSensitive"],
      ["已登記服務 nas.example.com", "timeSensitive"],
      ["已刪除服務 nas.example.com，它不再受保護", "timeSensitive"],
    ],
  );
  assert.ok(zh.every((message) => message.title === "Supa Visa"));
  const en = EVERY.map((notification) => compose(notification, "en", "Asia/Taipei").body);
  assert.equal(en[0], "Issued 203.0.113.7, expires 14:30");
  assert.equal(en[1], "Manually issued 198.51.100.0/24, expires 14:30");
  assert.equal(en[2], "203.0.113.7 expired after 6 h (2 renewals)");
  assert.equal(en[7], "All passkeys were reset; Supa Visa is back in setup mode (3 visas revoked)");
  assert.equal(compose({ type: "issue", target: "203.0.113.7", expiresAt: T, note: "飯店 Wi-Fi" }, "zh-Hant", "Asia/Taipei").body, "已簽發 203.0.113.7，到期 14:30（飯店 Wi-Fi）");
  assert.equal(compose({ type: "expire", target: "203.0.113.7", issuedAt: T - 45 * MINUTE, expiredAt: T, renewals: 0 }, "zh-Hant", undefined).body, "203.0.113.7 已過期，共使用 45 分鐘");
});

test("renewal messages and their switch", async () => {
  const body = (notification: Notification, lang: "zh-Hant" | "en") => compose(notification, lang, "Asia/Taipei");
  const renewed: Notification = { type: "renew", target: "2001:db8::/64", expiresAt: T };
  assert.deepEqual([body(renewed, "zh-Hant").body, body(renewed, "zh-Hant").level], ["已續簽 2001:db8::/64，到期 14:30", "passive"]);
  assert.equal(body(renewed, "en").body, "Renewed 2001:db8::/64, now expires 14:30");
  const failed = (reason: "hard_limit" | "no_activity" | "error", minutesLeft: number): Notification => ({
    type: "renew_failed",
    target: "203.0.113.7",
    reason,
    minutesLeft,
  });
  assert.deepEqual(
    [body(failed("hard_limit", 10), "zh-Hant"), body(failed("no_activity", 1), "zh-Hant"), body(failed("error", 1), "zh-Hant")].map((message) => [message.body, message.level]),
    [
      ["203.0.113.7 未續簽（已到硬上限，請用 passkey 重新簽發），將在 10 分鐘後過期", "timeSensitive"],
      ["203.0.113.7 未續簽（最近沒有活動），將在 1 分鐘後過期", "timeSensitive"],
      ["203.0.113.7 未續簽（無法查詢活動），將在 1 分鐘後過期", "timeSensitive"],
    ],
  );
  assert.equal(body(failed("no_activity", 1), "en").body, "203.0.113.7 was not renewed (no recent activity was seen) and expires in 1 min");

  const channel = new RecordingChannel();
  const { notifier: instance } = notifier(channel, ["issue"]);
  instance.notify(renewed);
  instance.notify(failed("error", 1));
  await instance.idle();
  assert.deepEqual(channel.sent, [], "both follow the renew switch");
});

test("block messages", () => {
  const blocked: Notification = { type: "block", source: "2001:db8::/64", days: 7, failures: 4 };
  assert.deepEqual(
    [compose(blocked, "zh-Hant", undefined).body, compose(blocked, "zh-Hant", undefined).level],
    ["2001:db8::/64 一天內 4 次認證失敗，已封鎖 7 天", "timeSensitive"],
  );
  assert.equal(compose(blocked, "en", undefined).body, "2001:db8::/64 was blocked for 7 days after 4 failed sign-ins in a day");
});

test("times follow TZ, and say UTC without it", () => {
  assert.equal(formatTime(T, "zh-Hant", "Asia/Taipei"), "14:30");
  assert.equal(formatTime(T, "en", "Europe/London"), "06:30");
  assert.equal(formatTime(T, "en", undefined), "06:30 UTC");
});

test("sends only enabled events, and passkey and service changes always", async () => {
  const channel = new RecordingChannel();
  const { notifier: instance } = notifier(channel, ["issue"]);
  for (const notification of EVERY) instance.notify(notification);
  await instance.idle();
  assert.deepEqual(
    channel.sent.map((message) => message.body.split(" ")[0]),
    ["已簽發", "已註冊新的", "所有", "已刪除一把", "已登記服務", "已刪除服務"],
    "manual_issue is switched off here",
  );
});

test("does nothing without a channel", async () => {
  const { notifier: instance } = notifier(undefined);
  instance.notify(EVERY[0] as Notification);
  await instance.idle();
});

test("retries three times, then logs without the device key", async () => {
  const channel = new RecordingChannel();
  channel.failures = 10;
  const { notifier: instance, entries, sleeps } = notifier(channel);
  instance.notify({ type: "revoke", target: "203.0.113.7" });
  await instance.idle();
  assert.equal(channel.attempts, 4);
  assert.deepEqual(sleeps, RETRY_DELAYS);
  assert.deepEqual(entries.at(-1), { time: "2026-11-22T06:30:00.000Z", level: "warn", event: "notify.failed", type: "revoke", error: "offline" });

  const flaky = new RecordingChannel();
  flaky.failures = 2;
  const second = notifier(flaky);
  second.notifier.notify({ type: "revoke", target: "203.0.113.7" });
  await second.notifier.idle();
  assert.equal(flaky.sent.length, 1);
  assert.ok(!second.entries.some((entry) => entry.event === "notify.failed"));
});

test("notify returns at once even when the channel never answers", () => {
  const { notifier: instance } = notifier({ send: () => new Promise<void>(() => {}) });
  const started = performance.now();
  instance.notify(EVERY[0] as Notification);
  assert.ok(performance.now() - started < 50);
});

test("Bark: one JSON request per device, with the documented fields", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json({ code: 200, message: "success", timestamp: 1 });
  }) as unknown as typeof fetch;
  const bark = new BarkChannel({ server: "https://bark.example.com/", deviceKeys: ["keyA", "keyB"], url: "https://visa.example.com", fetch: fetchImpl });
  await bark.send({ title: "Supa Visa", body: "已簽發 203.0.113.7", level: "active" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.url, "https://bark.example.com/push");
  assert.equal(calls[0]?.init.method, "POST");
  assert.deepEqual((calls[0]?.init.headers as Record<string, string>)["content-type"], "application/json; charset=utf-8");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    device_key: "keyA",
    title: "Supa Visa",
    body: "已簽發 203.0.113.7",
    level: "active",
    group: "Supa Visa",
    url: "https://visa.example.com",
  });
  assert.equal(JSON.parse(String(calls[1]?.init.body)).device_key, "keyB");
});

test("Bark: failures are errors that do not reveal the key", async () => {
  const cases: [() => Promise<Response>, RegExp][] = [
    [async () => new Response("nope", { status: 500 }), /HTTP 500/],
    [async () => Response.json({ code: 400, message: "failed to get device token" }), /code 400/],
    [async () => Response.json({ code: 400 }, { status: 400 }), /HTTP 400/],
    [async () => { throw new TypeError("fetch failed"); }, /could not be reached/],
    [async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }, /timed out/],
  ];
  for (const [respond, message] of cases) {
    const bark = new BarkChannel({ server: "https://bark.example.com", deviceKeys: ["secretKey123"], url: "https://visa.example.com", fetch: respond as unknown as typeof fetch });
    await assert.rejects(bark.send({ title: "t", body: "b", level: "passive" }), (error: Error) => {
      assert.match(error.message, message);
      assert.ok(!error.message.includes("secretKey123"));
      return true;
    });
  }
  const ok = new BarkChannel({ server: "https://bark.example.com", deviceKeys: ["k"], url: "https://visa.example.com", fetch: (async () => new Response("", { status: 200 })) as unknown as typeof fetch });
  await ok.send({ title: "t", body: "b", level: "passive" });
});
