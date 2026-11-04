import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SnappAdapter } from "./adapters/adapter.js";
import type { Geocoder } from "./geocode.js";
import type { PlaceStore } from "./places.js";
import type { BrowserLogin } from "./snapp/browser-login.js";
import type { SnappClient } from "./snapp/client.js";
import { randomUUID } from "node:crypto";
import { haversineKm } from "./geo.js";
import type { Ride, ScheduleQuote } from "./types.js";

const SERVICE = z.string().describe("A service id from a previous quote, e.g. classic / plus (mock) or Snapp's numeric service type.");
const LOCATION_HELP =
  'A saved place name (e.g. "home"), "here" for your current location, "lat,lng" coordinates, or an address / landmark ' +
  '(e.g. "Tajrish Square, Tehran" or "میدان تجریش"), which is looked up on OpenStreetMap.';

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(summary: string, data?: unknown): ToolResult {
  const text = data === undefined ? summary : `${summary}\n\n${JSON.stringify(data, null, 2)}`;
  return { content: [{ type: "text", text }] };
}

/** Runs a tool body and turns thrown errors into MCP tool errors the agent can read. */
async function guard(fn: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
  }
}

const toman = (n: number) => `${n.toLocaleString("en-US")} Toman`;

/** "A to B", or "A to B, then C" for a two-stop trip. */
function route(r: { origin: { label: string }; destination: { label: string }; secondDestination?: { label: string } }): string {
  return `${r.origin.label} to ${r.destination.label}${r.secondDestination ? `, then ${r.secondDestination.label}` : ""}`;
}

function carText(r: Ride): string {
  const d = r.driver;
  if (!d) return "the driver";
  const rating = Number.isFinite(d.rating) ? ` (${d.rating}★)` : "";
  const car = [d.color, d.car].filter(Boolean).join(" ");
  const plate = d.plate && !d.plate.startsWith("http") ? `, plate ${d.plate}` : "";
  return `${d.name}${rating}${car ? `, ${car}` : ""}${plate}`;
}

function describeRide(r: Ride): string {
  const mins = (n?: number) => (n !== undefined && Number.isFinite(n) ? ` About ${n} min.` : "");
  const fare = Number.isFinite(r.priceToman) ? ` Fare ${toman(r.priceToman)}.` : "";
  switch (r.status) {
    case "searching":
      return `Ride ${r.rideId}: looking for a driver.`;
    case "driver_assigned":
      return `Ride ${r.rideId}: ${carText(r)} is on the way to pick you up.${mins(r.pickupEtaMinutes)}`;
    case "driver_arrived":
      return `Ride ${r.rideId}: ${carText(r)} has arrived at ${r.origin.label}.`;
    case "on_trip":
      if (r.secondDestination && r.stopReached === 2) return `Ride ${r.rideId}: arrived at the second stop, ${r.secondDestination.label}.`;
      if (r.secondDestination && r.stopReached === 1) {
        return `Ride ${r.rideId}: reached the first stop (${r.destination.label}); next, ${r.secondDestination.label}.${mins(r.dropoffEtaMinutes)}`;
      }
      return `Ride ${r.rideId}: on the way to ${r.destination.label}${r.secondDestination ? `, then ${r.secondDestination.label}` : ""}.${mins(r.dropoffEtaMinutes)}`;
    case "completed":
      return `Ride ${r.rideId}: completed, ${route(r)}.${fare}`;
    case "cancelled":
      return `Ride ${r.rideId}: cancelled${r.cancellationFeeToman ? ` with a ${toman(r.cancellationFeeToman)} fee` : " (no fee)"}.`;
    case "no_driver_found":
      return `Ride ${r.rideId}: no driver was found. Try again or pick another service.`;
  }
}

export interface AuthDeps {
  client: SnappClient;
  login: BrowserLogin;
}

export function createServer(adapter: SnappAdapter, places: PlaceStore, auth?: AuthDeps, geocoder?: Geocoder): McpServer {
  /** Saved place / here / coordinates first, then an address search. */
  async function resolveLocation(input: string) {
    const known = places.tryResolve(input);
    if (known) return known;
    if (!geocoder) return places.resolve(input); // throws the "unknown location" help
    const [top] = await geocoder.search(input, places.getCurrent());
    if (!top) {
      throw new Error(`Couldn't find "${input}" on the map. Try a more specific address, a landmark, or lat,lng.`);
    }
    return { lat: top.lat, lng: top.lng, label: top.label };
  }

  const server = new McpServer(
    { name: "snapp-mcp", version: "0.1.0" },
    {
      instructions:
        "Book and manage Snapp rides. Flow: get_ride_quotes -> show the user the prices -> request_ride only after the user " +
        "explicitly picks a quote. After booking, follow the ride with wait_for_ride_update and tell the user each change. " +
        "For rides later today or tomorrow use get_schedule_quote -> schedule_ride. Same rule: " +
        "explicitly picks a quote. Never book or cancel a ride the user didn't ask for. Prices are in Toman." +
        (auth ? " If a tool says you're not logged in, call snapp_login: it opens Snapp's own sign-in page for the user." : "") +
        (adapter.name === "mock" ? " NOTE: this server runs on a MOCK Snapp backend; no real rides are booked." : ""),
    },
  );

  // --- location ---------------------------------------------------------

  server.registerTool(
    "get_current_location",
    {
      title: "Get current location",
      description: "Returns where the user currently is (the last location set with set_current_location).",
      annotations: { readOnlyHint: true },
    },
    () =>
      guard(() => {
        const cur = places.getCurrent();
        if (!cur) return ok("Current location isn't set yet. Ask the user where they are, then call set_current_location.");
        return ok(`You're at ${cur.label} (set ${cur.updatedAt}).`, cur);
      }),
  );

  server.registerTool(
    "set_current_location",
    {
      title: "Set current location",
      description: "Records where the user is right now, used as the default pickup point.",
      inputSchema: {
        location: z.string().describe(LOCATION_HELP),
        label: z.string().optional().describe("Optional friendly name, e.g. 'Valiasr St, near Tajrish'."),
      },
    },
    ({ location, label }) =>
      guard(async () => {
        const p = await resolveLocation(location);
        const cur = places.setCurrent({ ...p, label: label ?? p.label });
        return ok(`Current location set to ${cur.label}.`, cur);
      }),
  );

  if (geocoder) {
    server.registerTool(
      "search_address",
      {
        title: "Search for an address",
        description:
          "Looks up an address or landmark in Iran on OpenStreetMap and returns matching places with coordinates, " +
          "nearest to the user's current location first. Use it when a place name is ambiguous, then pass the chosen " +
          "lat,lng to other tools or save it with save_place.",
        inputSchema: {
          query: z.string().min(2).describe('Address or landmark, in Persian or English, e.g. "میدان ونک".'),
          limit: z.number().int().min(1).max(10).default(5),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      ({ query, limit }) =>
        guard(async () => {
          const matches = await geocoder.search(query, places.getCurrent(), limit);
          if (!matches.length) return ok(`No matches for "${query}".`);
          const lines = matches.map((m, i) => `${i + 1}. ${m.label} (${m.lat.toFixed(5)},${m.lng.toFixed(5)})`);
          const via = matches[0]!.matchedQuery;
          const note = via ? ` — the full address wasn't on the map, so these match «${via}»; confirm with the user` : "";
          return ok(`Matches for "${query}" (from OpenStreetMap)${note}:\n${lines.join("\n")}`, matches);
        }),
    );
  }

  server.registerTool(
    "list_places",
    {
      title: "List saved places",
      description: "Lists the user's saved places (home, work, ...).",
      annotations: { readOnlyHint: true },
    },
    () =>
      guard(() => {
        const list = places.list();
        return ok(list.length ? `${list.length} saved place(s).` : "No saved places yet. Add some with save_place.", list);
      }),
  );

  server.registerTool(
    "save_place",
    {
      title: "Save a place",
      description: "Saves or updates a named place so it can be used as a pickup or destination.",
      inputSchema: {
        name: z.string().min(1).describe("Short name, e.g. 'home', 'work', 'gym'."),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        address: z.string().optional().describe("Human-readable address."),
      },
    },
    (args) => guard(() => ok(`Saved "${args.name}".`, places.save(args))),
  );

  server.registerTool(
    "remove_place",
    {
      title: "Remove a saved place",
      description: "Deletes a saved place by name.",
      inputSchema: { name: z.string() },
      annotations: { destructiveHint: true },
    },
    ({ name }) => guard(() => ok(places.remove(name) ? `Removed "${name}".` : `No saved place called "${name}".`)),
  );

  // --- auth -------------------------------------------------------------

  if (auth) {
    server.registerTool(
      "snapp_login",
      {
        title: "Sign in to Snapp",
        description:
          "Opens Snapp's own sign-in page (app.snapp.taxi) in a browser window on the user's computer. The user signs in " +
          "there themselves (phone number, Snapp's captcha, SMS code). Waits up to a minute, then returns; if still waiting, " +
          "tell the user to finish in the window and call snapp_login_status.",
        annotations: { openWorldHint: true },
      },
      () =>
        guard(async () => {
          if (auth.client.isLoggedIn()) return ok("Already signed in to Snapp.", auth.client.whoami());
          const st = await auth.login.start(60_000);
          if (st.state === "done") return ok("Signed in to Snapp.");
          if (st.state === "failed") throw new Error(`Snapp sign-in failed: ${st.error}`);
          return ok("A Snapp sign-in window is open. Ask the user to sign in there, then call snapp_login_status.");
        }),
    );

    server.registerTool(
      "snapp_login_status",
      {
        title: "Snapp sign-in status",
        description: "Says whether the user is signed in to Snapp, or whether a sign-in window is still waiting.",
        annotations: { readOnlyHint: true },
      },
      () =>
        guard(() => {
          if (auth.client.isLoggedIn()) return ok("Signed in to Snapp.", auth.client.whoami());
          const st = auth.login.getStatus();
          if (st.state === "waiting") return ok("Still waiting for the user to sign in in the Snapp window.");
          if (st.state === "failed") return ok(`Last sign-in attempt failed: ${st.error}. Call snapp_login to try again.`);
          return ok("Not signed in. Call snapp_login.");
        }),
    );

    server.registerTool(
      "snapp_logout",
      {
        title: "Sign out of Snapp",
        description: "Forgets the saved Snapp session on this computer.",
        annotations: { destructiveHint: true },
      },
      () =>
        guard(() => {
          auth.client.logout();
          return ok("Signed out. The saved Snapp session was deleted from this computer.");
        }),
    );
  }

  // --- rides ------------------------------------------------------------

  server.registerTool(
    "get_ride_quotes",
    {
      title: "Get ride quotes",
      description:
        "Gets price and ETA quotes for a ride, one per service type. Does NOT book anything. " +
        "Show the user the options, then call request_ride with the quote they choose. Quotes expire after 5 minutes.",
      inputSchema: {
        destination: z.string().describe(`First (or only) stop. ${LOCATION_HELP}`),
        origin: z.string().default("here").describe(`Pickup point. ${LOCATION_HELP} Defaults to "here".`),
        second_destination: z
          .string()
          .optional()
          .describe(`Optional second stop, visited after the first. ${LOCATION_HELP}`),
        services: z.array(SERVICE).optional().describe("Limit to these services. Default: all."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ destination, origin, second_destination, services }) =>
      guard(async () => {
        const second = second_destination ? await resolveLocation(second_destination) : undefined;
        const quotes = await adapter.getQuotes(await resolveLocation(origin), await resolveLocation(destination), services, second);
        const lines = quotes.map(
          (q) =>
            `- ${q.serviceName}: ${toman(q.priceToman)}` +
            (Number.isFinite(q.pickupEtaMinutes) ? `, pickup in ~${q.pickupEtaMinutes} min` : "") +
            (Number.isFinite(q.tripMinutes) ? `, ~${q.tripMinutes} min trip` : "") +
            ` (quote_id ${q.quoteId})`,
        );
        return ok(`Quotes for ${route(quotes[0]!)}:\n${lines.join("\n")}`, quotes);
      }),
  );

  server.registerTool(
    "request_ride",
    {
      title: "Book a ride",
      description:
        "Books a ride using a quote_id from get_ride_quotes. This sends a real driver and charges the user, " +
        "so only call it after the user has explicitly confirmed the service and price.",
      inputSchema: {
        quote_id: z.string().describe("The quote_id the user chose."),
        confirmed_price_toman: z
          .number()
          .describe("The exact price in Toman the user agreed to for this quote. Must match the quote, or nothing is booked."),
      },
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    ({ quote_id, confirmed_price_toman }) =>
      guard(async () => {
        const quote = await adapter.getQuote(quote_id);
        if (!quote) throw new Error(`Quote ${quote_id} is unknown or expired (quotes last 5 minutes). Get a new quote.`);
        if (Math.round(confirmed_price_toman) !== quote.priceToman) {
          throw new Error(
            `Price mismatch: quote ${quote_id} is ${toman(quote.priceToman)}, not ${toman(confirmed_price_toman)}. ` +
              "Confirm the actual price with the user first. Nothing was booked.",
          );
        }
        const ride = await adapter.requestRide(quote_id);
        return ok(`Ride requested. ${describeRide(ride)} Check progress with get_ride_status.`, ride);
      }),
  );

  server.registerTool(
    "get_ride_status",
    {
      title: "Ride status",
      description: "Shows a ride's status, driver, car, plate, driver location and ETAs. Defaults to the active ride.",
      inputSchema: { ride_id: z.string().optional().describe("Omit to use the current active ride.") },
      annotations: { readOnlyHint: true },
    },
    ({ ride_id }) =>
      guard(async () => {
        const ride = ride_id ? await adapter.getRide(ride_id) : await adapter.getActiveRide();
        if (!ride) return ok(ride_id ? `No ride with id ${ride_id}.` : "You have no active ride.");
        return ok(describeRide(ride), ride);
      }),
  );

  server.registerTool(
    "cancel_ride",
    {
      title: "Cancel a ride",
      description:
        "Cancels a ride that hasn't started. Free while searching and for 2 minutes after a driver accepts; " +
        "after that a cancellation fee applies. Only call when the user asks to cancel.",
      inputSchema: {
        ride_id: z.string().optional().describe("Omit to cancel the current active ride."),
        reason: z.string().optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    ({ ride_id, reason }) =>
      guard(async () => {
        const id = ride_id ?? (await adapter.getActiveRide())?.rideId;
        if (!id) return ok("You have no active ride to cancel.");
        const { ride } = await adapter.cancelRide(id, reason);
        return ok(describeRide(ride), ride);
      }),
  );

  // --- live updates ------------------------------------------------------

  server.registerTool(
    "wait_for_ride_update",
    {
      title: "Wait for a ride update",
      description:
        "Waits until the ride changes (driver found, driver arrived, trip started, finished, cancelled) and returns " +
        "the new state, or returns the current state when the wait times out. Call it in a loop to follow a ride and " +
        "tell the user each change as it happens.",
      inputSchema: {
        ride_id: z.string().optional().describe("Omit to follow the current active ride."),
        timeout_seconds: z.number().int().min(5).max(240).default(45),
      },
      annotations: { readOnlyHint: true },
    },
    ({ ride_id, timeout_seconds }) =>
      guard(async () => {
        const get = () => (ride_id ? adapter.getRide(ride_id) : adapter.getActiveRide());
        const first = await get();
        if (!first) return ok(ride_id ? `No ride with id ${ride_id}.` : "You have no active ride to follow.");
        const id = first.rideId;
        const key = (r: Ride) => `${r.status}|${r.driver?.name ?? ""}|${r.destination.label}|${r.stopReached ?? 0}`;
        const start = key(first);
        const deadline = Date.now() + timeout_seconds * 1000;
        let last = first;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, Number(process.env.SNAPP_POLL_MS ?? 5000)));
          const now = (await adapter.getRide(id)) ?? last;
          last = now;
          if (key(now) !== start) return ok(`Update: ${describeRide(now)}`, now);
        }
        return ok(`No change yet. ${describeRide(last)}`, last);
      }),
  );

  // --- places from history ---------------------------------------------

  server.registerTool(
    "suggest_places",
    {
      title: "Suggest places from ride history",
      description:
        "Finds the addresses the user rides to and from most often (from their recent rides), so they can be saved " +
        "with save_place (e.g. as home or work). Ask the user which is which before saving.",
      inputSchema: { limit: z.number().int().min(1).max(10).default(5) },
      annotations: { readOnlyHint: true },
    },
    ({ limit }) =>
      guard(async () => {
        const rides = await adapter.listRides(50);
        const spots = new Map<string, { lat: number; lng: number; label: string; visits: number }>();
        for (const r of rides) {
          for (const p of [r.origin, r.destination]) {
            if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
            const k = `${p.lat.toFixed(3)},${p.lng.toFixed(3)}`; // ~100 m buckets
            const cur = spots.get(k);
            if (cur) cur.visits++;
            else spots.set(k, { lat: p.lat, lng: p.lng, label: p.label, visits: 1 });
          }
        }
        const top = [...spots.values()].sort((a, b) => b.visits - a.visits).slice(0, limit);
        if (!top.length) return ok("No ride history to learn places from yet.");
        const saved = places.list();
        const lines = top.map((t, i) => {
          const already = saved.find((p) => haversineKm(p, t) < 0.3);
          return `${i + 1}. ${t.label} (${t.visits} trips)${already ? `, saved as "${already.name}"` : ""} (${t.lat.toFixed(5)},${t.lng.toFixed(5)})`;
        });
        return ok(`Places you ride to and from most, from your last ${rides.length} rides:\n${lines.join("\n")}`, top);
      }),
  );

  // --- change destination ----------------------------------------------

  const activeId = async (rideId?: string) => {
    const id = rideId ?? (await adapter.getActiveRide())?.rideId;
    if (!id) throw new Error("You have no active ride.");
    return id;
  };

  server.registerTool(
    "preview_destination_change",
    {
      title: "Price a new destination",
      description:
        "Shows what the active ride would cost with a different destination. Changes nothing. Show the user the new " +
        "price, then call change_destination only if they agree.",
      inputSchema: {
        destination: z.string().describe(LOCATION_HELP),
        ride_id: z.string().optional().describe("Omit for the current active ride."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ destination, ride_id }) =>
      guard(async () => {
        const id = await activeId(ride_id);
        const q = await adapter.previewDestinationChange(id, await resolveLocation(destination));
        return ok(`New destination ${q.destination.label}: the ride would cost ${toman(q.newPriceToman)}.`, q);
      }),
  );

  server.registerTool(
    "change_destination",
    {
      title: "Change the destination",
      description:
        "Changes the active ride's destination. Only call after preview_destination_change and the user agreeing to " +
        "the new price; pass that price as confirmed_price_toman.",
      inputSchema: {
        destination: z.string().describe(LOCATION_HELP),
        confirmed_price_toman: z.number().describe("The new price the user agreed to. Must match the current preview."),
        ride_id: z.string().optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    ({ destination, confirmed_price_toman, ride_id }) =>
      guard(async () => {
        const id = await activeId(ride_id);
        const dest = await resolveLocation(destination);
        const q = await adapter.previewDestinationChange(id, dest);
        if (Math.round(confirmed_price_toman) !== q.newPriceToman) {
          throw new Error(
            `Price mismatch: the new destination now costs ${toman(q.newPriceToman)}, not ${toman(confirmed_price_toman)}. ` +
              "Confirm with the user first. Nothing was changed.",
          );
        }
        const ride = await adapter.changeDestination(id, dest);
        return ok(`Destination changed to ${dest.label}. ${describeRide(ride)}`, ride);
      }),
  );

  // --- scheduled rides --------------------------------------------------

  const scheduleQuotes = new Map<string, ScheduleQuote & { expiresAt: number }>();
  const fmtTime = (unix: number) =>
    new Date(unix * 1000).toLocaleString("en-GB", { timeZone: "Asia/Tehran", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  server.registerTool(
    "get_schedule_quote",
    {
      title: "Price a ride for later",
      description:
        "Prices a ride booked ahead for a given time (Snapp allows today and tomorrow, in 5-minute slots). Scheduled " +
        "prices are a range, and Snapp may add a scheduling fee. Books nothing; call schedule_ride after the user agrees.",
      inputSchema: {
        destination: z.string().describe(LOCATION_HELP),
        time: z.string().describe('Pickup time in Tehran time, ISO like "2026-11-05T08:00", or Unix seconds.'),
        origin: z.string().default("here").describe(`Pickup point. ${LOCATION_HELP}`),
        service: SERVICE.optional().describe("Service id from get_ride_quotes. Default: the first/cheapest car service."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ destination, time, origin, service }) =>
      guard(async () => {
        const want = parseTehranTime(time);
        const slots = await adapter.getScheduleSlots();
        const slot = slots.find((t) => Math.abs(t - want) < 150);
        if (slot === undefined) {
          const range = slots.length ? `${fmtTime(slots[0]!)} to ${fmtTime(slots.at(-1)!)}` : "none right now";
          throw new Error(`${fmtTime(want)} isn't a bookable time. Available: ${range}, every 5 minutes.`);
        }
        const o = await resolveLocation(origin), d = await resolveLocation(destination);
        const svc = service ?? (adapter.name === "mock" ? "classic" : "1");
        const q = await adapter.getScheduleQuote(o, d, svc, slot);
        const id = `sq_${randomUUID().slice(0, 8)}`;
        scheduleQuotes.set(id, { ...q, expiresAt: Date.now() + 10 * 60_000 });
        const priced = Number.isFinite(q.upperToman);
        return ok(
          `Ride at ${fmtTime(slot)} from ${o.label} to ${d.label}: ` +
            (priced
              ? `about ${toman(q.lowerToman)} to ${toman(q.upperToman)} (final price set before the trip; Snapp may add a scheduling fee).`
              : "Snapp can't estimate the price right now; it sets the final price before the trip. Tell the user, and only " +
                "book with accept_price_set_later if they agree.") +
            ` schedule_quote_id ${id}`,
          { scheduleQuoteId: id, ...q },
        );
      }),
  );

  server.registerTool(
    "schedule_ride",
    {
      title: "Book a ride for later",
      description:
        "Books the ride from get_schedule_quote. Only call after the user agreed to the time and price: pass the range's " +
        "upper price as confirmed_max_price_toman, or, when Snapp gave no estimate, accept_price_set_later: true.",
      inputSchema: {
        schedule_quote_id: z.string(),
        confirmed_max_price_toman: z.number().optional().describe("The upper end of the price range the user agreed to."),
        accept_price_set_later: z
          .boolean()
          .optional()
          .describe("Only when the quote had no estimate and the user agreed to Snapp setting the price before the trip."),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    ({ schedule_quote_id, confirmed_max_price_toman, accept_price_set_later }) =>
      guard(async () => {
        const q = scheduleQuotes.get(schedule_quote_id);
        if (!q || q.expiresAt < Date.now()) throw new Error("That schedule quote is unknown or expired. Get a new one.");
        if (Number.isFinite(q.upperToman)) {
          if (confirmed_max_price_toman === undefined || Math.round(confirmed_max_price_toman) !== q.upperToman) {
            throw new Error(`Price mismatch: the quote's upper price is ${toman(q.upperToman)}. Confirm with the user. Nothing was booked.`);
          }
        } else if (accept_price_set_later !== true) {
          throw new Error("This quote has no price estimate. Book only if the user agrees, with accept_price_set_later: true. Nothing was booked.");
        }
        scheduleQuotes.delete(schedule_quote_id);
        const r = await adapter.scheduleRide(q);
        return ok(`Scheduled: ${fmtTime(r.startTime)} from ${r.origin.label} to ${r.destination.label} (id ${r.scheduleId}).`, r);
      }),
  );

  server.registerTool(
    "list_scheduled_rides",
    {
      title: "Upcoming scheduled rides",
      description: "Lists rides booked for later.",
      annotations: { readOnlyHint: true },
    },
    () =>
      guard(async () => {
        const rides = await adapter.listScheduledRides();
        if (!rides.length) return ok("No upcoming scheduled rides.");
        const lines = rides.map(
          (r) => `- ${Number.isFinite(r.startTime) ? fmtTime(r.startTime) : "?"}: ${r.origin.label} to ${r.destination.label} (id ${r.scheduleId})`,
        );
        return ok(`Upcoming scheduled rides:\n${lines.join("\n")}`, rides);
      }),
  );

  server.registerTool(
    "cancel_scheduled_ride",
    {
      title: "Cancel a scheduled ride",
      description: "Cancels a ride booked for later. Only call when the user asks.",
      inputSchema: { schedule_id: z.string() },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    ({ schedule_id }) =>
      guard(async () => {
        await adapter.cancelScheduledRide(schedule_id);
        return ok(`Cancelled scheduled ride ${schedule_id}.`);
      }),
  );

  server.registerTool(
    "list_rides",
    {
      title: "Ride history",
      description: "Lists recent rides, newest first.",
      inputSchema: { limit: z.number().int().min(1).max(50).default(10) },
      annotations: { readOnlyHint: true },
    },
    ({ limit }) =>
      guard(async () => {
        const rides = await adapter.listRides(limit);
        if (!rides.length) return ok("No rides yet.");
        return ok(rides.map(describeRide).join("\n"), rides);
      }),
  );

  return server;
}

/** "2026-11-05T08:00" (Tehran local time, UTC+03:30), a full ISO string with offset, or Unix seconds. */
export function parseTehranTime(input: string): number {
  const t = input.trim();
  if (/^\d{9,11}$/.test(t)) return Number(t);
  const naive = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(t);
  const ms = Date.parse(naive ? `${t.replace(" ", "T")}+03:30` : t);
  if (!Number.isFinite(ms)) throw new Error(`Can't read the time "${input}". Use e.g. "2026-11-05T08:00" (Tehran time).`);
  return Math.round(ms / 1000);
}
