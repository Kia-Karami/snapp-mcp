import type {
  CancelResult,
  DestinationChangeQuote,
  Point,
  Quote,
  Ride,
  ScheduledRide,
  ScheduleQuote,
  ServiceId,
} from "../types.js";

/**
 * Everything the MCP tools need from Snapp. The mock implements this today;
 * a real adapter built on the Snapp web app's API implements the same shape.
 */
export interface SnappAdapter {
  readonly name: string;
  /** Pass `secondDestination` for a two-stop ride: origin -> destination -> secondDestination. */
  getQuotes(origin: Point, destination: Point, services?: ServiceId[], secondDestination?: Point): Promise<Quote[]>;
  /** Looks up a quote previously returned by getQuotes, if still valid. */
  getQuote(quoteId: string): Promise<Quote | undefined>;
  requestRide(quoteId: string): Promise<Ride>;
  getRide(rideId: string): Promise<Ride | undefined>;
  getActiveRide(): Promise<Ride | undefined>;
  cancelRide(rideId: string, reason?: string): Promise<CancelResult>;
  listRides(limit: number): Promise<Ride[]>;

  /** New price if the active ride's destination changed; changes nothing. */
  previewDestinationChange(rideId: string, destination: Point): Promise<DestinationChangeQuote>;
  changeDestination(rideId: string, destination: Point): Promise<Ride>;

  /** Unix-second start times that can be booked (5-minute slots). */
  getScheduleSlots(): Promise<number[]>;
  getScheduleQuote(origin: Point, destination: Point, service: ServiceId, startTime: number): Promise<ScheduleQuote>;
  scheduleRide(quote: ScheduleQuote): Promise<ScheduledRide>;
  listScheduledRides(): Promise<ScheduledRide[]>;
  cancelScheduledRide(scheduleId: string): Promise<void>;
}
