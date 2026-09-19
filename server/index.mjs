import { createServer } from "node:http";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, isAbsolute, join, normalize, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./db.mjs";
import { extractTripIntent, generateItinerary, reviseItinerary } from "./planner.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const databasePath = process.env.DATABASE_PATH
  ? (isAbsolute(process.env.DATABASE_PATH) ? process.env.DATABASE_PATH : resolve(root, process.env.DATABASE_PATH))
  : join(root, "data", "travel-agent.db");
const uploadsRoot = process.env.UPLOADS_PATH
  ? (isAbsolute(process.env.UPLOADS_PATH) ? process.env.UPLOADS_PATH : resolve(root, process.env.UPLOADS_PATH))
  : join(root, "data", "uploads");
const db = openDatabase(databasePath);
const port = Number(process.env.PORT ?? 3000);
const MIME_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml" };

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  response.end(JSON.stringify(body));
}

async function readJson(request, maxBytes = 1_000_000) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > maxBytes) throw badRequest(`Request body exceeds ${Math.round(maxBytes / 1_000_000)} MB`);
  }
  if (!body) return {};
  try { return JSON.parse(body); } catch { throw badRequest("Request body must be valid JSON"); }
}

async function serveUpload(path, response) {
  const safePath = normalize(path.replace(/^\/uploads\//, "")).replace(/^([/\\])+/, "");
  const target = join(uploadsRoot, safePath);
  if (!target.startsWith(`${uploadsRoot}/`) || !existsSync(target) || !(await stat(target)).isFile()) return send(response, 404, { error: "Photo not found" });
  response.writeHead(200, { "content-type": MIME_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream", "cache-control": "public, max-age=86400" });
  response.end(await readFile(target));
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function calculateEndDate(startDate, durationDays) {
  if (!startDate) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw badRequest("startDate must use YYYY-MM-DD");
  const date = new Date(`${startDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw badRequest("startDate is invalid");
  date.setUTCDate(date.getUTCDate() + durationDays - 1);
  return date.toISOString().slice(0, 10);
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
  if (merged.startDate !== undefined && typeof merged.startDate !== "string") throw badRequest("startDate must be a string");
  const startDate = merged.startDate?.trim() || undefined;
  return {
    ...merged,
    id: merged.id ?? randomUUID(),
    version: existing.id ? (existing.version + 1) : 1,
    status: merged.status ?? "draft",
    title: merged.title?.trim() || `${destinations.join(" · ")}之旅`,
    originalPrompt: merged.originalPrompt.trim(),
    destinations: destinations.map((item) => item.trim()),
    travelTiming: merged.travelTiming?.trim() || undefined,
    startDate,
    endDate: calculateEndDate(startDate, merged.durationDays),
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
      response.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS", "access-control-allow-headers": "content-type" });
      return response.end();
    }
    const path = new URL(request.url, `http://${request.headers.host}`).pathname;
    if (request.method === "GET" && path === "/api/health") return send(response, 200, { status: "ok" });
    if (request.method === "GET" && path.startsWith("/uploads/")) return serveUpload(path, response);
    if (request.method === "GET" && path === "/api/trips") return send(response, 200, { trips: db.list() });
    if (request.method === "POST" && path === "/api/trips/parse") {
      const { prompt, currentIntent } = await readJson(request);
      const assessment = await extractTripIntent(prompt, currentIntent);
      return send(response, 200, assessment);
    }
    const match = path.match(/^\/api\/trips\/([\w-]+)$/);
    const generateMatch = path.match(/^\/api\/trips\/([\w-]+)\/generate$/);
    const revisionsMatch = path.match(/^\/api\/trips\/([\w-]+)\/revisions$/);
    const locksMatch = path.match(/^\/api\/trips\/([\w-]+)\/locks$/);
    const photosMatch = path.match(/^\/api\/trips\/([\w-]+)\/photos$/);
    const photoMatch = path.match(/^\/api\/trips\/([\w-]+)\/photos\/([\w-]+)$/);
    if (request.method === "POST" && generateMatch) {
      const existing = db.find(generateMatch[1]);
      if (!existing) return send(response, 404, { error: "Trip not found" });
      const generated = await generateItinerary(existing);
      const trip = db.save({ ...existing, ...generated, version: existing.version + 1, status: "ready" });
      return send(response, 200, { trip });
    }
    if (request.method === "GET" && revisionsMatch) {
      const existing = db.find(revisionsMatch[1]);
      if (!existing) return send(response, 404, { error: "Trip not found" });
      return send(response, 200, { revisions: db.listRevisions(existing.id) });
    }
    if (request.method === "POST" && revisionsMatch) {
      const existing = db.find(revisionsMatch[1]);
      if (!existing) return send(response, 404, { error: "Trip not found" });
      const revised = await reviseItinerary(existing, await readJson(request));
      const trip = db.save({ ...existing, title: revised.title, itinerary: revised.itinerary, budgetEstimate: revised.budgetEstimate, version: revised.revision.version, status: "ready" });
      const revision = db.saveRevision(revised.revision);
      return send(response, 200, { trip, revision });
    }
    if (request.method === "PATCH" && locksMatch) {
      const existing = db.find(locksMatch[1]);
      if (!existing) return send(response, 404, { error: "Trip not found" });
      const { dayNumber, activityId, locked } = await readJson(request);
      if (!Number.isInteger(dayNumber) || typeof locked !== "boolean") throw badRequest("dayNumber and locked are required");
      let targetFound = false;
      const itinerary = existing.itinerary.map((day) => {
        if (day.dayNumber !== dayNumber) return day;
        if (!activityId) { targetFound = true; return { ...day, locked }; }
        const activities = day.activities.map((activity) => {
          if (activity.id !== activityId) return activity;
          targetFound = true;
          return { ...activity, locked };
        });
        return { ...day, activities };
      });
      if (!targetFound) return send(response, 404, { error: "Day or activity not found" });
      const trip = db.save({ ...existing, itinerary, version: existing.version + 1 });
      return send(response, 200, { trip });
    }
    if (request.method === "GET" && photosMatch) {
      const existing = db.find(photosMatch[1]);
      if (!existing) return send(response, 404, { error: "Trip not found" });
      return send(response, 200, { album: existing.album || null });
    }
    if (request.method === "POST" && photosMatch) {
      const existing = db.find(photosMatch[1]);
      if (!existing) return send(response, 404, { error: "Trip not found" });
      const { dataUrl, caption, dayNumber } = await readJson(request, 12_000_000);
      const image = typeof dataUrl === "string" && dataUrl.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
      if (!image) throw badRequest("photo must be a JPEG, PNG, or WebP data URL");
      const buffer = Buffer.from(image[2], "base64");
      if (!buffer.length || buffer.length > 8_000_000) throw badRequest("photo must be between 1 byte and 8 MB");
      if (dayNumber !== undefined && (!Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > existing.durationDays)) throw badRequest("dayNumber is outside this trip");
      const extension = image[1] === "jpeg" ? "jpg" : image[1];
      const photoId = randomUUID();
      const fileName = `${photoId}.${extension}`;
      const directory = join(uploadsRoot, existing.id);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, fileName), buffer, { flag: "wx" });
      const createdAt = new Date().toISOString();
      const photo = { id: photoId, tripId: existing.id, url: `/uploads/${existing.id}/${fileName}`, thumbnailUrl: `/uploads/${existing.id}/${fileName}`, caption: typeof caption === "string" ? caption.trim().slice(0, 280) : undefined, dayNumber, uploadStatus: "ready", createdAt };
      const album = existing.album || { id: randomUUID(), tripId: existing.id, title: `${existing.title}相册`, photos: [], createdAt, updatedAt: createdAt };
      const updatedAlbum = { ...album, coverPhotoId: album.coverPhotoId || photo.id, photos: [...album.photos, photo], updatedAt: createdAt };
      const trip = db.save({ ...existing, album: updatedAlbum, version: existing.version + 1 });
      return send(response, 201, { trip, photo });
    }
    if (request.method === "DELETE" && photoMatch) {
      const existing = db.find(photoMatch[1]);
      if (!existing) return send(response, 404, { error: "Trip not found" });
      const photo = existing.album?.photos.find((item) => item.id === photoMatch[2]);
      if (!photo) return send(response, 404, { error: "Photo not found" });
      const target = join(uploadsRoot, photo.url.replace(/^\/uploads\//, ""));
      if (target.startsWith(`${uploadsRoot}/`)) await unlink(target).catch((error) => { if (error.code !== "ENOENT") throw error; });
      const photos = existing.album.photos.filter((item) => item.id !== photo.id);
      const album = { ...existing.album, photos, coverPhotoId: existing.album.coverPhotoId === photo.id ? photos[0]?.id : existing.album.coverPhotoId, updatedAt: new Date().toISOString() };
      const trip = db.save({ ...existing, album, version: existing.version + 1 });
      return send(response, 200, { trip, album });
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

server.listen(port, () => console.log(`Travel Agent is running at http://localhost:${server.address().port}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { db.close(); server.close(() => process.exit(0)); });
