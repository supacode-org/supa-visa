// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { CloudflareError, HttpCloudflareClient } from "../src/cloudflare.ts";

const TOKEN = "secret-token-value";
const ITEM_1 = "0123456789abcdef0123456789abcd01";
const ITEM_2 = "0123456789abcdef0123456789abcd02";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(responses: (Response | Error)[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(input),
      headers: init?.headers as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const next = responses.shift();
    if (next === undefined) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

function ok(result: unknown, extra: Record<string, unknown> = {}): Response {
  return Response.json({ success: true, errors: [], messages: [], result, ...extra });
}

function failure(status: number, code = 10000, message = "failure"): Response {
  return Response.json({ success: false, errors: [{ code, message }], messages: [], result: null }, { status });
}

function client(responses: (Response | Error)[]) {
  const fake = fakeFetch(responses);
  const lists = new HttpCloudflareClient({
    apiToken: TOKEN,
    accountId: "acc",
    listId: "lst",
    baseUrl: "https://api.test/client/v4",
    fetch: fake.fetch,
  });
  return { lists, calls: fake.calls };
}

test("lists items across pages", async () => {
  const { lists, calls } = client([
    ok([{ id: ITEM_1, ip: "203.0.113.7", comment: "c" }], { result_info: { cursors: { after: "next page" } } }),
    ok([{ id: ITEM_2, ip: "2001:db8::/48" }], { result_info: { cursors: {} } }),
  ]);
  assert.deepEqual(await lists.listItems(), [
    { id: ITEM_1, ip: "203.0.113.7", comment: "c" },
    { id: ITEM_2, ip: "2001:db8::/48" },
  ]);
  assert.equal(calls[0]?.url, "https://api.test/client/v4/accounts/acc/rules/lists/lst/items?per_page=500");
  assert.equal(calls[1]?.url, "https://api.test/client/v4/accounts/acc/rules/lists/lst/items?per_page=500&cursor=next+page");
  assert.equal(calls[0]?.headers.authorization, `Bearer ${TOKEN}`);
});

test("creates and deletes items and returns the operation id", async () => {
  const { lists, calls } = client([ok({ operation_id: "op1" }), ok({ operation_id: "op2" })]);
  assert.equal(await lists.createItems([{ ip: "203.0.113.7", comment: "supa-visa" }]), "op1");
  assert.equal(await lists.deleteItems(["a", "b"]), "op2");
  assert.deepEqual(
    calls.map(({ method, url, body }) => ({ method, url, body })),
    [
      {
        method: "POST",
        url: "https://api.test/client/v4/accounts/acc/rules/lists/lst/items",
        body: [{ ip: "203.0.113.7", comment: "supa-visa" }],
      },
      {
        method: "DELETE",
        url: "https://api.test/client/v4/accounts/acc/rules/lists/lst/items",
        body: { items: [{ id: "a" }, { id: "b" }] },
      },
    ],
  );
  assert.equal(calls[0]?.headers["content-type"], "application/json");
});

test("reads bulk operation status", async () => {
  const { lists, calls } = client([
    ok({ id: "op", status: "running" }),
    ok({ id: "op", status: "completed", completed: "2026-11-22T10:00:00Z" }),
    ok({ id: "op", status: "failed", error: "This list is at the maximum number of items" }),
    ok({ id: "op", status: "exploded" }),
  ]);
  assert.deepEqual(await lists.operationStatus("op"), { status: "running" });
  assert.deepEqual(await lists.operationStatus("op"), { status: "completed" });
  assert.deepEqual(await lists.operationStatus("op"), {
    status: "failed",
    error: "This list is at the maximum number of items",
  });
  await assert.rejects(lists.operationStatus("op"), CloudflareError);
  assert.equal(calls[0]?.url, "https://api.test/client/v4/accounts/acc/rules/lists/bulk_operations/op");
});

test("classifies failures", async () => {
  const cases: [Response | Error, string][] = [
    [failure(401, 10000, "Authentication error"), "auth"],
    [failure(403), "auth"],
    [failure(404, 10006, "list not found"), "rejected"],
    [failure(400), "rejected"],
    [failure(429), "retryable"],
    [failure(500), "retryable"],
    [failure(503), "retryable"],
    [new TypeError("fetch failed"), "retryable"],
    [Object.assign(new Error("timeout"), { name: "TimeoutError" }), "retryable"],
    [new Response("<html>bad gateway</html>", { status: 502 }), "retryable"],
    [Response.json({ success: false, errors: [{ code: 1, message: "nope" }] }, { status: 200 }), "rejected"],
  ];
  for (const [response, kind] of cases) {
    const { lists } = client([response]);
    await assert.rejects(lists.listItems(), (error: unknown) => {
      assert.ok(error instanceof CloudflareError);
      assert.equal(error.kind, kind, error.message);
      assert.ok(!error.message.includes(TOKEN));
      assert.ok(!error.message.includes("acc"), "no account id in messages");
      return true;
    });
  }
});

test("error messages hide the account and list ids Cloudflare echoes back", async () => {
  const account = "0123456789abcdef0123456789abcdef";
  const list = "fedcba9876543210fedcba9876543210";
  const fake = fakeFetch([
    failure(404, 7003, `Could not route to /client/v4/accounts/${account}/rules/lists/${list}/items, perhaps your object identifier is invalid?`),
  ]);
  const lists = new HttpCloudflareClient({ apiToken: TOKEN, accountId: account, listId: list, fetch: fake.fetch });
  await assert.rejects(lists.listItems(), (error: Error) => {
    assert.match(error.message, /accounts\/<account>\/rules\/lists\/<list>\/items/);
    return true;
  });
});

test("error messages carry Cloudflare's codes", async () => {
  const { lists } = client([failure(404, 10006, "list not found")]);
  await assert.rejects(lists.deleteItems(["x"]), /DELETE list items: HTTP 404 \(10006 list not found\)/);
});

test("rejects malformed successful responses", async () => {
  for (const response of [
    ok({}),
    ok([{ id: 1, ip: "203.0.113.7" }]),
    ok([{ id: "not-a-cloudflare-id", ip: "203.0.113.7" }]),
    ok([{ id: ITEM_1 }]),
  ]) {
    const { lists } = client([response]);
    await assert.rejects(lists.listItems(), CloudflareError);
  }
  const { lists } = client([ok({})]);
  await assert.rejects(lists.createItems([]), /operation id/);
});

test("reads Retry-After from a rate-limited answer", async () => {
  const limited = new Response(JSON.stringify({ success: false, errors: [{ code: 971, message: "Please wait" }] }), {
    status: 429,
    headers: { "retry-after": "120" },
  });
  const { lists } = client([limited]);
  await assert.rejects(lists.listItems(), (error: CloudflareError) => error.retryAfter === 120_000);
});

function graphql(body: unknown): Response {
  return Response.json(body);
}

test("asks analytics for active clients with every value as a variable", async () => {
  const { lists, calls } = client([
    graphql({
      data: {
        viewer: {
          zones: [
            {
              httpRequestsAdaptiveGroups: [
                { dimensions: { clientIP: "2001:db8:0:0::1", datetimeMinute: "2026-11-22T10:05:00Z" } },
                { dimensions: { clientIP: "2001:db8::1", datetimeMinute: "2026-11-22T10:09:00Z" } },
                { dimensions: { clientIP: "203.0.113.7", datetimeMinute: "2026-11-22T10:01:00Z" } },
                { dimensions: { clientIP: "203.0.113.0/24", datetimeMinute: "2026-11-22T10:01:00Z" } },
                { dimensions: { clientIP: "not an ip", datetimeMinute: "2026-11-22T10:01:00Z" } },
                { dimensions: { clientIP: 7, datetimeMinute: "2026-11-22T10:01:00Z" } },
                { dimensions: { clientIP: "198.51.100.1", datetimeMinute: "yesterday" } },
                null,
              ],
            },
          ],
        },
      },
      errors: null,
    }),
  ]);
  const hostile = 'a.example.com" } ) { x';
  const active = await lists.activeClients("z".repeat(32), [hostile], Date.parse("2026-11-22T10:00:00Z"), Date.parse("2026-11-22T10:15:00Z"), ["/healthz"]);
  assert.deepEqual(active, [
    { ip: "2001:db8::1", lastMinute: Date.parse("2026-11-22T10:09:00Z") },
    { ip: "203.0.113.7", lastMinute: Date.parse("2026-11-22T10:01:00Z") },
  ]);
  const call = calls[0] as Call;
  assert.equal(call.method, "POST");
  assert.equal(call.url, "https://api.test/client/v4/graphql");
  const body = call.body as { query: string; variables: Record<string, unknown> };
  assert.ok(!body.query.includes(hostile) && !body.query.includes("z".repeat(32)) && !body.query.includes("/healthz"));
  assert.match(body.query, /securityAction_neq: "block"/);
  assert.match(body.query, /originResponseStatus_gt: 0/, "only requests that passed the block rule");
  assert.deepEqual(body.variables, {
    zone: "z".repeat(32),
    since: "2026-11-22T10:00:00.000Z",
    until: "2026-11-22T10:15:00.000Z",
    hosts: [hostile],
    ignore: ["/healthz"],
  });
});

test("leaves the path filter out when nothing is ignored", async () => {
  const { lists, calls } = client([graphql({ data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [] }] } } })]);
  assert.deepEqual(await lists.activeClients("z", ["a.example.com"], 0, 1, []), []);
  const body = calls[0]?.body as { query: string; variables: Record<string, unknown> };
  assert.ok(!body.query.includes("$ignore"));
  assert.equal("ignore" in body.variables, false);
});

test("classifies analytics errors and malformed answers", async () => {
  const { lists } = client([
    graphql({ data: null, errors: [{ message: "not authorized for secret-token-value" }] }),
    graphql({ data: null, errors: [{ message: "unknown field" }] }),
    graphql({ data: { viewer: { zones: [] } } }),
    failure(403),
  ]);
  await assert.rejects(lists.activeClients("z", ["a.example.com"], 0, 1, []), (error: unknown) => {
    assert.ok(error instanceof CloudflareError);
    assert.equal(error.kind, "auth");
    assert.ok(!error.message.includes(TOKEN));
    return true;
  });
  await assert.rejects(lists.activeClients("z", ["a.example.com"], 0, 1, []), { kind: "rejected" });
  await assert.rejects(lists.activeClients("z", ["a.example.com"], 0, 1, []), CloudflareError);
  await assert.rejects(lists.activeClients("z", ["a.example.com"], 0, 1, []), { kind: "auth" });
});
