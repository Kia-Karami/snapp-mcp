import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Thin HTTP client for Snapp's passenger API, shaped after what the official
 * web app (app.snapp.taxi) sends. Undocumented and subject to change.
 */

const OAUTH = "https://oauth-passenger.snapp.site";
const WEB = "https://app.snapp.taxi";
export const BASES = {
  base: `${WEB}/api/api-base`,
  api: `${WEB}/api`,
  events: `${WEB}/api/api-events`,
  locations: "https://locations.snapp.site",
} as const;
export type BaseName = keyof typeof BASES;

// Public client credentials embedded in Snapp's web app.
const CLIENT = { client_id: "ios_sadjfhasd9871231hfso234", client_secret: "23497shjlf982734-=1031nln" };

interface Session {
  accessToken: string;
  refreshToken: string;
  cellphone?: string;
  deviceId: string;
  savedAt: string;
}

export class SnappApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
  }
}

export class SnappClient {
  private session?: Session;
  private deviceId: string;

  constructor(private readonly file: string = defaultAuthFile()) {
    this.session = loadSession(file);
    this.deviceId = this.session?.deviceId ?? randomUUID();
  }

  isLoggedIn(): boolean {
    return !!this.session?.accessToken;
  }

  whoami(): { loggedIn: boolean; cellphone?: string; since?: string } {
    return { loggedIn: this.isLoggedIn(), cellphone: maskPhone(this.session?.cellphone), since: this.session?.savedAt };
  }

  /** Stores tokens taken from a signed-in Snapp web session. */
  adoptSession(t: { accessToken: string; refreshToken: string; deviceId?: string; cellphone?: string }): void {
    if (t.deviceId) this.deviceId = t.deviceId;
    this.saveSession({ accessToken: t.accessToken, refreshToken: t.refreshToken, cellphone: t.cellphone });
  }

  logout(): void {
    this.session = undefined;
    writeFileSync(this.file, "{}");
  }

  /** Authenticated call; refreshes the access token once on 401. */
  async call<T = unknown>(method: string, base: BaseName, path: string, body?: unknown): Promise<T> {
    if (!this.session) throw new Error("Not logged in to Snapp. Call the snapp_login tool first.");
    const url = `${BASES[base]}/${path}`;
    try {
      return (await this.raw(method, url, body, this.session.accessToken)) as T;
    } catch (err) {
      if (!(err instanceof SnappApiError) || err.status !== 401) throw err;
      await this.refresh();
      return (await this.raw(method, url, body, this.session!.accessToken)) as T;
    }
  }

  private async refresh(): Promise<void> {
    const s = this.session!;
    try {
      const body = (await this.raw("POST", `${OAUTH}/v2/auth`, {
        grant_type: "refresh_token",
        ...CLIENT,
        device_id: this.deviceId,
        refresh_token: s.refreshToken,
      })) as { access_token: string; refresh_token: string };
      this.saveSession({ accessToken: body.access_token, refreshToken: body.refresh_token, cellphone: s.cellphone });
    } catch {
      throw new Error("Snapp session expired. Call snapp_login to sign in again.");
    }
  }

  private async raw(method: string, url: string, body?: unknown, token?: string): Promise<unknown> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      locale: "fa-IR",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
      Origin: WEB,
      Referer: `${WEB}/`,
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, {
      method,
      headers,
      body: method === "GET" || body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    // Scheduled-ride ids are 64-bit; keep them as strings so JSON.parse doesn't round them.
    const text = (await res.text()).replace(/"id":\s*(\d{16,})/g, '"id":"$1"');
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      /* keep text */
    }
    if (process.env.SNAPP_DEBUG) console.error(`[snapp] ${method} ${url} -> ${res.status}\n${text.slice(0, 4000)}`);
    if (!res.ok) {
      const msg = extractMessage(parsed) ?? `HTTP ${res.status}`;
      throw new SnappApiError(`Snapp ${method} ${new URL(url).pathname} failed: ${msg}`, res.status, parsed);
    }
    return parsed;
  }

  private saveSession(s: Omit<Session, "deviceId" | "savedAt">): void {
    this.session = { ...s, deviceId: this.deviceId, savedAt: new Date().toISOString() };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.session, null, 2), { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }
}

function extractMessage(b: unknown): string | undefined {
  if (!b || typeof b !== "object") return typeof b === "string" && b ? b.slice(0, 200) : undefined;
  const o = b as Record<string, unknown>;
  const data = o.data as Record<string, unknown> | undefined;
  for (const v of [o.message, o.error_description, o.error, data?.message, (o.status as Record<string, unknown>)?.message]) {
    if (typeof v === "string" && v) return v;
  }
  return JSON.stringify(b).slice(0, 200);
}

function maskPhone(p?: string): string | undefined {
  return p ? `${p.slice(0, 6)}****${p.slice(-3)}` : undefined;
}

function defaultAuthFile(): string {
  return join(process.env.SNAPP_MCP_HOME ?? join(homedir(), ".snapp-mcp"), "auth.json");
}

function loadSession(file: string): Session | undefined {
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as Partial<Session>;
    return s.accessToken && s.refreshToken && s.deviceId ? (s as Session) : undefined;
  } catch {
    return undefined;
  }
}
