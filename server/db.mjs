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
      travel_timing TEXT,
      start_date TEXT,
      end_date TEXT,
      duration_days INTEGER NOT NULL,
      travelers_json TEXT NOT NULL,
      budget_json TEXT,
      budget_estimate_json TEXT,
      preferences_json TEXT NOT NULL,
      itinerary_json TEXT NOT NULL,
      album_json TEXT,
      checklist_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trips_updated_at ON trips(updated_at DESC);
    CREATE TABLE IF NOT EXISTS trip_revisions (
      id TEXT PRIMARY KEY,
      trip_id TEXT NOT NULL,
      instruction TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('trip', 'days')),
      affected_day_numbers_json TEXT NOT NULL,
      change_summary_json TEXT NOT NULL,
      budget_delta REAL NOT NULL DEFAULT 0,
      previous_version INTEGER NOT NULL,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(trip_id) REFERENCES trips(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_trip_revisions_trip_id ON trip_revisions(trip_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS trip_shares (
      token TEXT PRIMARY KEY,
      trip_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      FOREIGN KEY(trip_id) REFERENCES trips(id) ON DELETE CASCADE
    );
  `);
  try {
    db.exec("ALTER TABLE trips ADD COLUMN travel_timing TEXT");
  } catch (error) {
    if (!String(error.message).includes("duplicate column name")) throw error;
  }
  try {
    db.exec("ALTER TABLE trips ADD COLUMN budget_estimate_json TEXT");
  } catch (error) {
    if (!String(error.message).includes("duplicate column name")) throw error;
  }
  try {
    db.exec("ALTER TABLE trips ADD COLUMN checklist_json TEXT");
  } catch (error) {
    if (!String(error.message).includes("duplicate column name")) throw error;
  }

  const toTrip = (row) => row && ({
    id: row.id,
    userId: row.user_id ?? undefined,
    version: row.version,
    status: row.status,
    title: row.title,
    originalPrompt: row.original_prompt,
    origin: row.origin ?? undefined,
    destinations: parse(row.destinations_json),
    travelTiming: row.travel_timing ?? undefined,
    startDate: row.start_date ?? undefined,
    endDate: row.end_date ?? undefined,
    durationDays: row.duration_days,
    travelers: parse(row.travelers_json),
    budget: parse(row.budget_json),
    budgetEstimate: parse(row.budget_estimate_json),
    preferences: parse(row.preferences_json),
    itinerary: parse(row.itinerary_json),
    album: parse(row.album_json),
    checklist: parse(row.checklist_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });

  const write = db.prepare(`
    INSERT INTO trips (
      id, user_id, version, status, title, original_prompt, origin, destinations_json, travel_timing,
      start_date, end_date, duration_days, travelers_json, budget_json, preferences_json,
      budget_estimate_json, itinerary_json, album_json, checklist_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      user_id = excluded.user_id, version = excluded.version, status = excluded.status,
      title = excluded.title, original_prompt = excluded.original_prompt, origin = excluded.origin,
      destinations_json = excluded.destinations_json, travel_timing = excluded.travel_timing, start_date = excluded.start_date,
      end_date = excluded.end_date, duration_days = excluded.duration_days,
      travelers_json = excluded.travelers_json, budget_json = excluded.budget_json,
      budget_estimate_json = excluded.budget_estimate_json,
      preferences_json = excluded.preferences_json, itinerary_json = excluded.itinerary_json,
      album_json = excluded.album_json, checklist_json = excluded.checklist_json, updated_at = excluded.updated_at
  `);
  const writeRevision = db.prepare(`
    INSERT INTO trip_revisions (
      id, trip_id, instruction, scope, affected_day_numbers_json, change_summary_json,
      budget_delta, previous_version, version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const writeShare = db.prepare(`INSERT INTO trip_shares (token, trip_id, created_at) VALUES (?, ?, ?) ON CONFLICT(trip_id) DO UPDATE SET token = excluded.token, created_at = excluded.created_at`);

  const toRevision = (row) => row && ({
    id: row.id,
    tripId: row.trip_id,
    instruction: row.instruction,
    scope: row.scope,
    affectedDayNumbers: parse(row.affected_day_numbers_json) || [],
    changeSummary: parse(row.change_summary_json) || [],
    budgetDelta: row.budget_delta,
    previousVersion: row.previous_version,
    version: row.version,
    createdAt: row.created_at
  });

  function save(trip) {
    const updatedTrip = { ...trip, updatedAt: now() };
    write.run(
      updatedTrip.id, updatedTrip.userId ?? null, updatedTrip.version, updatedTrip.status,
      updatedTrip.title, updatedTrip.originalPrompt, updatedTrip.origin ?? null,
      json(updatedTrip.destinations), updatedTrip.travelTiming ?? null, updatedTrip.startDate ?? null, updatedTrip.endDate ?? null,
      updatedTrip.durationDays, json(updatedTrip.travelers), json(updatedTrip.budget),
      json(updatedTrip.preferences), json(updatedTrip.budgetEstimate), json(updatedTrip.itinerary), json(updatedTrip.album),
      json(updatedTrip.checklist), updatedTrip.createdAt, updatedTrip.updatedAt
    );
    return updatedTrip;
  }

  function saveRevision(revision) {
    writeRevision.run(
      revision.id, revision.tripId, revision.instruction, revision.scope,
      json(revision.affectedDayNumbers), json(revision.changeSummary), revision.budgetDelta || 0,
      revision.previousVersion, revision.version, revision.createdAt
    );
    return revision;
  }

  function saveTripWithRevision(trip, revision) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const updatedTrip = save(trip);
      const updatedRevision = saveRevision(revision);
      db.exec("COMMIT");
      return { trip: updatedTrip, revision: updatedRevision };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
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
    saveRevision,
    saveTripWithRevision,
    listRevisions(tripId) {
      return db.prepare("SELECT * FROM trip_revisions WHERE trip_id = ? ORDER BY created_at DESC").all(tripId).map(toRevision);
    },
    findShareByTrip(tripId) {
      return db.prepare("SELECT token, trip_id AS tripId, created_at AS createdAt FROM trip_shares WHERE trip_id = ?").get(tripId);
    },
    findShare(token) {
      return db.prepare("SELECT token, trip_id AS tripId, created_at AS createdAt FROM trip_shares WHERE token = ?").get(token);
    },
    saveShare(token, tripId) {
      const createdAt = now();
      writeShare.run(token, tripId, createdAt);
      return { token, tripId, createdAt };
    },
    deleteShare(tripId) {
      return db.prepare("DELETE FROM trip_shares WHERE trip_id = ?").run(tripId).changes > 0;
    },
    close() { db.close(); }
  };
}
