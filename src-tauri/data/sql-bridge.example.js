/*
 * PakePlus/Tauri SQLite bridge example for the research workbench.
 *
 * Paste this file into the app's custom JavaScript field. PakePlus writes the
 * result to config/inject/custom.js and executes it before the target page.
 * The fork must have tauri-plugin-sql registered and the sql permissions
 * enabled (see src-tauri/Cargo.toml and capabilities/default.json).
 *
 * The bridge deliberately keeps localStorage as the browser fallback. The
 * target page only needs to implement the following small contract:
 *   window.__WB_SQL_READY__ -> Promise<bridge>
 *   bridge.init({ database })
 *   bridge.loadSnapshot()
 *   bridge.saveSnapshot(snapshot, detail)
 */
(function () {
  "use strict";

  var DB_URL = "sqlite:科研工作台.db";
  var STORAGE_SCHEMA = 1;
  var TABLES = [
    "projects", "routes", "zones", "logs", "tasks", "people", "links", "events",
    "skills", "skillLogs", "skillCases", "planTasks", "personalEvents"
  ];
  var db = null;

  function isoNow() {
    return new Date().toISOString();
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function json(value) {
    return JSON.stringify(value == null ? null : value);
  }

  function recordProjectId(table, row) {
    if (table === "projects") return row.id || null;
    return row.projectId || null;
  }

  function recordRouteId(table, row) {
    if (table === "routes") return row.id || null;
    return row.routeId || null;
  }

  async function execute(sql, values) {
    return db.execute(sql, values || []);
  }

  async function ensureSchema() {
    await execute(
      "CREATE TABLE IF NOT EXISTS wb_meta (" +
        "key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL)"
    );
    await execute(
      "CREATE TABLE IF NOT EXISTS wb_state (" +
        "state_key TEXT PRIMARY KEY NOT NULL, schema_version INTEGER NOT NULL, " +
        "payload_json TEXT NOT NULL, updated_at TEXT NOT NULL, " +
        "payload_bytes INTEGER NOT NULL DEFAULT 0)"
    );
    await execute(
      "CREATE TABLE IF NOT EXISTS wb_records (" +
        "table_name TEXT NOT NULL CHECK (table_name IN (" +
          "'projects', 'routes', 'zones', 'logs', 'tasks', 'people', 'links', 'events', " +
          "'skills', 'skillLogs', 'skillCases', 'planTasks', 'personalEvents')), " +
        "record_id TEXT NOT NULL, project_id TEXT, route_id TEXT, " +
        "payload_json TEXT NOT NULL, updated_at TEXT NOT NULL, " +
        "PRIMARY KEY (table_name, record_id))"
    );
    await execute(
      "CREATE INDEX IF NOT EXISTS idx_wb_records_table_project " +
      "ON wb_records (table_name, project_id)"
    );
    await execute(
      "CREATE INDEX IF NOT EXISTS idx_wb_records_table_route " +
      "ON wb_records (table_name, route_id)"
    );
    await execute(
      "CREATE TABLE IF NOT EXISTS wb_operation_log (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, operation TEXT NOT NULL, " +
        "affected_count INTEGER NOT NULL DEFAULT 0, detail_json TEXT, " +
        "created_at TEXT NOT NULL)"
    );
    await execute(
      "CREATE INDEX IF NOT EXISTS idx_wb_operation_log_created_at " +
      "ON wb_operation_log (created_at DESC)"
    );
    await execute(
      "INSERT OR IGNORE INTO wb_meta (key, value, updated_at) VALUES ($1, $2, $3)",
      ["storage_schema", String(STORAGE_SCHEMA), isoNow()]
    );
  }

  async function init(options) {
    options = options || {};
    if (db) return { backend: "sqlite", schema: STORAGE_SCHEMA, database: DB_URL };
    var api = window.__TAURI__ && window.__TAURI__.sql;
    if (!api || typeof api.load !== "function") {
      throw new Error("PakePlus SQLite API unavailable: check tauri-plugin-sql and withGlobalTauri");
    }
    var database = options.database || DB_URL;
    db = await api.load(database);
    await ensureSchema();
    return { backend: "sqlite", schema: STORAGE_SCHEMA, database: database };
  }

  async function loadSnapshot() {
    var rows = await db.select(
      "SELECT payload_json, schema_version, updated_at FROM wb_state " +
      "WHERE state_key = $1 LIMIT 1",
      ["main"]
    );
    if (!rows.length || !rows[0].payload_json) return null;
    var snapshot = JSON.parse(rows[0].payload_json);
    return {
      state: snapshot,
      schemaVersion: Number(rows[0].schema_version || snapshot.schema || 0),
      updatedAt: rows[0].updated_at || ""
    };
  }

  async function saveSnapshot(snapshot, detail) {
    detail = detail || {};
    var now = isoNow();
    var payload = json(snapshot);
    await execute("BEGIN IMMEDIATE");
    try {
      await execute(
        "INSERT INTO wb_state (state_key, schema_version, payload_json, updated_at, payload_bytes) " +
        "VALUES ($1, $2, $3, $4, $5) " +
        "ON CONFLICT(state_key) DO UPDATE SET " +
        "schema_version=excluded.schema_version, payload_json=excluded.payload_json, " +
        "updated_at=excluded.updated_at, payload_bytes=excluded.payload_bytes",
        ["main", Number(snapshot.schema || 0), payload, now, payload.length]
      );
      await execute("DELETE FROM wb_records");
      for (var i = 0; i < TABLES.length; i += 1) {
        var table = TABLES[i];
        var rows = asArray(snapshot[table]);
        for (var j = 0; j < rows.length; j += 1) {
          var row = rows[j];
          if (!row || !row.id) continue;
          await execute(
            "INSERT INTO wb_records " +
            "(table_name, record_id, project_id, route_id, payload_json, updated_at) " +
            "VALUES ($1, $2, $3, $4, $5, $6)",
            [table, String(row.id), recordProjectId(table, row), recordRouteId(table, row), json(row), now]
          );
        }
      }
      await execute(
        "INSERT INTO wb_operation_log " +
        "(operation, affected_count, detail_json, created_at) VALUES ($1, $2, $3, $4)",
        ["save_snapshot", TABLES.reduce(function (count, table) {
          return count + asArray(snapshot[table]).length;
        }, 0), json(detail), now]
      );
      await execute("COMMIT");
      return { updatedAt: now, bytes: payload.length };
    } catch (error) {
      try { await execute("ROLLBACK"); } catch (_) {}
      throw error;
    }
  }

  async function health() {
    var rows = await db.select(
      "SELECT table_name, COUNT(*) AS count FROM wb_records " +
      "GROUP BY table_name ORDER BY table_name"
    );
    var state = await db.select(
      "SELECT schema_version, updated_at, payload_bytes FROM wb_state " +
      "WHERE state_key = $1",
      ["main"]
    );
    return { counts: rows, state: state[0] || null, backend: "sqlite", database: DB_URL };
  }

  window.__WB_SQL_READY__ = init({ database: DB_URL }).then(function () {
    var bridge = { init: init, loadSnapshot: loadSnapshot, saveSnapshot: saveSnapshot,
      health: health, schema: STORAGE_SCHEMA, database: DB_URL };
    window.__WB_SQL__ = bridge;
    return bridge;
  });
  window.__WB_SQL_READY__.catch(function (error) {
    window.__WB_SQL_ERROR__ = String(error && (error.message || error) || "SQLite bridge failed");
    console.warn("[PakePlus] SQLite bridge unavailable; target app may use its fallback storage.", error);
  });
}());
