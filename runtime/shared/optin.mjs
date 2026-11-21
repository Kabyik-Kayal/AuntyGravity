// Opt-in switch for the GLOBAL hook install. A global ~/.gemini/config/hooks.json applies to every project, so the
// hooks started with --opt-in do nothing unless the workspace (or an ancestor) has .agents/aunty.enabled.
// Hooks started without the flag (the PoC workspace's own .agents/hooks.json) are always active.
import fs from 'node:fs';
import path from 'node:path';

export const MARKER = path.join('.agents', 'aunty.enabled');

function* ancestors(dir) {
  let d = path.resolve(dir);
  for (;;) {
    yield d;
    const p = path.dirname(d);
    if (p === d) return;
    d = p;
  }
}

export function findUp(dir, rel) {
  for (const d of ancestors(dir)) {
    const f = path.join(d, rel);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// A workspace-local hooks.json that already carries the gate. The global install steps aside so nothing runs twice
// (injected system messages persist, so a double run would duplicate them).
export function hasLocalInstall(dir) {
  for (const d of ancestors(dir)) {
    try {
      if (fs.readFileSync(path.join(d, '.agents', 'hooks.json'), 'utf8').includes('auntygravity-gate')) return true;
    } catch {
      /* none here */
    }
  }
  return false;
}

export function isActive(cwd, optIn) {
  if (!optIn) return true;
  if (!cwd) return false; // unknown workspace: stay out of the way
  if (hasLocalInstall(cwd)) return false;
  return Boolean(findUp(cwd, MARKER));
}

// True when this hook run must do nothing (global install, workspace not opted in).
export const inactive = (payload) => !isActive(payload?.cwd ?? payload?.workspacePaths?.[0], process.argv.includes('--opt-in'));
