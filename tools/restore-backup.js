#!/usr/bin/env node
/**
 * Clinical Audit Syria — restore an encrypted backup.
 *
 * Usage:
 *   node tools/restore-backup.js backups/db-2026-01-01T00-00-00.cab > restored.json
 *   node tools/restore-backup.js backups/db-....cab --write      # overwrite data/db.json (server must be stopped)
 *
 * The AES-256-GCM key is read from backup.key (or BACKUP_KEY_FILE / BACKUP_KEY_HEX).
 */
const fs = require("fs");
const path = require("path");
const backup = require("../lib/backup");

const file = process.argv[2];
if (!file) {
  console.error("Usage: node tools/restore-backup.js <file.cab> [--write]");
  process.exit(1);
}
const full = path.resolve(file);
if (!fs.existsSync(full)) {
  console.error("Backup not found:", full);
  process.exit(1);
}
const payload = backup.decryptFile(full);
const json = JSON.stringify(payload, null, 2);

if (process.argv.includes("--write")) {
  const target = path.join(__dirname, "..", "data", "db.json");
  fs.writeFileSync(target, json);
  console.error("Restored into", target);
} else {
  process.stdout.write(json);
}
