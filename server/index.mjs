import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./db.mjs";
import { generateItinerary } from "./planner.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const db = openDatabase(join(root, "data", "travel-agent.db"));
const port = Number(process.env.PORT ?? 3000);
const MIME_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml" };

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("Request body exceeds 1 MB");
  }
  if (!body) return {};
  try { return JSON.parse(body); } catch { throw new Error("Request body must be valid JSON"); }
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function normalizeTrip(input, existing = {}) {
  const merged = {
    ...existing,
    ...input,
    travelers: { ...(existing.travelers ?? {}), ...(input.travelers ?? {}) },
    preferences: { ...(existing.preferences ?? {}), ...(input.preferences ?? {}) }
  };
  const destinations = merged.destinations;
  if (!Array.isArray(destinations) || destinations.length === 0 || !destinations.every((item) => typeof item === "string" && item.trim())) throw badRequest("destinations must contain at least one city");
  if (!Number.isInteger(merged.durationDays) || merged.durationDays < 1 || merged.durationDays > 30) throw badRequest("durationDays must be an integer between 1 and 30");
  if (!Number.isInteger(merged.travelers?.count) || merged.travelers.count < 1 || merged.travelers.count > 20) throw badRequest("travelers.count must be an integer between 1 and 20");
  if (!merged.originalPrompt?.trim()) throw badRequest("originalPrompt is required");
  const preferences = {
    interests: [], pace: "balanced", avoid: [], constraints: [], ...merged.preferences
  };
  if (!['relaxed', 'balanced', 'packed'].includes(preferences.pace)) throw badRequest("preferences.pace is invalid");
  return {
    ...merged,
    id: merged.id ?? randomUUID(),
    version: existing.id ? (existing.version + 1) : 1,
    status: merged.status ?? "draft",
    title: merged.title?.trim() || `${destinations.join(" · ")}之旅`,
    originalPrompt: merged.originalPrompt.trim(),
    destinations: destinations.map((item) => item.trim()),
    itinerary: Array.isArray(merged.itinerary) ? merged.itinerary : [],
    preferences
  };
}

async function serveStatic(request, response) {
  const requestPath = request.url === "/" ? "/index.html" : request.url.split("?")[0];
  const safePath = normalize(requestPath).replace(/^([/\\])+/, "");
  const target = join(root, safePath);
  if (!target.startsWith(root) || !existsSync(target) || !(await stat(target)).isFile()) return send(response, 404, { error: "Not found" });
  response.writeHead(200, { "content-type": MIME_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream" });
  response.end(await readFile(target));
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PATCH,OPTIONS", "access-control-allow-headers": "content-type" });
      return response.end();
    }
    const path = new URL(request.url, `http://${request.headers.host}`).pathname;
    if (request.method === "GET" && path === "/api/health") return send(response, 200, { status: "ok" });
    if (request.method === "GET" && path === "/api/trips") return send(response, 200, { trips: db.list() });
    const match = path.match(/^\/api\/trips\/([\w-]+)$/);
    const generateMatch = path.match(/^\/api\/trips\/([\w-]+)\/generate$/);
    if (request.method === "POST" && generateMatch) {
      const existing = db.find(generateMatch[1]);
      if (!existing) return send(response, 404, { error: "Trip not found" });
      const generated = await generateItinerary(existing);
      const trip = db.save({ ...existing, ...generated, version: existing.version + 1, status: "ready" });
      return send(response, 200, { trip });
    }
    if (request.method === "GET" && match) {
      const trip = db.find(match[1]);
      return trip ? send(response, 200, { trip }) : send(response, 404, { error: "Trip not found" });
    }
    if (request.method === "POST" && path === "/api/trips") {
      const trip = db.create(normalizeTrip(await readJson(request)));
      return send(response, 201, { trip });
    }
    if (request.method === "PATCH" && match) {
      const existing = db.find(match[1]);
      if (!existing) return send(response, 404, { error: "Trip not found" });
      const trip = db.save(normalizeTrip({ ...(await readJson(request)), id: existing.id }, existing));
      return send(response, 200, { trip });
    }
    if (path.startsWith("/api/")) return send(response, 404, { error: "API route not found" });
    return serveStatic(request, response);
  } catch (error) {
    return send(response, error.status ?? 500, { error: error.message || "Internal server error" });
  }
});

server.listen(port, () => console.log(`Travel Agent is running at http://localhost:${port}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { db.close(); server.close(() => process.exit(0)); });
