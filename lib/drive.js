const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const ROOT_NAME = process.env.DRIVE_ROOT_NAME || "clinical audit data";
const SHARE_WITH = process.env.DRIVE_SHARE_WITH || "ClinicalAudit.Syria@gmail.com";
const KEY_FILE = process.env.GOOGLE_KEY_FILE || path.join(__dirname, "..", "service_account.json");
const OAUTH_FILE = process.env.GOOGLE_OAUTH_FILE || path.join(__dirname, "..", "oauth_token.json");
const BRIDGE_FILE = process.env.DRIVE_BRIDGE_FILE || path.join(__dirname, "..", "drive_bridge.json");

let driveClient = null;
let authClient = null;
let authMode = "none"; // "oauth" | "service_account" | "none"
let rootCache = null;
let folderCache = {}; // projectCode -> folderId
let lastError = null;
let initialized = false;

/* ------------------------------------------------------------------ OAuth 2.0
   Preferred path: an OAuth2 refresh token belonging to the real Google account
   (ClinicalAudit.Syria@gmail.com). Files are then owned by that account and
   count against its own 15 GB Drive quota — no service-account quota problem.
   -------------------------------------------------------------------------- */
function readOAuth() {
  const env = {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    refreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
  };
  if (env.clientId && env.clientSecret && env.refreshToken) return env;
  try {
    if (fs.existsSync(OAUTH_FILE)) {
      const j = JSON.parse(fs.readFileSync(OAUTH_FILE, "utf8"));
      if (j && j.clientId && j.clientSecret && j.refreshToken) return j;
    }
  } catch (e) { /* ignore */ }
  return null;
}

function oauthConfigured() {
  return !!readOAuth();
}

function writeOAuth(cfg) {
  const data = {
    clientId: String((cfg && cfg.clientId) || "").trim(),
    clientSecret: String((cfg && cfg.clientSecret) || "").trim(),
    refreshToken: String((cfg && cfg.refreshToken) || "").trim(),
  };
  fs.writeFileSync(OAUTH_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  initialized = false;
  driveClient = null;
  authClient = null;
  rootCache = null;
  folderCache = {};
  return readOAuth();
}

function init() {
  if (initialized) return;
  initialized = true;

  const oa = readOAuth();
  if (oa) {
    try {
      const client = new google.auth.OAuth2(oa.clientId, oa.clientSecret);
      client.setCredentials({ refresh_token: oa.refreshToken });
      authClient = client;
      driveClient = google.drive({ version: "v3", auth: client });
      authMode = "oauth";
      return;
    } catch (e) {
      lastError = e.message;
      console.error("Drive OAuth init failed:", e.message);
    }
  }

  if (fs.existsSync(KEY_FILE)) {
    try {
      const creds = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
      authClient = new google.auth.GoogleAuth({
        credentials: creds,
        scopes: ["https://www.googleapis.com/auth/drive"],
      });
      driveClient = google.drive({ version: "v3", auth: authClient });
      authMode = "service_account";
      return;
    } catch (e) {
      lastError = e.message;
      console.error("Drive service-account init failed:", e.message);
    }
  }
  authMode = "none";
  lastError = lastError || "لا توجد بيانات اعتماد لـ Google Drive";
}

function available() {
  return oauthConfigured() || fs.existsSync(KEY_FILE);
}

/* ---------------- Apps Script bridge (legacy fallback) ---------------- */
function readBridge() {
  if (process.env.DRIVE_WEBAPP_URL) {
    return { url: process.env.DRIVE_WEBAPP_URL, token: process.env.DRIVE_WEBAPP_TOKEN || "" };
  }
  try {
    if (fs.existsSync(BRIDGE_FILE)) {
      const b = JSON.parse(fs.readFileSync(BRIDGE_FILE, "utf8"));
      if (b && b.url) return { url: b.url, token: b.token || "" };
    }
  } catch (e) { /* ignore */ }
  return null;
}

function writeBridge(url, token) {
  fs.writeFileSync(BRIDGE_FILE, JSON.stringify({ url: url || "", token: token || "" }, null, 2), { mode: 0o600 });
  return readBridge();
}

function bridgeConfigured() {
  const b = readBridge();
  return !!(b && b.url);
}

async function bridgeUpload(projectCode, buffer, filename, mimeType) {
  const b = readBridge();
  if (!b || !b.url) throw new Error("جسر Google Drive غير مُعدّ");
  const payload = {
    token: b.token || "",
    folder: projectCode,
    root: ROOT_NAME,
    filename,
    mimeType: mimeType || "application/octet-stream",
    base64: buffer.toString("base64"),
  };
  const resp = await fetch(b.url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
    redirect: "follow",
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error("استجابة غير صالحة من جسر Drive: " + text.slice(0, 160)); }
  if (!data.ok) throw new Error(data.error || "فشل الرفع عبر جسر Drive");
  return { id: data.id, name: data.name || filename, webViewLink: data.url || "" };
}

/* ---------------- folders ---------------- */
async function share(fileId, email, role) {
  if (authMode === "oauth") return; // already owned by the target account
  try {
    await driveClient.permissions.create({
      fileId,
      requestBody: { type: "user", role: role || "writer", emailAddress: email },
      supportsAllDrives: true,
      sendNotificationEmail: false,
    });
  } catch (e) {
    console.warn("Drive share warning:", e.message);
  }
}

async function findFolder(name, parentId) {
  const q = [
    `name = '${String(name).replace(/'/g, "\\'")}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    "trashed = false",
    parentId ? `'${parentId}' in parents` : "",
  ].filter(Boolean).join(" and ");

  const base = {
    q,
    fields: "files(id,name,webViewLink)",
    spaces: "drive",
    pageSize: 10,
  };
  if (authMode === "oauth") {
    base.corpora = "user";
  } else {
    base.supportsAllDrives = true;
    base.includeItemsFromAllDrives = true;
    base.corpora = "allDrives";
  }
  const res = await driveClient.files.list(base);
  return (res.data.files && res.data.files[0]) || null;
}

async function ensureRoot() {
  init();
  if (!driveClient) throw new Error(lastError || "Drive غير مهيأ");
  if (rootCache) return rootCache;

  let f = await findFolder(ROOT_NAME, null);
  if (!f) {
    const res = await driveClient.files.create({
      requestBody: { name: ROOT_NAME, mimeType: "application/vnd.google-apps.folder" },
      fields: "id,name,webViewLink",
      supportsAllDrives: true,
    });
    f = res.data;
  }
  await share(f.id, SHARE_WITH, "writer");
  rootCache = f;
  return f;
}

async function ensureProjectFolder(projectCode) {
  const root = await ensureRoot();
  if (folderCache[projectCode]) return folderCache[projectCode];
  let f = await findFolder(projectCode, root.id);
  if (!f) {
    const res = await driveClient.files.create({
      requestBody: { name: projectCode, mimeType: "application/vnd.google-apps.folder", parents: [root.id] },
      fields: "id,name,webViewLink",
      supportsAllDrives: true,
    });
    f = res.data;
  }
  folderCache[projectCode] = f.id;
  return f.id;
}

async function driveUpload(projectCode, buffer, filename, mimeType) {
  init();
  if (!driveClient) throw new Error(lastError || "Drive غير مهيأ");
  const folderId = await ensureProjectFolder(projectCode);
  const { Readable } = require("stream");
  const res = await driveClient.files.create({
    requestBody: { name: filename, parents: [folderId] },
    media: { mimeType: mimeType || "application/octet-stream", body: Readable.from(buffer) },
    fields: "id,name,webViewLink,size",
    supportsAllDrives: true,
  });
  return res.data;
}

/* ---------------- system folder (db snapshots) ---------------- */
const SYSTEM_FOLDER = process.env.DRIVE_SYSTEM_FOLDER || "_system";

async function ensureSystemFolder() {
  const root = await ensureRoot();
  if (folderCache["__system"]) return folderCache["__system"];
  let f = await findFolder(SYSTEM_FOLDER, root.id);
  if (!f) {
    const res = await driveClient.files.create({
      requestBody: { name: SYSTEM_FOLDER, mimeType: "application/vnd.google-apps.folder", parents: [root.id] },
      fields: "id,name,webViewLink",
      supportsAllDrives: true,
    });
    f = res.data;
  }
  folderCache["__system"] = f.id;
  return f.id;
}

async function findFileByName(name, parentId) {
  const q = [
    `name = '${String(name).replace(/'/g, "\\'")}'`,
    "trashed = false",
    `'${parentId}' in parents`,
  ].join(" and ");
  const base = { q, fields: "files(id,name,size,modifiedTime)", spaces: "drive", pageSize: 10 };
  if (authMode === "oauth") base.corpora = "user";
  else { base.supportsAllDrives = true; base.includeItemsFromAllDrives = true; base.corpora = "allDrives"; }
  const res = await driveClient.files.list(base);
  return (res.data.files && res.data.files[0]) || null;
}

/* Upload (or replace) the database snapshot in <root>/_system/db.json */
async function saveSystemSnapshot(buffer, filename) {
  init();
  if (!driveClient) throw new Error(lastError || "Drive غير مهيأ");
  const folderId = await ensureSystemFolder();
  const name = filename || "db.json";
  const existing = await findFileByName(name, folderId);
  const { Readable } = require("stream");
  if (existing) {
    const res = await driveClient.files.update({
      fileId: existing.id,
      media: { mimeType: "application/json", body: Readable.from(buffer) },
      fields: "id,name,modifiedTime,size",
      supportsAllDrives: true,
    });
    return res.data;
  }
  const res = await driveClient.files.create({
    requestBody: { name, parents: [folderId] },
    media: { mimeType: "application/json", body: Readable.from(buffer) },
    fields: "id,name,modifiedTime,size",
    supportsAllDrives: true,
  });
  return res.data;
}

/* Download the database snapshot from <root>/_system/db.json (or newest .json) */
async function loadSystemSnapshot() {
  init();
  if (!driveClient) throw new Error(lastError || "Drive غير مهيأ");
  const folderId = await ensureSystemFolder();
  let file = await findFileByName("db.json", folderId);
  if (!file) {
    const q = `'${folderId}' in parents and trashed = false and name contains '.json'`;
    const base = { q, fields: "files(id,name,modifiedTime,size)", orderBy: "modifiedTime desc", pageSize: 1, spaces: "drive" };
    if (authMode === "oauth") base.corpora = "user";
    else { base.supportsAllDrives = true; base.includeItemsFromAllDrives = true; base.corpora = "allDrives"; }
    const res = await driveClient.files.list(base);
    file = (res.data.files && res.data.files[0]) || null;
  }
  if (!file) return null;
  const res = await driveClient.files.get({ fileId: file.id, alt: "media" }, { responseType: "arraybuffer" });
  const buf = Buffer.from(res.data);
  return { name: file.name, modifiedTime: file.modifiedTime, buffer: buf };
}

/* ---------------- public API ---------------- */
async function uploadFile(projectCode, buffer, filename, mimeType) {
  // 1) OAuth2 refresh token (real account, real quota) — preferred
  if (oauthConfigured()) return driveUpload(projectCode, buffer, filename, mimeType);
  // 2) Apps Script bridge
  if (bridgeConfigured()) return bridgeUpload(projectCode, buffer, filename, mimeType);
  // 3) service account (shared drives only)
  return driveUpload(projectCode, buffer, filename, mimeType);
}

async function status() {
  const oa = readOAuth();
  if (oa) {
    init();
    try {
      const root = await ensureRoot();
      return {
        ok: true,
        mode: "oauth",
        root: root.name,
        rootId: root.id,
        rootLink: root.webViewLink,
        shareWith: SHARE_WITH,
        clientId: oa.clientId,
      };
    } catch (e) {
      lastError = e.message;
      return { ok: false, mode: "oauth", error: e.message, root: ROOT_NAME, shareWith: SHARE_WITH };
    }
  }
  const bridge = readBridge();
  if (bridge && bridge.url) {
    return { ok: true, mode: "bridge", root: ROOT_NAME, shareWith: SHARE_WITH, bridge: true };
  }
  init();
  if (!driveClient) return { ok: false, mode: "none", error: lastError || "غير مهيأ", root: ROOT_NAME, shareWith: SHARE_WITH };
  try {
    const root = await ensureRoot();
    return { ok: true, mode: "service_account", root: root.name, rootId: root.id, rootLink: root.webViewLink, shareWith: SHARE_WITH };
  } catch (e) {
    lastError = e.message;
    return { ok: false, mode: "service_account", error: e.message, root: ROOT_NAME, shareWith: SHARE_WITH };
  }
}

/* Apps Script source shown to the creator for one-time setup (legacy fallback) */
function scriptSource() {
  return `/**
 * Clinical Audit Syria — Drive bridge (optional legacy fallback)
 * Deploy: Deploy > New deployment > Web app
 *   Execute as: Me (ClinicalAudit.Syria@gmail.com)
 *   Who has access: Anyone
 */
var TOKEN = 'CHANGE_ME_TO_A_LONG_RANDOM_SECRET';
var ROOT_NAME = 'clinical audit data';

function doPost(e) {
  try {
    var d = JSON.parse(e.postData.contents);
    if (d.token !== TOKEN) return out({ok:false, error:'unauthorized'});
    var root = getOrCreate(ROOT_NAME, null);
    var folder = getOrCreate(d.folder || 'unfiled', root);
    var bytes = Utilities.base64Decode(d.base64);
    var blob = Utilities.newBlob(bytes, d.mimeType || 'application/octet-stream', d.filename || 'file');
    var file = folder.createFile(blob);
    return out({ok:true, id:file.getId(), name:file.getName(), url:file.getUrl()});
  } catch (err) {
    return out({ok:false, error:String(err)});
  }
}

function getOrCreate(name, parent) {
  var it = parent ? parent.getFoldersByName(name) : DriveApp.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return parent ? parent.createFolder(name) : DriveApp.createFolder(name);
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}`;
}

module.exports = {
  uploadFile, ensureProjectFolder, ensureRoot, status, available,
  bridgeConfigured, readBridge, writeBridge, scriptSource,
  oauthConfigured, readOAuth, writeOAuth,
  saveSystemSnapshot, loadSystemSnapshot, ensureSystemFolder,
  ROOT_NAME, SHARE_WITH, SYSTEM_FOLDER,
};
