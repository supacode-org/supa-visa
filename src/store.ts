// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type Block, type Blocks, isValidBlockSource, MAX_BLOCKS } from "./blocklist.ts";
import { canonicalTarget } from "./ip.ts";
import { type Passkey, passkeyProblem, type Passkeys, isBase64Url } from "./passkeys.ts";
import { type Service, serviceProblem, type Services } from "./services.ts";
import { isValidNote, isValidVisaId } from "./validate.ts";
import type { Visa, Visas } from "./visa.ts";

export interface State {
  readonly visas: Visas;
  readonly services: Services;
  readonly passkeys: Passkeys;
  // The WebAuthn user handle, created with the first passkey.
  readonly webauthnUserId: string | undefined;
  // Sources blocked after repeated failed credential checks.
  readonly blocks: Blocks;
}

export const EMPTY_STATE: State = { visas: [], services: [], passkeys: [], webauthnUserId: undefined, blocks: [] };

export interface StateStore {
  load(): Promise<State>;
  save(state: State): Promise<void>;
  flush(): Promise<void>;
}

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

const FORMAT_VERSION = 1;

type Extra = Record<string, unknown>;

export class FileStore implements StateStore {
  readonly path: string;
  // Top-level fields this version does not know about (passkeys from a later phase,
  // for example) are written back untouched instead of being dropped.
  private extra: Extra = {};
  private queue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<State> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_STATE;
      throw error;
    }
    const decoded = decodeDataFile(text);
    this.extra = decoded.extra;
    return decoded.state;
  }

  save(state: State): Promise<void> {
    const data = encodeDataFile(state, this.extra);
    const run = this.queue.then(() => writeAtomic(this.path, data));
    this.queue = run.catch(() => {});
    return run;
  }

  flush(): Promise<void> {
    return this.queue;
  }
}

export function encodeDataFile(state: State, extra: Extra = {}): string {
  const encoded = state.visas.map((visa) => ({
    id: visa.id,
    target: visa.target,
    issuedAt: new Date(visa.issuedAt).toISOString(),
    expiresAt: new Date(visa.expiresAt).toISOString(),
    lastSeen: visa.lastSeen === null ? null : new Date(visa.lastSeen).toISOString(),
    ...(visa.note === undefined ? {} : { note: visa.note }),
    manual: visa.manual,
    renewals: visa.renewals,
  }));
  const services = state.services.map((service) => ({
    hostname: service.hostname,
    zoneId: service.zoneId,
    zoneName: service.zoneName,
    addedAt: new Date(service.addedAt).toISOString(),
  }));
  const passkeys = state.passkeys.map((passkey) => ({
    id: passkey.id,
    publicKey: passkey.publicKey,
    counter: passkey.counter,
    transports: passkey.transports,
    createdAt: new Date(passkey.createdAt).toISOString(),
    lastUsedAt: passkey.lastUsedAt === null ? null : new Date(passkey.lastUsedAt).toISOString(),
  }));
  return `${JSON.stringify(
    {
      ...extra,
      version: FORMAT_VERSION,
      visas: encoded,
      services,
      ...(state.webauthnUserId === undefined ? {} : { webauthnUserId: state.webauthnUserId }),
      passkeys,
      blocks: state.blocks.map((block) => ({
        source: block.source,
        since: new Date(block.since).toISOString(),
        until: new Date(block.until).toISOString(),
        failures: block.failures,
      })),
    },
    null,
    2,
  )}\n`;
}

export function decodeDataFile(text: string): { state: State; extra: Extra } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StoreError("data file is not valid JSON");
  }
  if (!isObject(parsed)) throw new StoreError("data file must contain a JSON object");
  const { version, visas, services = [], passkeys = [], webauthnUserId, blocks = [], ...extra } = parsed;
  if (version !== FORMAT_VERSION) throw new StoreError(`data file version must be ${FORMAT_VERSION}`);
  if (!Array.isArray(visas)) throw new StoreError("visas must be an array");
  if (!Array.isArray(services)) throw new StoreError("services must be an array");
  const decodedServices = services.map((item, index) => decodeService(item, `services[${index}]`));
  const hostnames = new Set<string>();
  decodedServices.forEach((service, index) => {
    if (hostnames.has(service.hostname)) throw new StoreError(`services[${index}].hostname is registered twice`);
    hostnames.add(service.hostname);
  });
  if (!Array.isArray(passkeys)) throw new StoreError("passkeys must be an array");
  const decodedPasskeys = passkeys.map((item, index) => decodePasskey(item, `passkeys[${index}]`));
  if (new Set(decodedPasskeys.map((passkey) => passkey.id)).size !== decodedPasskeys.length) {
    throw new StoreError("passkeys must not contain the same credential twice");
  }
  if (webauthnUserId !== undefined && (typeof webauthnUserId !== "string" || !isBase64Url(webauthnUserId, 16, 64))) {
    throw new StoreError("webauthnUserId must be 16 to 64 base64url characters");
  }
  if (!Array.isArray(blocks)) throw new StoreError("blocks must be an array");
  if (blocks.length > MAX_BLOCKS) throw new StoreError(`blocks must have at most ${MAX_BLOCKS} entries`);
  const decodedBlocks = blocks.map((item, index) => decodeBlock(item, `blocks[${index}]`));
  if (new Set(decodedBlocks.map((block) => block.source)).size !== decodedBlocks.length) {
    throw new StoreError("blocks must not contain the same source twice");
  }
  return {
    state: {
      visas: visas.map((item, index) => decodeVisa(item, `visas[${index}]`)),
      services: decodedServices,
      passkeys: decodedPasskeys,
      webauthnUserId,
      blocks: decodedBlocks,
    },
    extra,
  };
}

function decodePasskey(item: unknown, at: string): Passkey {
  if (!isObject(item)) throw new StoreError(`${at} must be an object`);
  const time = (value: unknown, field: string): number => {
    const parsed = typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : Number.NaN;
    if (Number.isNaN(parsed)) throw new StoreError(`${at}.${field} must be an ISO 8601 time`);
    return parsed;
  };
  const passkey = {
    id: item.id,
    publicKey: item.publicKey,
    counter: item.counter,
    transports: item.transports,
    createdAt: time(item.createdAt, "createdAt"),
    lastUsedAt: item.lastUsedAt === null ? null : time(item.lastUsedAt, "lastUsedAt"),
  };
  const problem = passkeyProblem(passkey);
  if (problem !== undefined) throw new StoreError(`${at}.${problem}`);
  return passkey as Passkey;
}

function decodeBlock(item: unknown, at: string): Block {
  if (!isObject(item)) throw new StoreError(`${at} must be an object`);
  const { source, since, until, failures, ...rest } = item;
  if (Object.keys(rest).length > 0) throw new StoreError(`${at} has unknown fields`);
  if (typeof source !== "string" || !isValidBlockSource(source)) {
    throw new StoreError(`${at}.source must be a canonical IPv4 /24 or IPv6 /48`);
  }
  const time = (value: unknown, field: string): number => {
    const parsed = typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : Number.NaN;
    if (Number.isNaN(parsed)) throw new StoreError(`${at}.${field} must be an ISO 8601 time`);
    return parsed;
  };
  const block = { source, since: time(since, "since"), until: time(until, "until") };
  if (block.until <= block.since) throw new StoreError(`${at}.until must be after since`);
  if (!Number.isSafeInteger(failures) || (failures as number) < 1 || (failures as number) > 1000) {
    throw new StoreError(`${at}.failures must be an integer from 1 to 1000`);
  }
  return { ...block, failures: failures as number };
}

function decodeService(item: unknown, at: string): Service {
  if (!isObject(item)) throw new StoreError(`${at} must be an object`);
  const { hostname, zoneId, zoneName, addedAt } = item;
  const added = typeof addedAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(addedAt) ? Date.parse(addedAt) : Number.NaN;
  if (typeof hostname !== "string" || typeof zoneId !== "string" || typeof zoneName !== "string") {
    throw new StoreError(`${at} must have string hostname, zoneId and zoneName`);
  }
  if (Number.isNaN(added)) throw new StoreError(`${at}.addedAt must be an ISO 8601 time`);
  const service: Service = { hostname, zoneId, zoneName, addedAt: added };
  const problem = serviceProblem(service);
  if (problem !== undefined) throw new StoreError(`${at}.${problem}`);
  return service;
}

function decodeVisa(item: unknown, at: string): Visa {
  if (!isObject(item)) throw new StoreError(`${at} must be an object`);
  const fail = (field: string, rule: string): never => {
    throw new StoreError(`${at}.${field} ${rule}`);
  };
  const text = (field: string): string => {
    const value = item[field];
    return typeof value === "string" && value !== "" ? value : fail(field, "must be a non-empty string");
  };
  const time = (field: string): number => {
    const value = item[field];
    const parsed = typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : Number.NaN;
    return Number.isNaN(parsed) ? fail(field, "must be an ISO 8601 time") : parsed;
  };

  const id = text("id");
  if (!isValidVisaId(id)) fail("id", "must be 1 to 64 letters, digits or hyphens");
  const target = text("target");
  // A hand-edited or tampered file must not get anything but a canonical IP or
  // range into memory, and from there into Cloudflare.
  if (canonicalTarget(target) !== target) fail("target", "must be a canonical IP address or CIDR range");
  const note = item.note === undefined ? undefined : text("note");
  if (note !== undefined && !isValidNote(note)) fail("note", "must be 1 to 40 printable characters");

  const visa: Visa = {
    id,
    target,
    issuedAt: time("issuedAt"),
    expiresAt: time("expiresAt"),
    lastSeen: item.lastSeen === null ? null : time("lastSeen"),
    ...(note === undefined ? {} : { note }),
    manual: typeof item.manual === "boolean" ? item.manual : fail("manual", "must be true or false"),
    renewals:
      Number.isSafeInteger(item.renewals) && (item.renewals as number) >= 0
        ? (item.renewals as number)
        : fail("renewals", "must be a non-negative integer"),
  };
  if (visa.expiresAt < visa.issuedAt) fail("expiresAt", "must not be before issuedAt");
  return visa;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Write to a temporary file in the same directory and rename it over the data file,
// so a crash or a full disk leaves either the old file or the new one, never half of it.
async function writeAtomic(path: string, data: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(data, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  await syncDirectory(directory);
}

// Makes the rename durable. Some platforms cannot fsync a directory; the rename
// has already happened, so that is not worth failing the save over.
async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {}
}
