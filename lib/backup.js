const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BACKUP_DIR = path.join(__dirname, "..", "backups");
const KEY_FILE = path.join(__dirname, "..", "backup.key");
const ALGO = "aes-256-gcm";

function ensureDirs() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function getKey() {
  if (process.env.BACKUP_KEY) {
    return crypto.createHash("sha256").update(process.env.BACKUP_KEY).digest();
  }
  ensureDirs();
  if (!fs.existsSync(KEY_FILE)) {
    fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  const hex = fs.readFileSync(KEY_FILE, "utf8").trim();
  return Buffer.from(hex, "hex");
}

// Encrypt JSON payload -> file: MAGIC(8) | iv(12) | tag(16) | ciphertext
function encryptToFile(payload, label) {
  ensureDirs();
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const plain = Buffer.from(JSON.stringify(payload), "utf8");
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const magic = Buffer.from("CABK0001", "ascii");
  const out = Buffer.concat([magic, iv, tag, enc]);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `backup-${label || "manual"}-${ts}.cab`;
  const full = path.join(BACKUP_DIR, name);
  fs.writeFileSync(full, out, { mode: 0o600 });
  return { file: name, path: full, bytes: out.length, at: new Date().toISOString() };
}

function decryptFile(fullPath) {
  const key = getKey();
  const buf = fs.readFileSync(fullPath);
  const magic = buf.slice(0, 8).toString("ascii");
  if (magic !== "CABK0001") throw new Error("ملف نسخة احتياطية غير صالح");
  const iv = buf.slice(8, 20);
  const tag = buf.slice(20, 36);
  const enc = buf.slice(36);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return JSON.parse(dec.toString("utf8"));
}

function list() {
  ensureDirs();
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith(".cab"))
    .map((f) => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      return { file: f, bytes: st.size, at: st.mtime.toISOString() };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

function prune(keep) {
  const files = list();
  files.slice(keep || 30).forEach((f) => {
    try { fs.unlinkSync(path.join(BACKUP_DIR, f.file)); } catch (e) {}
  });
}

module.exports = { encryptToFile, decryptFile, list, prune, BACKUP_DIR, KEY_FILE };
