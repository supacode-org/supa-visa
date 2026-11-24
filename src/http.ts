// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type Action, parseAction } from "./actions.ts";
import { AuthError, type Authenticator } from "./auth.ts";
import type { Blocklist } from "./blocklist.ts";
import type { Clock } from "./clock.ts";
import { formatDuration } from "./duration.ts";
import { canonicalTarget, type Ipv6Prefix, IPV6_PREFIXES, targetContains } from "./ip.ts";
import type { GeoLookup } from "./geo.ts";
import { errorMessage, type Logger } from "./log.ts";
import { networkBucketOf, type RateLimiter, sourceOf } from "./ratelimit.ts";
import type { VisaService } from "./service.ts";
import { InvalidInputError } from "./validate.ts";
import { VERSION } from "./version.ts";

export const MAX_BODY = 64 * 1024;

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://api.ipify.org https://api6.ipify.org https://api-ipv4.ip.sb https://api-ipv6.ip.sb https://ipv4.icanhazip.com https://ipv6.icanhazip.com https://ipv4.cloudflare-dns.com https://ipv6.cloudflare-dns.com https://v4.ident.me https://v6.ident.me; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

export interface StaticFile {
  readonly contentType: string;
  readonly body: Buffer;
}

const ASSETS: Record<string, { file: URL; contentType: string }> = {
  "/": { file: new URL("../public/index.html", import.meta.url), contentType: "text/html; charset=utf-8" },
  "/app.js": { file: new URL("../public/app.js", import.meta.url), contentType: "text/javascript; charset=utf-8" },
  "/app.css": { file: new URL("../public/app.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  "/icon.png": { file: new URL("../public/icon.png", import.meta.url), contentType: "image/png" },
  // iOS asks for this path even when the page has no <link> for it.
  "/apple-touch-icon.png": { file: new URL("../public/apple-touch-icon.png", import.meta.url), contentType: "image/png" },
  "/vendor/webauthn.js": {
    file: new URL("../node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js", import.meta.url),
    contentType: "text/javascript; charset=utf-8",
  },
};

// The page is a fixed set of files read once at startup; no path from a request
// ever reaches the file system.
export async function loadAssets(): Promise<Map<string, StaticFile>> {
  const assets = new Map<string, StaticFile>();
  for (const [path, { file, contentType }] of Object.entries(ASSETS)) {
    assets.set(path, { contentType, body: await readFile(file) });
  }
  return assets;
}

export interface AppOptions {
  readonly service: VisaService;
  readonly authenticator: Authenticator<Action>;
  readonly rpId: string;
  readonly origin: string;
  readonly durations: readonly number[];
  readonly maxLifetime: number;
  readonly ipv6Prefix: Ipv6Prefix;
  readonly manualIssue?: { readonly enabled: boolean; readonly minPrefixV4: number; readonly minPrefixV6: number };
  readonly assets: ReadonlyMap<string, StaticFile>;
  // Applied to every POST, before anything else is done with it.
  readonly limiter: RateLimiter;
  // Sources with too many failed credential checks; checked before the limiter.
  readonly blocklist: Blocklist;
  // Present only when the owner configured an ipinfo token.
  readonly geo?: GeoLookup;
  readonly logger: Logger;
  readonly clock: Clock;
}

class HttpError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.error));
    this.status = status;
    this.body = body;
  }
}

const notFound = () => new HttpError(404, { error: "not_found" });

// What a request did, filled in while it is handled and logged once it is answered.
interface RequestRecord {
  action?: string;
  result?: string;
  reason?: string;
  field?: string;
  targets?: readonly string[];
}

export function createHandler(options: AppOptions): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    const started = performance.now();
    const record: RequestRecord = {};
    response.once("close", () => logRequest(options, request, response, record, performance.now() - started));
    handle(options, request, response, record).catch((error: unknown) => {
      if (error instanceof HttpError) {
        record.result = String(error.body.error);
        return send(response, error.status, error.body);
      }
      if (error instanceof AuthError) {
        record.result = "auth_failed";
        record.reason = error.reason;
        if (error.counted) {
          options.blocklist.fail(networkBucketOf(clientIp(options, request)), error.reason).catch((failure: unknown) => {
            options.logger.error("ip.block_failed", { error: errorMessage(failure) });
          });
        }
        return send(response, 401, { error: "auth_failed" });
      }
      if (error instanceof InvalidInputError) {
        record.result = "invalid_input";
        record.field = error.field;
        return send(response, 400, { error: "invalid_input", field: error.field, message: error.message });
      }
      record.result = "error";
      options.logger.error("http.failed", { method: request.method, path: pathOf(request), error: errorMessage(error) });
      send(response, 500, { error: "internal" });
    });
  };
}

// One line per request, whoever sent it: the owner's own record of every attempt.
function logRequest(
  options: AppOptions,
  request: IncomingMessage,
  response: ServerResponse,
  record: RequestRecord,
  milliseconds: number,
): void {
  const header = request.headers["cf-connecting-ip"];
  const peer = request.socket.remoteAddress?.replace(/^::ffff:/, "");
  const path = printable(pathOf(request), 200);
  // The container's own health check every 30 seconds is not worth a line.
  if (header === undefined && path === "/healthz" && (peer === "127.0.0.1" || peer === "::1")) return;
  const ip = typeof header === "string" ? canonicalTarget(header) : undefined;
  const country = request.headers["cf-ipcountry"];
  const userAgent = request.headers["user-agent"];
  options.logger.info("http.request", {
    method: (request.method ?? "").slice(0, 10),
    path,
    status: response.statusCode,
    ip: header === undefined ? null : ip !== undefined && !ip.includes("/") ? ip : "invalid",
    ...(header !== undefined && (ip === undefined || ip.includes("/")) ? { ipHeader: printable(String(header), 64) } : {}),
    ...(header === undefined ? { peer: peer ?? null } : {}),
    ...(typeof country === "string" && /^[A-Z0-9]{2}$/.test(country) ? { country } : {}),
    ...(typeof userAgent === "string" ? { ua: printable(userAgent, 200) } : {}),
    ms: Math.round(milliseconds),
    ...(record.action === undefined ? {} : { action: record.action }),
    result: record.result ?? (response.statusCode < 400 ? "ok" : "error"),
    // Library errors can quote the client's own data.
    ...(record.reason === undefined ? {} : { reason: printable(record.reason, 200) }),
    ...(record.field === undefined ? {} : { field: record.field }),
    ...(record.targets === undefined ? {} : { targets: record.targets }),
  });
}

async function handle(
  options: AppOptions,
  request: IncomingMessage,
  response: ServerResponse,
  record: RequestRecord,
): Promise<void> {
  const { service, authenticator } = options;
  const path = pathOf(request);
  const method = request.method ?? "";

  if (method === "GET") {
    const asset = options.assets.get(path);
    if (asset !== undefined) return sendRaw(response, 200, asset.contentType, asset.body);
    if (path === "/api/me") return send(response, 200, me(options, request));
    if (path === "/healthz") {
      // Anyone can read this; whether syncing is failing is all it says.
      return send(response, 200, { status: service.syncStatus.failingSince === undefined ? "ok" : "degraded" });
    }
    if (path === "/setup") {
      const state = authenticator.setupState();
      if (state === "inactive") throw notFound();
      return send(response, 200, { state });
    }
    throw notFound();
  }

  if (method !== "POST") {
    response.setHeader("allow", "GET, POST");
    throw new HttpError(405, { error: "method_not_allowed" });
  }

  const known = ["/api/challenge", "/api/actions", "/api/passkeys/challenge", "/api/passkeys/authorize", "/api/passkeys", "/setup/begin", "/setup/complete"];
  if (!known.includes(path)) throw notFound();
  // The setup routes do not exist once a passkey is registered.
  if (path.startsWith("/setup/") && authenticator.setupState() === "inactive") throw notFound();
  const ip = clientIp(options, request);
  const source = sourceOf(ip);
  const blockedUntil = options.blocklist.blockedUntil(networkBucketOf(ip));
  if (blockedUntil !== undefined) throw new HttpError(403, { error: "blocked", until: iso(blockedUntil) });
  if (!options.limiter.take(networkBucketOf(ip))) throw new HttpError(429, { error: "rate_limited" });
  const body = await readJson(request, options.origin);

  switch (path) {
    case "/api/challenge": {
      record.action = "challenge";
      allowOnly(body, ["action"]);
      const action = parseAction(body.action, {
        clientIp: ip,
        durations: options.durations,
        ipv6Prefix: options.ipv6Prefix,
        ...(options.manualIssue === undefined ? {} : { manual: options.manualIssue }),
      });
      record.action = `challenge.${action.kind}`;
      if (action.kind === "issue") record.targets = action.targets;
      // Only checks that need nothing from outside: before the passkey, a request
      // must never reach Cloudflare (it could exhaust the API rate limit) or learn
      // which hostnames are registered or in the account's zones.
      if (action.kind === "add-service" && action.hostname === new URL(options.origin).hostname) {
        throw new InvalidInputError("hostname", "must not be Supa Visa's own hostname");
      }
      return send(response, 200, await authenticator.beginAction(action, source));
    }
    case "/api/actions": {
      record.action = "action";
      allowOnly(body, ["challengeId", "credential"]);
      const action = await authenticator.completeAction(body.challengeId, body.credential);
      record.action = `action.${action.kind}`;
      if (action.kind === "issue") record.targets = action.targets;
      const result = await execute(options, action);
      return send(response, 200, { result, state: await ownerState(options) });
    }
    case "/api/passkeys/challenge":
      record.action = "passkey.add.challenge";
      allowOnly(body, []);
      return send(response, 200, await authenticator.beginAddPasskey(source));
    case "/api/passkeys/authorize":
      record.action = "passkey.add.authorize";
      allowOnly(body, ["challengeId", "credential"]);
      return send(response, 200, await authenticator.authorizeNewPasskey(body.challengeId, body.credential, source));
    case "/api/passkeys":
    case "/setup/complete": {
      record.action = path === "/setup/complete" ? "setup.complete" : "passkey.register";
      allowOnly(body, ["challengeId", "credential"]);
      await authenticator.completeRegistration(body.challengeId, body.credential);
      return send(response, 200, { passkeys: authenticator.passkeyCount });
    }
    case "/setup/begin":
      record.action = "setup.begin";
      allowOnly(body, ["code"]);
      return send(response, 200, await authenticator.beginSetup(body.code, source));
  }
}

async function execute(options: AppOptions, action: Action): Promise<Record<string, unknown>> {
  const { service, authenticator } = options;
  switch (action.kind) {
    case "issue": {
      const { visas, synced } = await service.issueAll(
        action.targets.map((target) => ({
          target,
          duration: action.duration,
          manual: action.manual === true,
          ...(action.note === undefined ? {} : { note: action.note }),
        })),
      );
      return { kind: action.kind, visas: visas.map(visaView), synced };
    }
    case "revoke": {
      const revoked = await service.revoke(action.id);
      if (revoked === undefined) throw notFound();
      return { kind: action.kind, visa: visaView(revoked.visa), synced: revoked.synced };
    }
    case "list":
      return { kind: action.kind };
    case "delete-passkey": {
      const deleted = await authenticator.deletePasskey(action.id);
      if (deleted === undefined) throw notFound();
      return { kind: action.kind, remaining: deleted.remaining };
    }
    case "add-service": {
      const { service: added, synced } = await service.addService(action.hostname);
      return { kind: action.kind, hostname: added.hostname, synced };
    }
    case "remove-service": {
      const removed = await service.removeService(action.hostname);
      if (removed === undefined) throw notFound();
      return { kind: action.kind, hostname: removed.service.hostname, synced: removed.synced };
    }
  }
}

function me(options: AppOptions, request: IncomingMessage): Record<string, unknown> {
  const ip = clientIp(options, request);
  const now = options.clock();
  // Only visas that cover the requester; everything else needs a passkey.
  const covering = ip === undefined ? [] : options.service.current.filter((candidate) => candidate.expiresAt > now && targetContains(candidate.target, ip));
  const visa = covering.sort((a, b) => b.expiresAt - a.expiresAt)[0];
  const blockedUntil = options.blocklist.blockedUntil(networkBucketOf(ip));
  return {
    ip: ip ?? null,
    visa: visa === undefined ? null : { issuedAt: iso(visa.issuedAt), expiresAt: iso(visa.expiresAt), target: visa.target },
    setup: options.authenticator.setupState(),
    durations: options.durations.map(formatDuration),
    maxLifetime: formatDuration(options.maxLifetime),
    ...(ip !== undefined && ip.includes(":") ? { ipv6Prefixes: [...IPV6_PREFIXES], ipv6Prefix: options.ipv6Prefix } : {}),
    ...(options.manualIssue?.enabled === true ? { manual: true } : {}),
    ...(blockedUntil === undefined ? {} : { blocked: { until: iso(blockedUntil) } }),
  };
}

// The owner's whole view; built only after a passkey check, which is also the
// only time the owner's ipinfo token is spent.
async function ownerState(options: AppOptions): Promise<Record<string, unknown>> {
  const { service, authenticator } = options;
  const { lastSuccessAt, failingSince, lastError } = service.syncStatus;
  const addressOf = (target: string) => target.split("/")[0] as string;
  const geo = options.geo === undefined ? new Map() : await options.geo.lookUp(service.current.map((visa) => addressOf(visa.target)));
  return {
    visas: service.current.map((visa) => ({ ...visaView(visa), geo: geo.get(addressOf(visa.target)) ?? null })),
    services: service.registeredServices.map((registered) => ({
      hostname: registered.hostname,
      zoneName: registered.zoneName,
      addedAt: iso(registered.addedAt),
    })),
    passkeys: authenticator.passkeyCount,
    // Only ever sent after a passkey check: the IDs would help someone with a stolen key.
    passkeyList: authenticator.passkeyList().map((passkey) => ({
      id: passkey.id,
      createdAt: iso(passkey.createdAt),
      lastUsedAt: passkey.lastUsedAt === null ? null : iso(passkey.lastUsedAt),
    })),
    version: VERSION,
    sync: {
      lastSuccessAt: lastSuccessAt === undefined ? null : iso(lastSuccessAt),
      failingSince: failingSince === undefined ? null : iso(failingSince),
      lastError: lastError ?? null,
    },
  };
}

function visaView(visa: VisaService["current"][number]): Record<string, unknown> {
  return {
    id: visa.id,
    target: visa.target,
    issuedAt: iso(visa.issuedAt),
    expiresAt: iso(visa.expiresAt),
    lastSeen: visa.lastSeen === null ? null : iso(visa.lastSeen),
    note: visa.note ?? null,
    manual: visa.manual,
  };
}

// Only Cloudflare sets CF-Connecting-IP: the service is reachable only through the
// tunnel. Without Cloudflare (local development on localhost) the socket address is used.
function clientIp(options: AppOptions, request: IncomingMessage): string | undefined {
  const header = request.headers["cf-connecting-ip"];
  if (typeof header === "string") {
    const ip = canonicalTarget(header);
    return ip !== undefined && !ip.includes("/") ? ip : undefined;
  }
  if (options.rpId === "localhost") {
    const address = request.socket.remoteAddress?.replace(/^::ffff:/, "");
    return address === undefined ? undefined : canonicalTarget(address);
  }
  return undefined;
}

async function readJson(request: IncomingMessage, origin: string): Promise<Record<string, unknown>> {
  // A cross-site page cannot set Origin to ours; requiring it blocks cross-site requests.
  if (request.headers.origin !== origin) throw new HttpError(403, { error: "bad_origin" });
  const type = request.headers["content-type"] ?? "";
  if (!/^application\/json(;\s*charset=utf-8)?$/i.test(type)) {
    throw new HttpError(415, { error: "unsupported_media_type" });
  }
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY) throw new HttpError(413, { error: "too_large" });

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, { error: "too_large" });
    chunks.push(chunk as Buffer);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, { error: "invalid_json" });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, { error: "invalid_json" });
  return body as Record<string, unknown>;
}

// Header bytes arrive as latin1, so C1 controls (read as escape sequences by some
// terminals) would otherwise reach `docker logs` untouched.
function printable(text: string, max: number): string {
  return text.slice(0, max).replace(/[^\x20-\x7E]/g, "?");
}

function allowOnly(body: Record<string, unknown>, fields: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!fields.includes(key)) throw new InvalidInputError(key, "is not allowed here");
  }
}

function pathOf(request: IncomingMessage): string {
  const url = request.url ?? "/";
  const question = url.indexOf("?");
  return question < 0 ? url : url.slice(0, question);
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

function send(response: ServerResponse, status: number, body: unknown): void {
  sendRaw(response, status, "application/json; charset=utf-8", Buffer.from(JSON.stringify(body)));
}

function sendRaw(response: ServerResponse, status: number, contentType: string, body: Buffer): void {
  if (response.headersSent) return;
  response.writeHead(status, { ...SECURITY_HEADERS, "content-type": contentType, "content-length": body.length });
  response.end(body);
}
