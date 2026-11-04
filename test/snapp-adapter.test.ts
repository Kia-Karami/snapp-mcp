import { test } from "node:test";
import assert from "node:assert/strict";
import { RealSnappAdapter } from "../src/adapters/snapp.js";
import type { SnappClient } from "../src/snapp/client.js";

// Fake client replaying response shapes seen from Snapp on 2026-11-04.
function fakeClient(state: { searching: boolean }) {
  const calls: string[] = [];
  const client = {
    async call(method: string, _base: string, path: string, body?: unknown) {
      calls.push(`${method} ${path} ${body ? JSON.stringify(body) : ""}`.trim());
      if (method === "GET" && path === "v2/passenger/ride") {
        return {
          data: {
            ride: null,
            started_ride: state.searching
              ? {
                  ride_info: {
                    ride_id: "SNP-T", current_state: 1, final_price: 1400000,
                    origin: { lat: 35.7575, lng: 51.4098, formatted_address: "Vanak Square" },
                    destination: { lat: 35.8045, lng: 51.4339, formatted_address: "Tajrish" },
                  },
                  service_type: { type: "1", name: "اسنپ" },
                }
              : null,
          },
        };
      }
      if (path.endsWith("/cancellation-reasons")) {
        return { data: { before_accept: [{ id: 101, reason: "عجله داشتم" }, { id: 102, reason: "از سفر منصرف شدم." }], accepted: [{ id: 201, reason: "x" }] } };
      }
      if (method === "PATCH") {
        state.searching = false;
        return { data: { message: "سفر با موفقیت لغو شد" } };
      }
      if (path.startsWith("v3/passenger/ride/history")) return { data: { rides: [] } };
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  return { client: client as unknown as SnappClient, calls };
}

test("a ride still searching (started_ride) counts as active and cancels via /waiting", async () => {
  const state = { searching: true };
  const { client, calls } = fakeClient(state);
  const a = new RealSnappAdapter(client);
  const ride = await a.getActiveRide();
  assert.equal(ride?.rideId, "SNP-T");
  assert.equal(ride?.status, "searching");
  assert.equal(ride?.priceToman, 140000);

  const res = await a.cancelRide("SNP-T", "test");
  assert.equal(res.ride.status, "cancelled");
  assert.ok(calls.some((c) => c === 'PATCH v2/passenger/ride/SNP-T/cancel/waiting {"cancellation_reason_id":102,"cancellation_description":"test"}'));
  assert.equal(await a.getActiveRide(), undefined);
});

import { formatPlate } from "../src/adapters/snapp.js";

test("formats Snapp plates and reads the driver from an accepted ride", async () => {
  assert.equal(formatPlate({ character: "هـ", type: 1, part_a: 15, part_b: 131, iran_id: 38 }), "15 هـ 131 - ایران 38");
  const client = {
    async call(_m: string, _b: string, path: string) {
      if (path === "v2/passenger/ride") {
        return {
          data: {
            ride: null,
            started_ride: {
              ride_info: { ride_id: "SNP-A", current_state: 2, final_price: 1620000 },
              driver: {
                driver_name: "سعید احمدی", vehicle_model: "پژو ۲۰۶ نقره‌ای",
                plate: { character: "هـ", part_a: 15, part_b: 131, iran_id: 38 },
              },
              driver_location_info: { lat: 35.7712, lng: 51.4213 },
            },
          },
        };
      }
      throw new Error(`unexpected ${path}`); // no separate driver-location call needed
    },
  } as unknown as SnappClient;
  const r = await new RealSnappAdapter(client).getActiveRide();
  assert.equal(r?.status, "driver_assigned");
  assert.equal(r?.driver?.plate, "15 هـ 131 - ایران 38");
  assert.deepEqual(r?.driver?.location, { lat: 35.7712, lng: 51.4213, label: "35.7712,51.4213" });
});

import { stopReached } from "../src/adapters/snapp.js";

test("real adapter sends the second stop to price and booking calls", async () => {
  const sent: { path: string; body: any }[] = [];
  const client = {
    async call(method: string, _b: string, path: string, body?: any) {
      sent.push({ path, body });
      if (path === "v3/price") return { data: { services: [{ id: 1, enabled: true, price: { final: 2000000 }, info: { name: "اسنپ" } }] } };
      if (path === "v2/passenger/ride" && method === "GET") return { data: { ride: null, started_ride: null } };
      if (path === "v2/passenger/ride" && method === "POST") return { data: { ride_id: "SNP-2" } };
      throw new Error(`unexpected ${path}`);
    },
  } as unknown as SnappClient;
  const a = new RealSnappAdapter(client);
  const o = { lat: 35.7575, lng: 51.4098, label: "Vanak Square" }, d = { lat: 35.8045, lng: 51.4339, label: "Tajrish" }, e = { lat: 35.7448, lng: 51.3753, label: "Milad Tower" };
  const [q] = await a.getQuotes(o, d, undefined, e);
  assert.equal(sent[0]!.body.points.length, 3);
  assert.deepEqual(sent[0]!.body.points[2], { lat: "35.7448", lng: "51.3753" });
  assert.equal(q!.secondDestination?.label, "Milad Tower");
  const ride = await a.requestRide(q!.quoteId);
  const book = sent.find((x) => x.path === "v2/passenger/ride" && x.body)!.body;
  assert.equal(book.extra_destination_lat, 35.7448);
  assert.equal(book.extra_destination_lng, 51.3753);
  assert.equal(ride.secondDestination?.label, "Milad Tower");
  assert.deepEqual([16, 17, 4].map(stopReached), [1, 2, undefined]);
});
