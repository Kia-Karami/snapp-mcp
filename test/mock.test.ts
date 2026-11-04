import { test } from "node:test";
import assert from "node:assert/strict";
import { MockSnappAdapter } from "../src/adapters/mock.js";

const tajrish = { lat: 35.8045, lng: 51.4339, label: "Tajrish" };
const azadi = { lat: 35.6997, lng: 51.338, label: "Azadi Tower" };

function setup() {
  let now = 1_700_000_000_000;
  const adapter = new MockSnappAdapter({ speed: 1, now: () => now, random: () => 0.5 });
  return { adapter, advance: (sec: number) => (now += sec * 1000) };
}

test("quotes cover every service and expire after 5 minutes", async () => {
  const { adapter, advance } = setup();
  const quotes = await adapter.getQuotes(tajrish, azadi);
  assert.deepEqual(quotes.map((q) => q.service), ["classic", "plus", "rose", "bike"]);
  const classic = quotes[0]!, plus = quotes[1]!;
  assert.ok(plus.priceToman > classic.priceToman);
  advance(301);
  await assert.rejects(adapter.requestRide(classic.quoteId), /expired/);
});

test("ride moves through its whole lifecycle", async () => {
  const { adapter, advance } = setup();
  const [q] = await adapter.getQuotes(tajrish, azadi, ["classic"]);
  const ride = await adapter.requestRide(q!.quoteId);
  assert.equal(ride.status, "searching");
  assert.equal(ride.driver, undefined);

  advance(21);
  let s = (await adapter.getRide(ride.rideId))!;
  assert.equal(s.status, "driver_assigned");
  assert.ok(s.driver?.plate);

  advance(q!.pickupEtaMinutes * 60);
  assert.equal((await adapter.getRide(ride.rideId))!.status, "driver_arrived");
  advance(61);
  assert.equal((await adapter.getRide(ride.rideId))!.status, "on_trip");
  advance(q!.tripMinutes * 60);
  s = (await adapter.getRide(ride.rideId))!;
  assert.equal(s.status, "completed");
  assert.equal(await adapter.getActiveRide(), undefined);
});

test("quote books at most one ride, one active ride at a time", async () => {
  const { adapter } = setup();
  const [a, b] = await adapter.getQuotes(tajrish, azadi, ["classic", "plus"]);
  await adapter.requestRide(a!.quoteId);
  await assert.rejects(adapter.requestRide(a!.quoteId), /unknown or expired/);
  await assert.rejects(adapter.requestRide(b!.quoteId), /already have an active ride/);
});

test("cancel is free early and charges a fee late", async () => {
  const { adapter, advance } = setup();
  const [q1] = await adapter.getQuotes(tajrish, azadi, ["classic"]);
  const r1 = await adapter.requestRide(q1!.quoteId);
  advance(60); // driver assigned 40s ago
  assert.equal((await adapter.cancelRide(r1.rideId)).feeToman, 0);
  await assert.rejects(adapter.cancelRide(r1.rideId), /cancelled/);

  const [q2] = await adapter.getQuotes(tajrish, azadi, ["classic"]);
  const r2 = await adapter.requestRide(q2!.quoteId);
  advance(20 + 150); // driver assigned 150s ago
  const res = await adapter.cancelRide(r2.rideId, "changed plans");
  assert.equal(res.feeToman, 15_000);
  assert.equal(res.ride.status, "cancelled");
  advance(10_000); // a cancelled ride stays cancelled
  assert.equal((await adapter.getRide(r2.rideId))!.status, "cancelled");
});

import { parseTehranTime } from "../src/server.js";

test("parses Tehran-local times", () => {
  assert.equal(parseTehranTime("2026-11-05T08:00"), Date.UTC(2026, 10, 5, 4, 30) / 1000);
  assert.equal(parseTehranTime("1793802600"), 1793802600);
  assert.throws(() => parseTehranTime("tomorrow"));
});
