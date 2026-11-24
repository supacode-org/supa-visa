// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";
import { VERSION } from "../src/version.ts";
import { temporaryDirectory } from "./helpers.ts";

const execFileAsync = promisify(execFile);
const mainPath = fileURLToPath(new URL("../src/main.ts", import.meta.url));

const VALID_ENV = {
  CF_API_TOKEN: "token",
  CF_ACCOUNT_ID: "account",
  CF_LIST_ID: "list",
  RP_ID: "visa.example.com",
  ORIGIN: "https://visa.example.com",
  // Nothing listens here, so a test that forgets its fake server fails instead of reaching Cloudflare.
  CF_API_BASE_URL: "http://127.0.0.1:9/client/v4",
};

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// A local stand-in for the Lists API with one item on the list.
async function fakeCloudflare(t: TestContext): Promise<{ baseUrl: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url} ${request.headers.authorization}`);
    const reply = (result: unknown) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ success: true, errors: [], messages: [], result, result_info: { cursors: {} } }));
    };
    if (request.method === "GET" && request.url?.startsWith("/client/v4/accounts/account/rules/lists/list/items")) {
      return reply([{ id: "0123456789abcdef0123456789abcd01", ip: "192.0.2.1" }]);
    }
    if (request.method === "GET" && request.url === "/client/v4/accounts/account/rules/lists/list") {
      return reply({ id: "list", name: "supa_visa", kind: "ip" });
    }
    if (request.method === "GET" && request.url?.startsWith("/client/v4/zones?")) return reply([]);
    if (request.method === "DELETE") return reply({ operation_id: "op" });
    if (request.url?.endsWith("/bulk_operations/op")) return reply({ id: "op", status: "completed" });
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`, requests };
}

async function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [mainPath, ...args], {
      env: { PATH: process.env.PATH ?? "", ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}

function logLines(stdout: string): Record<string, unknown>[] {
  return stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

test("--version prints the version", async () => {
  const result = await runCli(["--version"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), VERSION);
});

test("unknown arguments print usage and exit with 2", async () => {
  const result = await runCli(["--nope"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Usage:/);
});

test("refuses to start without configuration", async () => {
  const result = await runCli([]);
  assert.equal(result.code, 1);
  const [entry] = logLines(result.stdout);
  assert.equal(entry?.event, "config.invalid");
  assert.ok((entry?.errors as string[]).includes("CF_API_TOKEN is required"));
});

test("refuses to start with a corrupt data file", async (t) => {
  const directory = await temporaryDirectory(t);
  const dataFile = join(directory, "visa.json");
  await writeFile(dataFile, "[]");
  const result = await runCli([], { ...VALID_ENV, DATA_FILE: dataFile });
  assert.equal(result.code, 1);
  assert.equal(logLines(result.stdout).at(-1)?.event, "store.invalid");
  assert.equal(await readFile(dataFile, "utf8"), "[]");
});

test("starts, syncs with Cloudflare, and stops cleanly on SIGTERM", async (t) => {
  const directory = await temporaryDirectory(t);
  const cloudflare = await fakeCloudflare(t);
  const child = spawn(process.execPath, [mainPath], {
    env: {
      PATH: process.env.PATH ?? "",
      ...VALID_ENV,
      CF_API_BASE_URL: cloudflare.baseUrl,
      DATA_FILE: join(directory, "visa.json"),
      LISTEN: `127.0.0.1:${await freePort()}`,
    },
  });
  let stdout = "";
  let signalled = false;
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (!signalled && stdout.includes('"rules.complete"')) {
      signalled = true;
      child.kill("SIGTERM");
    }
  });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, 0);
  const entries = logLines(stdout);
  const events = entries.map((entry) => entry.event);
  // Listening and the first sync run side by side, so only their own order is fixed.
  assert.deepEqual(events.slice(0, 2), ["service.start", "setup.code"]);
  assert.equal(events.at(-1), "service.stop");
  assert.deepEqual([...events.slice(2, -1)].sort(), ["http.listen", "rules.complete", "sync.complete"]);
  assert.ok(events.indexOf("sync.complete") < events.indexOf("rules.complete"));
  const sync = entries.find((entry) => entry.event === "sync.complete");
  assert.deepEqual(sync, { ...sync, reason: "startup", added: 0, removed: 1 });
  assert.ok(cloudflare.requests.every((request) => request.endsWith("Bearer token")));
  assert.ok(!stdout.includes("Bearer"), "the token never reaches the logs");
});

test("reset-passkeys asks the running service, and says so when it is not running", async (t) => {
  const directory = await temporaryDirectory(t);
  const dataFile = join(directory, "visa.json");
  const notRunning = await runCli(["reset-passkeys"], { DATA_FILE: dataFile });
  assert.equal(notRunning.code, 1);
  assert.match(notRunning.stderr, /not running/);

  const cloudflare = await fakeCloudflare(t);
  await writeFile(
    dataFile,
    JSON.stringify({
      version: 1,
      visas: [
        {
          id: "v1",
          target: "203.0.113.7",
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          lastSeen: null,
          manual: false,
          renewals: 0,
        },
      ],
    }),
  );
  const child = spawn(process.execPath, [mainPath], {
    env: {
      PATH: process.env.PATH ?? "",
      ...VALID_ENV,
      CF_API_BASE_URL: cloudflare.baseUrl,
      DATA_FILE: dataFile,
      LISTEN: `127.0.0.1:${await freePort()}`,
    },
  });
  let stdout = "";
  const started = new Promise<void>((resolve) => {
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes('"setup.code"')) resolve();
    });
  });
  const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
  await started;

  const reset = await runCli(["reset-passkeys", "--revoke-all"], { DATA_FILE: dataFile });
  assert.equal(reset.code, 0, reset.stderr);
  assert.match(reset.stdout, /1 visas revoked/);
  assert.equal((await runCli(["reset-passkeys", "--everything"], { DATA_FILE: dataFile })).code, 2);

  const unblocked = await runCli(["unblock", "--all"], { DATA_FILE: dataFile });
  assert.deepEqual([unblocked.code, unblocked.stdout.trim()], [0, "Nothing was blocked."]);
  assert.equal((await runCli(["unblock", "203.0.113.7"], { DATA_FILE: dataFile })).code, 0);
  const bad = await runCli(["unblock", "not-an-ip"], { DATA_FILE: dataFile });
  assert.deepEqual([bad.code, bad.stderr.trim()], [2, "Give an IP address, an IPv6 /64, or --all."]);
  const wide = await runCli(["unblock", "203.0.113.0/24"], { DATA_FILE: dataFile });
  assert.equal(wide.code, 1);
  assert.match(wide.stderr, /single IP address or an IPv6 \/64/);
  assert.equal((await runCli(["unblock"], { DATA_FILE: dataFile })).code, 2);

  child.kill("SIGTERM");
  assert.equal(await closed, 0);
  const events = logLines(stdout).map((entry) => entry.event);
  assert.ok(events.includes("passkeys.reset"));
  assert.equal(events.filter((event) => event === "setup.code").length, 2, "a new code after the reset");
  assert.deepEqual(JSON.parse(await readFile(dataFile, "utf8")).visas, []);
});

test("refuses to run when the admin socket cannot be opened", async (t) => {
  const directory = join(await temporaryDirectory(t), "x".repeat(110));
  const cloudflare = await fakeCloudflare(t);
  const result = await runCli([], {
    ...VALID_ENV,
    CF_API_BASE_URL: cloudflare.baseUrl,
    DATA_FILE: join(directory, "visa.json"),
    LISTEN: `127.0.0.1:${await freePort()}`,
  });
  assert.equal(result.code, 1);
  const failure = logLines(result.stdout).find((entry) => entry.event === "admin.listen_failed");
  assert.match(String(failure?.error), /shorter directory/);
  assert.equal(result.stderr, "", "no stack trace");
});
