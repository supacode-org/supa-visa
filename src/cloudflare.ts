// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import { isCanonicalHostname } from "./hostname.ts";
import { canonicalTarget } from "./ip.ts";
import { isValidZoneId } from "./services.ts";
import { isValidListItemId } from "./validate.ts";
import type { Zone } from "./waf.ts";

export interface ListItem {
  readonly id: string;
  readonly ip: string;
  readonly comment?: string;
}

export interface NewListItem {
  readonly ip: string;
  readonly comment: string;
}

export type OperationStatus =
  | { readonly status: "pending" | "running" | "completed" }
  | { readonly status: "failed"; readonly error: string };

export interface ListsClient {
  listItems(signal?: AbortSignal): Promise<ListItem[]>;
  createItems(items: readonly NewListItem[], signal?: AbortSignal): Promise<string>;
  deleteItems(ids: readonly string[], signal?: AbortSignal): Promise<string>;
  operationStatus(operationId: string, signal?: AbortSignal): Promise<OperationStatus>;
}

// "auth": the token is wrong or lacks permission. "rejected": any other request
// Cloudflare refuses (unknown list, invalid item). "retryable": rate limits,
// server errors, network failures, timeouts.
export type CloudflareErrorKind = "auth" | "rejected" | "retryable";

export class CloudflareError extends Error {
  readonly kind: CloudflareErrorKind;
  readonly status: number | undefined;
  // From a Retry-After header, in milliseconds.
  readonly retryAfter: number | undefined;

  constructor(kind: CloudflareErrorKind, message: string, status?: number, retryAfter?: number) {
    super(message);
    this.name = "CloudflareError";
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export interface ZoneRule {
  readonly id: string;
  readonly ref: string | undefined;
  readonly action: string;
  readonly expression: string;
  readonly enabled: boolean;
}

export interface EntryRuleset {
  readonly id: string;
  readonly rules: readonly ZoneRule[];
}

export interface RuleInput {
  readonly ref: string;
  readonly action: "block";
  readonly expression: string;
  readonly description: string;
  readonly enabled: true;
}

export interface RulesClient {
  listName(signal?: AbortSignal): Promise<string>;
  listZones(signal?: AbortSignal): Promise<Zone[]>;
  // undefined when the zone has no custom rules entry point yet.
  entrypoint(zoneId: string, signal?: AbortSignal): Promise<EntryRuleset | undefined>;
  createEntrypoint(zoneId: string, rule: RuleInput, signal?: AbortSignal): Promise<void>;
  // New and updated rules are placed first, so no earlier rule can skip them.
  createRule(zoneId: string, rulesetId: string, rule: RuleInput, signal?: AbortSignal): Promise<void>;
  updateRule(zoneId: string, rulesetId: string, ruleId: string, rule: RuleInput, signal?: AbortSignal): Promise<void>;
  deleteRule(zoneId: string, rulesetId: string, ruleId: string, signal?: AbortSignal): Promise<void>;
}

export const CUSTOM_RULES_PHASE = "http_request_firewall_custom";

export interface ClientActivity {
  readonly ip: string;
  // The latest minute with a request from this address.
  readonly lastMinute: number;
}

export interface ActivityClient {
  // Addresses that sent requests to `hosts` in the zone between `since` and `until`.
  activeClients(
    zoneId: string,
    hosts: readonly string[],
    since: number,
    until: number,
    ignorePaths: readonly string[],
    signal?: AbortSignal,
  ): Promise<ClientActivity[]>;
}

export const DEFAULT_API_BASE_URL = "https://api.cloudflare.com/client/v4";

export interface HttpCloudflareClientOptions {
  readonly apiToken: string;
  readonly accountId: string;
  readonly listId: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly timeout?: number;
}

interface Envelope {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: unknown;
  result_info?: { cursors?: { after?: string }; total_pages?: number };
}

export class HttpCloudflareClient implements ListsClient, RulesClient, ActivityClient {
  private readonly options: HttpCloudflareClientOptions;

  constructor(options: HttpCloudflareClientOptions) {
    this.options = options;
  }

  async listItems(signal?: AbortSignal): Promise<ListItem[]> {
    const items: ListItem[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ per_page: "500" });
      if (cursor !== undefined) query.set("cursor", cursor);
      const envelope = await this.request("GET", `${this.listPath()}/items?${query}`, undefined, signal);
      if (!Array.isArray(envelope.result)) throw malformed("list items");
      for (const item of envelope.result) {
        if (typeof item?.id !== "string" || !isValidListItemId(item.id) || typeof item?.ip !== "string") {
          throw malformed("list item");
        }
        items.push({
          id: item.id,
          ip: item.ip,
          ...(typeof item.comment === "string" ? { comment: item.comment } : {}),
        });
      }
      cursor = envelope.result_info?.cursors?.after || undefined;
    } while (cursor !== undefined);
    return items;
  }

  async createItems(items: readonly NewListItem[], signal?: AbortSignal): Promise<string> {
    return operationId(await this.request("POST", `${this.listPath()}/items`, items, signal));
  }

  async deleteItems(ids: readonly string[], signal?: AbortSignal): Promise<string> {
    return operationId(
      await this.request("DELETE", `${this.listPath()}/items`, { items: ids.map((id) => ({ id })) }, signal),
    );
  }

  async operationStatus(id: string, signal?: AbortSignal): Promise<OperationStatus> {
    const { result } = await this.request(
      "GET",
      `/accounts/${encodeURIComponent(this.options.accountId)}/rules/lists/bulk_operations/${encodeURIComponent(id)}`,
      undefined,
      signal,
    );
    const status = (result as { status?: unknown } | undefined)?.status;
    if (status === "failed") {
      const error = (result as { error?: unknown }).error;
      return { status, error: typeof error === "string" ? error : "unknown error" };
    }
    if (status === "pending" || status === "running" || status === "completed") return { status };
    throw malformed("operation status");
  }

  async listName(signal?: AbortSignal): Promise<string> {
    const { result } = await this.request("GET", this.listPath(), undefined, signal);
    const name = (result as { name?: unknown } | undefined)?.name;
    if (typeof name !== "string") throw malformed("list name");
    return name;
  }

  async listZones(signal?: AbortSignal): Promise<Zone[]> {
    const zones: Zone[] = [];
    for (let page = 1; ; page++) {
      const query = new URLSearchParams({ "account.id": this.options.accountId, per_page: "50", page: String(page) });
      const envelope = await this.request("GET", `/zones?${query}`, undefined, signal);
      if (!Array.isArray(envelope.result)) throw malformed("zones");
      for (const zone of envelope.result) {
        if (typeof zone?.id !== "string" || !isValidZoneId(zone.id)) throw malformed("zone id");
        if (typeof zone?.name !== "string" || !isCanonicalHostname(zone.name)) throw malformed("zone name");
        zones.push({ id: zone.id, name: zone.name });
      }
      const totalPages = (envelope.result_info as { total_pages?: unknown } | undefined)?.total_pages;
      if (envelope.result.length === 0 || typeof totalPages !== "number" || page >= totalPages) return zones;
    }
  }

  async entrypoint(zoneId: string, signal?: AbortSignal): Promise<EntryRuleset | undefined> {
    let envelope: Envelope;
    try {
      envelope = await this.request("GET", `${zonePath(zoneId)}/rulesets/phases/${CUSTOM_RULES_PHASE}/entrypoint`, undefined, signal);
    } catch (error) {
      if (error instanceof CloudflareError && error.status === 404) return undefined;
      throw error;
    }
    const result = envelope.result as { id?: unknown; rules?: unknown } | undefined;
    if (typeof result?.id !== "string" || !isValidRuleId(result.id)) throw malformed("ruleset id");
    const rules = result.rules ?? [];
    if (!Array.isArray(rules)) throw malformed("rules");
    return {
      id: result.id,
      rules: rules.map((rule) => {
        if (typeof rule?.id !== "string" || !isValidRuleId(rule.id)) throw malformed("rule id");
        return {
          id: rule.id,
          ref: typeof rule.ref === "string" ? rule.ref : undefined,
          action: typeof rule.action === "string" ? rule.action : "",
          expression: typeof rule.expression === "string" ? rule.expression : "",
          enabled: rule.enabled !== false,
        };
      }),
    };
  }

  async createEntrypoint(zoneId: string, rule: RuleInput, signal?: AbortSignal): Promise<void> {
    await this.request(
      "POST",
      `${zonePath(zoneId)}/rulesets`,
      { name: "default", kind: "zone", phase: CUSTOM_RULES_PHASE, rules: [rule] },
      signal,
    );
  }

  async createRule(zoneId: string, rulesetId: string, rule: RuleInput, signal?: AbortSignal): Promise<void> {
    await this.request("POST", `${rulesetPath(zoneId, rulesetId)}/rules`, { ...rule, position: { index: 1 } }, signal);
  }

  async updateRule(
    zoneId: string,
    rulesetId: string,
    ruleId: string,
    rule: RuleInput,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request(
      "PATCH",
      `${rulesetPath(zoneId, rulesetId)}/rules/${encodeURIComponent(ruleId)}`,
      { ...rule, position: { index: 1 } },
      signal,
    );
  }

  async deleteRule(zoneId: string, rulesetId: string, ruleId: string, signal?: AbortSignal): Promise<void> {
    await this.request("DELETE", `${rulesetPath(zoneId, rulesetId)}/rules/${encodeURIComponent(ruleId)}`, undefined, signal);
  }

  async activeClients(
    zoneId: string,
    hosts: readonly string[],
    since: number,
    until: number,
    ignorePaths: readonly string[],
    signal?: AbortSignal,
  ): Promise<ClientActivity[]> {
    // Every value travels as a GraphQL variable, never inside the query text.
    // Only requests that reached the origin, which means they passed the block
    // rule: strangers' requests (blocked, redirected, dropped) would otherwise
    // fill the 1,000-row limit and push the owner's rows out.
    const query = `query ($zone: String!, $since: Time!, $until: Time!, $hosts: [String!]${ignorePaths.length > 0 ? ", $ignore: [String!]" : ""}) {
      viewer { zones(filter: { zoneTag: $zone }) {
        httpRequestsAdaptiveGroups(limit: 1000, orderBy: [datetimeMinute_DESC], filter: { datetime_geq: $since, datetime_lt: $until, clientRequestHTTPHost_in: $hosts, securityAction_neq: "block", originResponseStatus_gt: 0${ignorePaths.length > 0 ? ", clientRequestPath_notin: $ignore" : ""} }) {
          dimensions { clientIP datetimeMinute }
        }
      } }
    }`;
    const variables = {
      zone: zoneId,
      since: new Date(since).toISOString(),
      until: new Date(until).toISOString(),
      hosts,
      ...(ignorePaths.length > 0 ? { ignore: ignorePaths } : {}),
    };
    const envelope = (await this.request("POST", "/graphql", { query, variables }, signal)) as Envelope & {
      data?: { viewer?: { zones?: { httpRequestsAdaptiveGroups?: unknown }[] } };
      errors?: { message?: string }[] | null;
    };
    if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
      const message = this.redact(envelope.errors.map((error) => error.message ?? "").join("; ").slice(0, 300));
      const kind: CloudflareErrorKind = /authoriz|permission|access/i.test(message) ? "auth" : "rejected";
      throw new CloudflareError(kind, `analytics query: ${message}`);
    }
    const groups = envelope.data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups;
    if (!Array.isArray(groups)) throw malformed("analytics");
    const latest = new Map<string, number>();
    for (const group of groups) {
      const ip = typeof group?.dimensions?.clientIP === "string" ? canonicalTarget(group.dimensions.clientIP) : undefined;
      const minute = typeof group?.dimensions?.datetimeMinute === "string" ? Date.parse(group.dimensions.datetimeMinute) : Number.NaN;
      if (ip === undefined || ip.includes("/") || Number.isNaN(minute)) continue;
      latest.set(ip, Math.max(latest.get(ip) ?? 0, minute));
    }
    return [...latest].map(([ip, lastMinute]) => ({ ip, lastMinute }));
  }

  // Cloudflare echoes the request path in some errors; the IDs identify the owner.
  private redact(text: string): string {
    const { accountId, listId, apiToken } = this.options;
    let redacted = text;
    // Real IDs are 32 hex characters; skipping short values avoids mangling ordinary words.
    for (const [value, label] of [[apiToken, "<token>"], [accountId, "<account>"], [listId, "<list>"]] as const) {
      if (value.length >= 8) redacted = redacted.replaceAll(value, label);
    }
    return redacted;
  }

  private listPath(): string {
    const { accountId, listId } = this.options;
    return `/accounts/${encodeURIComponent(accountId)}/rules/lists/${encodeURIComponent(listId)}`;
  }

  private async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Envelope> {
    const fetchImpl = this.options.fetch ?? fetch;
    const url = `${this.options.baseUrl ?? DEFAULT_API_BASE_URL}${path}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${this.options.apiToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([
          AbortSignal.timeout(this.options.timeout ?? 30_000),
          ...(signal === undefined ? [] : [signal]),
        ]),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      const reason = name === "TimeoutError" ? "timed out" : name === "AbortError" ? "aborted" : "network error";
      throw new CloudflareError("retryable", `${method} ${describe(path)}: ${reason}`);
    }

    let envelope: Envelope = {};
    try {
      envelope = (await response.json()) as Envelope;
    } catch {}

    if (response.ok && envelope.success !== false) return envelope;

    const details = this.redact(
      (envelope.errors ?? []).map((error) => `${error.code ?? "?"} ${error.message ?? ""}`.trim()).join("; "),
    );
    const message = `${method} ${describe(path)}: HTTP ${response.status}${details ? ` (${details})` : ""}`;
    const status = response.status;
    const kind: CloudflareErrorKind =
      status === 401 || status === 403 ? "auth" : status === 429 || status >= 500 ? "retryable" : "rejected";
    const retryAfter = /^[0-9]{1,6}$/.test(response.headers.get("retry-after") ?? "")
      ? Number(response.headers.get("retry-after")) * 1000
      : undefined;
    throw new CloudflareError(kind, message, status, retryAfter);
  }
}

function zonePath(zoneId: string): string {
  return `/zones/${encodeURIComponent(zoneId)}`;
}

function rulesetPath(zoneId: string, rulesetId: string): string {
  return `${zonePath(zoneId)}/rulesets/${encodeURIComponent(rulesetId)}`;
}

function isValidRuleId(id: string): boolean {
  return /^[0-9a-f]{32}$/.test(id);
}

function operationId(envelope: Envelope): string {
  const id = (envelope.result as { operation_id?: unknown } | undefined)?.operation_id;
  if (typeof id !== "string") throw malformed("operation id");
  return id;
}

function malformed(what: string): CloudflareError {
  return new CloudflareError("retryable", `unexpected response from Cloudflare: missing or invalid ${what}`);
}

// Keeps account, list and zone IDs out of logs; they are not secret, but they identify the owner.
function describe(path: string): string {
  if (path.includes("/bulk_operations/")) return "bulk operation";
  if (path.includes("/rules/lists/")) return path.includes("/items") ? "list items" : "list";
  if (path.includes("/entrypoint")) return "zone custom rules";
  if (path === "/graphql") return "analytics";
  if (path.includes("/rulesets")) return "zone ruleset";
  return "zones";
}
