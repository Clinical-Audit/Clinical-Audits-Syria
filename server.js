/**
 * Clinical Audit Syria — full-stack server
 * - HTTPS (self-signed by default, real certs via env)
 * - server-side sessions + RBAC
 * - Google Drive auto-upload (service account) into "clinical audit data"/<project code>
 * - AES-256-GCM encrypted backups
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const multer = require("multer");

const store = require("./lib/store");
const auth = require("./lib/auth");
const drive = require("./lib/drive");
const backup = require("./lib/backup");
const cloudsync = require("./lib/cloudsync");

const APP_DIR = __dirname;
const PUBLIC_DIR = path.join(APP_DIR, "public");
const UPLOAD_DIR = path.join(APP_DIR, "uploads");
const CERT_DIR = path.join(APP_DIR, "certs");
const PORT = Number(process.env.PORT || 8080);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);
const SESSION_COOKIE = "ca_sid";
const INVITE_CODE = process.env.INVITE_CODE || "CA-SY-2026";
const CREATOR_EMAIL = (process.env.CREATOR_EMAIL || "ahmedalbeiruti1@gmail.com").toLowerCase();
const CREATOR_PASSWORD = process.env.CREATOR_PASSWORD || "2016";
const CREATOR_NAME = process.env.CREATOR_NAME || "Ahmed Al-Beiruti";
const MAX_AVATAR_CHARS = 400 * 1024;

for (const d of [UPLOAD_DIR, CERT_DIR, path.join(APP_DIR, "backups")]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

/* ------------------------------------------------------------------ seed */
function seed() {
  const db = store.getDB();
  let changed = false;
  if (!db.users.some((u) => u.email === CREATOR_EMAIL)) {
    db.users.push({
      id: "u" + Date.now().toString(36),
      name: CREATOR_NAME,
      email: CREATOR_EMAIL,
      role: "creator",
      teamNo: "001",
      title: "منشئ الموقع",
      avatar: "",
      passwordHash: auth.hashPassword(CREATOR_PASSWORD),
      createdAt: store.nowISO(),
    });
    changed = true;
    console.log(`[seed] creator account created: ${CREATOR_EMAIL} (change password after first login)`);
  }
  if (!db.subteams.length) {
    db.subteams = [
      { id: "st1", teamNo: "001", leader: "", members: [], createdAt: store.nowISO() },
    ];
    changed = true;
  }
  if (changed) store.flushSync();
}
/* seed() runs in bootstrap() below — AFTER the cloud restore, so a fresh
   container never overwrites real data with an empty seeded database. */

/* ------------------------------------------------------------------ app */
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "6mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// CORS — allow the branded frontend (e.g. *.pages.dev) to call this API with cookies
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allow = origin && ALLOWED_ORIGINS.includes(origin);
  if (allow) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// security headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

/* ------------------------------------------------------------------ helpers */
const nowISO = store.nowISO;
function ok(res, data) { res.json(data || { ok: true }); }
function fail(res, code, error, message) { res.status(code).json({ error, message: message || error }); }

function setSessionCookie(req, res, sid) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  const crossSite = process.env.CROSS_SITE === "1";
  res.cookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    sameSite: crossSite ? "none" : "lax",
    secure: crossSite ? true : secure,
    maxAge: auth.SESSION_TTL_MS,
    path: "/",
  });
}

function publicUsers(db) { return db.users.map(auth.publicUser); }

function findProject(db, id) { return db.projects.find((p) => p.id === id); }

function projectCode(p) {
  return p.code || `CA-${p.teamNo || "001"}-${p.auditNo || "001"}`;
}

function addProjectEvent(p, actor, action, oldV, newV) {
  p.events = p.events || [];
  p.events.push({
    time: nowISO(),
    user: actor ? actor.id : null,
    action,
    old: oldV == null ? "" : String(oldV),
    new: newV == null ? "" : String(newV),
  });
}

function safeFilename(name) {
  return String(name || "file").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 180);
}

/* ------------------------------------------------------------------ auth */
app.post("/api/auth/signup", (req, res) => {
  const { name, email, password, invite, avatar, teamNo, title } = req.body || {};
  if (!name || !email || !password) return fail(res, 400, "missing_fields", "الاسم والبريد وكلمة المرور مطلوبة.");
  if (String(invite || "").trim() !== INVITE_CODE) return fail(res, 403, "bad_invite", "كود الدعوة غير صحيح.");
  const pwProblem = auth.passwordProblem(password);
  if (pwProblem) return fail(res, 400, "weak_password", pwProblem);
  if (avatar && String(avatar).length > MAX_AVATAR_CHARS) return fail(res, 413, "avatar_too_large", "حجم الصورة كبير جداً.");
  const db = store.getDB();
  const mail = String(email).trim().toLowerCase();
  if (db.users.some((u) => u.email === mail)) return fail(res, 409, "email_exists", "هذا البريد مسجّل مسبقاً.");
  const user = {
    id: "u" + Date.now().toString(36) + Math.floor(Math.random() * 99),
    name: String(name).trim(),
    email: mail,
    role: "member",
    teamNo: String(teamNo || "").trim(),
    title: String(title || "عضو فريق التدقيق السريري").trim(),
    avatar: avatar || "",
    passwordHash: auth.hashPassword(password),
    createdAt: nowISO(),
  };
  db.users.push(user);
  store.save();
  store.log(user, "إنشاء حساب", `انضم عضو جديد: ${user.name}`);
  const sid = auth.createSession(user.id);
  setSessionCookie(req, res, sid);
  ok(res, { user: auth.publicUser(user), expiry: auth.sessionExpiry(sid) });
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  const db = store.getDB();
  const mail = String(email || "").trim().toLowerCase();
  const user = db.users.find((u) => u.email === mail);
  if (!user || !auth.verifyPassword(String(password || ""), user.passwordHash)) {
    return fail(res, 401, "bad_credentials", "البريد الإلكتروني أو كلمة المرور غير صحيحة.");
  }
  const sid = auth.createSession(user.id);
  setSessionCookie(req, res, sid);
  store.log(user, "تسجيل دخول", "دخول إلى المنصة");
  ok(res, { user: auth.publicUser(user), expiry: auth.sessionExpiry(sid) });
});

app.post("/api/auth/logout", (req, res) => {
  const sid = req.cookies && req.cookies[SESSION_COOKIE];
  if (sid) auth.destroySession(sid);
  res.clearCookie(SESSION_COOKIE, {
    path: "/",
    sameSite: process.env.CROSS_SITE === "1" ? "none" : "lax",
    secure: process.env.CROSS_SITE === "1" ? true : (req.secure || req.headers["x-forwarded-proto"] === "https"),
  });
  ok(res);
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, app: "Clinical Audit Syria", time: new Date().toISOString() });
});

app.get("/api/cloud/status", auth.requireAuth, async (req, res) => {
  ok(res, { sync: cloudsync.status(), drive: await drive.status() });
});

app.post("/api/cloud/backup", auth.requireAuth, auth.requireCreator, async (req, res) => {
  const r = await cloudsync.push("manual");
  if (r.ok) return ok(res, { file: r.file, size: r.size });
  fail(res, 502, "cloud_backup_failed", "تعذّر النسخ إلى Google Drive: " + (r.error || "غير مهيأ"));
});

app.get("/api/auth/me", auth.requireAuth, (req, res) => {
  ok(res, { user: auth.publicUser(req.user), expiry: auth.sessionExpiry(req.sid) });
});

/* ------------------------------------------------------------------ state */
app.get("/api/state", auth.requireAuth, (req, res) => {
  const db = store.getDB();
  ok(res, {
    me: auth.publicUser(req.user),
    users: publicUsers(db),
    subteams: db.subteams,
    projects: db.projects,
    logs: db.logs.slice(0, 300),
    drive: { account: drive.SHARE_WITH || "ClinicalAudit.Syria@gmail.com", root: "clinical audit data" },
    expiry: auth.sessionExpiry(req.sid),
    serverTime: nowISO(),
  });
});

/* ------------------------------------------------------------------ projects */
// Bulk save (frontend keeps a working copy). Server validates & enforces ownership rules.
app.put("/api/projects", auth.requireAuth, (req, res) => {
  const incoming = req.body && req.body.projects;
  if (!Array.isArray(incoming)) return fail(res, 400, "bad_payload", "قائمة المشاريع غير صالحة.");
  const db = store.getDB();
  const isCreator = req.user.role === "creator";
  const byId = new Map(db.projects.map((p) => [p.id, p]));
  const next = [];
  for (const raw of incoming) {
    if (!raw || typeof raw !== "object" || !raw.id) continue;
    const prev = byId.get(raw.id);
    if (prev && !isCreator && prev.owner && prev.owner !== req.user.id) {
      // members may only edit their own projects; keep previous untouched
      next.push(prev);
      continue;
    }
    const p = { ...raw };
    p.code = projectCode(p);
    p.criteria = Array.isArray(p.criteria) ? p.criteria : [];
    p.rounds = Array.isArray(p.rounds) ? p.rounds : [];
    p.attachments = Array.isArray(p.attachments) ? p.attachments : [];
    p.recommendations = Array.isArray(p.recommendations) ? p.recommendations : [];
    p.events = Array.isArray(p.events) ? p.events : [];
    if (!prev) {
      p.owner = p.owner || req.user.id;
      p.createdAt = nowISO();
      p.createdBy = req.user.id;
      addProjectEvent(p, req.user, "إنشاء مشروع", "", p.title || p.code);
      store.log(req.user, "إنشاء مشروع", `${p.code} — ${p.title || ""}`);
    } else {
      p.createdAt = prev.createdAt;
      p.createdBy = prev.createdBy;
      if (prev.state !== p.state) addProjectEvent(p, req.user, "تغيير الحالة", prev.state, p.state);
      if (prev.stage !== p.stage) addProjectEvent(p, req.user, "تغيير المرحلة", prev.stage, p.stage);
      if (prev.title !== p.title) addProjectEvent(p, req.user, "تعديل العنوان", prev.title, p.title);
      store.log(req.user, "تعديل مشروع", `${p.code}`);
    }
    next.push(p);
  }
  // deletions
  for (const prev of db.projects) {
    if (!next.some((p) => p.id === prev.id)) {
      if (!isCreator && prev.owner && prev.owner !== req.user.id) { next.push(prev); continue; }
      store.log(req.user, "حذف مشروع", `${prev.code} — ${prev.title || ""}`);
    }
  }
  db.projects = next;
  store.save();
  store.flushSync();
  cloudsync.push("projects").catch(() => {});
  ok(res, { projects: db.projects });
});

/* ------------------------------------------------------------------ uploads */
app.post("/api/projects/:id/attachments", auth.requireAuth, upload.single("file"), async (req, res) => {
  const db = store.getDB();
  const p = findProject(db, req.params.id);
  if (!p) return fail(res, 404, "not_found", "المشروع غير موجود.");
  if (!req.file) return fail(res, 400, "no_file", "لم يتم اختيار ملف.");
  const original = safeFilename(req.file.originalname);
  const ext = (original.split(".").pop() || "").toLowerCase();
  const allowed = ["pdf", "docx", "xlsx", "png", "jpg", "jpeg"];
  if (!allowed.includes(ext)) return fail(res, 400, "bad_type", `نوع الملف غير مسموح: ${ext}`);

  const storedName = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${original}`;
  const localPath = path.join(UPLOAD_DIR, storedName);
  fs.writeFileSync(localPath, req.file.buffer);

  // ALWAYS upload to Google Drive into clinical audit data/<project code>
  let driveInfo = null;
  let driveError = null;
  try {
    const up = await drive.uploadFile(projectCode(p), req.file.buffer, original, req.file.mimetype);
    driveInfo = { id: up.id, link: up.webViewLink, name: up.name };
  } catch (e) {
    driveError = e.message;
    console.error("Drive upload failed:", e.message);
  }

  const att = {
    id: "att" + Date.now().toString(36) + Math.floor(Math.random() * 99),
    name: original,
    type: ext,
    size: (req.file.size / 1024).toFixed(0) + " KB",
    bytes: req.file.size,
    storedName,
    date: nowISO().slice(0, 10),
    by: req.user.id,
    sensitivity: "معتمد",
    drive: driveInfo,
    driveError,
  };
  p.attachments = p.attachments || [];
  p.attachments.push(att);
  addProjectEvent(p, req.user, "رفع مستند", "", original);
  store.log(req.user, "رفع مستند", `${projectCode(p)} — ${original}${driveInfo ? " (Drive ✓)" : " (Drive ✗)"}`);
  store.save();
  store.flushSync();
  cloudsync.push("attachment").catch(() => {});
  ok(res, { attachment: att, project: p, drive: driveInfo, driveError });
});

app.get("/api/projects/:id/attachments/:attId/download", auth.requireAuth, (req, res) => {
  const db = store.getDB();
  const p = findProject(db, req.params.id);
  if (!p) return fail(res, 404, "not_found", "المشروع غير موجود.");
  const att = (p.attachments || []).find((a) => a.id === req.params.attId);
  if (!att) return fail(res, 404, "not_found", "المرفق غير موجود.");
  const full = path.join(UPLOAD_DIR, att.storedName || "");
  if (!att.storedName || !fs.existsSync(full)) {
    if (att.drive && att.drive.link) return res.redirect(att.drive.link);
    return fail(res, 404, "not_found", "الملف غير متوفر محلياً.");
  }
  store.log(req.user, "تنزيل مستند", `${projectCode(p)} — ${att.name}`);
  res.download(full, att.name);
});

// Upload the generated project report to Drive
app.post("/api/projects/:id/drive-report", auth.requireAuth, async (req, res) => {
  const db = store.getDB();
  const p = findProject(db, req.params.id);
  if (!p) return fail(res, 404, "not_found", "المشروع غير موجود.");
  try {
    const html = req.body && req.body.html;
    const body = Buffer.from(html || `تقرير المشروع ${projectCode(p)} — ${p.title || ""}`, "utf8");
    const up = await drive.uploadFile(projectCode(p), body, `report-${projectCode(p)}.html`, "text/html");
    addProjectEvent(p, req.user, "رفع تقرير إلى Drive", "", up.name);
    store.log(req.user, "رفع تقرير إلى Drive", `${projectCode(p)}`);
    store.save();
    ok(res, { file: up });
  } catch (e) {
    fail(res, 502, "drive_error", "تعذّر الرفع إلى Google Drive: " + e.message);
  }
});

// Upload all project documents to Drive
app.post("/api/projects/:id/drive-all", auth.requireAuth, async (req, res) => {
  const db = store.getDB();
  const p = findProject(db, req.params.id);
  if (!p) return fail(res, 404, "not_found", "المشروع غير موجود.");
  const results = [];
  for (const att of p.attachments || []) {
    const full = path.join(UPLOAD_DIR, att.storedName || "");
    if (!att.storedName || !fs.existsSync(full)) { results.push({ name: att.name, ok: false, error: "الملف غير موجود محلياً" }); continue; }
    try {
      const up = await drive.uploadFile(projectCode(p), fs.readFileSync(full), att.name, "application/octet-stream");
      att.drive = { id: up.id, link: up.webViewLink, name: up.name };
      att.driveError = null;
      results.push({ name: att.name, ok: true, link: up.webViewLink });
    } catch (e) {
      att.driveError = e.message;
      results.push({ name: att.name, ok: false, error: e.message });
    }
  }
  store.log(req.user, "رفع مستندات المشروع إلى Drive", `${projectCode(p)} — ${results.filter((r) => r.ok).length}/${results.length}`);
  store.save();
  ok(res, { results });
});

/* ------------------------------------------------------------------ members */
app.post("/api/members", auth.requireAuth, auth.requireCreator, (req, res) => {
  const { name, email, password, teamNo, title, avatar } = req.body || {};
  if (!name || !email || !password) return fail(res, 400, "missing_fields", "الاسم والبريد وكلمة المرور مطلوبة.");
  const pwProblem = auth.passwordProblem(password);
  if (pwProblem) return fail(res, 400, "weak_password", pwProblem);
  if (avatar && String(avatar).length > MAX_AVATAR_CHARS) return fail(res, 413, "avatar_too_large", "حجم الصورة كبير جداً.");
  const db = store.getDB();
  const mail = String(email).trim().toLowerCase();
  if (db.users.some((u) => u.email === mail)) return fail(res, 409, "email_exists", "هذا البريد مسجّل مسبقاً.");
  const user = {
    id: "u" + Date.now().toString(36) + Math.floor(Math.random() * 99),
    name: String(name).trim(),
    email: mail,
    role: "member",
    teamNo: String(teamNo || "").trim(),
    title: String(title || "عضو فريق التدقيق السريري").trim(),
    avatar: avatar || "",
    passwordHash: auth.hashPassword(password),
    createdAt: nowISO(),
  };
  db.users.push(user);
  store.log(req.user, "إضافة عضو", `${user.name} (${user.email})`);
  store.save();
  ok(res, { user: auth.publicUser(user) });
});

app.put("/api/members/:id", auth.requireAuth, (req, res) => {
  const db = store.getDB();
  const target = db.users.find((u) => u.id === req.params.id);
  if (!target) return fail(res, 404, "not_found", "العضو غير موجود.");
  const isCreator = req.user.role === "creator";
  if (!isCreator && req.user.id !== target.id) return fail(res, 403, "forbidden", "لا تملك صلاحية تعديل هذا العضو.");
  const { name, title, teamNo, avatar } = req.body || {};
  if (name) target.name = String(name).trim();
  if (title != null) target.title = String(title).trim();
  if (teamNo != null) target.teamNo = String(teamNo).trim();
  if (avatar != null) {
    if (String(avatar).length > MAX_AVATAR_CHARS) return fail(res, 413, "avatar_too_large", "حجم الصورة كبير جداً.");
    target.avatar = avatar;
  }
  store.log(req.user, "تعديل عضو", `${target.name}`);
  store.save();
  ok(res, { user: auth.publicUser(target) });
});

// Expel a user: delete membership + account (creator only)
app.delete("/api/members/:id", auth.requireAuth, auth.requireCreator, (req, res) => {
  const db = store.getDB();
  const idx = db.users.findIndex((u) => u.id === req.params.id);
  if (idx === -1) return fail(res, 404, "not_found", "العضو غير موجود.");
  if (db.users[idx].role === "creator") return fail(res, 403, "forbidden", "لا يمكن طرد منشئ الموقع.");
  const [removed] = db.users.splice(idx, 1);
  // remove from subteams
  (db.subteams || []).forEach((st) => {
    st.members = (st.members || []).filter((m) => m !== removed.id && m !== removed.email && m !== removed.name);
    if (st.leaderId === removed.id) st.leaderId = "";
  });
  auth.destroyUserSessions(removed.id);
  store.log(req.user, "طرد عضو", `${removed.name} (${removed.email})`);
  store.save();
  ok(res, { removed: auth.publicUser(removed) });
});

/* ------------------------------------------------------------------ subteams */
app.put("/api/subteams", auth.requireAuth, auth.requireCreator, (req, res) => {
  const incoming = req.body && req.body.subteams;
  if (!Array.isArray(incoming)) return fail(res, 400, "bad_payload", "قائمة الفرق الفرعية غير صالحة.");
  const db = store.getDB();
  db.subteams = incoming.map((s, i) => ({
    id: s.id || "st" + Date.now().toString(36) + i,
    teamNo: String(s.teamNo || "").trim(),
    name: String(s.name || "").trim(),
    leader: String(s.leader || "").trim(),
    leaderId: s.leaderId || "",
    members: Array.isArray(s.members) ? s.members : [],
    note: String(s.note || "").trim(),
    createdAt: s.createdAt || nowISO(),
  }));
  store.log(req.user, "تعديل الفرق الفرعية", `${db.subteams.length} فريق`);
  store.save();
  ok(res, { subteams: db.subteams });
});

/* ------------------------------------------------------------------ drive */
app.get("/api/drive/status", auth.requireAuth, async (req, res) => {
  try {
    const st = await drive.status();
    ok(res, st);
  } catch (e) {
    ok(res, { ok: false, error: e.message });
  }
});

// Drive OAuth2 configuration (preferred) — creator only
app.get("/api/drive/oauth", auth.requireAuth, auth.requireCreator, (req, res) => {
  const o = drive.readOAuth();
  ok(res, {
    configured: !!o,
    clientId: o ? o.clientId : "",
    hasSecret: !!(o && o.clientSecret),
    hasRefreshToken: !!(o && o.refreshToken),
  });
});

app.put("/api/drive/oauth", auth.requireAuth, auth.requireCreator, async (req, res) => {
  const { clientId, clientSecret, refreshToken } = req.body || {};
  const cur = drive.readOAuth() || {};
  const next = {
    clientId: String(clientId || cur.clientId || "").trim(),
    clientSecret: String(clientSecret || cur.clientSecret || "").trim(),
    refreshToken: String(refreshToken || cur.refreshToken || "").trim(),
  };
  if (!next.clientId || !next.clientSecret || !next.refreshToken) {
    return fail(res, 400, "bad_payload", "clientId و clientSecret و refreshToken مطلوبة جميعاً.");
  }
  drive.writeOAuth(next);
  const st = await drive.status();
  store.log(req.user, "إعداد Google Drive (OAuth)", st.ok ? "تم الربط بنجاح" : "فشل: " + (st.error || ""));
  if (!st.ok) return fail(res, 400, "drive_error", st.error || "تعذّر الاتصال بـ Drive");
  ok(res, { status: st });
});

// One-click OAuth consent flow: /api/drive/oauth/start -> Google -> /api/drive/oauth/callback
const OAUTH_STATES = new Map();

function publicBase(req) {
  if (process.env.PUBLIC_URL) return String(process.env.PUBLIC_URL).replace(/\/$/, "");
  const proto = req.headers["x-forwarded-proto"] || (req.secure ? "https" : "http");
  return `${proto}://${req.headers.host}`;
}

app.get("/api/drive/oauth/start", auth.requireAuth, auth.requireCreator, (req, res) => {
  const o = drive.readOAuth() || {};
  const clientId = String(req.query.clientId || o.clientId || "").trim();
  if (!clientId) return fail(res, 400, "no_client", "أدخل Client ID أولاً.");
  const redirectUri = publicBase(req) + "/api/drive/oauth/callback";
  const st = Math.random().toString(36).slice(2) + Date.now().toString(36);
  OAUTH_STATES.set(st, { at: Date.now(), redirectUri });
  const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/drive",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: st,
  }).toString();
  ok(res, { url, redirectUri });
});

app.get("/api/drive/oauth/callback", async (req, res) => {
  const { code, state, error } = req.query;
  const page = (title, body, color) => res.status(200).type("html").send(
    `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${title}</title>
     <style>body{font-family:system-ui,"Segoe UI",Tahoma,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
     .box{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:32px 40px;max-width:520px;text-align:center}
     h1{font-size:20px;margin:0 0 12px;color:${color}}p{line-height:1.9;margin:0;color:#cbd5e1}a{color:#38bdf8}</style></head>
     <body><div class="box"><h1>${title}</h1><p>${body}</p></div></body></html>`
  );
  if (error) return page("لم يتم منح الإذن", "رفض Google الطلب: " + String(error) + ". يمكنك إغلاق هذه النافذة والمحاولة مرة أخرى.", "#f87171");
  const meta = OAUTH_STATES.get(String(state || ""));
  if (!code || !meta) return page("طلب غير صالح", "انتهت صلاحية الطلب أو أن الرابط غير صحيح. ابدأ من جديد من داخل المنصة.", "#f87171");
  OAUTH_STATES.delete(String(state));
  const cur = drive.readOAuth() || {};
  try {
    const client = new (require("googleapis").google.auth.OAuth2)(cur.clientId, cur.clientSecret, meta.redirectUri);
    const { tokens } = await client.getToken(String(code));
    if (!tokens.refresh_token) {
      return page("لم يصل refresh token", "أعد المحاولة مع prompt=consent أو احذف صلاحية التطبيق من حساب Google ثم أعد الربط.", "#fbbf24");
    }
    drive.writeOAuth({ clientId: cur.clientId, clientSecret: cur.clientSecret, refreshToken: tokens.refresh_token });
    const st = await drive.status();
    store.log({ id: "system", name: "النظام" }, "ربط Google Drive عبر OAuth", st.ok ? "ناجح" : "فشل: " + (st.error || ""));
    if (!st.ok) return page("تم حفظ الرمز لكن الاتصال فشل", String(st.error || ""), "#fbbf24");
    return page("✅ تم ربط Google Drive بنجاح", "المجلد الجذر: <b>" + st.root + "</b><br>كل مستند يُرفع الآن تلقائياً إلى مجلد المشروع. يمكنك إغلاق هذه النافذة والعودة إلى المنصة.", "#34d399");
  } catch (e) {
    return page("تعذّر إتمام الربط", String(e.message || e), "#f87171");
  }
});

// Drive bridge (Apps Script) configuration — legacy fallback, creator only
app.get("/api/drive/bridge", auth.requireAuth, auth.requireCreator, (req, res) => {
  const b = drive.readBridge();
  ok(res, { configured: !!(b && b.url), url: b ? b.url : "", hasToken: !!(b && b.token), script: drive.scriptSource() });
});

app.put("/api/drive/bridge", auth.requireAuth, auth.requireCreator, (req, res) => {
  const { url, token } = req.body || {};
  if (url && !/^https:\/\/script\.google\.com\//.test(String(url))) {
    return fail(res, 400, "bad_url", "رابط النشر يجب أن يبدأ بـ https://script.google.com/");
  }
  drive.writeBridge(String(url || "").trim(), String(token || "").trim());
  store.log(req.user, "إعداد جسر Google Drive", url ? "تم الربط" : "تم الفصل");
  ok(res, { configured: !!url, url: url || "" });
});

/* ------------------------------------------------------------------ backups */
app.post("/api/backup", auth.requireAuth, auth.requireCreator, (req, res) => {
  try {
    const db = store.getDB();
    const info = backup.encryptToFile(db, "manual");
    backup.prune(60);
    store.log(req.user, "نسخة احتياطية مشفّرة", info.file);
    ok(res, { backup: info });
  } catch (e) {
    fail(res, 500, "backup_error", "تعذّر إنشاء النسخة الاحتياطية: " + e.message);
  }
});

app.get("/api/backups", auth.requireAuth, auth.requireCreator, (req, res) => {
  ok(res, { backups: backup.list() });
});

/* ------------------------------------------------------------------ logs */
app.get("/api/logs", auth.requireAuth, (req, res) => {
  const db = store.getDB();
  ok(res, { logs: db.logs.slice(0, 500) });
});

/* ------------------------------------------------------------------ static */
app.use(express.static(PUBLIC_DIR, { extensions: ["html"], etag: false, maxAge: 0, setHeaders: (res) => res.setHeader("Cache-Control", "no-store") }));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return fail(res, 404, "not_found", "المسار غير موجود.");
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

/* ------------------------------------------------------------------ https */
function ensureSelfSigned() {
  const keyPath = process.env.TLS_KEY || path.join(CERT_DIR, "server.key");
  const crtPath = process.env.TLS_CERT || path.join(CERT_DIR, "server.crt");
  if (fs.existsSync(keyPath) && fs.existsSync(crtPath)) return { keyPath, crtPath };
  try {
    const { execSync } = require("child_process");
    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${crtPath}" -days 825 -subj "/CN=clinical-audit-syria.local/O=Clinical Audit Syria/C=SY"`,
      { stdio: "ignore" }
    );
    console.log("[tls] self-signed certificate generated");
  } catch (e) {
    console.warn("[tls] could not generate certificate:", e.message);
  }
  return { keyPath, crtPath };
}

/* ------------------------------------------------------------------ bootstrap
   1) restore the database from Google Drive if the local disk is empty
   2) seed the creator account
   3) start cloud sync + scheduled encrypted backups
   4) open HTTP/HTTPS listeners
   -------------------------------------------------------------------------- */
async function bootstrap() {
  try {
    const r = await cloudsync.pullIfEmpty();
    if (r && r.restored) console.log("[bootstrap] database restored from Google Drive");
  } catch (e) {
    console.error("[bootstrap] cloud restore skipped:", e.message);
  }

  seed();

  cloudsync.start();
  setTimeout(() => { cloudsync.push("startup").catch(() => {}); }, 6000);

  setInterval(() => {
    try {
      const info = backup.encryptToFile(store.getDB(), "scheduled");
      backup.prune(60);
      console.log("[backup]", info.file);
    } catch (e) { console.error("[backup] failed", e.message); }
  }, 6 * 60 * 60 * 1000).unref();

  // HTTP (for proxy / local)
  http.createServer(app).listen(PORT, () => {
    console.log(`Clinical Audit Syria — HTTP on http://localhost:${PORT}`);
  });

  // HTTPS
  const { keyPath, crtPath } = ensureSelfSigned();
  if (fs.existsSync(keyPath) && fs.existsSync(crtPath)) {
    https
      .createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(crtPath) }, app)
      .listen(HTTPS_PORT, () => {
        console.log(`Clinical Audit Syria — HTTPS on https://localhost:${HTTPS_PORT}`);
      });
  }
}

bootstrap().catch((e) => {
  console.error("[bootstrap] fatal:", e);
  process.exit(1);
});

module.exports = app;
