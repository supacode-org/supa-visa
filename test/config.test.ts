// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Config, ConfigError, type Env, loadConfig } from "../src/config.ts";
import { DAY, HOUR, MINUTE } from "../src/duration.ts";

const REQUIRED: Env = {
  CF_API_TOKEN: "token-value-that-must-stay-secret",
  CF_ACCOUNT_ID: "account",
  CF_LIST_ID: "list",
  RP_ID: "visa.example.com",
  ORIGIN: "https://visa.example.com",
};

function load(extra: Env = {}): Config {
  return loadConfig({ ...REQUIRED, ...extra });
}

function errorsOf(env: Env): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    return error.errors;
  }
  assert.fail("expected a ConfigError");
}

function rejects(extra: Env, variable: string): void {
  const errors = errorsOf({ ...REQUIRED, ...extra });
  assert.ok(
    errors.some((error) => error.startsWith(variable)),
    `${variable} should be rejected, got ${JSON.stringify(errors)}`,
  );
}

test("applies the defaults", () => {
  assert.deepEqual(load(), {
    cloudflare: {
      apiToken: "token-value-that-must-stay-secret",
      accountId: "account",
      listId: "list",
      baseUrl: "https://api.cloudflare.com/client/v4",
    },
    rpId: "visa.example.com",
    origin: "https://visa.example.com",
    dataFile: "./data/visa.json",
    logMaxBytes: 64 * 1024 * 1024,
    listen: { host: "127.0.0.1", port: 8787 },
    setupToken: undefined,
    maxLifetime: 24 * HOUR,
    durations: [1 * HOUR, 4 * HOUR, 12 * HOUR],
    renewal: { enabled: false, activeWindow: 15 * MINUTE, renewBy: 2 * HOUR, ignorePaths: [] },
    ipv6Prefix: 64,
    manualIssue: { enabled: false, minPrefixV4: 24, minPrefixV6: 48 },
    heartbeatUrl: undefined,
    ipinfo: undefined,
    notify: {
      barkServer: "https://api.day.app",
      barkDeviceKeys: [],
      events: ["issue", "manual_issue", "expire", "revoke", "renew", "block", "sync_fail"],
      lang: "zh-Hant",
      timeZone: undefined,
    },
  });
});

test("reads every optional variable", () => {
  const config = load({
    DATA_FILE: "/data/visa.json",
    LISTEN: "[::1]:9000",
    SETUP_TOKEN: "4F7K-92QX",
    MAX_LIFETIME: "7d",
    DURATIONS: " 30m , 2h ,, 7d ",
    AUTO_RENEW: "true",
    ACTIVE_WINDOW: "5m",
    RENEW_BY: "1h",
    RENEW_IGNORE_PATHS: "/healthz, /ping",
    IPV6_PREFIX: "56",
    MANUAL_ISSUE_ENABLED: "true",
    MANUAL_MIN_PREFIX_V4: "28",
    MANUAL_MIN_PREFIX_V6: "56",
    HEARTBEAT_URL: "https://heartbeat.example.com/ping",
    BARK_SERVER: "https://bark.example.com",
    BARK_DEVICE_KEYS: "a,b",
    NOTIFY_EVENTS: "issue,expire,renew,issue",
    NOTIFY_LANG: "en",
    TZ: "Asia/Taipei",
  });
  assert.equal(config.dataFile, "/data/visa.json");
  assert.deepEqual(config.listen, { host: "::1", port: 9000 });
  assert.equal(config.setupToken, "4F7K-92QX");
  assert.equal(config.maxLifetime, 7 * DAY);
  assert.deepEqual(config.durations, [30 * MINUTE, 2 * HOUR, 7 * DAY]);
  assert.deepEqual(config.renewal, {
    enabled: true,
    activeWindow: 5 * MINUTE,
    renewBy: 1 * HOUR,
    ignorePaths: ["/healthz", "/ping"],
  });
  assert.equal(config.ipv6Prefix, 56);
  assert.deepEqual(config.manualIssue, { enabled: true, minPrefixV4: 28, minPrefixV6: 56 });
  assert.equal(config.heartbeatUrl, "https://heartbeat.example.com/ping");
  assert.deepEqual(config.notify, {
    barkServer: "https://bark.example.com",
    barkDeviceKeys: ["a", "b"],
    events: ["issue", "expire", "renew"],
    lang: "en",
    timeZone: "Asia/Taipei",
  });
});

test("lists every missing required variable at once", () => {
  assert.deepEqual(errorsOf({ CF_API_TOKEN: "  " }), [
    "CF_API_TOKEN is required",
    "CF_ACCOUNT_ID is required",
    "CF_LIST_ID is required",
    "RP_ID is required",
    "ORIGIN is required",
  ]);
});

test("never puts a value into an error message", () => {
  const errors = errorsOf({ ...REQUIRED, CF_ACCOUNT_ID: "", LISTEN: REQUIRED.CF_API_TOKEN, ORIGIN: "nope" });
  assert.ok(errors.length >= 2);
  assert.ok(errors.every((error) => !error.includes("token-value-that-must-stay-secret")));
});

test("MAX_LIFETIME cannot be turned off or exceed 7 days", () => {
  rejects({ MAX_LIFETIME: "0" }, "MAX_LIFETIME");
  rejects({ MAX_LIFETIME: "off" }, "MAX_LIFETIME");
  rejects({ MAX_LIFETIME: "8d" }, "MAX_LIFETIME");
  rejects({ MAX_LIFETIME: "169h" }, "MAX_LIFETIME");
  assert.equal(load({ MAX_LIFETIME: "168h" }).maxLifetime, 7 * DAY);
});

test("DURATIONS must be valid, distinct and within MAX_LIFETIME", () => {
  rejects({ DURATIONS: "1h,48h" }, "DURATIONS");
  rejects({ DURATIONS: "4h,2h", MAX_LIFETIME: "3h" }, "DURATIONS");
  rejects({ DURATIONS: "1h,60m" }, "DURATIONS");
  rejects({ DURATIONS: "1h,soon" }, "DURATIONS");
  rejects({ DURATIONS: " , " }, "DURATIONS");
  assert.deepEqual(load({ DURATIONS: "24h" }).durations, [24 * HOUR]);
});

test("ORIGIN must be an https origin matching RP_ID", () => {
  rejects({ ORIGIN: "https://visa.example.com/login" }, "ORIGIN");
  rejects({ ORIGIN: "http://visa.example.com" }, "ORIGIN");
  rejects({ ORIGIN: "https://other.example.net" }, "ORIGIN");
  rejects({ ORIGIN: "https://evilvisa.example.com" }, "ORIGIN");
  rejects({ ORIGIN: "visa.example.com" }, "ORIGIN");
  assert.equal(load({ ORIGIN: "https://visa.example.com/" }).origin, "https://visa.example.com");
  assert.equal(load({ RP_ID: "example.com" }).origin, "https://visa.example.com");
  assert.equal(load({ RP_ID: "Visa.Example.com" }).rpId, "visa.example.com");
  assert.equal(load({ RP_ID: "localhost", ORIGIN: "http://localhost:8787" }).origin, "http://localhost:8787");
});

test("addresses need a host and a valid port", () => {
  rejects({ LISTEN: "127.0.0.1" }, "LISTEN");
  rejects({ LISTEN: "127.0.0.1:0" }, "LISTEN");
  rejects({ LISTEN: "127.0.0.1:65536" }, "LISTEN");
  rejects({ LISTEN: "::1:8787" }, "LISTEN");
  rejects({ LISTEN: "[not-ipv6]:8787" }, "LISTEN");
  assert.deepEqual(load({ LISTEN: "0.0.0.0:80" }).listen, { host: "0.0.0.0", port: 80 });
});

test("rejects malformed booleans, integers, choices and URLs", () => {
  rejects({ IPV6_PREFIX: "60" }, "IPV6_PREFIX");
  rejects({ IPV6_PREFIX: "/64" }, "IPV6_PREFIX");
  rejects({ MANUAL_ISSUE_ENABLED: "TRUE" }, "MANUAL_ISSUE_ENABLED");
  rejects({ MANUAL_MIN_PREFIX_V4: "33" }, "MANUAL_MIN_PREFIX_V4");
  rejects({ MANUAL_MIN_PREFIX_V4: "7" }, "MANUAL_MIN_PREFIX_V4");
  rejects({ MANUAL_MIN_PREFIX_V6: "11" }, "MANUAL_MIN_PREFIX_V6");
  rejects({ MANUAL_MIN_PREFIX_V6: "129" }, "MANUAL_MIN_PREFIX_V6");
  rejects({ MANUAL_MIN_PREFIX_V6: "4.5" }, "MANUAL_MIN_PREFIX_V6");
  rejects({ NOTIFY_EVENTS: "issue,renewal" }, "NOTIFY_EVENTS");
  rejects({ AUTO_RENEW: "yes" }, "AUTO_RENEW");
  rejects({ NOTIFY_LANG: "zh-Hans" }, "NOTIFY_LANG");
  rejects({ BARK_SERVER: "ftp://bark.example.com" }, "BARK_SERVER");
  rejects({ HEARTBEAT_URL: "not a url" }, "HEARTBEAT_URL");
  rejects({ RENEW_BY: "soon" }, "RENEW_BY");
  rejects({ RENEW_IGNORE_PATHS: "/a b" }, "RENEW_IGNORE_PATHS");
  rejects({ RENEW_IGNORE_PATHS: Array.from({ length: 21 }, (_, i) => `/p${i}`).join(",") }, "RENEW_IGNORE_PATHS");
  rejects({ RENEW_IGNORE_PATHS: "healthz" }, "RENEW_IGNORE_PATHS");
  rejects({ SETUP_TOKEN: "short" }, "SETUP_TOKEN");
  rejects({ ACTIVE_WINDOW: "0m" }, "ACTIVE_WINDOW");
  rejects({ CF_API_BASE_URL: "file:///etc/passwd" }, "CF_API_BASE_URL");
  rejects({ TZ: "Mars/Olympus" }, "TZ");
  rejects({ IPINFO_TOKEN: "short" }, "IPINFO_TOKEN");
  rejects({ IPINFO_TOKEN: "abc123def456&x=1" }, "IPINFO_TOKEN");
  rejects({ IPINFO_TOKEN: "abcdef123456", IPINFO_PLAN: "pro" }, "IPINFO_PLAN");
  assert.deepEqual(load({ IPINFO_TOKEN: "abcdef123456" }).ipinfo, { token: "abcdef123456", plan: "lite" });
  for (const size of ["0", "0MB", "512KB", "11GB", "64", "64mb", "64 MB", "-1MB"]) rejects({ LOG_MAX_SIZE: size }, "LOG_MAX_SIZE");
  assert.equal(load({ LOG_MAX_SIZE: "1GB" }).logMaxBytes, 1024 ** 3);
  rejects({ BARK_DEVICE_KEYS: "good,bad key" }, "BARK_DEVICE_KEYS");
  rejects({ BARK_DEVICE_KEYS: 'a","title":"x' }, "BARK_DEVICE_KEYS");
  assert.equal(load({ CF_API_BASE_URL: "http://127.0.0.1:9999/client/v4/" }).cloudflare.baseUrl, "http://127.0.0.1:9999/client/v4");
});
