// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import { chmod, rm } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { dirname, join, resolve } from "node:path";
import { errorMessage, type Logger } from "./log.ts";

// Commands from the server's shell reach the running service through a Unix
// socket next to the data file, so only one process ever writes that file.
// Whoever can open the socket can already read and write the data file.

export type AdminCommand =
  | { readonly command: "reset-passkeys"; readonly revokeAll: boolean }
  | { readonly command: "unblock"; readonly target: string };
export type AdminReply =
  | { readonly ok: true; readonly revokedVisas?: number; readonly removed?: number }
  | { readonly ok: false; readonly error: string };

export const MAX_ADMIN_MESSAGE = 4096;
// Unix socket paths are limited to 104 bytes on macOS and 108 on Linux, counting the terminator.
export const MAX_SOCKET_PATH = 103;

export function adminSocketPath(dataFile: string): string {
  return join(dirname(resolve(dataFile)), "admin.sock");
}

export function parseAdminCommand(line: string): AdminCommand | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { command, ...rest } = value as Record<string, unknown>;
  if (command === "reset-passkeys") {
    const { revokeAll, ...others } = rest;
    if (Object.keys(others).length > 0 || typeof revokeAll !== "boolean") return undefined;
    return { command, revokeAll };
  }
  if (command === "unblock") {
    const { target, ...others } = rest;
    // The service checks the address itself; this only bounds what it is handed.
    if (Object.keys(others).length > 0 || typeof target !== "string" || !/^[0-9A-Za-z:./]{1,64}$/.test(target)) return undefined;
    return { command, target };
  }
  return undefined;
}

export async function startAdminServer(
  path: string,
  handle: (command: AdminCommand) => Promise<AdminReply>,
  logger: Logger,
): Promise<Server> {
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH) {
    throw new Error(
      `the admin socket path ${path} is longer than ${MAX_SOCKET_PATH} bytes; put DATA_FILE in a shorter directory`,
    );
  }
  // A socket file left by a process that did not shut down cleanly blocks listen().
  await rm(path, { force: true });
  const server = createServer((socket) => {
    let buffer = "";
    let answered = false;
    const reply = (message: AdminReply) => {
      if (answered) return;
      answered = true;
      socket.end(`${JSON.stringify(message)}\n`);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(10_000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", (chunk: string) => {
      if (answered) return;
      buffer += chunk;
      if (buffer.length > MAX_ADMIN_MESSAGE) return reply({ ok: false, error: "message too long" });
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const command = parseAdminCommand(buffer.slice(0, newline));
      if (command === undefined) return reply({ ok: false, error: "unknown command" });
      handle(command).then(reply, (error: unknown) => {
        logger.error("admin.failed", { command: command.command, error: errorMessage(error) });
        reply({ ok: false, error: "the command failed; see the service log" });
      });
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    try {
      server.listen(path, () => {
        server.off("error", reject);
        resolvePromise();
      });
    } catch (error) {
      // Some failures (an invalid path) are thrown rather than emitted.
      reject(error);
    }
  });
  await chmod(path, 0o600);
  return server;
}

export async function closeAdminServer(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  await rm(path, { force: true });
}

export function sendAdminCommand(path: string, command: AdminCommand, timeout = 60_000): Promise<AdminReply> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(path);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.setTimeout(timeout, () => socket.destroy(new Error("the service did not answer in time")));
    socket.on("connect", () => socket.write(`${JSON.stringify(command)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        resolvePromise(JSON.parse(buffer) as AdminReply);
      } catch {
        reject(new Error("the service sent an unreadable reply"));
      }
    });
  });
}
