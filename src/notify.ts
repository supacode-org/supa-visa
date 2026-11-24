// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import type { NotifyEvent, NotifyLang } from "./config.ts";
import { HOUR, MINUTE, SECOND } from "./duration.ts";
import { errorMessage, type Logger } from "./log.ts";

export type Notification =
  | { readonly type: "issue"; readonly target: string; readonly expiresAt: number; readonly note?: string }
  | { readonly type: "manual_issue"; readonly target: string; readonly expiresAt: number; readonly note?: string }
  | { readonly type: "expire"; readonly target: string; readonly issuedAt: number; readonly expiredAt: number; readonly renewals: number }
  | { readonly type: "revoke"; readonly target: string }
  | { readonly type: "renew"; readonly target: string; readonly expiresAt: number }
  | {
      readonly type: "renew_failed";
      readonly target: string;
      readonly reason: "hard_limit" | "no_activity" | "error";
      readonly minutesLeft: number;
    }
  | { readonly type: "block"; readonly source: string; readonly days: number; readonly failures: number }
  | { readonly type: "sync_fail" }
  | { readonly type: "sync_recovered" }
  | { readonly type: "passkey_register"; readonly total: number }
  | { readonly type: "passkeys_reset"; readonly revokedVisas: number }
  | { readonly type: "passkey_delete"; readonly remaining: number }
  | { readonly type: "service_add"; readonly hostname: string }
  | { readonly type: "service_remove"; readonly hostname: string };

export type Notify = (notification: Notification) => void;

export type Level = "active" | "timeSensitive" | "passive";

export interface Message {
  readonly title: string;
  readonly body: string;
  readonly level: Level;
}

export interface Channel {
  // Throws when the message could not be delivered.
  send(message: Message): Promise<void>;
}

// Which NOTIFY_EVENTS switch controls a notification; undefined means it is always sent.
const SWITCH: Record<Notification["type"], NotifyEvent | undefined> = {
  issue: "issue",
  manual_issue: "manual_issue",
  expire: "expire",
  revoke: "revoke",
  renew: "renew",
  renew_failed: "renew",
  block: "block",
  sync_fail: "sync_fail",
  sync_recovered: "sync_fail",
  passkey_register: undefined,
  passkeys_reset: undefined,
  passkey_delete: undefined,
  service_add: undefined,
  service_remove: undefined,
};

export const RETRY_DELAYS = [2 * SECOND, 4 * SECOND, 8 * SECOND];

export interface NotifierOptions {
  readonly channel: Channel | undefined;
  readonly events: readonly NotifyEvent[];
  readonly lang: NotifyLang;
  readonly timeZone: string | undefined;
  readonly logger: Logger;
  readonly sleep?: (delay: number) => Promise<void>;
}

export class Notifier {
  private readonly options: NotifierOptions;
  private readonly pending = new Set<Promise<void>>();

  constructor(options: NotifierOptions) {
    this.options = options;
  }

  // Returns at once: nothing that issues, expires or syncs waits for a notification.
  readonly notify: Notify = (notification) => {
    const { channel, events } = this.options;
    if (channel === undefined) return;
    const toggle = SWITCH[notification.type];
    if (toggle !== undefined && !events.includes(toggle)) return;
    const message = compose(notification, this.options.lang, this.options.timeZone);
    const delivery = this.deliver(channel, message, notification.type).finally(() => this.pending.delete(delivery));
    this.pending.add(delivery);
  };

  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all(this.pending);
  }

  private async deliver(channel: Channel, message: Message, type: string): Promise<void> {
    const sleep = this.options.sleep ?? ((delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay)));
    for (let attempt = 0; ; attempt++) {
      try {
        await channel.send(message);
        return;
      } catch (error) {
        const delay = RETRY_DELAYS[attempt];
        if (delay === undefined) {
          this.options.logger.warn("notify.failed", { type, error: errorMessage(error) });
          return;
        }
        await sleep(delay);
      }
    }
  }
}

export function formatTime(time: number, lang: NotifyLang, timeZone: string | undefined): string {
  const text = new Intl.DateTimeFormat(lang === "en" ? "en-GB" : "zh-TW", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timeZone ?? "UTC",
  }).format(time);
  return timeZone === undefined ? `${text} UTC` : text;
}

export function formatSpan(milliseconds: number, lang: NotifyLang): string {
  const hours = Math.floor(milliseconds / HOUR);
  const minutes = Math.round((milliseconds % HOUR) / MINUTE);
  if (lang === "en") {
    if (hours === 0) return `${minutes} min`;
    return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
  }
  if (hours === 0) return `${minutes} 分鐘`;
  return minutes === 0 ? `${hours} 小時` : `${hours} 小時 ${minutes} 分鐘`;
}

export function compose(notification: Notification, lang: NotifyLang, timeZone: string | undefined): Message {
  const en = lang === "en";
  const time = (value: number) => formatTime(value, lang, timeZone);
  const message = (body: string, level: Level): Message => ({ title: "Supa Visa", body, level });
  switch (notification.type) {
    case "issue":
      return message(
        en
          ? `Issued ${notification.target}, expires ${time(notification.expiresAt)}${notification.note === undefined ? "" : ` (${notification.note})`}`
          : `已簽發 ${notification.target}，到期 ${time(notification.expiresAt)}${notification.note === undefined ? "" : `（${notification.note}）`}`,
        "active",
      );
    case "manual_issue":
      return message(
        en
          ? `Manually issued ${notification.target}, expires ${time(notification.expiresAt)}${notification.note === undefined ? "" : ` (${notification.note})`}`
          : `已手動簽發 ${notification.target}，到期 ${time(notification.expiresAt)}${notification.note === undefined ? "" : `（${notification.note}）`}`,
        "timeSensitive",
      );
    case "expire": {
      const span = formatSpan(notification.expiredAt - notification.issuedAt, lang);
      const renewals = notification.renewals;
      return message(
        en
          ? `${notification.target} expired after ${span}${renewals > 0 ? ` (${renewals} renewal${renewals === 1 ? "" : "s"})` : ""}`
          : `${notification.target} 已過期，共使用 ${span}${renewals > 0 ? `（含 ${renewals} 次續簽）` : ""}`,
        "passive",
      );
    }
    case "revoke":
      return message(en ? `${notification.target} was revoked` : `${notification.target} 已被撤銷`, "passive");
    case "renew":
      return message(
        en
          ? `Renewed ${notification.target}, now expires ${time(notification.expiresAt)}`
          : `已續簽 ${notification.target}，到期 ${time(notification.expiresAt)}`,
        "passive",
      );
    case "renew_failed": {
      const left = notification.minutesLeft;
      const why = {
        hard_limit: en ? "it reached its hard limit; issue it again with your passkey" : "已到硬上限，請用 passkey 重新簽發",
        no_activity: en ? "no recent activity was seen" : "最近沒有活動",
        error: en ? "activity could not be checked" : "無法查詢活動",
      }[notification.reason];
      return message(
        en
          ? `${notification.target} was not renewed (${why}) and expires in ${left} min`
          : `${notification.target} 未續簽（${why}），將在 ${left} 分鐘後過期`,
        "timeSensitive",
      );
    }
    case "block":
      return message(
        en
          ? `${notification.source} was blocked for ${notification.days} days after ${notification.failures} failed sign-ins in a day`
          : `${notification.source} 一天內 ${notification.failures} 次認證失敗，已封鎖 ${notification.days} 天`,
        "timeSensitive",
      );
    case "sync_fail":
      return message(
        en
          ? "Syncing with Cloudflare has failed for 10 minutes; expired IPs may not have been removed"
          : "Cloudflare 同步已失敗 10 分鐘，過期的 IP 可能還沒移除",
        "timeSensitive",
      );
    case "sync_recovered":
      return message(en ? "Syncing with Cloudflare works again" : "Cloudflare 同步已恢復", "passive");
    case "passkey_register":
      return message(
        en
          ? `A new passkey was registered (${notification.total} in total)`
          : `已註冊新的 passkey，共 ${notification.total} 把`,
        "timeSensitive",
      );
    case "passkeys_reset": {
      const revoked = notification.revokedVisas;
      return message(
        en
          ? `All passkeys were reset; Supa Visa is back in setup mode${revoked > 0 ? ` (${revoked} visas revoked)` : ""}`
          : `所有 passkey 已重置，回到設定模式${revoked > 0 ? `（撤銷了 ${revoked} 張簽證）` : ""}`,
        "timeSensitive",
      );
    }
    case "passkey_delete":
      return message(
        en ? `A passkey was deleted (${notification.remaining} left)` : `已刪除一把 passkey，剩 ${notification.remaining} 把`,
        "timeSensitive",
      );
    case "service_add":
      return message(en ? `Registered service ${notification.hostname}` : `已登記服務 ${notification.hostname}`, "timeSensitive");
    case "service_remove":
      return message(
        en
          ? `Removed service ${notification.hostname}; it is no longer protected`
          : `已刪除服務 ${notification.hostname}，它不再受保護`,
        "timeSensitive",
      );
  }
}

export interface BarkOptions {
  readonly server: string;
  readonly deviceKeys: readonly string[];
  // Opened when the notification is tapped.
  readonly url: string;
  readonly fetch?: typeof fetch;
  readonly timeout?: number;
}

export class BarkChannel implements Channel {
  private readonly options: BarkOptions;

  constructor(options: BarkOptions) {
    this.options = options;
  }

  // One request per device: sending several keys at once needs bark-server 2.1.9
  // or later, and a self-hosted server may be older. Fails if any device failed.
  async send(message: Message): Promise<void> {
    const results = await Promise.allSettled(this.options.deviceKeys.map((key) => this.sendTo(key, message)));
    const failures = results.filter((result) => result.status === "rejected").length;
    if (failures > 0) throw new Error(`${failures} of ${results.length} devices did not receive the notification: ${errorMessage((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason)}`);
  }

  private async sendTo(deviceKey: string, message: Message): Promise<void> {
    const fetchImpl = this.options.fetch ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(`${this.options.server.replace(/\/$/, "")}/push`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          device_key: deviceKey,
          title: message.title,
          body: message.body,
          level: message.level,
          group: "Supa Visa",
          url: this.options.url,
        }),
        signal: AbortSignal.timeout(this.options.timeout ?? 10 * SECOND),
      });
    } catch (error) {
      // Not the URL: it may carry a key in a self-hosted path.
      throw new Error(error instanceof Error && error.name === "TimeoutError" ? "Bark timed out" : "Bark could not be reached");
    }
    let code: unknown;
    try {
      code = ((await response.json()) as { code?: unknown }).code;
    } catch {}
    if (!response.ok || (code !== undefined && code !== 200)) {
      throw new Error(`Bark answered HTTP ${response.status}${code === undefined ? "" : ` with code ${String(code)}`}`);
    }
  }
}
