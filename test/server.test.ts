import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MockSnappAdapter } from "../src/adapters/mock.js";
import { PlaceStore } from "../src/places.js";
import { createServer } from "../src/server.js";

async function connect(speed = 1) {
  const dir = mkdtempSync(join(tmpdir(), "snapp-mcp-"));
  const server = createServer(new MockSnappAdapter({ speed, random: () => 0.5 }), new PlaceStore(join(dir, "state.json")));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content[0]!.text, isError: !!r.isError };
  };
  return { client, call, dir };
}

test("agent flow: places -> location -> quote -> book -> status -> cancel", async () => {
  const { client, call, dir } = await connect();
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, [
    "cancel_ride", "cancel_scheduled_ride", "change_destination", "get_current_location", "get_ride_quotes",
    "get_ride_status", "get_schedule_quote", "list_places", "list_rides", "list_scheduled_rides",
    "preview_destination_change", "remove_place", "request_ride", "save_place", "schedule_ride",
    "set_current_location", "suggest_places", "wait_for_ride_update",
  ]);

  assert.match((await call("get_current_location")).text, /isn't set/);
  assert.equal((await call("get_ride_quotes", { destination: "work" })).isError, true);

  await call("save_place", { name: "Home", lat: 35.8045, lng: 51.4339, address: "Tajrish" });
  await call("save_place", { name: "work", lat: 35.7575, lng: 51.41 });
  assert.match((await call("set_current_location", { location: "home" })).text, /Home/);

  const quotes = await call("get_ride_quotes", { destination: "work", services: ["classic"] });
  assert.equal(quotes.isError, false);
  const quoteId = quotes.text.match(/quote_id (q_\w+)/)![1]!;
  const price = Number(quotes.text.match(/: ([\d,]+) Toman/)![1]!.replace(/,/g, ""));

  const wrong = await call("request_ride", { quote_id: quoteId, confirmed_price_toman: price + 1000 });
  assert.equal(wrong.isError, true);
  assert.match(wrong.text, /Price mismatch.*Nothing was booked/);
  assert.match((await call("request_ride", { quote_id: quoteId, confirmed_price_toman: price })).text, /looking for a driver/);
  assert.match((await call("get_ride_status")).text, /looking for a driver/);
  assert.match((await call("cancel_ride", { reason: "test" })).text, /cancelled \(no fee\)/);
  assert.match((await call("get_ride_status")).text, /no active ride/);
  assert.match((await call("list_rides")).text, /cancelled/);

  // State persists across a new store on the same file.
  const reopened = new PlaceStore(join(dir, "state.json"));
  assert.equal(reopened.getCurrent()?.label, "Home (Tajrish)");
  assert.equal(reopened.list().length, 2);
});

async function bookClassic(call: Awaited<ReturnType<typeof connect>>["call"]) {
  await call("save_place", { name: "home", lat: 35.8045, lng: 51.4339 });
  await call("save_place", { name: "work", lat: 35.7575, lng: 51.41 });
  await call("set_current_location", { location: "home" });
  const q = await call("get_ride_quotes", { destination: "work", services: ["classic"] });
  const quoteId = q.text.match(/quote_id (q_\w+)/)![1]!;
  const price = Number(q.text.match(/: ([\d,]+) Toman/)![1]!.replace(/,/g, ""));
  return call("request_ride", { quote_id: quoteId, confirmed_price_toman: price });
}

test("wait_for_ride_update returns when the driver is found", async () => {
  process.env.SNAPP_POLL_MS = "20";
  const { call } = await connect(200); // 200x clock: driver found after ~0.1s
  await bookClassic(call);
  const u = await call("wait_for_ride_update", { timeout_seconds: 5 });
  assert.match(u.text, /^Update: .*on the way to pick you up/);
});

test("change destination: preview, mismatch guard, then change", async () => {
  process.env.SNAPP_POLL_MS = "20";
  const { call } = await connect(200);
  await bookClassic(call);
  await call("wait_for_ride_update", { timeout_seconds: 5 }); // driver assigned
  const p = await call("preview_destination_change", { destination: "35.70,51.34" });
  const price = Number(p.text.match(/cost ([\d,]+) Toman/)![1]!.replace(/,/g, ""));
  const bad = await call("change_destination", { destination: "35.70,51.34", confirmed_price_toman: price - 1000 });
  assert.match(bad.text, /Price mismatch.*Nothing was changed/);
  const good = await call("change_destination", { destination: "35.70,51.34", confirmed_price_toman: price });
  assert.match(good.text, /Destination changed to 35.70,51.34/);
});

test("schedule a ride for later, list it, cancel it", async () => {
  const { call } = await connect();
  await call("save_place", { name: "home", lat: 35.8045, lng: 51.4339 });
  await call("save_place", { name: "work", lat: 35.7575, lng: 51.41 });
  const at = new Date(Math.ceil((Date.now() + 3 * 3600_000) / 300_000) * 300_000);
  const q = await call("get_schedule_quote", { origin: "home", destination: "work", time: String(Math.round(at.getTime() / 1000)) });
  assert.equal(q.isError, false, q.text);
  const id = q.text.match(/schedule_quote_id (sq_\w+)/)![1]!;
  const hi = Number(q.text.match(/to ([\d,]+) Toman \(/)![1]!.replace(/,/g, ""));
  assert.match((await call("schedule_ride", { schedule_quote_id: id, confirmed_max_price_toman: hi + 1 })).text, /Price mismatch/);
  const s = await call("schedule_ride", { schedule_quote_id: id, confirmed_max_price_toman: hi });
  const sid = s.text.match(/id (s_\w+)/)![1]!;
  assert.match((await call("list_scheduled_rides")).text, new RegExp(sid));
  await call("cancel_scheduled_ride", { schedule_id: sid });
  assert.match((await call("list_scheduled_rides")).text, /No upcoming/);
});

test("suggest_places ranks addresses from ride history", async () => {
  const { call } = await connect();
  await bookClassic(call);
  await call("cancel_ride", {});
  const s = await call("suggest_places", {});
  assert.match(s.text, /home.*saved as "home"/s);
});

test("two-stop ride: quote costs more, books, and keeps both stops", async () => {
  const { call } = await connect();
  await call("save_place", { name: "home", lat: 35.8045, lng: 51.4339 });
  await call("save_place", { name: "work", lat: 35.7575, lng: 51.41 });
  await call("save_place", { name: "gym", lat: 35.7, lng: 51.39 });
  await call("set_current_location", { location: "home" });
  const one = await call("get_ride_quotes", { destination: "work", services: ["classic"] });
  const two = await call("get_ride_quotes", { destination: "work", second_destination: "gym", services: ["classic"] });
  const p = (t: string) => Number(t.match(/: ([\d,]+) Toman/)![1]!.replace(/,/g, ""));
  assert.match(two.text, /Quotes for home to work, then gym/);
  assert.ok(p(two.text) > p(one.text));
  const id = two.text.match(/quote_id (q_\w+)/)![1]!;
  const b = await call("request_ride", { quote_id: id, confirmed_price_toman: p(two.text) });
  assert.match(b.text, /looking for a driver/);
  assert.match(b.text, /"secondDestination"[\s\S]*"label": "gym"/);
});
