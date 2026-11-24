// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { HOUR } from "../src/duration.ts";
import { GeoLookup, parseGeo } from "../src/geo.ts";
import { FakeClock, recordingLogger } from "./helpers.ts";

const TOKEN = "ipinfoToken12345";

function fakeIpinfo(respond: (url: string) => Response | Promise<Response>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    return respond(url);
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

test("keeps only well-formed fields from Lite and Core answers", () => {
  assert.deepEqual(parseGeo({ ip: "8.8.8.8", asn: "AS15169", as_name: "Google LLC", country_code: "US", country: "United States" }, "lite"), {
    countryCode: "US",
    country: "United States",
    asn: "AS15169",
    asName: "Google LLC",
  });
  assert.deepEqual(
    parseGeo({ ip: "8.8.8.8", geo: { city: "Mountain View", country: "United States", country_code: "US" }, as: { asn: "AS15169", name: "Google LLC" } }, "core"),
    { countryCode: "US", country: "United States", city: "Mountain View", asn: "AS15169", asName: "Google LLC" },
  );
  assert.equal(parseGeo({ ip: "10.0.0.1", bogon: true }, "lite"), null);
  assert.deepEqual(parseGeo({ country_code: "usa", country: "<script>x</script>", asn: "15169", as_name: "x".repeat(81) }, "lite"), null);
  assert.deepEqual(parseGeo({ country: "Taiwan", as_name: "line\nbreak" }, "lite"), { country: "Taiwan" });
  assert.equal(parseGeo("nope", "lite"), null);
});

test("sends the token in a header only, and caches answers", async () => {
  const time = new FakeClock(0);
  const { logger } = recordingLogger(time.clock);
  const ipinfo = fakeIpinfo(() => Response.json({ country_code: "TW", country: "Taiwan", asn: "AS3462", as_name: "Chunghwa Telecom" }));
  const geo = new GeoLookup({ token: TOKEN, plan: "lite", clock: time.clock, logger, fetch: ipinfo.fetch });
  const first = await geo.lookUp(["9.9.9.9", "2606:4700:4700::"]);
  assert.equal(first.get("9.9.9.9")?.country, "Taiwan");
  assert.deepEqual(ipinfo.calls.map((call) => call.url).sort(), ["https://api.ipinfo.io/lite/2606%3A4700%3A4700%3A%3A", "https://api.ipinfo.io/lite/9.9.9.9"]);
  assert.ok(ipinfo.calls.every((call) => call.headers.authorization === `Bearer ${TOKEN}` && !call.url.includes(TOKEN)));

  await geo.lookUp(["9.9.9.9"]);
  assert.equal(ipinfo.calls.length, 2, "cached");
  time.now = 25 * HOUR;
  await geo.lookUp(["9.9.9.9"]);
  assert.equal(ipinfo.calls.length, 3, "looked up again after a day");
});

test("failures and slow answers never hold the owner's view", async () => {
  const time = new FakeClock(0);
  const { logger, entries } = recordingLogger(time.clock);
  const slow = fakeIpinfo(() => new Promise<Response>(() => {}));
  const geo = new GeoLookup({ token: TOKEN, plan: "lite", clock: time.clock, logger, fetch: slow.fetch, timeout: 50 });
  const started = Date.now();
  assert.equal((await geo.lookUp(["9.9.9.9"])).get("9.9.9.9"), null);
  assert.ok(Date.now() - started < 1000);

  const limited = fakeIpinfo(() => new Response("Too many", { status: 429 }));
  const second = new GeoLookup({ token: TOKEN, plan: "lite", clock: time.clock, logger, fetch: limited.fetch });
  assert.equal((await second.lookUp(["9.9.9.9"])).get("9.9.9.9"), null);
  assert.ok(entries.some((entry) => entry.event === "geo.failed" && entry.status === 429));
  assert.ok(!JSON.stringify(entries).includes(TOKEN));
});
