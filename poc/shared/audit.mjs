// After-the-fact audit of file changes, because shell commands cannot be scoped in advance.
// A baseline of dirty files is taken when a plan is recorded; at Stop, anything new or changed is compared to the plan.
// Requires a git repository. Without one the audit is skipped (returns null).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { norm } from './plan-scope.mjs';

const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 8000 });

export function snapshot(cwd) {
  if (!cwd) return null;
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) return null;
  const st = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']);
  if (st.status !== 0) return null;
  const root = top.stdout.trim();
  const files = {};
  const tokens = st.stdout.split('\0').filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i].slice(0, 2);
    const rel = tokens[i].slice(3);
    if (/^[RC]/.test(code)) i++; // rename/copy: next token is the old path
    const abs = path.join(root, rel);
    let meta = { gone: true };
    try {
      const s = fs.statSync(abs);
      meta = { size: s.size, mtimeMs: Math.round(s.mtimeMs) };
    } catch {
      /* deleted */
    }
    files[norm(abs)] = meta;
  }
  return { files };
}

// Paths that are new or changed compared with the baseline (deletions count as changes).
export function changedSince(baseline, cwd) {
  const now = snapshot(cwd);
  if (!baseline || !now) return null;
  return Object.entries(now.files)
    .filter(([p, m]) => {
      const b = baseline.files[p];
      return !b || b.gone !== m.gone || b.size !== m.size || b.mtimeMs !== m.mtimeMs;
    })
    .map(([p]) => p);
}
