// Shared state helpers for the AuntyGravity PoC. Used by the stub MCP server and the hooks.
// State lives outside the repo (override with AUNTY_STATE_DIR) and holds no real user content.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const stateDir = () =>
  process.env.AUNTY_STATE_DIR || path.join(os.homedir(), '.auntygravity', 'state');

export const lastConsultPath = () => path.join(stateDir(), 'last_consult.json');

const safe = (id) => String(id ?? 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);

export const sessionPath = (conversationId) =>
  path.join(stateDir(), 'sessions', `${safe(conversationId)}.json`);

export function readJson(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

// Hook payloads arrive as one JSON object on stdin. Returns null if unreadable.
export function readStdinJson() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

// Logs only tool NAMES and decisions, never arguments or content.
export function appendLog(file, line) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.appendFileSync(path.join(stateDir(), file), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* logging must never break a hook */
  }
}

export const out = (obj) => process.stdout.write(JSON.stringify(obj));
