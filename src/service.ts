// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import type { Clock } from "./clock.ts";
import { MINUTE } from "./duration.ts";
import { canonicalTarget } from "./ip.ts";
import type { Logger } from "./log.ts";
import type { Notify } from "./notify.ts";
import { canonicalHostname } from "./hostname.ts";
import { MAX_SERVICES, type Service, type Services } from "./services.ts";
import { StateKeeper } from "./state.ts";
import type { StateStore } from "./store.ts";
import type { Sync, SyncStatus } from "./sync.ts";
import { InvalidInputError, isValidNote } from "./validate.ts";
import { VERSION } from "./version.ts";
import { expire, issue, revoke, type Visa, type Visas } from "./visa.ts";
import { buildExpression, ExpressionError, type Zone, zoneFor } from "./waf.ts";

export interface ServiceOptions {
  readonly maxLifetime: number;
  // Supa Visa's own hostname, which must never be registered as a service.
  readonly ownHostname: string;
  // The zones the API token can see, for placing a new service in its zone.
  readonly zones: () => Promise<Zone[]>;
  readonly store: StateStore;
  readonly sync: Sync;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly newId?: () => string;
  readonly tickInterval?: number;
  readonly notify?: Notify;
}

export interface IssueInput {
  readonly target: string;
  readonly duration: number;
  readonly note?: string;
  readonly manual: boolean;
}

export interface ServiceChangeResult {
  readonly service: Service;
  readonly synced: boolean;
}

export interface ChangeResult {
  readonly visa: Visa;
  // Whether the Cloudflare sync right after the change succeeded. When it did not,
  // the change is saved locally and the sync retries on its own.
  readonly synced: boolean;
}

export class VisaService {
  private readonly options: ServiceOptions;
  // Shared with the authenticator; all changes go through its queue, so an issue
  // that finishes after a tick cannot put back a visa the tick had just expired.
  readonly keeper: StateKeeper;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: ServiceOptions) {
    this.options = options;
    this.keeper = new StateKeeper(options.store, options.logger);
  }

  get current(): Visas {
    return this.keeper.state.visas;
  }

  get registeredServices(): Services {
    return this.keeper.state.services;
  }

  get syncStatus(): SyncStatus {
    return this.options.sync.status();
  }

  async start(): Promise<void> {
    await this.keeper.load();
    await this.expireAndSave();
    this.timer = setInterval(() => void this.tick(), this.options.tickInterval ?? MINUTE);
    // Not awaited: the service is up even while Cloudflare is slow or unreachable.
    void this.options.sync.request("startup");
    this.options.logger.info("service.start", { version: VERSION, visas: this.current.length });
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.keeper.idle();
    await this.options.sync.stop();
    await this.keeper.idle();
    this.options.logger.info("service.stop");
  }

  async tick(): Promise<void> {
    const expired = await this.expireAndSave();
    if (expired > 0) void this.options.sync.request("expire");
    this.options.sync.tick();
  }

  // Throws InvalidInputError before touching any state. Callers (the HTTP layer)
  // validate too, but this is the last line before the data file and Cloudflare.
  async issue(input: IssueInput): Promise<ChangeResult> {
    const { visas, synced } = await this.issueAll([input]);
    return { visa: visas[0] as Visa, synced };
  }

  // Several visas (one per address family) with one save and one sync; all or none.
  async issueAll(inputs: readonly IssueInput[]): Promise<{ visas: Visa[]; synced: boolean }> {
    if (inputs.length === 0 || inputs.length > 2) throw new InvalidInputError("targets", "must be one or two addresses");
    const checked = inputs.map((input) => {
      const target = canonicalTarget(input.target);
      if (target === undefined) throw new InvalidInputError("target", "must be an IP address or CIDR range");
      if (!Number.isSafeInteger(input.duration) || input.duration <= 0) {
        throw new InvalidInputError("duration", "must be a positive number of milliseconds");
      }
      if (input.note !== undefined && !isValidNote(input.note)) {
        throw new InvalidInputError("note", "must be 1 to 40 printable characters");
      }
      return { ...input, target };
    });
    if (new Set(checked.map((input) => input.target)).size !== checked.length) {
      throw new InvalidInputError("targets", "must not repeat");
    }
    const issued = await this.keeper.exclusive(async () => {
      const now = this.options.clock();
      let visas = this.current;
      const results = [];
      for (const input of checked) {
        const result = issue(
          visas,
          {
            target: input.target,
            duration: input.duration,
            ...(input.note === undefined ? {} : { note: input.note }),
            manual: input.manual,
            id: (this.options.newId ?? randomUUID)(),
            maxLifetime: this.options.maxLifetime,
          },
          now,
        );
        visas = result.visas;
        results.push(result);
      }
      await this.keeper.commit({ ...this.keeper.state, visas });
      for (const result of results) {
        this.options.logger.info("visa.issue", {
          id: result.visa.id,
          target: result.visa.target,
          expiresAt: new Date(result.visa.expiresAt).toISOString(),
          manual: result.visa.manual,
          replaced: result.replaced?.id ?? null,
        });
        this.options.notify?.({
          type: result.visa.manual ? "manual_issue" : "issue",
          target: result.visa.target,
          expiresAt: result.visa.expiresAt,
          ...(result.visa.note === undefined ? {} : { note: result.visa.note }),
        });
      }
      return results.map((result) => result.visa);
    });
    return { visas: issued, synced: await this.options.sync.request("issue") };
  }

  async revoke(id: string): Promise<ChangeResult | undefined> {
    const visa = await this.keeper.exclusive(async () => {
      const result = revoke(this.current, id);
      if (result.revoked === undefined) return undefined;
      // Like expiry, a revocation takes effect even if the data file cannot be
      // written: it narrows access, so it must not wait for the disk.
      await this.keeper.apply({ ...this.keeper.state, visas: result.visas });
      this.options.logger.info("visa.revoke", { id: result.revoked.id, target: result.revoked.target });
      this.options.notify?.({ type: "revoke", target: result.revoked.target });
      return result.revoked;
    });
    if (visa === undefined) return undefined;
    return { visa, synced: await this.options.sync.request("revoke") };
  }

  // Every check addService makes, without changing anything; lets the page report
  // a bad hostname before asking for a passkey.
  async checkNewService(text: string): Promise<{ hostname: string; zone: Zone }> {
    const hostname = canonicalHostname(text);
    if (hostname === undefined) throw new InvalidInputError("hostname", "must be a hostname such as nas.example.com");
    if (hostname === this.options.ownHostname) {
      throw new InvalidInputError("hostname", "must not be Supa Visa's own hostname");
    }
    const zone = zoneFor(hostname, await this.options.zones());
    if (zone === undefined) throw new InvalidInputError("hostname", "is not in a zone the API token can see");
    this.checkRoomFor(hostname, zone);
    return { hostname, zone };
  }

  // Validates fully (including the zone lookup) before changing anything.
  async addService(text: string): Promise<ServiceChangeResult> {
    const { hostname, zone } = await this.checkNewService(text);
    const service = await this.keeper.exclusive(async () => {
      // Again inside the queue: the state may have changed during the zone lookup.
      this.checkRoomFor(hostname, zone);
      const added: Service = { hostname, zoneId: zone.id, zoneName: zone.name, addedAt: this.options.clock() };
      await this.keeper.commit({ ...this.keeper.state, services: [...this.registeredServices, added] });
      this.options.logger.info("service.add", { hostname, zoneName: zone.name });
      this.options.notify?.({ type: "service_add", hostname });
      return added;
    });
    return { service, synced: await this.options.sync.request("services") };
  }

  private checkRoomFor(hostname: string, zone: Zone): void {
    const services = this.registeredServices;
    if (services.some((existing) => existing.hostname === hostname)) {
      throw new InvalidInputError("hostname", "is already registered");
    }
    if (services.length >= MAX_SERVICES) {
      throw new InvalidInputError("hostname", `cannot be added: at most ${MAX_SERVICES} services`);
    }
    const sameZone = services.filter((existing) => existing.zoneId === zone.id).map((existing) => existing.hostname);
    try {
      // The longest list name Cloudflare allows, so the real expression can only be shorter.
      buildExpression([...sameZone, hostname], "x".repeat(50));
    } catch (error) {
      if (error instanceof ExpressionError) {
        throw new InvalidInputError("hostname", "cannot be added: the zone's rule would be too long");
      }
      throw error;
    }
  }

  async removeService(text: string): Promise<ServiceChangeResult | undefined> {
    const hostname = canonicalHostname(text);
    if (hostname === undefined) throw new InvalidInputError("hostname", "must be a hostname such as nas.example.com");
    const service = await this.keeper.exclusive(async () => {
      const services = this.registeredServices;
      const removed = services.find((existing) => existing.hostname === hostname);
      if (removed === undefined) return undefined;
      await this.keeper.commit({ ...this.keeper.state, services: services.filter((existing) => existing !== removed) });
      this.options.logger.info("service.remove", { hostname });
      this.options.notify?.({ type: "service_remove", hostname });
      return removed;
    });
    if (service === undefined) return undefined;
    return { service, synced: await this.options.sync.request("services") };
  }

  // Extends a visa that is in use, never past its hard limit. Local only: the
  // address is already on the Cloudflare list, so nothing needs syncing.
  async renew(id: string, until: number, lastSeen: number): Promise<Visa | undefined> {
    return this.keeper.exclusive(async () => {
      const visa = this.current.find((candidate) => candidate.id === id);
      if (visa === undefined) return undefined;
      const expiresAt = Math.min(until, visa.issuedAt + this.options.maxLifetime);
      if (expiresAt <= visa.expiresAt || visa.expiresAt <= this.options.clock()) return undefined;
      const renewed: Visa = { ...visa, expiresAt, lastSeen, renewals: visa.renewals + 1 };
      await this.keeper.apply({
        ...this.keeper.state,
        visas: this.current.map((candidate) => (candidate.id === id ? renewed : candidate)),
      });
      this.options.logger.info("visa.renew", {
        id,
        target: visa.target,
        expiresAt: new Date(expiresAt).toISOString(),
        renewals: renewed.renewals,
      });
      this.options.notify?.({ type: "renew", target: visa.target, expiresAt });
      return renewed;
    });
  }

  // Revokes every visa (used by `reset-passkeys --revoke-all`). Like expiry, it
  // takes effect in memory even if the save fails.
  async revokeAll(): Promise<{ revoked: number; synced: boolean }> {
    const revoked = await this.keeper.exclusive(async () => {
      const visas = this.current;
      await this.keeper.apply({ ...this.keeper.state, visas: [] });
      for (const visa of visas) this.options.logger.info("visa.revoke", { id: visa.id, target: visa.target });
      return visas.length;
    });
    return { revoked, synced: await this.options.sync.request("revoke") };
  }

  // Returns how many visas expired.
  private expireAndSave(): Promise<number> {
    return this.keeper.exclusive(async () => {
      const { visas, expired } = expire(this.current, this.options.clock());
      for (const visa of expired) {
        this.options.logger.info("visa.expire", {
          id: visa.id,
          target: visa.target,
          issuedAt: new Date(visa.issuedAt).toISOString(),
          renewals: visa.renewals,
        });
        this.options.notify?.({
          type: "expire",
          target: visa.target,
          issuedAt: visa.issuedAt,
          expiredAt: visa.expiresAt,
          renewals: visa.renewals,
        });
      }
      // Expiry always takes effect in memory first: a visa must never outlive its
      // expiry just because the disk is full.
      if (expired.length > 0) await this.keeper.apply({ ...this.keeper.state, visas });
      else await this.keeper.saveUnsaved();
      return expired.length;
    });
  }
}
