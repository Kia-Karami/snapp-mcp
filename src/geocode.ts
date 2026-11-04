import type { LatLng, Point } from "./types.js";

/**
 * Address search via OpenStreetMap Nominatim. Follows its usage policy:
 * an identifying User-Agent and at most one request per second.
 * https://operations.osmfoundation.org/policies/nominatim/
 */

const ENDPOINT = process.env.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "snapp-mcp/0.1 (open-source MCP server)";
const MIN_INTERVAL_MS = 1100;
/** Extra requests allowed when the full address finds nothing (each costs ~1 s). */
const MAX_FALLBACKS = 4;

interface Raw {
  match: AddressMatch;
  /** Normalised display_name, used to rank fallback matches. */
  full: string;
}

export interface AddressMatch extends Point {
  type: string;
  /** Set when the full address found nothing and a shorter piece of it was matched instead. */
  matchedQuery?: string;
}

export interface Geocoder {
  search(query: string, near?: LatLng, limit?: number): Promise<AddressMatch[]>;
}

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
  name?: string;
  type?: string;
}

export class NominatimGeocoder implements Geocoder {
  private last = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly cache = new Map<string, Raw[]>();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly minIntervalMs = MIN_INTERVAL_MS,
  ) {}

  /**
   * Searches the address as typed. Nominatim can't parse a whole sentence like
   * "تهران ونک خیابان شیخ بهایی نبش پارک ملت", so when that finds
   * nothing we retry with shorter pieces (most specific first) and rank the
   * matches by how many of the other words (city, neighbourhood) they contain.
   */
  async search(query: string, near?: LatLng, limit = 5): Promise<AddressMatch[]> {
    const q = query.trim();
    if (!q) return [];
    const first = await this.lookup(q, near, limit);
    if (first.length) return first.map((r) => r.match);

    const { candidates, context } = addressCandidates(q);
    for (const c of candidates.slice(0, MAX_FALLBACKS)) {
      if (c === q) continue;
      const found = await this.lookup(c, near, limit);
      if (!found.length) continue;
      const score = (full: string) => context.filter((w) => !c.includes(w) && full.includes(w)).length;
      return found
        .map((r, i) => ({ ...r, i, s: score(r.full) }))
        .sort((a, b) => b.s - a.s || a.i - b.i)
        .map((r) => ({ ...r.match, matchedQuery: c }));
    }
    return [];
  }

  /** One throttled, cached Nominatim request. */
  private lookup(q: string, near: LatLng | undefined, limit: number): Promise<Raw[]> {
    const key = `${q}|${near ? `${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : ""}|${limit}`;
    const hit = this.cache.get(key);
    if (hit) return Promise.resolve(hit);
    // Serialise requests so we never exceed one per second.
    const run = this.queue.then(async () => {
      const wait = this.last + this.minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      const results = await this.fetchOnce(q, near, limit);
      this.cache.set(key, results);
      return results;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private async fetchOnce(q: string, near: LatLng | undefined, limit: number): Promise<Raw[]> {
    const params = new URLSearchParams({
      q,
      format: "jsonv2",
      countrycodes: "ir",
      limit: String(limit),
      "accept-language": "fa,en",
    });
    if (near) {
      // Prefer results near the user without excluding the rest.
      const d = 0.3;
      params.set("viewbox", `${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}`);
    }
    const res = await this.fetchImpl(`${ENDPOINT}?${params}`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Address search failed (HTTP ${res.status}).`);
    const body = (await res.json()) as NominatimResult[];
    return body.map((r) => ({
      full: normalize(r.display_name),
      match: {
        lat: Number(r.lat),
        lng: Number(r.lon),
        label: shortLabel(r.display_name),
        type: r.type ?? "place",
      },
    }));
  }
}

/** "میدان تجریش, ناحیه ۷, منطقه ۱ شهر تهران, تجریش, تهران, ..." -> first three parts. */
function shortLabel(displayName: string): string {
  return displayName
    .split(/[,،]\s*/)
    .filter((p) => p && !/^[\d۰-۹-]+$/.test(p))
    .slice(0, 3)
    .join("، ");
}

/** Words that start a new part of a Persian address ("street", "alley", "corner of", ...). */
const MARKERS = new Set([
  "خیابان", "خ", "کوچه", "کوچهٔ", "بلوار", "بزرگراه", "اتوبان", "میدان", "کوی", "شهرک", "محله",
  "بن‌بست", "بن", "نبش", "جنب", "کنار", "روبروی", "روبه‌روی", "مقابل", "پشت", "انتهای", "ابتدای",
  "سر", "بین", "نرسیده", "پلاک", "طبقه", "واحد", "street", "st", "alley", "ave", "avenue", "blvd",
]);
/** Leading words like "from"/"to" that are part of the request, not the address. */
const LEADING = new Set(["از", "به", "تا", "مبدا", "مقصد", "from", "to"]);
/** Parts after these words are a unit/plate number, not a place. */
const UNIT = new Set(["پلاک", "طبقه", "واحد"]);
/** Second word of a two-word marker ("بعد از", "قبل از", "نرسیده به", "بن بست"). */
const FOLLOWERS = new Set(["از", "به", "بست"]);

export function normalize(s: string): string {
  return s
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[\u200c\u200f\u200e]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Splits a free-form address into searchable pieces.
 * "از تهران ونک خیابان شیخ بهایی نبش پارک ملت" ->
 *   candidates ["تهران ونک شیخ بهایی پارک ملت", "پارک ملت", "شیخ بهایی", "تهران ونک"]
 *   context    ["تهران", "ونک", "شیخ", "دبیرستان", "ملت"]
 */
export function addressCandidates(query: string): { candidates: string[]; context: string[] } {
  const tokens = normalize(query).split(/[\s،,؛;\-–]+/).filter(Boolean);
  while (tokens.length && LEADING.has(tokens[0]!.toLowerCase())) tokens.shift();

  const parts: string[][] = [[]];
  let skipUnit = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const lower = t.toLowerCase().replace(/\.$/, "");
    if (lower === "بعد" || lower === "قبل" || MARKERS.has(lower)) {
      if (FOLLOWERS.has(tokens[i + 1] ?? "")) i++;
      skipUnit = UNIT.has(lower);
      parts.push([]);
      continue;
    }
    if (skipUnit && /^[\d۰-۹]+$/.test(t)) continue; // the plate/floor number itself
    skipUnit = false;
    parts.at(-1)!.push(t);
  }
  const pieces = parts.map((p) => p.join(" ")).filter((p) => p && !/^[\d۰-۹]+$/.test(p));

  const candidates: string[] = [];
  const add = (c: string) => {
    if (c && !candidates.includes(c)) candidates.push(c);
  };
  add(pieces.join(" "));
  for (const p of [...pieces].reverse()) add(p); // most specific (last) first
  const context = [...new Set(pieces.flatMap((p) => p.split(" ")))].filter(
    (w) => w.length > 1 && !/^[\d۰-۹]+$/.test(w),
  );
  return { candidates, context };
}
