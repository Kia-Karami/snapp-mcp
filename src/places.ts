import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseLatLng } from "./geo.js";
import type { LatLng, Place, Point } from "./types.js";

interface CurrentLocation extends LatLng {
  label: string;
  updatedAt: string;
}

interface StoreData {
  places: Record<string, Place>;
  current?: CurrentLocation;
}

const HERE_WORDS = new Set(["here", "current", "current location", "me", "my location"]);

/**
 * Saved places plus the user's current location, persisted as JSON
 * (default ~/.snapp-mcp/state.json, override with SNAPP_MCP_HOME).
 */
export class PlaceStore {
  private data: StoreData;

  constructor(private readonly file: string = defaultStateFile()) {
    this.data = load(file);
  }

  list(): Place[] {
    return Object.values(this.data.places).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): Place | undefined {
    return this.data.places[key(name)];
  }

  save(place: Place): Place {
    const clean: Place = { ...place, name: place.name.trim() };
    if (!clean.name) throw new Error("Place name cannot be empty.");
    if (HERE_WORDS.has(key(clean.name))) {
      throw new Error(`"${clean.name}" is reserved for your current location.`);
    }
    this.data.places[key(clean.name)] = clean;
    this.persist();
    return clean;
  }

  remove(name: string): boolean {
    const k = key(name);
    if (!this.data.places[k]) return false;
    delete this.data.places[k];
    this.persist();
    return true;
  }

  getCurrent(): CurrentLocation | undefined {
    return this.data.current;
  }

  setCurrent(point: Point): CurrentLocation {
    this.data.current = { ...point, updatedAt: new Date().toISOString() };
    this.persist();
    return this.data.current;
  }

  /**
   * Turns user input into a point: a saved place name, "here"/"current",
   * or raw "lat,lng" coordinates. Returns undefined for anything else
   * (e.g. a street address, which needs a geocoder).
   */
  tryResolve(input: string): Point | undefined {
    const trimmed = input.trim();
    if (HERE_WORDS.has(key(trimmed))) {
      const cur = this.data.current;
      if (!cur) {
        throw new Error(
          "Your current location isn't set. Call set_current_location with a place, address, or lat,lng first.",
        );
      }
      return { lat: cur.lat, lng: cur.lng, label: cur.label };
    }
    const coords = parseLatLng(trimmed);
    if (coords) return { ...coords, label: trimmed };
    const place = this.get(trimmed);
    if (place) return { lat: place.lat, lng: place.lng, label: place.address ? `${place.name} (${place.address})` : place.name };
    return undefined;
  }

  resolve(input: string): Point {
    const p = this.tryResolve(input);
    if (p) return p;
    const known = this.list().map((x) => x.name);
    throw new Error(
      `Unknown location "${input.trim()}". Use a saved place (${known.length ? known.join(", ") : "none saved yet"}), "here", or "lat,lng". ` +
        "Save new places with save_place.",
    );
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
}

function key(name: string): string {
  return name.trim().toLowerCase();
}

function defaultStateFile(): string {
  const home = process.env.SNAPP_MCP_HOME ?? join(homedir(), ".snapp-mcp");
  return join(home, "state.json");
}

function load(file: string): StoreData {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StoreData>;
    return { places: parsed.places ?? {}, current: parsed.current };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { places: {} };
    throw new Error(`Could not read ${file}: ${(err as Error).message}`);
  }
}
