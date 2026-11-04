import { test } from "node:test";
import assert from "node:assert/strict";
import { NominatimGeocoder } from "../src/geocode.js";

test("geocoder sends policy headers, biases near the user, caches, and parses", async () => {
  const calls: { url: string; ua: string | null }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, ua: new Headers(init.headers).get("User-Agent") });
    return new Response(JSON.stringify([{ lat: "35.8045", lon: "51.4339", display_name: "میدان تجریش, ناحیه ۷, منطقه ۱ شهر تهران, تجریش, تهران, 19898-10006, ایران", type: "square" }]));
  }) as unknown as typeof fetch;
  const g = new NominatimGeocoder(fake);
  const near = { lat: 35.7, lng: 51.34 };
  const [m] = await g.search("میدان تجریش", near);
  assert.deepEqual(m, { lat: 35.8045, lng: 51.4339, label: "میدان تجریش، ناحیه ۷، منطقه ۱ شهر تهران", type: "square" });
  await g.search("میدان تجریش", near); // cached
  assert.equal(calls.length, 1);
  const u = new URL(calls[0]!.url);
  assert.equal(u.searchParams.get("countrycodes"), "ir");
  assert.ok(u.searchParams.get("viewbox"));
  assert.match(calls[0]!.ua!, /snapp-mcp/);
});

test("splits a long Persian address into searchable pieces", async () => {
  const { addressCandidates } = await import("../src/geocode.js");
  const a = addressCandidates("از تهران ونک خیابان شیخ بهایی نبش پارک ملت");
  assert.deepEqual(a.candidates, ["تهران ونک شیخ بهایی پارک ملت", "پارک ملت", "شیخ بهایی", "تهران ونک"]);
  assert.ok(a.context.includes("ونک"));
  const b = addressCandidates("کوچه ۱۲ غربی گوهردشت پلاک ۱۲ طبقه ۳");
  assert.deepEqual(b.candidates, ["۱۲ غربی گوهردشت"]);
  assert.deepEqual(addressCandidates("بلوار ارم، بعد از میدان، شیخ‌بهایی").candidates, ["ارم شیخ بهایی", "شیخ بهایی", "ارم"]);
});

test("retries a full address with shorter pieces and ranks by the other words", async () => {
  const asked: string[] = [];
  const fake = (async (url: string) => {
    const q = new URL(url).searchParams.get("q")!;
    asked.push(q);
    if (q !== "پارک ملت") return new Response("[]");
    return new Response(JSON.stringify([
      { lat: "36.3", lon: "59.6", display_name: "پارک ملت, مشهد, ایران", type: "school" },
      { lat: "35.7600", lon: "51.4100", display_name: "پارک ملت, ونک, تهران, ایران", type: "school" },
    ]));
  }) as unknown as typeof fetch;
  const g = new NominatimGeocoder(fake, 0);
  const [top, other] = await g.search("از تهران ونک خیابان شیخ بهایی نبش پارک ملت");
  assert.equal(top!.lat, 35.7600); // the Tehran one wins on "تهران"/"ونک"
  assert.equal(top!.matchedQuery, "پارک ملت");
  assert.equal(other!.lat, 36.3);
  assert.deepEqual(asked, [
    "از تهران ونک خیابان شیخ بهایی نبش پارک ملت",
    "تهران ونک شیخ بهایی پارک ملت",
    "پارک ملت",
  ]);
});
