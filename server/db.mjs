import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const now = () => new Date().toISOString();
const json = (value) => JSON.stringify(value ?? null);
const parse = (value) => (value ? JSON.parse(value) : undefined);

export function openDatabase(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS trips (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL CHECK(status IN ('draft', 'planning', 'ready', 'archived')),
      title TEXT NOT NULL,
      original_prompt TEXT NOT NULL,
      origin TEXT,
      destinations_json TEXT NOT NULL,
      start_date TEXT,
      end_date TEXT,
      duration_days INTEGER NOT NULL,
      travelers_json TEXT NOT NULL,
      budget_json TEXT,
      preferences_json TEXT NOT NULL,
      itinerary_json TEXT NOT NULL,
      album_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trips_updated_at ON trips(updated_at DESC);
  `);

  const toTrip = (row) => row && ({
    id: row.id,
    userId: row.user_id ?? undefined,
    version: row.version,
    status: row.status,
    title: row.title,
    originalPrompt: row.original_prompt,
    origin: row.origin ?? undefined,
    destinations: parse(row.destinations_json),
    startDate: row.start_date ?? undefined,
    endDate: row.end_date ?? undefined,
    durationDays: row.duration_days,
    travelers: parse(row.travelers_json),
    budget: parse(row.budget_json),
    preferences: parse(row.preferences_json),
    itinerary: parse(row.itinerary_json),
    album: parse(row.album_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });

  const write = db.prepare(`
    INSERT INTO trips (
      id, user_id, version, status, title, original_prompt, origin, destinations_json,
      start_date, end_date, duration_days, travelers_json, budget_json, preferences_json,
      itinerary_json, album_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      user_id = excluded.user_id, version = excluded.version, status = excluded.status,
      title = excluded.title, original_prompt = excluded.original_prompt, origin = excluded.origin,
      destinations_json = excluded.destinations_json, start_date = excluded.start_date,
      end_date = excluded.end_date, duration_days = excluded.duration_days,
      travelers_json = excluded.travelers_json, budget_json = excluded.budget_json,
      preferences_json = excluded.preferences_json, itinerary_json = excluded.itinerary_json,
      album_json = excluded.album_json, updated_at = excluded.updated_at
  `);

  function save(trip) {
    const updatedTrip = { ...trip, updatedAt: now() };
    write.run(
      updatedTrip.id, updatedTrip.userId ?? null, updatedTrip.version, updatedTrip.status,
      updatedTrip.title, updatedTrip.originalPrompt, updatedTrip.origin ?? null,
      json(updatedTrip.destinations), updatedTrip.startDate ?? null, updatedTrip.endDate ?? null,
      updatedTrip.durationDays, json(updatedTrip.travelers), json(updatedTrip.budget),
      json(updatedTrip.preferences), json(updatedTrip.itinerary), json(updatedTrip.album),
      updatedTrip.createdAt, updatedTrip.updatedAt
    );
    return updatedTrip;
  }

  return {
    list() {
      return db.prepare("SELECT * FROM trips ORDER BY updated_at DESC").all().map(toTrip);
    },
    find(id) {
      return toTrip(db.prepare("SELECT * FROM trips WHERE id = ?").get(id));
    },
    create(trip) {
      return save({ ...trip, createdAt: now(), updatedAt: now() });
    },
    save,
    close() { db.close(); }
  };
}
