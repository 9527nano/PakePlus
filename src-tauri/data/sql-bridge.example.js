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

  var DB_URL = "sqlite:research-workbench.db";
  var LEGACY_DB_URL = "sqlite:科研工作台.db";
  var STORAGE_SCHEMA = 2;
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

  function byteLength(value) {
    var text = String(value);
    if (typeof TextEncoder === "function") return new TextEncoder().encode(text).length;
    return unescape(encodeURIComponent(text)).length;
  }

  function recordId(table, row, index, used) {
    var raw = row && row.id != null && String(row.id) ? String(row.id) : "__missing__:" + table + ":" + index;
    var count = used[raw] || 0;
    used[raw] = count + 1;
    return count ? raw + "#duplicate-" + count : raw;
  }

  function recordRefs(table, row) {
    var refs = { projectId: null, routeId: null, projectAId: null, projectBId: null };
    if (table === "projects") refs.projectId = row.id || null;
    else refs.projectId = row.projectId || null;
    if (table === "routes") refs.routeId = row.id || null;
    else refs.routeId = row.routeId || null;
    if (table === "links") {
      refs.projectAId = row.a || null;
      refs.projectBId = row.b || null;
    }
    return refs;
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
        "project_a_id TEXT, project_b_id TEXT, " +
        "payload_json TEXT NOT NULL, updated_at TEXT NOT NULL, " +
        "PRIMARY KEY (table_name, record_id))"
    );
    var columns = await db.select("PRAGMA table_info(wb_records)");
    var columnNames = columns.map(function (column) { return column.name; });
    if (columnNames.indexOf("project_a_id") < 0) await execute("ALTER TABLE wb_records ADD COLUMN project_a_id TEXT");
    if (columnNames.indexOf("project_b_id") < 0) await execute("ALTER TABLE wb_records ADD COLUMN project_b_id TEXT");
    await execute(
      "CREATE INDEX IF NOT EXISTS idx_wb_records_table_project " +
      "ON wb_records (table_name, project_id)"
    );
    await execute(
      "CREATE INDEX IF NOT EXISTS idx_wb_records_table_route " +
      "ON wb_records (table_name, route_id)"
    );
    await execute(
      "CREATE INDEX IF NOT EXISTS idx_wb_records_table_project_a " +
      "ON wb_records (table_name, project_a_id)"
    );
    await execute(
      "CREATE INDEX IF NOT EXISTS idx_wb_records_table_project_b " +
      "ON wb_records (table_name, project_b_id)"
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
      "INSERT INTO wb_meta (key, value, updated_at) VALUES ($1, $2, $3) " +
      "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
      ["storage_schema", String(STORAGE_SCHEMA), isoNow()]
    );
    await execute(
      "INSERT OR IGNORE INTO wb_meta (key, value, updated_at) VALUES ($1, $2, $3)",
      ["index_status", JSON.stringify({ status: "never", updatedAt: "" }), isoNow()]
    );
  }

  async function readSnapshotFrom(database) {
    try {
      var rows = await database.select(
        "SELECT payload_json, schema_version, updated_at FROM wb_state " +
        "WHERE state_key = $1 LIMIT 1",
        ["main"]
      );
      if (!rows.length || !rows[0].payload_json) return null;
      return {
        state: JSON.parse(rows[0].payload_json),
        schemaVersion: Number(rows[0].schema_version || 0),
        updatedAt: rows[0].updated_at || ""
      };
    } catch (_) {
      return null;
    }
  }

  async function updateIndexStatus(status, error, count) {
    var value = JSON.stringify({ status: status, error: error || "", count: count || 0, updatedAt: isoNow() });
    await execute(
      "INSERT INTO wb_meta (key, value, updated_at) VALUES ($1, $2, $3) " +
      "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
      ["index_status", value, isoNow()]
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
    var migratedFrom = "";
    if (database === DB_URL && !(await readSnapshotFrom(db))) {
      var legacy = null;
      try {
        legacy = await api.load(LEGACY_DB_URL);
        var legacySnapshot = await readSnapshotFrom(legacy);
        if (legacySnapshot && legacySnapshot.state) {
          await saveSnapshotNow(legacySnapshot.state, { reason: "legacy_database_migration", source: LEGACY_DB_URL });
          migratedFrom = LEGACY_DB_URL;
        }
      } catch (_) {
        /* 没有旧库或旧库结构不完整时，保持新库为空并继续启动。 */
      } finally {
        if (legacy && typeof legacy.close === "function") {
          try { await legacy.close(); } catch (_) {}
        }
      }
    }
    return { backend: "sqlite", schema: STORAGE_SCHEMA, database: database, migratedFrom: migratedFrom };
  }

  async function loadSnapshot() {
    return readSnapshotFrom(db);
  }

  async function insertRecordBatch(batch) {
    if (!batch.length) return;
    var placeholders = [], values = [];
    batch.forEach(function (row, index) {
      var offset = index * 8;
      placeholders.push("($" + (offset + 1) + ", $" + (offset + 2) + ", $" + (offset + 3) + ", $" + (offset + 4) + ", $" + (offset + 5) + ", $" + (offset + 6) + ", $" + (offset + 7) + ", $" + (offset + 8) + ")");
      values.push.apply(values, row);
    });
    await execute(
      "INSERT INTO wb_records " +
      "(table_name, record_id, project_id, route_id, project_a_id, project_b_id, payload_json, updated_at) " +
      "VALUES " + placeholders.join(", "),
      values
    );
  }

  async function rebuildRecordIndex(snapshot, now) {
    await execute("DELETE FROM wb_records");
    var batch = [], affected = 0;
    for (var i = 0; i < TABLES.length; i += 1) {
      var table = TABLES[i], used = {}, rows = asArray(snapshot[table]);
      for (var j = 0; j < rows.length; j += 1) {
        var row = rows[j];
        if (!row || typeof row !== "object") continue;
        var refs = recordRefs(table, row);
        batch.push([table, recordId(table, row, j, used), refs.projectId, refs.routeId,
          refs.projectAId, refs.projectBId, json(row), now]);
        affected += 1;
        if (batch.length >= 100) {
          await insertRecordBatch(batch.splice(0, batch.length));
        }
      }
    }
    await insertRecordBatch(batch);
    return affected;
  }

  async function saveSnapshotNow(snapshot, detail) {
    detail = detail || {};
    var now = isoNow();
    var payload = json(snapshot);
    /* execute() 每次从 SQLx 连接池独立取连接；主快照单语句写入，索引可重建。 */
    await execute(
      "INSERT INTO wb_state (state_key, schema_version, payload_json, updated_at, payload_bytes) " +
      "VALUES ($1, $2, $3, $4, $5) " +
      "ON CONFLICT(state_key) DO UPDATE SET " +
      "schema_version=excluded.schema_version, payload_json=excluded.payload_json, " +
      "updated_at=excluded.updated_at, payload_bytes=excluded.payload_bytes",
      ["main", Number(snapshot.schema || 0), payload, now, byteLength(payload)]
    );
    var indexReady = true, indexError = "", affected = 0;
    try {
      affected = await rebuildRecordIndex(snapshot, now);
      await updateIndexStatus("ready", "", affected);
    } catch (error) {
      indexReady = false;
      indexError = error && (error.message || String(error)) || "索引重建失败";
      try { await updateIndexStatus("stale", indexError, affected); } catch (_) {}
    }
    try {
      await execute(
        "INSERT INTO wb_operation_log " +
        "(operation, affected_count, detail_json, created_at) VALUES ($1, $2, $3, $4)",
        ["save_snapshot", affected, json({
          detail: detail, indexReady: indexReady, indexError: indexError
        }), now]
      );
    } catch (_) {
      /* 操作日志失败不能覆盖已经成功写入的主快照。 */
    }
    return { updatedAt: now, bytes: byteLength(payload), indexReady: indexReady, indexError: indexError };
  }

  var saveQueue = Promise.resolve();
  async function saveSnapshot(snapshot, detail) {
    var run = saveQueue.then(function () { return saveSnapshotNow(snapshot, detail); });
    saveQueue = run.catch(function () {});
    return run;
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
    var indexMeta = await db.select("SELECT value FROM wb_meta WHERE key = $1", ["index_status"]);
    var index = { status: "unknown" };
    try { if (indexMeta[0] && indexMeta[0].value) index = JSON.parse(indexMeta[0].value); } catch (_) {}
    return { counts: rows, state: state[0] || null, index: index, backend: "sqlite", database: DB_URL };
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
