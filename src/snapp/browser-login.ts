import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright-core";
import type { SnappClient } from "./client.js";

/**
 * Logs in on Snapp's own website: opens app.snapp.taxi/login in a real browser
 * window, the user signs in there exactly as usual (phone, Snapp's captcha,
 * SMS code), and once the site has a session we keep its tokens and close
 * the window. We never see or relay the captcha or the SMS code.
 */

const LOGIN_URL = "https://app.snapp.taxi/login";
const TIMEOUT_MS = 5 * 60_000;

export type LoginState =
  | { state: "idle" }
  | { state: "waiting"; startedAt: string }
  | { state: "done"; at: string }
  | { state: "failed"; error: string };

export class BrowserLogin {
  private status: LoginState = { state: "idle" };
  private running?: Promise<void>;

  constructor(private readonly client: SnappClient) {}

  getStatus(): LoginState {
    return this.status;
  }

  /** Starts the login window if it isn't open; resolves when login finishes or `waitMs` passes. */
  async start(waitMs: number): Promise<LoginState> {
    if (!this.running) {
      this.status = { state: "waiting", startedAt: new Date().toISOString() };
      this.running = this.run()
        .then(() => {
          this.status = { state: "done", at: new Date().toISOString() };
        })
        .catch((err: Error) => {
          this.status = { state: "failed", error: err.message };
        })
        .finally(() => {
          this.running = undefined;
        });
    }
    await Promise.race([this.running, new Promise((r) => setTimeout(r, waitMs))]);
    return this.status;
  }

  private async run(): Promise<void> {
    const context = await launch();
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
      const deadline = Date.now() + TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (page.isClosed()) throw new Error("The login window was closed before signing in.");
        const t = await page
          .evaluate(() => ({
            access: localStorage.getItem("accessToken"),
            refresh: localStorage.getItem("refreshToken"),
            device: localStorage.getItem("deviceId"),
          }))
          .catch(() => undefined); // page navigating
        const access = clean(t?.access);
        const refresh = clean(t?.refresh);
        if (access && refresh) {
          this.client.adoptSession({ accessToken: access, refreshToken: refresh, deviceId: clean(t?.device) });
          return;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error("Login timed out after 5 minutes.");
    } finally {
      await context.close().catch(() => {});
    }
  }
}

function clean(v: string | null | undefined): string | undefined {
  if (!v || v === "null" || v === "undefined") return undefined;
  return v.replace(/^"|"$/g, "");
}

async function launch(): Promise<BrowserContext> {
  const { chromium, webkit } = await import("playwright-core");
  const profile = join(process.env.SNAPP_MCP_HOME ?? join(homedir(), ".snapp-mcp"), "browser");
  const opts = { headless: false, viewport: { width: 430, height: 860 }, locale: "fa-IR" };
  // Prefer the user's installed Chrome/Edge; fall back to Playwright's WebKit.
  for (const channel of ["chrome", "msedge"]) {
    try {
      return await chromium.launchPersistentContext(`${profile}-${channel}`, { ...opts, channel });
    } catch {
      /* not installed */
    }
  }
  try {
    return await webkit.launchPersistentContext(`${profile}-webkit`, opts);
  } catch (err) {
    throw new Error(
      "No browser available for Snapp login. Install Google Chrome, or run `npx playwright-core install webkit`. " +
        `(${(err as Error).message.split("\n")[0]})`,
    );
  }
}
