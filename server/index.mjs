import { createServer } from "node:http";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./db.mjs";
import { extractTripIntent, generateChecklist, generateItinerary, reviseItinerary } from "./planner.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const databasePath = process.env.DATABASE_PATH
  ? (isAbsolute(process.env.DATABASE_PATH) ? process.env.DATABASE_PATH : resolve(root, process.env.DATABASE_PATH))
  : join(root, "data", "travel-agent.db");
const uploadsRoot = process.env.UPLOADS_PATH
  ? (isAbsolute(process.env.UPLOADS_PATH) ? process.env.UPLOADS_PATH : resolve(root, process.env.UPLOADS_PATH))
  : join(root, "data", "uploads");
const db = openDatabase(databasePath);
const port = Number(process.env.PORT ?? 3000);
const host = process.env.TRAVEL_AGENT_HOST || "127.0.0.1";
const MIME_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml" };

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sendText(response, status, body, contentType = "text/plain; charset=utf-8", headers = {}) {
  response.writeHead(status, { "content-type": contentType, ...headers });
  response.end(body);
}

function tripMarkdown(trip) {
  const lines = [
    `# ${trip.title}`,
    "",
    `- 目的地：${trip.destinations.join("、")}`,
    `- 出发地：${trip.origin || "未设定"}`,
    `- 时间：${trip.startDate ? `${trip.startDate} 至 ${trip.endDate}` : trip.travelTiming || "未设定"}`,
    `- 时长：${trip.durationDays} 天`,
    `- 人数：${trip.travelers.count} 人`,
    `- 节奏：${trip.preferences.pace}`
  ];
  if (trip.budget?.perPerson) lines.push(`- 人均预算目标：${trip.budget.currency} ${trip.budget.perPerson}`);
  if (trip.budgetEstimate) lines.push(`- 人均预算估算：${trip.budgetEstimate.totalPerPerson.currency} ${trip.budgetEstimate.totalPerPerson.min}–${trip.budgetEstimate.totalPerPerson.max}`);
  lines.push("", `> 原始需求：${trip.originalPrompt.replace(/\n/g, " ")}`, "");
  for (const day of trip.itinerary) {
    lines.push(`## Day ${day.dayNumber}｜${day.city}｜${day.theme}`, "");
    for (const activity of day.activities) {
      lines.push(`- **${activity.timeSlot}｜${activity.title}**${activity.durationMinutes ? `（约 ${activity.durationMinutes} 分钟）` : ""}`);
      if (activity.reason) lines.push(`  - ${activity.reason}`);
      for (const note of activity.notes || []) lines.push(`  - 提示：${note}`);
    }
    lines.push("", `预计花费：${day.estimatedBudget.currency} ${day.estimatedBudget.min}–${day.estimatedBudget.max} / 人`);
    if (day.tip) lines.push(`\n出行提示：${day.tip}`);
    lines.push("");
  }
  if (trip.checklist?.items?.length) {
    lines.push("## 行前准备清单", "");
    for (const item of trip.checklist.items) lines.push(`- [${item.completed ? "x" : " "}] ${item.title}${item.reason ? ` — ${item.reason}` : ""}`);
    lines.push("");
  }
  if (trip.recommendations?.accommodationAreas?.length) {
    lines.push("## 住宿区域建议", "");
    for (const item of trip.recommendations.accommodationAreas) lines.push(`- **${item.city}｜${item.area}**：${item.suitableFor}；建议 ${item.recommendedNights} 晚，${item.nightlyBudget.currency} ${item.nightlyBudget.min}–${item.nightlyBudget.max} / 晚`);
    lines.push("");
  }
  if (trip.recommendations?.transportation?.length) {
    lines.push("## 交通建议", "");
    for (const item of trip.recommendations.transportation) lines.push(`- **${item.segment}｜${item.mode}**：${item.recommendation}`);
    lines.push("");
  }
  lines.push("---", `导出时间：${new Date().toISOString()}`, "价格、开放时间和交通信息请在出发前通过官方渠道复核。");
  return lines.join("\n");
}

function sharedTripView(trip) {
  return {
    title: trip.title,
    destinations: trip.destinations,
    travelTiming: trip.travelTiming,
    startDate: trip.startDate,
    endDate: trip.endDate,
    durationDays: trip.durationDays,
    travelers: { count: trip.travelers.count, tripType: trip.travelers.tripType },
    preferences: { pace: trip.preferences.pace },
    budgetEstimate: trip.budgetEstimate,
    recommendations: trip.recommendations,
    itinerary: trip.itinerary.map((day) => ({
      ...day,
      locked: undefined,
      activities: day.activities.map(({ locked, ...activity }) => activity)
    })),
    updatedAt: trip.updatedAt
  };
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
  if (!isWithin(uploadsRoot, target) || !existsSync(target) || !(await stat(target)).isFile()) return send(response, 404, { error: "Photo not found" });
  response.writeHead(200, { "content-type": MIME_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream", "cache-control": "public, max-age=86400" });
  response.end(await readFile(target));
}

function isWithin(parent, target) {
  const childPath = relative(parent, target);
  return childPath === "" || (!childPath.startsWith("..") && !isAbsolute(childPath));
}

function allowCors(request, response) {
  const origin = request.headers.origin;
  if (!origin) return true;
  let originHost;
  try { originHost = new URL(origin).host; } catch { originHost = ""; }
  const localOrigin = origin === "null" || /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(originHost);
  const sameOrigin = originHost && originHost === request.headers.host;
  if (!localOrigin && !sameOrigin) return false;
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "Origin");
  return true;
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function versionConflict() {
  const error = new Error("行程已在其他操作中更新，请刷新后重试");
  error.status = 409;
  error.code = "VERSION_CONFLICT";
  return error;
}

function assertExpectedVersion(trip, expectedVersion) {
  if (expectedVersion === undefined) return;
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw badRequest("expectedVersion must be a positive integer");
  if (trip.version !== expectedVersion) throw versionConflict();
}

function assertUnchanged(tripId, version) {
  const current = db.find(tripId);
  if (!current || current.version !== version) throw versionConflict();
  return current;
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
  const requestPath = new URL(request.url, `http://${request.headers.host}`).pathname === "/" ? "/index.html" : new URL(request.url, `http://${request.headers.host}`).pathname;
  const safePath = normalize(requestPath).replace(/^([/\\])+/, "");
  const allowedPhoto = safePath.startsWith("Photos/") && [".jpg", ".jpeg", ".png", ".webp"].includes(extname(safePath).toLowerCase());
  if (safePath !== "index.html" && !allowedPhoto) return send(response, 404, { error: "Not found" });
  const target = join(root, safePath);
  if (!isWithin(root, target) || !existsSync(target) || !(await stat(target)).isFile()) return send(response, 404, { error: "Not found" });
  response.writeHead(200, { "content-type": MIME_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream", "cache-control": allowedPhoto ? "public, max-age=86400" : "no-cache" });
  response.end(await readFile(target));
}

const server = createServer(async (request, response) => {
  try {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "same-origin");
    if (!allowCors(request, response)) return send(response, 403, { error: "Origin not allowed" });
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS", "access-control-allow-headers": "content-type" });
      return response.end();
    }
    const path = new URL(request.url, `http://${request.headers.host}`).pathname;
    if (request.method === "GET" && path === "/api/health") return send(response, 200, { status: "ok", aiConfigured: Boolean(process.env.DEEPSEEK_API_KEY) });
    if (request.method === "GET" && path.startsWith("/uploads/")) return serveUpload(path, response);
    if (request.method === "GET" && path === "/api/trips") return send(response, 200, { trips: db.list() });
    const sharedMatch = path.match(/^\/api\/shared\/([\w-]+)$/);
    if (request.method === "GET" && sharedMatch) {
      const share = db.findShare(sharedMatch[1]);
      if (!share) return send(response, 404, { error: "Shared trip not found" });
      const trip = db.find(share.tripId);
      if (!trip || !trip.itinerary?.length) return send(response, 404, { error: "Shared trip not found" });
      return send(response, 200, { trip: sharedTripView(trip), sharedAt: share.createdAt });
    }
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
    const exportMatch = path.match(/^\/api\/trips\/([\w-]+)\/export$/);
    const checklistMatch = path.match(/^\/api\/trips\/([\w-]+)\/checklist$/);
    const checklistGenerateMatch = path.match(/^\/api\/trips\/([\w-]+)\/checklist\/generate$/);
    const checklistItemMatch = path.match(/^\/api\/trips\/([\w-]+)\/checklist\/([\w-]+)$/);
    const shareMatch = path.match(/^\/api\/trips\/([\w-]+)\/share$/);
    if (request.method === "POST" && generateMatch) {
      const { expectedVersion } = await readJson(request);
      const existing = db.find(generateMatch[1]);
      if (!existing) return send(response, 404, { error: "Trip not found" });
      assertExpectedVersion(existing, expectedVersion);
      const generated = await generateItinerary(existing);
      assertUnchanged(existing.id, existing.version);
      const trip = db.save({ ...existing, ...generated, version: existing.version + 1, status: "ready" });
      return send(response, 200, { trip });
    }
    if (request.method === "GET" && revisionsMatch) {
      const existing = db.find(revisionsMatch[1]);
      if (!existing) return send(response, 404, { error: "Trip not found" });
      return send(response, 200, { revisions: db.listRevisions(existing.id) });
    }
    if (request.method === "POST" && revisionsMatch) {
      const revisionRequest = await readJson(request);
      const existing = db.find(revisionsMatch[1]);
      if (!existing) return send(response, 404, { error: "Trip not found" });
      assertExpectedVersion(existing, revisionRequest.expectedVersion);
      const revised = await reviseItinerary(existing, revisionRequest);
      assertUnchanged(existing.id, existing.version);
      const { trip, revision } = db.saveTripWithRevision({ ...existing, title: revised.title, itinerary: revised.itinerary, budgetEstimate: revised.budgetEstimate, recommendations: revised.recommendations, version: revised.revision.version, status: "ready" }, revised.revision);
      return send(response, 200, { trip, revision });
    }
    if (request.method === "PATCH" && locksMatch) {
      const { dayNumber, activityId, locked, expectedVersion } = await readJson(request);
      const existing = db.find(locksMatch[1]);
      if (!existing) return send(response, 404, { error: "Trip not found" });
      assertExpectedVersion(existing, expectedVersion);
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
      const { dataUrl, caption, dayNumber, expectedVersion } = await readJson(request, 12_000_000);
      const existing = db.find(photosMatch[1]);
      if (!existing) return send(response, 404, { error: "Trip not found" });
      assertExpectedVersion(existing, expectedVersion);
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
      try { assertUnchanged(existing.id, existing.version); } catch (error) { await unlink(join(directory, fileName)).catch(() => {}); throw error; }
      const createdAt = new Date().toISOString();
      const photo = { id: photoId, tripId: existing.id, url: `/uploads/${existing.id}/${fileName}`, thumbnailUrl: `/uploads/${existing.id}/${fileName}`, caption: typeof caption === "string" ? caption.trim().slice(0, 280) : undefined, dayNumber, uploadStatus: "ready", createdAt };
      const album = existing.album || { id: randomUUID(), tripId: existing.id, title: `${existing.title}相册`, photos: [], createdAt, updatedAt: createdAt };
      const updatedAlbum = { ...album, coverPhotoId: album.coverPhotoId || photo.id, photos: [...album.photos, photo], updatedAt: createdAt };
      let trip;
      try { trip = db.save({ ...existing, album: updatedAlbum, version: existing.version + 1 }); }
      catch (error) { await unlink(join(directory, fileName)).catch(() => {}); throw error; }
      return send(response, 201, { trip, photo });
    }
    if (request.method === "DELETE" && photoMatch) {
      const { expectedVersion } = await readJson(request);
      const existing = db.find(photoMatch[1]);
      if (!existing) return send(response, 404, { error: "Trip not found" });
      assertExpectedVersion(existing, expectedVersion);
      const photo = existing.album?.photos.find((item) => item.id === photoMatch[2]);
      if (!photo) return send(response, 404, { error: "Photo not found" });
      const target = join(uploadsRoot, photo.url.replace(/^\/uploads\//, ""));
      const photos = existing.album.photos.filter((item) => item.id !== photo.id);
      const album = { ...existing.album, photos, coverPhotoId: existing.album.coverPhotoId === photo.id ? photos[0]?.id : existing.album.coverPhotoId, updatedAt: new Date().toISOString() };
      const trip = db.save({ ...existing, album, version: existing.version + 1 });
      if (isWithin(uploadsRoot, target)) await unlink(target).catch((error) => { if (error.code !== "ENOENT") console.warn(`Unable to remove photo file ${target}: ${error.message}`); });
      return send(response, 200, { trip, album });
    }
    if (request.method === "GET" && checklistMatch) {
      const existing = db.find(checklistMatch[1]);
      if (!existing) return send(response, 404, { error: "Trip not found" });
      return send(response, 200, { checklist: existing.checklist || null });
    }
    if (request.method === "POST" && checklistGenerateMatch) {
      const { expectedVersion } = await readJson(request);
      const existing = db.find(checklistGenerateMatch[1]);
      if (!existing) return send(response, 404, { error: "Trip not found" });
      assertExpectedVersion(existing, expectedVersion);
      const checklist = await generateChecklist(existing);
      assertUnchanged(existing.id, existing.version);
      const trip = db.save({ ...existing, checklist, version: existing.version + 1 });
      return send(response, 200, { trip, checklist });
    }
    if (request.method === "POST" && checklistMatch) {
      const { title, category = "other", reason, expectedVersion } = await readJson(request);
      const existing = db.find(checklistMatch[1]);
      if (!existing) return send(response, 404, { error: "Trip not found" });
      assertExpectedVersion(existing, expectedVersion);
      if (typeof title !== "string" || !title.trim() || title.trim().length > 160) throw badRequest("checklist item title must be 1 to 160 characters");
      const allowedCategories = ["documents", "booking", "packing", "health", "money", "other"];
      if (!allowedCategories.includes(category)) throw badRequest("checklist item category is invalid");
      const timestamp = new Date().toISOString();
      const item = { id: randomUUID(), title: title.trim(), category, reason: typeof reason === "string" ? reason.trim().slice(0, 280) : "", completed: false, source: "manual", createdAt: timestamp };
      const checklist = existing.checklist || { id: randomUUID(), tripId: existing.id, items: [], updatedAt: timestamp };
      const updatedChecklist = { ...checklist, items: [...checklist.items, item], updatedAt: timestamp };
      const trip = db.save({ ...existing, checklist: updatedChecklist, version: existing.version + 1 });
      return send(response, 201, { trip, checklist: updatedChecklist, item });
    }
    if (request.method === "PATCH" && checklistItemMatch) {
      const { completed, title, expectedVersion } = await readJson(request);
      const existing = db.find(checklistItemMatch[1]);
      if (!existing) return send(response, 404, { error: "Trip not found" });
      assertExpectedVersion(existing, expectedVersion);
      const itemId = checklistItemMatch[2];
      let found = false;
      const items = (existing.checklist?.items || []).map((item) => {
        if (item.id !== itemId) return item;
        found = true;
        if (completed !== undefined && typeof completed !== "boolean") throw badRequest("completed must be a boolean");
        if (title !== undefined && (typeof title !== "string" || !title.trim() || title.trim().length > 160)) throw badRequest("title must be 1 to 160 characters");
        return { ...item, ...(completed === undefined ? {} : { completed }), ...(title === undefined ? {} : { title: title.trim() }) };
      });
      if (!found) return send(response, 404, { error: "Checklist item not found" });
      const checklist = { ...existing.checklist, items, updatedAt: new Date().toISOString() };
      const trip = db.save({ ...existing, checklist, version: existing.version + 1 });
      return send(response, 200, { trip, checklist });
    }
    if (request.method === "DELETE" && checklistItemMatch) {
      const { expectedVersion } = await readJson(request);
      const existing = db.find(checklistItemMatch[1]);
      if (!existing) return send(response, 404, { error: "Trip not found" });
      assertExpectedVersion(existing, expectedVersion);
      if (!existing.checklist?.items.some((item) => item.id === checklistItemMatch[2])) return send(response, 404, { error: "Checklist item not found" });
      const checklist = { ...existing.checklist, items: existing.checklist.items.filter((item) => item.id !== checklistItemMatch[2]), updatedAt: new Date().toISOString() };
      const trip = db.save({ ...existing, checklist, version: existing.version + 1 });
      return send(response, 200, { trip, checklist });
    }
    if (request.method === "POST" && shareMatch) {
      const { expectedVersion, rotate = false } = await readJson(request);
      const existing = db.find(shareMatch[1]);
      if (!existing) return send(response, 404, { error: "Trip not found" });
      assertExpectedVersion(existing, expectedVersion);
      if (!existing.itinerary?.length) throw badRequest("generate an itinerary before sharing");
      const current = db.findShareByTrip(existing.id);
      const share = current && !rotate ? current : db.saveShare(randomUUID(), existing.id);
      return send(response, 200, { share });
    }
    if (request.method === "DELETE" && shareMatch) {
      const { expectedVersion } = await readJson(request);
      const existing = db.find(shareMatch[1]);
      if (!existing) return send(response, 404, { error: "Trip not found" });
      assertExpectedVersion(existing, expectedVersion);
      return send(response, 200, { revoked: db.deleteShare(existing.id) });
    }
    if (request.method === "GET" && exportMatch) {
      const existing = db.find(exportMatch[1]);
      if (!existing) return send(response, 404, { error: "Trip not found" });
      const safeName = existing.title.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-|-$/g, "") || "travel-plan";
      return sendText(response, 200, tripMarkdown(existing), "text/markdown; charset=utf-8", { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}.md` });
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
      const { expectedVersion, ...changes } = await readJson(request);
      const existing = db.find(match[1]);
      if (!existing) return send(response, 404, { error: "Trip not found" });
      assertExpectedVersion(existing, expectedVersion);
      const trip = db.save(normalizeTrip({ ...changes, id: existing.id }, existing));
      return send(response, 200, { trip });
    }
    if (path.startsWith("/api/")) return send(response, 404, { error: "API route not found" });
    return serveStatic(request, response);
  } catch (error) {
    return send(response, error.status ?? 500, { error: error.message || "Internal server error", ...(error.code ? { code: error.code } : {}) });
  }
});

server.listen(port, host, () => console.log(`Travel Agent is running at http://${host}:${server.address().port}`));
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => {
    server.closeAllConnections();
  }, 5_000).unref();
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, shutdown);
