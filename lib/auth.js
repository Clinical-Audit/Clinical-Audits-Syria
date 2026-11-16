const bcrypt = require("bcryptjs");
const store = require("./store");

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 8 * 60 * 60 * 1000); // 8h absolute
const IDLE_TTL_MS = Number(process.env.SESSION_IDLE_MS || 30 * 60 * 1000); // 30m idle

// In-memory session store: sid -> {userId, createdAt, lastSeen}
const sessions = new Map();

function createSession(userId) {
  const sid = require("crypto").randomBytes(32).toString("hex");
  const t = Date.now();
  sessions.set(sid, { userId, createdAt: t, lastSeen: t });
  return sid;
}

function destroySession(sid) { sessions.delete(sid); }

function destroyUserSessions(userId) {
  for (const [sid, s] of sessions) if (s.userId === userId) sessions.delete(sid);
}

function touch(sid) {
  const s = sessions.get(sid);
  if (!s) return null;
  const t = Date.now();
  if (t - s.createdAt > SESSION_TTL_MS || t - s.lastSeen > IDLE_TTL_MS) {
    sessions.delete(sid);
    return null;
  }
  s.lastSeen = t;
  return s;
}

function sessionExpiry(sid) {
  const s = sessions.get(sid);
  if (!s) return null;
  return Math.min(s.createdAt + SESSION_TTL_MS, s.lastSeen + IDLE_TTL_MS);
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, name: u.name, email: u.email, role: u.role,
    teamNo: u.teamNo || "", avatar: u.avatar || "", title: u.title || "",
    createdAt: u.createdAt,
  };
}

function hashPassword(p) { return bcrypt.hashSync(p, 12); }
function verifyPassword(p, hash) { return bcrypt.compareSync(p, hash); }

function passwordProblem(p) {
  if (!p || p.length < 8) return "كلمة المرور يجب أن تكون 8 أحرف على الأقل.";
  if (!/[A-Za-z\u0600-\u06FF]/.test(p)) return "كلمة المرور يجب أن تحتوي على حرف واحد على الأقل.";
  if (!/[0-9]/.test(p)) return "كلمة المرور يجب أن تحتوي على رقم واحد على الأقل.";
  if (!/[^A-Za-z0-9\u0600-\u06FF\s]/.test(p)) return "كلمة المرور يجب أن تحتوي على رمز واحد على الأقل (مثل @ # $ !).";
  return "";
}

// Middleware: attach req.user if valid session, else 401
function requireAuth(req, res, next) {
  const sid = req.cookies && req.cookies["ca_sid"];
  if (!sid) return res.status(401).json({ error: "unauthenticated", message: "الجلسة غير صالحة. يرجى تسجيل الدخول." });
  const s = touch(sid);
  if (!s) {
    res.clearCookie("ca_sid");
    return res.status(401).json({ error: "session_expired", message: "انتهت الجلسة. يرجى تسجيل الدخول مجدداً." });
  }
  const db = store.getDB();
  const u = db.users.find((x) => x.id === s.userId);
  if (!u) { destroySession(sid); res.clearCookie("ca_sid"); return res.status(401).json({ error: "unauthenticated" }); }
  req.user = u;
  req.sid = sid;
  next();
}

function requireCreator(req, res, next) {
  if (!req.user || req.user.role !== "creator") {
    return res.status(403).json({ error: "forbidden", message: "هذه العملية متاحة لمنشئ الموقع فقط." });
  }
  next();
}

module.exports = {
  createSession, destroySession, destroyUserSessions, touch, sessionExpiry,
  publicUser, hashPassword, verifyPassword, passwordProblem,
  requireAuth, requireCreator, sessions, SESSION_TTL_MS, IDLE_TTL_MS,
};
