// Opt a project in or out of the globally installed AuntyGravity hooks.
// enable: creates <dir>/.agents/aunty.enabled (the only project file; the executor protocol is delivered by the hook).
//   --exclude keeps the marker out of git via .git/info/exclude (personal opt-in) instead of leaving it committable.
// disable: removes the marker, our exclude line, and any AGENTS.md block written by earlier versions.
// Usage: node runtime/tools/enable.mjs enable|disable|status <dir> [--exclude]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKER } from '../shared/optin.mjs';

const BEGIN = '<!-- auntygravity:begin -->';
const END = '<!-- auntygravity:end -->';
const blockRe = new RegExp(`\\r?\\n?${BEGIN}[\\s\\S]*?${END}\\r?\\n?`);
const EXCLUDE_LINE = '.agents/aunty.enabled';

const excludeFile = (root) => path.join(root, '.git', 'info', 'exclude');
const isGit = (root) => fs.existsSync(path.join(root, '.git'));

function addExclude(root) {
  if (!isGit(root) || !fs.statSync(path.join(root, '.git')).isDirectory()) return false; // worktrees/submodules: leave it
  const f = excludeFile(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  if (cur.split(/\r?\n/).includes(EXCLUDE_LINE)) return true;
  fs.writeFileSync(f, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${EXCLUDE_LINE}\n`);
  return true;
}

function removeExclude(root) {
  const f = excludeFile(root);
  if (!fs.existsSync(f)) return;
  const left = fs.readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l !== EXCLUDE_LINE).join('\n');
  fs.writeFileSync(f, left);
}

export function enable(dir, { exclude = false } = {}) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`${root} is not a directory`);
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, MARKER), `enabled ${new Date().toISOString()}\n`);
  const excluded = exclude ? addExclude(root) : false;
  const git = isGit(root);
  return {
    root,
    enabled: true,
    marker: path.join(root, MARKER),
    gitRepo: git,
    excludedFromGit: excluded,
    note: git ? undefined : 'not a git repo: the Stop audit of shell-made changes is skipped here',
  };
}

export function disable(dir) {
  const root = path.resolve(dir);
  fs.rmSync(path.join(root, MARKER), { force: true });
  removeExclude(root);
  const agents = path.join(root, 'AGENTS.md');
  if (fs.existsSync(agents) && blockRe.test(fs.readFileSync(agents, 'utf8'))) {
    // a block from an earlier version
    const left = fs.readFileSync(agents, 'utf8').replace(blockRe, '\n').replace(/^\s+$/, '');
    if (left.trim()) fs.writeFileSync(agents, left);
    else fs.rmSync(agents, { force: true });
  }
  try {
    fs.rmdirSync(path.join(root, '.agents')); // only if we left it empty
  } catch {
    /* not empty: it holds the project's own files */
  }
  return { root, enabled: false };
}

export const status = (dir) => {
  const root = path.resolve(dir);
  return { root, enabled: fs.existsSync(path.join(root, MARKER)), gitRepo: isGit(root) };
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, dir, ...flags] = process.argv.slice(2);
  try {
    if (!cmd || !dir || !['enable', 'disable', 'status'].includes(cmd)) throw new Error('usage: node runtime/tools/enable.mjs enable|disable|status <dir> [--exclude]');
    console.log(JSON.stringify({ enable, disable, status }[cmd](dir, { exclude: flags.includes('--exclude') }), null, 2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
