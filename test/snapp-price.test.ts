import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrices } from "../src/adapters/snapp.js";

const a = { lat: 35.6997, lng: 51.338, label: "Azadi" };
const b = { lat: 35.8045, lng: 51.4339, label: "Tajrish" };

// Trimmed from a real /v3/price response (2026-11-04).
const body = {
  status: 200,
  data: {
    ttl: 359,
    services: [
      { id: 1, enabled: true, price: { final: 4560000 }, info: { name: "اسنپ", description: "به صرفه" }, estimation: { eta: [56] } },
      { id: 24, enabled: true, price: { final: 2670000 }, info: { name: "سفر اشتراکی" }, estimation: {} },
      { id: 7, enabled: false, price: { final: 1000000 }, info: { name: "موتور" } },
      { id: 9, enabled: true, price: { final: null }, info: { name: "پیک" } },
    ],
  },
};

test("parses Snapp prices, converts Rial to Toman, skips disabled/unpriced", () => {
  const q = parsePrices(body, a, b);
  assert.deepEqual(q.map((x) => [x.service, x.serviceName, x.priceToman]), [
    ["1", "اسنپ - به صرفه", 456000],
    ["24", "سفر اشتراکی", 267000],
  ]);
  assert.equal(q[0]!.tripMinutes, 56);
  assert.ok(Number.isNaN(q[1]!.tripMinutes));
});

import { mapState, parseHistoryRide } from "../src/adapters/snapp.js";

test("maps Snapp ride states", () => {
  assert.deepEqual([1, 2, 3, 4, 16, 5, 9, 6, 7, 19].map(mapState), [
    "searching", "driver_assigned", "driver_arrived", "on_trip", "on_trip", "completed",
    "no_driver_found", "cancelled", "cancelled", "cancelled",
  ]);
});

test("parses a history ride (shape from /v3/passenger/ride/history)", () => {
  const r = parseHistoryRide({
    human_readable_id: "SNP-1", latest_ride_status: 5, final_price: 4560000, created_at: "2026-11-04",
    origin: { lat: 35.7, lng: 51.3, formatted_address: "A" }, destination: { lat: 35.8, lng: 51.4, formatted_address: "B" },
    service_type: { type: "1", name: "اسنپ" }, driver_name: "X", vehicle_model: "Pride",
  });
  assert.equal(r.rideId, "SNP-1");
  assert.equal(r.status, "completed");
  assert.equal(r.priceToman, 456000);
  assert.equal(r.origin.label, "A");
  assert.equal(r.driver?.car, "Pride");
});
