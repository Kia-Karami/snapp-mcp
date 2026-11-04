import { randomUUID } from "node:crypto";
import { haversineKm, lerp } from "../geo.js";
import type {
  CancelResult,
  DestinationChangeQuote,
  Driver,
  LatLng,
  Point,
  Quote,
  Ride,
  ScheduledRide,
  ScheduleQuote,
  ServiceType,
} from "../types.js";
import type { SnappAdapter } from "./adapter.js";

/**
 * A fake Snapp that behaves like the real thing: priced quotes that expire,
 * a ride that moves through searching -> driver_assigned -> driver_arrived ->
 * on_trip -> completed on a simulated clock, and cancellation fees.
 * Prices are rough Tehran-style numbers in Toman, not real Snapp fares.
 */

interface ServiceSpec {
  name: string;
  base: number;
  perKm: number;
  perMin: number;
  speedFactor: number; // <1 means faster than a car
}

const SERVICES: Record<ServiceType, ServiceSpec> = {
  classic: { name: "Snapp Classic", base: 35_000, perKm: 11_000, perMin: 1_500, speedFactor: 1 },
  plus: { name: "Snapp Plus", base: 50_000, perKm: 15_000, perMin: 2_000, speedFactor: 1 },
  rose: { name: "Snapp Rose (women drivers)", base: 38_000, perKm: 12_000, perMin: 1_600, speedFactor: 1 },
  bike: { name: "Snapp Bike", base: 20_000, perKm: 6_500, perMin: 800, speedFactor: 0.7 },
};

const QUOTE_TTL_MS = 5 * 60_000;
// Simulated seconds for each phase.
const SEARCH_SEC = 20;
const WAIT_AT_PICKUP_SEC = 60;
const FREE_CANCEL_WINDOW_SEC = 120;
const CANCEL_FEE_TOMAN = 15_000;
const AVG_CITY_KMH = 22;

const MALE_NAMES = ["Reza Ahmadi", "Ali Karimi", "Mehdi Rostami", "Hossein Moradi", "Saeed Jafari"];
const FEMALE_NAMES = ["Maryam Hosseini", "Zahra Rezaei", "Fatemeh Kazemi", "Sara Mohammadi"];
const CARS = ["Peugeot 206", "Peugeot Pars", "Samand", "Kia Pride", "Tiba 2", "Dena"];
const PLUS_CARS = ["Toyota Camry", "Hyundai Sonata", "Peugeot 508", "Kia Optima"];
const BIKES = ["Honda 125", "Benelli 150", "Yamaha Nouvo"];
const COLORS = ["white", "silver", "black", "grey", "dark blue"];
const PLATE_LETTERS = ["ب", "ج", "د", "س", "ص", "ط", "ق", "ل", "م", "ن", "و", "ه", "ی"];

interface RideRecord {
  ride: Ride;
  quote: Quote;
  requestedAtMs: number;
  driverStart: LatLng;
  pickupSec: number; // simulated seconds for driver to reach pickup
  tripSec: number;
  cancelledAtMs?: number;
}

export interface MockOptions {
  /** Simulated seconds per real second. Default 10 (or SNAPP_MOCK_SPEED). */
  speed?: number;
  now?: () => number;
  random?: () => number;
  /** Chance a request finds no driver, 0..1. Default 0. */
  noDriverRate?: number;
}

export class MockSnappAdapter implements SnappAdapter {
  readonly name = "mock";
  private readonly quotes = new Map<string, Quote>();
  private readonly rides = new Map<string, RideRecord>();
  private readonly speed: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly noDriverRate: number;

  constructor(opts: MockOptions = {}) {
    this.speed = opts.speed ?? Number(process.env.SNAPP_MOCK_SPEED ?? 10);
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.noDriverRate = opts.noDriverRate ?? 0;
  }

  async getQuotes(origin: Point, destination: Point, services?: string[], second?: Point): Promise<Quote[]> {
    if (second && haversineKm(destination, second) < 0.1) throw new Error("The second stop is the same as the first.");
    const straightKm = haversineKm(origin, destination) + (second ? haversineKm(destination, second) : 0);
    if (straightKm < 0.1) throw new Error("Pickup and destination are the same place.");
    if (straightKm > 150) throw new Error("Destination is too far for an in-city ride (over 150 km).");
    const roadKm = straightKm * 1.3; // roads aren't straight lines
    const all = Object.keys(SERVICES) as ServiceType[];
    const unknown = services?.filter((x) => !all.includes(x as ServiceType)) ?? [];
    if (unknown.length) throw new Error(`Unknown service(s): ${unknown.join(", ")}. Available: ${all.join(", ")}.`);
    const wanted = services?.length ? (services as ServiceType[]) : all;
    const expiresAt = new Date(this.now() + QUOTE_TTL_MS).toISOString();

    return wanted.map((service) => {
      const spec = SERVICES[service];
      const leg1 = this.price(spec, origin, destination);
      const leg2 = second ? this.price(spec, destination, second) : undefined;
      // A second stop adds the second leg's distance/time, not another base fare.
      const price = leg2 ? leg1.price + leg2.price - Math.round(spec.base / 1000) * 1000 : leg1.price;
      const tripMinutes = leg1.tripMinutes + (leg2?.tripMinutes ?? 0);
      const quote: Quote = {
        quoteId: `q_${randomUUID().slice(0, 8)}`,
        service,
        serviceName: spec.name,
        origin,
        destination,
        ...(second && { secondDestination: second }),
        priceToman: price,
        distanceKm: Math.round(roadKm * 10) / 10,
        tripMinutes,
        pickupEtaMinutes: 2 + Math.floor(this.random() * 6),
        expiresAt,
      };
      this.quotes.set(quote.quoteId, quote);
      return quote;
    });
  }

  async getQuote(quoteId: string): Promise<Quote | undefined> {
    const q = this.quotes.get(quoteId);
    if (!q || Date.parse(q.expiresAt) < this.now()) return undefined;
    return q;
  }

  async requestRide(quoteId: string): Promise<Ride> {
    const quote = await this.getQuote(quoteId);
    if (!quote) {
      throw new Error(`Quote ${quoteId} is unknown or expired (quotes last 5 minutes). Get a new quote.`);
    }
    const active = await this.getActiveRide();
    if (active) {
      throw new Error(`You already have an active ride (${active.rideId}, ${active.status}). Cancel it first.`);
    }
    this.quotes.delete(quoteId); // a quote books at most one ride

    const pickupSec = quote.pickupEtaMinutes * 60;
    const rec: RideRecord = {
      quote,
      requestedAtMs: this.now(),
      driverStart: offset(quote.origin, (pickupSec / 3600) * AVG_CITY_KMH, this.random),
      pickupSec,
      tripSec: quote.tripMinutes * 60,
      ride: {
        rideId: `r_${randomUUID().slice(0, 8)}`,
        status: "searching",
        service: quote.service,
        origin: quote.origin,
        destination: quote.destination,
        ...(quote.secondDestination && { secondDestination: quote.secondDestination }),
        priceToman: quote.priceToman,
        requestedAt: new Date(this.now()).toISOString(),
      },
    };
    if (this.random() < this.noDriverRate) rec.ride.status = "no_driver_found";
    else rec.ride.driver = this.makeDriver(quote.service as ServiceType, rec.driverStart);
    this.rides.set(rec.ride.rideId, rec);
    return this.snapshot(rec);
  }

  async getRide(rideId: string): Promise<Ride | undefined> {
    const rec = this.rides.get(rideId);
    return rec ? this.snapshot(rec) : undefined;
  }

  async getActiveRide(): Promise<Ride | undefined> {
    for (const rec of [...this.rides.values()].reverse()) {
      const ride = this.snapshot(rec);
      if (isActive(ride.status)) return ride;
    }
    return undefined;
  }

  async cancelRide(rideId: string, reason?: string): Promise<CancelResult> {
    const rec = this.rides.get(rideId);
    if (!rec) throw new Error(`No ride with id ${rideId}.`);
    const ride = this.snapshot(rec);
    if (!isActive(ride.status)) {
      throw new Error(`Ride ${rideId} is ${ride.status} and can't be cancelled.`);
    }
    if (ride.status === "on_trip") {
      throw new Error("You're already on the trip; ask the driver to stop instead of cancelling.");
    }
    const sim = this.simElapsed(rec);
    const sinceAssigned = sim - SEARCH_SEC;
    const fee = ride.status === "searching" || sinceAssigned <= FREE_CANCEL_WINDOW_SEC ? 0 : CANCEL_FEE_TOMAN;
    rec.cancelledAtMs = this.now();
    rec.ride.cancellationFeeToman = fee;
    rec.ride.cancellationReason = reason;
    return { ride: this.snapshot(rec), feeToman: fee };
  }

  async listRides(limit: number): Promise<Ride[]> {
    return [...this.rides.values()].reverse().slice(0, limit).map((r) => this.snapshot(r));
  }

  // --- destination change -----------------------------------------------

  async previewDestinationChange(rideId: string, destination: Point): Promise<DestinationChangeQuote> {
    const rec = this.activeRecord(rideId);
    const spec = SERVICES[rec.quote.service as ServiceType];
    const { price } = this.price(spec, rec.quote.origin, destination);
    return { rideId, destination, newPriceToman: price };
  }

  async changeDestination(rideId: string, destination: Point): Promise<Ride> {
    const rec = this.activeRecord(rideId);
    const spec = SERVICES[rec.quote.service as ServiceType];
    const { price, tripMinutes } = this.price(spec, rec.quote.origin, destination);
    rec.quote = { ...rec.quote, destination, priceToman: price, tripMinutes };
    rec.ride.destination = destination;
    rec.ride.priceToman = price;
    rec.tripSec = tripMinutes * 60;
    return this.snapshot(rec);
  }

  private activeRecord(rideId: string): RideRecord {
    const rec = this.rides.get(rideId);
    if (!rec) throw new Error(`No ride with id ${rideId}.`);
    const st = this.snapshot(rec).status;
    if (!["driver_assigned", "driver_arrived", "on_trip"].includes(st)) {
      throw new Error(`The destination can only be changed once a driver has accepted (ride is ${st}).`);
    }
    return rec;
  }

  /** Longer trips use highways, so the average speed rises with distance (22 -> 60 km/h). */
  private price(spec: ServiceSpec, a: LatLng, b: LatLng): { price: number; tripMinutes: number } {
    const roadKm = haversineKm(a, b) * 1.3;
    const kmh = Math.min(60, AVG_CITY_KMH + roadKm * 0.6);
    const tripMinutes = Math.max(3, Math.round((roadKm / kmh) * 60 * spec.speedFactor));
    const raw = spec.base + spec.perKm * roadKm + spec.perMin * tripMinutes;
    return { price: Math.round(raw / 1000) * 1000, tripMinutes };
  }

  // --- scheduled rides --------------------------------------------------

  private readonly scheduled = new Map<string, ScheduledRide>();

  async getScheduleSlots(): Promise<number[]> {
    const step = 300;
    const first = Math.ceil((this.now() / 1000 + 30 * 60) / step) * step;
    return Array.from({ length: (48 * 3600) / step }, (_, i) => first + i * step);
  }

  async getScheduleQuote(origin: Point, destination: Point, service: string, startTime: number): Promise<ScheduleQuote> {
    const spec = SERVICES[service as ServiceType];
    if (!spec) throw new Error(`Unknown service ${service}. Available: ${Object.keys(SERVICES).join(", ")}.`);
    const { price } = this.price(spec, origin, destination);
    const round = (n: number) => Math.round(n / 1000) * 1000;
    return { service, origin, destination, startTime, lowerToman: round(price * 0.85), upperToman: round(price * 1.2) };
  }

  async scheduleRide(q: ScheduleQuote): Promise<ScheduledRide> {
    const ride: ScheduledRide = {
      scheduleId: `s_${randomUUID().slice(0, 8)}`,
      service: q.service,
      origin: q.origin,
      destination: q.destination,
      startTime: q.startTime,
      status: "scheduled",
      priceText: `${q.lowerToman.toLocaleString("en-US")} - ${q.upperToman.toLocaleString("en-US")} Toman`,
    };
    this.scheduled.set(ride.scheduleId, ride);
    return ride;
  }

  async listScheduledRides(): Promise<ScheduledRide[]> {
    return [...this.scheduled.values()].filter((r) => r.status === "scheduled").sort((a, b) => a.startTime - b.startTime);
  }

  async cancelScheduledRide(scheduleId: string): Promise<void> {
    const r = this.scheduled.get(scheduleId);
    if (!r || r.status !== "scheduled") throw new Error(`No upcoming scheduled ride with id ${scheduleId}.`);
    r.status = "cancelled";
  }

  // --- simulation -------------------------------------------------------

  private simElapsed(rec: RideRecord, atMs = this.now()): number {
    return ((atMs - rec.requestedAtMs) / 1000) * this.speed;
  }

  /** Computes the ride's state at the current moment. */
  private snapshot(rec: RideRecord): Ride {
    const base = rec.ride;
    if (base.status === "no_driver_found") return { ...base };
    const endMs = rec.cancelledAtMs ?? this.now();
    const t = this.simElapsed(rec, endMs);
    const arrive = SEARCH_SEC + rec.pickupSec;
    const board = arrive + WAIT_AT_PICKUP_SEC;
    const done = board + rec.tripSec;
    const ride: Ride = { ...base, driver: base.driver ? { ...base.driver } : undefined };
    const atMs = (sim: number) => new Date(rec.requestedAtMs + (sim / this.speed) * 1000).toISOString();

    if (t < SEARCH_SEC) {
      ride.status = "searching";
      delete ride.driver; // not revealed yet
    } else if (t < arrive) {
      ride.status = "driver_assigned";
      const progress = (t - SEARCH_SEC) / rec.pickupSec;
      ride.driver!.location = round(lerp(rec.driverStart, rec.quote.origin, progress));
      ride.pickupEtaMinutes = Math.ceil((arrive - t) / 60);
      ride.dropoffEtaMinutes = Math.ceil((done - t) / 60);
    } else if (t < board) {
      ride.status = "driver_arrived";
      ride.driver!.location = round(rec.quote.origin);
      ride.pickupEtaMinutes = 0;
      ride.dropoffEtaMinutes = Math.ceil((done - t) / 60);
    } else if (t < done) {
      ride.status = "on_trip";
      const progress = (t - board) / rec.tripSec;
      const end = rec.quote.secondDestination ?? rec.quote.destination;
      if (rec.quote.secondDestination && progress >= 0.5) ride.stopReached = 1;
      ride.driver!.location = round(lerp(rec.quote.origin, end, progress));
      ride.dropoffEtaMinutes = Math.ceil((done - t) / 60);
    } else {
      ride.status = "completed";
      ride.driver!.location = round(rec.quote.secondDestination ?? rec.quote.destination);
      ride.completedAt = atMs(done);
    }

    if (rec.cancelledAtMs !== undefined) {
      ride.status = "cancelled";
      ride.cancelledAt = new Date(rec.cancelledAtMs).toISOString();
      delete ride.pickupEtaMinutes;
      delete ride.dropoffEtaMinutes;
    }
    return ride;
  }

  private makeDriver(service: ServiceType, location: LatLng): Driver {
    const pick = <T>(xs: T[]) => xs[Math.floor(this.random() * xs.length)]!;
    const digits = (n: number) => Array.from({ length: n }, () => Math.floor(this.random() * 10)).join("");
    const names = service === "rose" ? FEMALE_NAMES : [...MALE_NAMES, ...FEMALE_NAMES];
    const car = service === "bike" ? pick(BIKES) : service === "plus" ? pick(PLUS_CARS) : pick(CARS);
    return {
      name: pick(names),
      phone: `0912${digits(7)}`,
      rating: Math.round((4.5 + this.random() * 0.5) * 100) / 100,
      car,
      color: pick(COLORS),
      plate: service === "bike" ? `${digits(3)}-${digits(5)}` : `${digits(2)} ${pick(PLATE_LETTERS)} ${digits(3)} - ${digits(2)}`,
      location: round(location),
    };
  }
}

function isActive(status: Ride["status"]): boolean {
  return status === "searching" || status === "driver_assigned" || status === "driver_arrived" || status === "on_trip";
}

/** A point roughly `km` away from `p` in a random direction. */
function offset(p: LatLng, km: number, random: () => number): LatLng {
  const angle = random() * 2 * Math.PI;
  const dLat = (km / 111) * Math.cos(angle);
  const dLng = (km / (111 * Math.cos((p.lat * Math.PI) / 180))) * Math.sin(angle);
  return { lat: p.lat + dLat, lng: p.lng + dLng };
}

function round(p: LatLng): LatLng {
  return { lat: Math.round(p.lat * 1e5) / 1e5, lng: Math.round(p.lng * 1e5) / 1e5 };
}
