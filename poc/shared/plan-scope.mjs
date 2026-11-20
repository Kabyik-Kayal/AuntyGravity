// Plan scope: which files the Gemini plan allows the executor to change, and how to decide if a path is inside it.
// Entries: an exact file, or a directory (trailing "/" or "/**"). Entries that would cover the whole workspace
// (or a parent of it) are ignored as too broad. Symlinks are not resolved.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WIN = process.platform === 'win32';

export function norm(p) {
  let s = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  if (WIN) s = s.toLowerCase();
  return s;
}

const toPath = (s) => (/^file:\/\//i.test(s) ? fileURLToPath(s) : s);
const absOf = (s, base) => {
  const p = toPath(String(s).trim());
  return norm(path.isAbsolute(p) ? p : path.join(base, p));
};

function resolveEntry(entry, base) {
  if (typeof entry !== 'string' || !entry.trim()) return null;
  const raw = entry.trim();
  const dir = /[\\/]\*{0,2}$/.test(raw);
  const cleaned = raw.replace(/[\\/]\*\*$/, '').replace(/[\\/]+$/, '');
  if (!cleaned || /[*?]/.test(cleaned)) return null; // no globs other than a trailing /**
  const abs = absOf(cleaned, base);
  const root = norm(base);
  if (abs === root || root.startsWith(`${abs}/`)) return null; // the workspace itself or a parent: too broad
  return { dir, abs };
}

export const allowedFromPlan = (plan, base) =>
  (plan ?? []).flatMap((s) => (Array.isArray(s?.files) ? s.files : [])).map((e) => resolveEntry(e, base)).filter(Boolean);

export function isAllowed(target, allowed, base) {
  const t = absOf(target, base);
  return allowed.some((a) => t === a.abs || (a.dir && t.startsWith(`${a.abs}/`)));
}

// Path-like string arguments of a tool call. Keys must END in file/path/uri so code text such as
// "TargetContent" or "ReplacementContent" is not mistaken for a path.
export function extractPaths(v, key = '', out = []) {
  if (typeof v === 'string') {
    if (/(file|path|uri)s?$/i.test(key) && v.trim()) out.push(v);
  } else if (Array.isArray(v)) {
    v.forEach((x) => extractPaths(x, key, out));
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) extractPaths(x, k, out);
  }
  return out;
}

// Tools that write to the file system directly. Shell commands are covered by the Stop audit instead.
export const isFileMutatingTool = (name) =>
  /^(write|edit|replace|delete|remove|move|rename|create|patch|append|insert)/i.test(name) ||
  /(write|edit|replace|delete|move|rename|patch)_?(file|content|code)/i.test(name);
