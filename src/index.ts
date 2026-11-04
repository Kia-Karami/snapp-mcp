#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MockSnappAdapter } from "./adapters/mock.js";
import { RealSnappAdapter } from "./adapters/snapp.js";
import { NominatimGeocoder } from "./geocode.js";
import { PlaceStore } from "./places.js";
import { BrowserLogin } from "./snapp/browser-login.js";
import { SnappClient } from "./snapp/client.js";
import { createServer } from "./server.js";

const backend = process.env.SNAPP_BACKEND ?? "mock";
const places = new PlaceStore();
const geocoder = new NominatimGeocoder();
let server;
if (backend === "mock") {
  server = createServer(new MockSnappAdapter(), places, undefined, geocoder);
} else if (backend === "snapp") {
  const client = new SnappClient();
  server = createServer(new RealSnappAdapter(client), places, { client, login: new BrowserLogin(client) }, geocoder);
} else {
  throw new Error(`Unknown SNAPP_BACKEND "${backend}". Use "mock" or "snapp".`);
}
await server.connect(new StdioServerTransport());
// stdout carries the MCP protocol, so logs go to stderr.
console.error(`snapp-mcp running on stdio (backend: ${backend})`);
