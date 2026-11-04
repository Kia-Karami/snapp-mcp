import { SnappApiError, type SnappClient } from "../snapp/client.js";
import type { CancelResult, DestinationChangeQuote, Point, Quote, Ride, ScheduledRide, ScheduleQuote } from "../types.js";
import type { SnappAdapter } from "./adapter.js";

/**
 * Real Snapp backend over the passenger web API (what app.snapp.taxi uses):
 * quotes, booking, active ride status, driver location, cancel and history.
 */

const QUOTE_TTL_MS = 5 * 60_000;

export class RealSnappAdapter implements SnappAdapter {
  readonly name = "snapp";
  private readonly quotes = new Map<string, Quote>();
  /** Quotes our rides were booked from, so we can show origin/destination. */
  private readonly booked = new Map<string, Quote>();

  constructor(private readonly client: SnappClient) {}

  async getQuotes(origin: Point, destination: Point, services?: string[], second?: Point): Promise<Quote[]> {
    const body = await this.client.call("POST", "api", "v3/price", {
      points: [pt(origin), pt(destination), ...(second ? [pt(second)] : [])],
      price_ride_recom: false,
      options: {},
      locale: "fa-IR",
      os: 6,
      version: 0,
    });
    const quotes = parsePrices(body, origin, destination, second).filter((q) => !services?.length || services.includes(q.service));
    if (!quotes.length) {
      throw new Error(`Snapp returned no prices for this trip. Raw response: ${JSON.stringify(body).slice(0, 800)}`);
    }
    for (const q of quotes) this.quotes.set(q.quoteId, q);
    return quotes;
  }

  async getQuote(quoteId: string): Promise<Quote | undefined> {
    const q = this.quotes.get(quoteId);
    return q && Date.parse(q.expiresAt) > Date.now() ? q : undefined;
  }

  async requestRide(quoteId: string): Promise<Ride> {
    const quote = await this.getQuote(quoteId);
    if (!quote) throw new Error(`Quote ${quoteId} is unknown or expired (quotes last 5 minutes). Get a new quote.`);
    const active = await this.getActiveRide();
    if (active) throw new Error(`You already have an active Snapp ride (${active.rideId}, ${active.status}). Cancel it first.`);
    this.quotes.delete(quoteId); // a quote books at most one ride
    const body = await this.client.call<{ data?: Obj }>("POST", "base", "v2/passenger/ride", {
      origin_lat: quote.origin.lat,
      origin_lng: quote.origin.lng,
      destination_lat: quote.destination.lat,
      destination_lng: quote.destination.lng,
      ...(quote.secondDestination && {
        extra_destination_lat: quote.secondDestination.lat,
        extra_destination_lng: quote.secondDestination.lng,
      }),
      service_type: Number(quote.service),
      is_paid_by_recipient: false,
      is_for_friend: false,
    });
    const data = body?.data ?? {};
    const rideId = str(data.ride_id) ?? str((data.ride_info as Obj | undefined)?.ride_id) ?? str((data.ride as Obj | undefined)?.ride_id);
    if (!rideId) throw new Error(`Snapp accepted the request but returned no ride id: ${JSON.stringify(body).slice(0, 500)}`);
    this.booked.set(rideId, quote);
    return (
      (await this.getActiveRide()) ?? {
        rideId,
        status: "searching",
        service: quote.service,
        origin: quote.origin,
        destination: quote.destination,
        ...(quote.secondDestination && { secondDestination: quote.secondDestination }),
        priceToman: quote.priceToman,
        requestedAt: new Date().toISOString(),
      }
    );
  }

  async getActiveRide(): Promise<Ride | undefined> {
    const body = await this.client.call<{ data?: { ride?: Obj | null; started_ride?: Obj | null } }>("GET", "base", "v2/passenger/ride");
    // A ride still looking for a driver comes back as started_ride.
    const ride = body?.data?.ride ?? body?.data?.started_ride;
    if (!ride) return undefined;
    const parsed = this.parseActive(ride);
    if (parsed.driver && parsed.status !== "searching" && !Number.isFinite(parsed.driver.location.lat)) {
      try {
        const loc = await this.client.call<{ data?: Obj }>("GET", "locations", `v4/passenger/ride/${parsed.rideId}/driver-location`);
        const l = (loc?.data?.location ?? loc?.data) as Obj | undefined;
        const lat = num(l?.lat), lng = num(l?.lng);
        if (lat !== undefined && lng !== undefined) parsed.driver.location = { lat, lng };
      } catch {
        /* location is best-effort */
      }
    }
    return parsed;
  }

  async getRide(rideId: string): Promise<Ride | undefined> {
    const active = await this.getActiveRide();
    if (active?.rideId === rideId) return active;
    return (await this.listRides(50)).find((r) => r.rideId === rideId);
  }

  async cancelRide(rideId: string, reason?: string): Promise<CancelResult> {
    const active = await this.getActiveRide();
    if (!active || active.rideId !== rideId) throw new Error(`Ride ${rideId} isn't your active Snapp ride, so it can't be cancelled.`);
    if (active.status === "on_trip") throw new Error("You're already on the trip; ask the driver to stop instead of cancelling.");
    const path = active.status === "searching" ? "waiting" : "inride";
    const reasonId = await this.pickReason(rideId, path === "waiting" ? "before_accept" : "accepted");
    await this.client.call("PATCH", "base", `v2/passenger/ride/${rideId}/cancel/${path}`, {
      ...(reasonId !== undefined && { cancellation_reason_id: reasonId }),
      ...(reason && { cancellation_description: reason }),
    });
    const after = (await this.listRides(5)).find((r) => r.rideId === rideId);
    const ride: Ride = after ?? { ...active, status: "cancelled", cancelledAt: new Date().toISOString() };
    ride.status = "cancelled";
    ride.cancellationReason = reason;
    return { ride, feeToman: ride.cancellationFeeToman ?? 0 };
  }

  async listRides(limit: number): Promise<Ride[]> {
    const body = await this.client.call<{ data?: { rides?: Obj[] } }>("GET", "base", "v3/passenger/ride/history?page=1");
    return (body?.data?.rides ?? []).slice(0, limit).map(parseHistoryRide);
  }

  // --- destination change -----------------------------------------------

  async previewDestinationChange(rideId: string, destination: Point): Promise<DestinationChangeQuote> {
    await this.checkDestinationChange(rideId);
    const body = await this.client.call("POST", "base", `v2/passenger/ride/${rideId}/change-destination/price/true`, {
      destination_lat: destination.lat,
      destination_lng: destination.lng,
      round_trip: false,
    });
    const rial = findRial(body);
    if (rial === undefined) throw new Error(`Snapp didn't return a new price: ${JSON.stringify(body).slice(0, 500)}`);
    return { rideId, destination, newPriceToman: Math.round(rial / 10) };
  }

  async changeDestination(rideId: string, destination: Point): Promise<Ride> {
    await this.checkDestinationChange(rideId);
    await this.client.call("POST", "base", `v2/passenger/ride/${rideId}/change-destination/price/false`, {
      destination_lat: destination.lat,
      destination_lng: destination.lng,
      round_trip: false,
    });
    const q = this.booked.get(rideId);
    if (q) this.booked.set(rideId, { ...q, destination });
    return (await this.getActiveRide()) ?? Promise.reject(new Error("The ride is no longer active."));
  }

  private async checkDestinationChange(rideId: string): Promise<void> {
    const active = await this.getActiveRide();
    if (!active || active.rideId !== rideId) throw new Error(`Ride ${rideId} isn't your active Snapp ride.`);
    await this.client.call("GET", "api", `v2/passenger/ride/change-destination/${rideId}/validate`);
  }

  // --- scheduled rides --------------------------------------------------

  async getScheduleSlots(): Promise<number[]> {
    const body = await this.client.call<{ available_days?: { available_hours?: { available_minutes?: { timestamp?: number; has_conflict?: boolean }[] }[] }[] }>(
      "GET", "base", "ride_scheduling/v1/passenger/ride/available_times",
    );
    return (body?.available_days ?? [])
      .flatMap((d) => d.available_hours ?? [])
      .flatMap((h) => h.available_minutes ?? [])
      .filter((m) => typeof m.timestamp === "number" && !m.has_conflict)
      .map((m) => m.timestamp!);
  }

  async getScheduleQuote(origin: Point, destination: Point, service: string, startTime: number): Promise<ScheduleQuote> {
    const body = await this.client.call<{ price_estimation?: { lower_bound?: number; upper_bound?: number } }>(
      "POST", "base", "ride_scheduling/v1/passenger/ride/price_estimation",
      { service_type: Number(service), reserved_at: startTime, coordinates: [{ lat: origin.lat, lng: origin.lng }, { lat: destination.lat, lng: destination.lng }] },
    );
    // Snapp sometimes can't estimate ("فعلاً امکان محاسبه وجود ندارد"); the final price is then set before the trip.
    const lo = num(body?.price_estimation?.lower_bound), hi = num(body?.price_estimation?.upper_bound);
    return {
      service, origin, destination, startTime,
      lowerToman: lo === undefined ? NaN : Math.round(lo / 10),
      upperToman: hi === undefined ? NaN : Math.round(hi / 10),
    };
  }

  async scheduleRide(q: ScheduleQuote): Promise<ScheduledRide> {
    let body: Obj;
    try {
      body = await this.client.call<Obj>("POST", "base", "ride_scheduling/v1/passenger/ride/schedule", {
        origin_lat: String(q.origin.lat),
        origin_lng: String(q.origin.lng),
        dest_lat: String(q.destination.lat),
        dest_lng: String(q.destination.lng),
        service_type: Number(q.service),
        start_timestamp: q.startTime,
      });
    } catch (err) {
      if (err instanceof SnappApiError && (err.body as Obj | undefined)?.error_code === 6005) {
        throw new Error(
          "Snapp doesn't offer scheduled rides for this service at that time, pickup and destination (error 6005). " +
            "Nothing was booked. Try another time, another service, or book a normal ride closer to the time.",
        );
      }
      throw err;
    }
    const data = (body?.data ?? body) as Obj;
    const id = str(data?.id) ?? str((data?.ride as Obj | undefined)?.id) ?? str(data?.schedule_ride_id);
    if (!id) throw new Error(`Snapp accepted the schedule but returned no id: ${JSON.stringify(body).slice(0, 400)}`);
    return { scheduleId: id, service: q.service, origin: q.origin, destination: q.destination, startTime: q.startTime, status: "scheduled" };
  }

  async listScheduledRides(): Promise<ScheduledRide[]> {
    const body = await this.client.call<{ data?: { rides?: Obj[] } }>("GET", "base", "ride_scheduling/v2/passenger/ride/upcoming_rides?page=1&pageSize=20");
    return (body?.data?.rides ?? []).map(parseScheduled);
  }

  async cancelScheduledRide(scheduleId: string): Promise<void> {
    await this.client.call("PATCH", "base", `ride_scheduling/v1/passenger/ride/cancel/${scheduleId}`);
  }

  /**
   * Snapp lists reasons as { before_accept: [...], accepted: [...] }. Use
   * "I changed my mind" (از سفر منصرف شدم), else the first reason listed.
   */
  private async pickReason(rideId: string, phase: "before_accept" | "accepted"): Promise<number | undefined> {
    try {
      const body = await this.client.call<{ data?: Obj }>("GET", "base", `v2/passenger/ride/${rideId}/cancellation-reasons`);
      const list = (body?.data?.[phase] ?? []) as Obj[];
      const changedMind = list.find((r) => typeof r.reason === "string" && r.reason.includes("منصرف"));
      return num((changedMind ?? list[0])?.id);
    } catch {
      return undefined; // Snapp accepted a cancel without a reason id in testing
    }
  }

  private parseActive(ride: Obj): Ride {
    const info = (ride.ride_info ?? ride) as Obj;
    const rideId = str(info.ride_id) ?? "unknown";
    const quote = this.booked.get(rideId);
    const d = ride.driver as Obj | undefined;
    const status = mapState(num(info.current_state) ?? num(info.state));
    return {
      rideId,
      status,
      service: String(num(ride.service_type) ?? num((ride.service_type as Obj | undefined)?.type) ?? quote?.service ?? ""),
      origin: point(info.origin) ?? quote?.origin ?? { lat: NaN, lng: NaN, label: "pickup" },
      destination: point(info.destination) ?? quote?.destination ?? { lat: NaN, lng: NaN, label: "destination" },
      ...((point(info.extra_destination) ?? point(info.second_destination) ?? quote?.secondDestination) && {
        secondDestination: point(info.extra_destination) ?? point(info.second_destination) ?? quote?.secondDestination,
      }),
      ...(stopReached(num(info.current_state)) && { stopReached: stopReached(num(info.current_state)) }),
      priceToman: toToman(info.final_price) ?? quote?.priceToman ?? NaN,
      requestedAt: str(info.created_at) ?? new Date().toISOString(),
      driver:
        d && status !== "searching"
          ? {
              name: str(d.driver_name) ?? "Driver",
              phone: str(d.cellphone) ?? "",
              rating: num(d.rate) ?? num(d.rating) ?? NaN,
              car: str(d.vehicle_model) ?? "",
              color: str(d.vehicle_color) ?? "",
              plate: formatPlate(d.plate) ?? "",
              location: point(ride.driver_location_info) ?? { lat: NaN, lng: NaN },
            }
          : undefined,
    };
  }
}

/** States 16/17 mean the first/second destination was reached. */
export function stopReached(state: number | undefined): 1 | 2 | undefined {
  return state === 16 ? 1 : state === 17 ? 2 : undefined;
}

/** Snapp ride states, from the web app's state enum. */
export function mapState(state: number | undefined): Ride["status"] {
  switch (state) {
    case 1:
      return "searching";
    case 2:
      return "driver_assigned";
    case 3:
      return "driver_arrived";
    case 4:
    case 16:
    case 17:
      return "on_trip";
    case 5:
    case 15:
      return "completed";
    case 9:
    case 10:
      return "no_driver_found";
    case 6:
    case 7:
    case 8:
    case 11:
    case 13:
    case 19:
      return "cancelled";
    default:
      return "searching";
  }
}

export function parseHistoryRide(r: Obj): Ride {
  const st = (r.service_type ?? {}) as Obj;
  const status = mapState(num(r.latest_ride_status));
  return {
    rideId: str(r.human_readable_id) ?? "unknown",
    status,
    service: str(st.type) ?? "",
    origin: point(r.origin) ?? { lat: NaN, lng: NaN, label: str(r.origin_formatted_address) ?? "" },
    destination: point(r.destination) ?? { lat: NaN, lng: NaN, label: str(r.destination_formatted_address) ?? "" },
    priceToman: toToman(r.final_price) ?? NaN,
    requestedAt: str(r.created_at) ?? "",
    ...(status === "completed" && { completedAt: str(r.updated_at) }),
    ...(status === "cancelled" && { cancelledAt: str(r.updated_at) }),
    driver: str(r.driver_name)
      ? { name: str(r.driver_name)!, phone: "", rating: NaN, car: str(r.vehicle_model) ?? "", color: "", plate: "", location: { lat: NaN, lng: NaN } }
      : undefined,
  };
}

/** Snapp plate { part_a: 15, character: "هـ", part_b: 131, iran_id: 38 } -> "15 هـ 131 - ایران 38". */
export function formatPlate(p: unknown): string | undefined {
  if (!isObj(p)) return undefined;
  const a = num(p.part_a), b = num(p.part_b), ir = num(p.iran_id), ch = str(p.character);
  if (a === undefined || b === undefined) return undefined;
  return `${a} ${ch ?? ""} ${b}${ir !== undefined ? ` - ایران ${ir}` : ""}`.replace(/\s+/g, " ");
}

/** Upcoming-ride fields aren't documented; read the likely names. */
export function parseScheduled(r: Obj): ScheduledRide {
  const o = (r.origin ?? {}) as Obj, d = (r.destination ?? {}) as Obj;
  const p = (lat: unknown, lng: unknown, label: unknown): Point => ({
    lat: num(lat) ?? NaN, lng: num(lng) ?? NaN, label: str(label) ?? "",
  });
  const state = num(r.state) ?? num(r.status);
  return {
    scheduleId: str(r.id) ?? "unknown",
    service: str(r.service_type) ?? str((r.service_type as Obj | undefined)?.type) ?? "",
    origin: p(o.lat ?? r.origin_lat, o.lng ?? r.origin_lng, o.formatted_address ?? r.origin_address),
    destination: p(d.lat ?? r.dest_lat, d.lng ?? r.dest_lng, d.formatted_address ?? r.dest_address),
    startTime: num(r.start_timestamp) ?? num(r.start_time) ?? NaN,
    status: state === undefined || state === 0 ? "scheduled" : state === 5 ? "scheduled" : "unknown",
    priceText: str((r.price as Obj | undefined)?.price) ?? str(r.price_text),
  };
}

/** First Rial price field found in an undocumented response. */
function findRial(v: unknown, depth = 0): number | undefined {
  if (depth > 5 || !v || typeof v !== "object") return undefined;
  const o = v as Obj;
  for (const k of ["final_price", "final", "new_price", "price"]) {
    const n = num(o[k]);
    if (n !== undefined && n > 1000) return n;
  }
  for (const x of Object.values(o)) {
    const n = findRial(x, depth + 1);
    if (n !== undefined) return n;
  }
  return undefined;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : undefined);
const toToman = (v: unknown): number | undefined => {
  const n = num(v);
  return n === undefined ? undefined : Math.round(n / 10);
};
function point(v: unknown): Point | undefined {
  if (!isObj(v)) return undefined;
  const lat = num(v.lat), lng = num(v.lng);
  if (lat === undefined || lng === undefined) return undefined;
  return { lat, lng, label: str(v.formatted_address) ?? `${lat},${lng}` };
}

const pt = (p: Point) => ({ lat: String(p.lat), lng: String(p.lng) });

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v.replace(/,/g, "")) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

interface PriceService {
  id: number;
  enabled?: boolean;
  price?: { final?: number | null };
  info?: { name?: string; description?: string; disabled_reason?: string };
  estimation?: { eta?: number[]; time_to_arrive?: string[] };
}

/**
 * Reads Snapp's /v3/price response: data.services[] with price.final in Rial
 * (shown in Toman, Rial / 10, as the app does) and estimation.eta in minutes.
 */
export function parsePrices(body: unknown, origin: Point, destination: Point, second?: Point): Quote[] {
  const services = ((body as { data?: { services?: PriceService[] } })?.data?.services ?? []) as PriceService[];
  const expiresAt = new Date(Date.now() + QUOTE_TTL_MS).toISOString();
  return services
    .filter((x) => x.enabled !== false && typeof x.price?.final === "number")
    .map((x) => {
      const name = [x.info?.name, x.info?.description].filter(Boolean).join(" - ") || `Service ${x.id}`;
      return {
        quoteId: `q_${x.id}_${Math.random().toString(36).slice(2, 8)}`,
        service: String(x.id),
        serviceName: name,
        origin,
        destination,
        ...(second && { secondDestination: second }),
        priceToman: Math.round(x.price!.final! / 10),
        distanceKm: NaN,
        tripMinutes: x.estimation?.eta?.[0] ?? NaN,
        pickupEtaMinutes: NaN,
        expiresAt,
      };
    });
}
