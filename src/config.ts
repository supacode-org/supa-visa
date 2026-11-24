// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import { isIP } from "node:net";
import { DAY, parseDuration } from "./duration.ts";
import { type Ipv6Prefix, IPV6_PREFIXES } from "./ip.ts";

export type NotifyEvent = "issue" | "manual_issue" | "expire" | "revoke" | "renew" | "block" | "sync_fail";
export type NotifyLang = "zh-Hant" | "en";

export interface Address {
  host: string;
  port: number;
}

export interface Config {
  cloudflare: { apiToken: string; accountId: string; listId: string; baseUrl: string };
  rpId: string;
  origin: string;
  dataFile: string;
  // Total size of the rotating log files kept next to the data file.
  logMaxBytes: number;
  listen: Address;
  setupToken: string | undefined;
  maxLifetime: number;
  durations: number[];
  renewal: {
    // Checkpoint renewal from Cloudflare's request analytics.
    enabled: boolean;
    activeWindow: number;
    renewBy: number;
    ignorePaths: string[];
  };
  // The default prefix when issuing for an IPv6 address.
  ipv6Prefix: Ipv6Prefix;
  manualIssue: { enabled: boolean; minPrefixV4: number; minPrefixV6: number };
  heartbeatUrl: string | undefined;
  // The owner's ipinfo token for showing where issued addresses are; optional.
  ipinfo: { token: string; plan: "lite" | "core" } | undefined;
  notify: {
    barkServer: string;
    barkDeviceKeys: string[];
    events: NotifyEvent[];

    lang: NotifyLang;
    // An IANA time zone for times in notifications; undefined means UTC.
    timeZone: string | undefined;
  };
}

export type Env = Readonly<Record<string, string | undefined>>;

export class ConfigError extends Error {
  readonly errors: readonly string[];

  constructor(errors: readonly string[]) {
    super(`Invalid configuration:\n${errors.map((error) => `- ${error}`).join("\n")}`);
    this.name = "ConfigError";
    this.errors = errors;
  }
}

export const MAX_LIFETIME_LIMIT = 7 * DAY;
const NOTIFY_EVENTS: readonly NotifyEvent[] = ["issue", "manual_issue", "expire", "revoke", "renew", "block", "sync_fail"];
const NOTIFY_LANGS: readonly NotifyLang[] = ["zh-Hant", "en"];

// Error messages name the variable and the rule only, never the value, so a
// misplaced token cannot end up in the logs.
export function loadConfig(env: Env): Config {
  const errors: string[] = [];
  const reader = new Reader(env, errors);

  const apiToken = reader.required("CF_API_TOKEN");
  const accountId = reader.required("CF_ACCOUNT_ID");
  const listId = reader.required("CF_LIST_ID");
  const rpId = reader.required("RP_ID")?.toLowerCase();
  const origin = reader.origin("ORIGIN", rpId);

  const setupToken = reader.optional("SETUP_TOKEN");
  if (setupToken !== undefined && setupToken.length < 8) {
    errors.push("SETUP_TOKEN must be at least 8 characters");
  }

  const maxLifetime = reader.duration("MAX_LIFETIME", "24h");
  if (maxLifetime !== undefined && maxLifetime > MAX_LIFETIME_LIMIT) {
    errors.push("MAX_LIFETIME must not exceed 7d");
  }
  const durations = reader.durationList("DURATIONS", "1h,4h,12h");
  if (durations !== undefined && maxLifetime !== undefined && durations.some((value) => value > maxLifetime)) {
    errors.push("DURATIONS must not exceed MAX_LIFETIME");
  }

  const barkDeviceKeys = reader.list("BARK_DEVICE_KEYS", "");
  if (barkDeviceKeys.some((key) => !/^[A-Za-z0-9_-]{1,128}$/.test(key))) {
    errors.push("BARK_DEVICE_KEYS entries must be 1 to 128 letters, digits, - or _");
  }

  const ignorePaths = reader.list("RENEW_IGNORE_PATHS", "");
  // The paths go into an analytics query as values, never into its text; still,
  // only plain path characters are accepted.
  if (ignorePaths.some((path) => !/^\/[A-Za-z0-9._~\/-]{0,200}$/.test(path)) || ignorePaths.length > 20) {
    errors.push("RENEW_IGNORE_PATHS entries must be plain paths starting with /, at most 20");
  }

  const config = {
    cloudflare: {
      apiToken,
      accountId,
      listId,
      baseUrl: reader.httpUrl("CF_API_BASE_URL", "https://api.cloudflare.com/client/v4")?.replace(/\/$/, ""),
    },
    rpId,
    origin,
    dataFile: reader.optional("DATA_FILE") ?? "./data/visa.json",
    logMaxBytes: reader.size("LOG_MAX_SIZE", "64MB", 1024 ** 2, 10 * 1024 ** 3),
    listen: reader.address("LISTEN", "127.0.0.1:8787"),
    setupToken,
    maxLifetime,
    durations,
    renewal: {
      enabled: reader.boolean("AUTO_RENEW", false),
      activeWindow: reader.duration("ACTIVE_WINDOW", "15m"),
      renewBy: reader.duration("RENEW_BY", "2h"),
      ignorePaths,
    },
    ipv6Prefix: reader.ipv6Prefix("IPV6_PREFIX", 64),
    manualIssue: {
      enabled: reader.boolean("MANUAL_ISSUE_ENABLED", false),
      minPrefixV4: reader.integer("MANUAL_MIN_PREFIX_V4", 24, 8, 32),
      minPrefixV6: reader.integer("MANUAL_MIN_PREFIX_V6", 48, 12, 128),
    },
    heartbeatUrl: reader.optional("HEARTBEAT_URL") === undefined ? undefined : reader.httpUrl("HEARTBEAT_URL", ""),
    ipinfo: (() => {
      const token = reader.optional("IPINFO_TOKEN");
      const plan = reader.choice("IPINFO_PLAN", "lite", ["lite", "core"] as const);
      if (token === undefined) return undefined;
      if (!/^[A-Za-z0-9]{8,128}$/.test(token)) {
        errors.push("IPINFO_TOKEN must be 8 to 128 letters and digits");
        return undefined;
      }
      return plan === undefined ? undefined : { token, plan };
    })(),
    notify: {
      barkServer: reader.httpUrl("BARK_SERVER", "https://api.day.app"),
      barkDeviceKeys,
      events: reader.choices("NOTIFY_EVENTS", NOTIFY_EVENTS.join(","), NOTIFY_EVENTS),
      lang: reader.choice("NOTIFY_LANG", "zh-Hant", NOTIFY_LANGS),
      timeZone: reader.timeZone("TZ"),
    },
  };

  if (errors.length > 0) throw new ConfigError(errors);
  // Every undefined left in a required field above has pushed an error, so the cast is safe here.
  return config as Config;
}

class Reader {
  private readonly env: Env;
  private readonly errors: string[];

  constructor(env: Env, errors: string[]) {
    this.env = env;
    this.errors = errors;
  }

  optional(name: string): string | undefined {
    const value = this.env[name]?.trim();
    return value === undefined || value === "" ? undefined : value;
  }

  required(name: string): string | undefined {
    const value = this.optional(name);
    if (value === undefined) this.errors.push(`${name} is required`);
    return value;
  }

  private valueOr(name: string, fallback: string): string {
    return this.optional(name) ?? fallback;
  }

  list(name: string, fallback: string): string[] {
    return this.valueOr(name, fallback)
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");
  }

  duration(name: string, fallback: string): number | undefined {
    const value = parseDuration(this.valueOr(name, fallback));
    if (value === undefined) this.errors.push(`${name} must be a duration such as 30m, 4h or 7d`);
    return value;
  }

  durationList(name: string, fallback: string): number[] | undefined {
    const items = this.list(name, fallback);
    const values = items.map(parseDuration);
    if (items.length === 0 || values.some((value) => value === undefined)) {
      this.errors.push(`${name} must be a comma-separated list of durations such as 1h,4h,12h`);
      return undefined;
    }
    const durations = values as number[];
    if (new Set(durations).size !== durations.length) {
      this.errors.push(`${name} must not contain the same duration twice`);
    }
    return durations;
  }

  boolean(name: string, fallback: boolean): boolean | undefined {
    const value = this.optional(name);
    if (value === undefined) return fallback;
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
    this.errors.push(`${name} must be true, false, 1 or 0`);
    return undefined;
  }

  integer(name: string, fallback: number, min: number, max: number): number | undefined {
    const value = this.optional(name);
    if (value === undefined) return fallback;
    const number = /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
    if (!(number >= min && number <= max)) {
      this.errors.push(`${name} must be an integer from ${min} to ${max}`);
      return undefined;
    }
    return number;
  }

  choice<T extends string>(name: string, fallback: T, allowed: readonly T[]): T | undefined {
    const value = this.valueOr(name, fallback);
    if ((allowed as readonly string[]).includes(value)) return value as T;
    this.errors.push(`${name} must be one of ${allowed.join(", ")}`);
    return undefined;
  }

  choices<T extends string>(name: string, fallback: string, allowed: readonly T[]): T[] | undefined {
    const items = this.list(name, fallback);
    if (items.some((item) => !(allowed as readonly string[]).includes(item))) {
      this.errors.push(`${name} entries must be among ${allowed.join(", ")}`);
      return undefined;
    }
    return [...new Set(items)] as T[];
  }

  address(name: string, fallback: string): Address | undefined {
    const value = this.valueOr(name, fallback);
    const match = /^(?:\[([^\]]+)\]|([^:\[\]]+)):([0-9]+)$/.exec(value);
    const host = match?.[1] ?? match?.[2];
    const port = Number(match?.[3]);
    const hostValid = match?.[1] !== undefined ? isIP(match[1]) === 6 : host !== undefined;
    if (!hostValid || host === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
      this.errors.push(`${name} must be host:port or [IPv6]:port with a port from 1 to 65535`);
      return undefined;
    }
    return { host, port };
  }

  ipv6Prefix(name: string, fallback: Ipv6Prefix): Ipv6Prefix | undefined {
    const value = this.optional(name);
    if (value === undefined) return fallback;
    const prefix = IPV6_PREFIXES.find((candidate) => String(candidate) === value);
    if (prefix === undefined) this.errors.push(`${name} must be one of ${IPV6_PREFIXES.join(", ")}`);
    return prefix;
  }

  size(name: string, fallback: string, min: number, max: number): number | undefined {
    const value = this.valueOr(name, fallback);
    const match = /^([1-9][0-9]{0,6})(KB|MB|GB)$/.exec(value);
    const bytes = match === null ? Number.NaN : Number(match[1]) * 1024 ** { KB: 1, MB: 2, GB: 3 }[match[2] as "KB" | "MB" | "GB"];
    if (!(bytes >= min && bytes <= max)) {
      this.errors.push(`${name} must be a size such as 64MB, from 1MB to 10GB`);
      return undefined;
    }
    return bytes;
  }

  timeZone(name: string): string | undefined {
    const value = this.optional(name);
    if (value === undefined) return undefined;
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return value;
    } catch {
      this.errors.push(`${name} must be a time zone name such as Asia/Taipei`);
      return undefined;
    }
  }

  httpUrl(name: string, fallback: string): string | undefined {
    const value = this.valueOr(name, fallback);
    const url = URL.parse(value);
    if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
      this.errors.push(`${name} must be an http or https URL`);
      return undefined;
    }
    return value;
  }

  origin(name: string, rpId: string | undefined): string | undefined {
    const value = this.required(name);
    if (value === undefined) return undefined;
    const url = URL.parse(value);
    if (url === null || url.origin !== value.replace(/\/$/, "").toLowerCase()) {
      this.errors.push(`${name} must be a scheme and host only, such as https://visa.example.com`);
      return undefined;
    }
    const isLocalhost = url.hostname === "localhost";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost)) {
      this.errors.push(`${name} must use https (http is allowed only for localhost)`);
      return undefined;
    }
    // WebAuthn accepts an origin whose host is the RP ID or one of its subdomains.
    if (rpId !== undefined && url.hostname !== rpId && !url.hostname.endsWith(`.${rpId}`)) {
      this.errors.push(`${name} host must be RP_ID or a subdomain of it`);
      return undefined;
    }
    return url.origin;
  }
}
