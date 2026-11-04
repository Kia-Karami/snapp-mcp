# Snapp MCP

An MCP server that lets an AI agent get Snapp ride quotes, book a ride, track the driver, cancel, and know where you are.

> **Status:** two backends.
> - `mock` (default): a realistic simulated Snapp. Nothing real happens.
> - `snapp`: the real Snapp passenger API, the one app.snapp.taxi uses. **Sign-in and price quotes work.**
>   Verified live on 2026-11-04: quotes, booking, status, live updates with a real driver (name, car, plate,
>   location), cancel (free while searching, and free right after a driver accepted), history, suggested places,
>   scheduled-ride pricing, two-stop pricing. Changing the destination, booking a two-stop ride and booking a scheduled ride follow the web app's own calls but
>   haven't been run live.
>   (Scheduling a test route was refused by Snapp with error 6005 for both economy and Eco Plus, so booking a
>   scheduled ride is still unverified.)
>
> This is an unofficial client of an undocumented API. Snapp may change or block it, and it may conflict with
> Snapp's terms. Use it with your own account only.

## Tools

| Tool | What it does |
| --- | --- |
| `get_current_location` / `set_current_location` | Where you are now; the default pickup point |
| `list_places` / `save_place` / `remove_place` | Saved places like `home`, `work` |
| `search_address` | Find an address or landmark in Iran (OpenStreetMap) |
| `get_ride_quotes` | Price + ETA per service. Optional `second_destination` for a two-stop ride. Books nothing |
| `request_ride` | Books a ride from a `quote_id` the user picked |
| `get_ride_status` | Status, driver, car, plate, driver location, ETAs |
| `cancel_ride` | Free while searching and for 2 min after a driver accepts, then a fee |
| `list_rides` | Ride history |
| `wait_for_ride_update` | Waits until the ride changes (driver found, arrived, trip started, done) so the agent can tell you |
| `suggest_places` | Your most frequent pickup/drop-off addresses from ride history, to save as home/work |
| `preview_destination_change` / `change_destination` | New price for a different destination, then change it (needs the agreed price) |
| `get_schedule_quote` / `schedule_ride` | Book a ride for later today or tomorrow (5-minute slots; price is a range) |
| `list_scheduled_rides` / `cancel_scheduled_ride` | Upcoming scheduled rides |
| `snapp_login` / `snapp_login_status` / `snapp_logout` | Real backend only: sign in on Snapp's own page |

Locations can be a saved place name, `here`, `lat,lng`, or an address/landmark (Persian or English), looked up on
[OpenStreetMap Nominatim](https://nominatim.org) at most once per second. `search_address` lists matches.
Full addresses work too, e.g. `از تهران ونک خیابان شیخ بهایی نبش پارک ملت`: if the whole sentence isn't
found, the search retries with its pieces (the landmark after «نبش», the alley, the street, ...) and ranks matches by
the remaining words such as city and neighbourhood.

**Safety:** booking is two steps. The agent must get quotes first, and `request_ride` needs both the `quote_id`
(valid for 5 minutes, usable once) and `confirmed_price_toman`, the exact price the user agreed to. If the price
doesn't match the quote, nothing is booked.

## Setup

Needs Node.js 20+. No clone needed: `npx` builds it straight from GitHub.

Add it to Claude Code (real Snapp):

```bash
claude mcp add snapp -e SNAPP_BACKEND=snapp -- npx -y github:Kia-Karami/snapp-mcp
```

Or to Claude Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "snapp": {
      "command": "npx",
      "args": ["-y", "github:Kia-Karami/snapp-mcp"],
      "env": { "SNAPP_BACKEND": "snapp" }
    }
  }
}
```

Leave out `SNAPP_BACKEND` to try the simulated Snapp first. Then ask your assistant to sign in to Snapp.

### Development

```bash
git clone https://github.com/Kia-Karami/snapp-mcp && cd snapp-mcp
npm install
npm test
npm run build
```

## Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `SNAPP_BACKEND` | `mock` | `mock` or `snapp` |
| `SNAPP_DEBUG` | unset | Log raw Snapp API traffic to stderr |
| `SNAPP_MCP_HOME` | `~/.snapp-mcp` | Where saved places and current location are stored (`state.json`) |
| `SNAPP_MOCK_SPEED` | `10` | Mock clock speed: simulated seconds per real second |

Mock ride state lives in memory and resets when the server restarts. Saved places persist.

## Signing in (real backend)

`snapp_login` opens **Snapp's own sign-in page** (app.snapp.taxi) in a browser window. The user signs in there
as usual: phone number, Snapp's captcha, SMS code. When the site has a session, the MCP keeps its tokens in
`~/.snapp-mcp/auth.json` (readable only by you), refreshes them as needed, and closes the window. The MCP never
sees or relays the captcha or SMS code.

The window uses Google Chrome or Edge if installed, otherwise Playwright's WebKit:

```bash
npx playwright-core install webkit
```

(Playwright's Chromium download is geo-blocked in Iran; WebKit downloads fine.)
