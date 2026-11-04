export interface LatLng {
  lat: number;
  lng: number;
}

export interface Place extends LatLng {
  name: string;
  address?: string;
}

/** A resolved point used for pickup / drop-off. */
export interface Point extends LatLng {
  label: string;
}

export type ServiceType = "classic" | "plus" | "rose" | "bike";

/** Service id as the backend names it (mock: ServiceType, Snapp: its numeric service type). */
export type ServiceId = string;

export interface Quote {
  quoteId: string;
  service: ServiceId;
  serviceName: string;
  origin: Point;
  destination: Point;
  /** Optional second stop, visited after `destination`. */
  secondDestination?: Point;
  priceToman: number;
  distanceKm: number;
  tripMinutes: number;
  pickupEtaMinutes: number;
  expiresAt: string;
}

export type RideStatus =
  | "searching"
  | "driver_assigned"
  | "driver_arrived"
  | "on_trip"
  | "completed"
  | "cancelled"
  | "no_driver_found";

export interface Driver {
  name: string;
  phone: string;
  rating: number;
  car: string;
  color: string;
  plate: string;
  location: LatLng;
}

export interface Ride {
  rideId: string;
  status: RideStatus;
  service: ServiceId;
  origin: Point;
  destination: Point;
  secondDestination?: Point;
  /** On a two-stop ride: 1 once the first stop is reached, 2 at the second. */
  stopReached?: 1 | 2;
  priceToman: number;
  requestedAt: string;
  driver?: Driver;
  pickupEtaMinutes?: number;
  dropoffEtaMinutes?: number;
  cancelledAt?: string;
  cancellationFeeToman?: number;
  cancellationReason?: string;
  completedAt?: string;
}

export interface CancelResult {
  ride: Ride;
  feeToman: number;
}

export interface ScheduleQuote {
  service: ServiceId;
  origin: Point;
  destination: Point;
  /** Unix seconds, snapped to Snapp's 5-minute slots. */
  startTime: number;
  lowerToman: number;
  upperToman: number;
}

export interface ScheduledRide {
  scheduleId: string;
  service: ServiceId;
  origin: Point;
  destination: Point;
  startTime: number;
  status: "scheduled" | "cancelled" | "started" | "unknown";
  priceText?: string;
}

export interface DestinationChangeQuote {
  rideId: string;
  destination: Point;
  newPriceToman: number;
}
