#!/usr/bin/env node
// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import { type AdminCommand, type AdminReply, adminSocketPath, closeAdminServer, sendAdminCommand, startAdminServer } from "./admin.ts";
import { createServer } from "node:http";
import type { Action } from "./actions.ts";
import { Authenticator } from "./auth.ts";
import { systemClock } from "./clock.ts";
import { HttpCloudflareClient } from "./cloudflare.ts";
import { ConfigError, type Env, loadConfig } from "./config.ts";
import { createHandler, loadAssets } from "./http.ts";
import { dirname, join, resolve } from "node:path";
import { createLogger, errorMessage, hideSetupCode, type Logger } from "./log.ts";
import { RotatingLogFile } from "./logfile.ts";
import { GeoLookup } from "./geo.ts";
import { Blocklist } from "./blocklist.ts";
import { canonicalTarget } from "./ip.ts";
import { Heartbeat } from "./heartbeat.ts";
import { Renewer } from "./renew.ts";
import { BarkChannel, Notifier } from "./notify.ts";
import { RateLimiter } from "./ratelimit.ts";
import { VisaService } from "./service.ts";
import { FileStore, StoreError } from "./store.ts";
import { CloudflareSync, desiredTargets } from "./sync.ts";
import { VERSION } from "./version.ts";

const USAGE = `Usage:
  supa-visa                               start the service (configured through environment variables)
  supa-visa reset-passkeys [--revoke-all] remove every passkey and return to setup mode;
                                          --revoke-all also revokes every visa
  supa-visa unblock <ip> | --all          lift the block on an address (an IPv6 /64), or every block
  supa-visa --version                     print the version`;

export async function run(args: readonly string[], env: Env): Promise<number> {
  if (args.length === 0) return serve(env);
  if (args.length === 1 && args[0] === "--version") {
    console.log(VERSION);
    return 0;
  }
  if (args[0] === "reset-passkeys" && (args.length === 1 || (args.length === 2 && args[1] === "--revoke-all"))) {
    return resetPasskeys(env, args[1] === "--revoke-all");
  }
  if (args[0] === "unblock" && args.length === 2) return unblock(env, args[1] === "--all" ? "all" : (args[1] as string));
  console.error(USAGE);
  return 2;
}

async function unblock(env: Env, target: string): Promise<number> {
  if (target !== "all" && canonicalTarget(target) === undefined) {
    console.error("Give an IP address, an IPv6 /64, or --all.");
    return 2;
  }
  const reply = await askService(env, { command: "unblock", target });
  if (reply === undefined) return 1;
  if (!reply.ok) {
    console.error(`Unblock failed: ${reply.error}`);
    return 1;
  }
  console.log(reply.removed === 0 ? "Nothing was blocked." : `Lifted ${reply.removed} block${reply.removed === 1 ? "" : "s"}.`);
  return 0;
}

// Undefined when the service could not be reached; the reason is already printed.
async function askService(env: Env, command: AdminCommand): Promise<AdminReply | undefined> {
  const path = adminSocketPath(env.DATA_FILE?.trim() || "./data/visa.json");
  try {
    return await sendAdminCommand(path, command);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.error(
      code === "ENOENT" || code === "ECONNREFUSED"
        ? "Supa Visa is not running. Start the service, then run this command again."
        : `Could not reach Supa Visa: ${errorMessage(error)}`,
    );
    return undefined;
  }
}

// Asks the running service to reset, so that only the service writes the data file.
async function resetPasskeys(env: Env, revokeAll: boolean): Promise<number> {
  const reply = await askService(env, { command: "reset-passkeys", revokeAll });
  if (reply === undefined) return 1;
  if (!reply.ok) {
    console.error(`Reset failed: ${reply.error}`);
    return 1;
  }
  console.log(
    `All passkeys were removed${revokeAll ? ` and ${reply.revokedVisas ?? 0} visas revoked` : ""}. ` +
      "Supa Visa is back in setup mode; the new setup code is in its log.",
  );
  return 0;
}

async function serve(env: Env): Promise<number> {
  const console = createLogger(systemClock);

  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error("config.invalid", { errors: error.errors });
    return 1;
  }

  // Every event goes to stdout and to rotating files in the data volume, so a
  // record of who tried what survives container restarts.
  let logFile: RotatingLogFile;
  try {
    let failures = 0;
    logFile = new RotatingLogFile({
      directory: join(dirname(resolve(config.dataFile)), "logs"),
      maxBytes: config.logMaxBytes,
      clock: systemClock,
      onError: (error) => {
        if (failures++ % 100 === 0) console.error("log.write_failed", { error: errorMessage(error), failures });
      },
    });
  } catch (error) {
    console.error("log.open_failed", { error: errorMessage(error) });
    return 1;
  }
  const logger: Logger = createLogger(systemClock, (line) => {
    process.stdout.write(`${line}\n`);
    logFile.write(line.includes('"event":"setup.code"') ? hideSetupCode(line) : line);
  });

  // Listen before starting: a signal that arrives during startup must still stop cleanly.
  const stopRequested = new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });

  const notifier = new Notifier({
    channel:
      config.notify.barkDeviceKeys.length === 0
        ? undefined
        : new BarkChannel({ server: config.notify.barkServer, deviceKeys: config.notify.barkDeviceKeys, url: config.origin }),
    events: config.notify.events,
    lang: config.notify.lang,
    timeZone: config.notify.timeZone,
    logger,
  });
  const notify = notifier.notify;

  const client = new HttpCloudflareClient(config.cloudflare);
  const sync = new CloudflareSync({
    client,
    desired: () => desiredTargets(service.current, systemClock()),
    services: () => service.registeredServices,
    clock: systemClock,
    logger,
    notify,
  });
  const service = new VisaService({
    maxLifetime: config.maxLifetime,
    ownHostname: new URL(config.origin).hostname,
    zones: () => client.listZones(),
    store: new FileStore(config.dataFile),
    sync,
    logger,
    clock: systemClock,
    notify,
  });
  try {
    await service.start();
  } catch (error) {
    logger.error(error instanceof StoreError ? "store.invalid" : "service.start_failed", {
      error: errorMessage(error),
    });
    return 1;
  }

  const authenticator = new Authenticator<Action>({
    keeper: service.keeper,
    rpId: config.rpId,
    origin: config.origin,
    setupToken: config.setupToken,
    logger,
    clock: systemClock,
    notify,
    narrowsAccess: (action) => action.kind === "revoke",
  });
  authenticator.start();
  const blocklist = new Blocklist({ keeper: service.keeper, clock: systemClock, logger, notify });

  const socketPath = adminSocketPath(config.dataFile);
  let admin;
  try {
    admin = await startAdminServer(
      socketPath,
      async (command) => {
        if (command.command === "unblock") {
          try {
            return { ok: true, removed: await blocklist.unblock(command.target) };
          } catch (error) {
            return { ok: false, error: errorMessage(error) };
          }
        }
        const { revokeAll } = command;
        await authenticator.reset();
        const revokedVisas = revokeAll ? (await service.revokeAll()).revoked : 0;
        logger.warn("passkeys.reset", { revokedVisas });
        notify({ type: "passkeys_reset", revokedVisas });
        return { ok: true, revokedVisas };
      },
      logger,
    );
  } catch (error) {
    // Without the socket there is no way to reset lost passkeys, so do not run.
    logger.error("admin.listen_failed", { error: errorMessage(error) });
    await service.stop();
    return 1;
  }

  const server = createServer(
    { requestTimeout: 15_000, headersTimeout: 10_000 },
    createHandler({
      service,
      authenticator,
      rpId: config.rpId,
      origin: config.origin,
      durations: config.durations,
      maxLifetime: config.maxLifetime,
      ipv6Prefix: config.ipv6Prefix,
      manualIssue: config.manualIssue,
      assets: await loadAssets(),
      limiter: new RateLimiter({ burst: 20, refillEvery: 3000, maxSources: 10_000, clock: systemClock }),
      blocklist,
      ...(config.ipinfo === undefined
        ? {}
        : { geo: new GeoLookup({ token: config.ipinfo.token, plan: config.ipinfo.plan, clock: systemClock, logger }) }),
      logger,
      clock: systemClock,
    }),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.listen.port, config.listen.host, () => resolve());
    });
  } catch (error) {
    logger.error("http.listen_failed", { error: errorMessage(error) });
    await closeAdminServer(admin, socketPath);
    await service.stop();
    return 1;
  }
  logger.info("http.listen", { host: config.listen.host, port: config.listen.port });

  const heartbeatUrl = config.heartbeatUrl;
  const heartbeat =
    heartbeatUrl === undefined ? undefined : new Heartbeat({ url: heartbeatUrl, status: () => sync.status(), logger });
  const heartbeatTimer = heartbeat === undefined ? undefined : setInterval(() => void heartbeat.beat(), 60_000);

  let renewTimer: NodeJS.Timeout | undefined;
  if (config.renewal.enabled) {
    const renewer = new Renewer({
      service,
      client,
      services: () => service.registeredServices,
      maxLifetime: config.maxLifetime,
      activeWindow: config.renewal.activeWindow,
      renewBy: config.renewal.renewBy,
      ignorePaths: config.renewal.ignorePaths,
      clock: systemClock,
      logger,
      notify,
    });
    await renewer.probe();
    if (renewer.enabled) {
      logger.info("renew.enabled", { checkpoints: "10m,5m,3m,1m" });
      renewTimer = setInterval(() => void renewer.tick(), 30_000);
    }
  }

  await stopRequested;
  clearInterval(heartbeatTimer);
  clearInterval(renewTimer);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  await closeAdminServer(admin, socketPath);
  await service.stop();
  // Give notifications already under way (the expiry on shutdown, for example) a short moment.
  await Promise.race([notifier.idle(), new Promise((done) => setTimeout(done, 3000).unref())]);
  logFile.close();
  return 0;
}

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2), process.env);
}
