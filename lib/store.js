const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

function nowISO() { return new Date().toISOString(); }

function defaultDB() {
  return {
    meta: { createdAt: nowISO(), schema: 2, institution: "جامعة دمشق" },
    users: [],
    subteams: [],
    projects: [],
    logs: [],
  };
}

let DB = null;
let writeTimer = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDir();
  if (DB) return DB;
  if (fs.existsSync(DB_FILE)) {
    try {
      DB = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
      if (!DB.users) DB.users = [];
      if (!DB.subteams) DB.subteams = [];
      if (!DB.projects) DB.projects = [];
      if (!DB.logs) DB.logs = [];
      if (!DB.meta) DB.meta = defaultDB().meta;
    } catch (e) {
      console.error("DB read failed, starting fresh:", e.message);
      DB = defaultDB();
    }
  } else {
    DB = defaultDB();
    flushSync();
  }
  return DB;
}

function flushSync() {
  ensureDir();
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(DB, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function save() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => { try { flushSync(); } catch (e) { console.error("DB write failed", e); } }, 60);
}

function getDB() { return load(); }

function log(actor, action, detail) {
  const db = load();
  db.logs.unshift({
    id: "log" + Date.now() + Math.floor(Math.random() * 999),
    at: nowISO(),
    actorId: actor ? actor.id : null,
    actorName: actor ? actor.name : "النظام",
    actorEmail: actor ? actor.email : "",
    action: action || "",
    detail: detail || "",
  });
  if (db.logs.length > 5000) db.logs.length = 5000;
  save();
}

module.exports = { getDB, save, log, flushSync, DB_FILE, DATA_DIR, nowISO, defaultDB };
