/**
 * Clinical Audit Syria — cloud persistence (Google Drive)
 *
 * Keeps the whole database safe on Google Drive so the app can run on any host
 * (including free tiers with ephemeral disks) without ever losing data.
 *
 *   <DRIVE_ROOT_NAME>/_system/db.json       <- live snapshot (overwritten)
 *   <DRIVE_ROOT_NAME>/_system/db-<ts>.json  <- rolling history
 */
const fs = require("fs");
const path = require("path");
const drive = require("./drive");
const store = require("./store");

const ENABLED = String(process.env.CLOUD_SYNC || "1") !== "0";
const INTERVAL_MIN = Number(process.env.CLOUD_SYNC_MINUTES || 10);
const SNAPSHOT = "db.json";

let timer = null;
let lastOk = null;
let lastError = null;
let lastReason = null;
let inflight = false;

function snapshotBuffer() {
  const db = store.getDB();
  return Buffer.from(JSON.stringify(db, null, 2), "utf8");
}

/** Upload the current database to Drive. */
async function push(reason) {
  if (!ENABLED || !drive.available()) return { ok: false, skipped: true };
  if (inflight) return { ok: false, skipped: true, busy: true };
  inflight = true;
  try {
    const buf = snapshotBuffer();
    const info = await drive.saveSystemSnapshot(buf, SNAPSHOT);
    lastOk = new Date().toISOString();
    lastError = null;
    lastReason = reason || "auto";
    if (reason === "scheduled") {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      try { await drive.saveSystemSnapshot(buf, `db-${stamp}.json`); } catch (e) { /* ignore */ }
    }
    return { ok: true, file: info.name, size: buf.length };
  } catch (e) {
    lastError = e.message;
    console.error("[cloudsync] push failed:", e.message);
    return { ok: false, error: e.message };
  } finally {
    inflight = false;
  }
}

/** Restore the database from Drive when the local copy is missing or empty. */
async function pullIfEmpty() {
  if (!ENABLED || !drive.available()) return { ok: false, skipped: true };
  const dbFile = store.DB_FILE;
  let localEmpty = true;
  try {
    if (fs.existsSync(dbFile)) {
      const raw = fs.readFileSync(dbFile, "utf8").trim();
      if (raw && raw !== "{}") {
        const j = JSON.parse(raw);
        localEmpty = !(j && Array.isArray(j.users) && j.users.length);
      }
    }
  } catch (e) { localEmpty = true; }

  if (!localEmpty) return { ok: true, skipped: true, reason: "local data present" };

  try {
    const snap = await drive.loadSystemSnapshot();
    if (!snap || !snap.buffer || !snap.buffer.length) return { ok: false, reason: "no snapshot on Drive" };
    const parsed = JSON.parse(snap.buffer.toString("utf8"));
    if (!parsed || !Array.isArray(parsed.users)) return { ok: false, reason: "invalid snapshot" };
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    fs.writeFileSync(dbFile, JSON.stringify(parsed, null, 2));
    console.log(`[cloudsync] restored from Drive (${snap.name}) — users=${parsed.users.length}, projects=${(parsed.projects || []).length}`);
    return { ok: true, restored: true, name: snap.name, modifiedTime: snap.modifiedTime, users: parsed.users.length };
  } catch (e) {
    lastError = e.message;
    console.error("[cloudsync] restore failed:", e.message);
    return { ok: false, error: e.message };
  }
}

function start() {
  if (!ENABLED) { console.log("[cloudsync] disabled"); return; }
  if (!drive.available()) { console.log("[cloudsync] Drive not configured — cloud sync off"); return; }
  if (timer) return;
  timer = setInterval(() => { push("scheduled").catch(() => {}); }, Math.max(2, INTERVAL_MIN) * 60 * 1000);
  timer.unref();
  console.log(`[cloudsync] enabled — snapshot every ${INTERVAL_MIN} min to Drive/${drive.ROOT_NAME}/${drive.SYSTEM_FOLDER}/${SNAPSHOT}`);
}

function status() {
  return { enabled: ENABLED, intervalMinutes: INTERVAL_MIN, lastOk, lastError, lastReason, driveAvailable: drive.available() };
}

module.exports = { push, pullIfEmpty, start, status, ENABLED };
