// Opt a project in or out of the globally installed AuntyGravity hooks.
// enable: creates <dir>/.agents/aunty.enabled and adds the executor rules to <dir>/AGENTS.md (a marked block).
// disable: removes the marker and that block. Usage: node poc/tools/enable.mjs enable|disable|status <dir>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKER } from '../shared/optin.mjs';

const BEGIN = '<!-- auntygravity:begin -->';
const END = '<!-- auntygravity:end -->';

const RULES = [
  '## Executor protocol (AuntyGravity)',
  '',
  'You are the executor. Gemini, reached through the `consult` tool, is the planner and decision-maker.',
  '',
  '1. Before any edit or command, call `consult` with the task and the relevant facts. Read-only exploration is allowed first.',
  '2. Treat the returned plan as binding. Execute its steps in order. Do not add, skip or reorder steps, and do not substitute your own design.',
  '3. If a step is impossible or a decision is missing, call `consult` again with `intent: "decision"`. Do not decide yourself.',
  '4. After each step, run that step\'s verification and report the result.',
  '5. If `consult` replies PENDING, call it again with `collect: true` (same task and model). Never resend the prompt, and do not act until you have the plan.',
  '6. Do not start sub-agents, swarms or workers. Their actions may bypass the checks, so the spawn tools are blocked.',
  '',
  'State-changing tools are blocked by a hook until `consult` has returned a plan, and file changes outside the plan are blocked.',
].join('\n');

const blockRe = new RegExp(`\\r?\\n?${BEGIN}[\\s\\S]*?${END}\\r?\\n?`);

export function enable(dir) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`${root} is not a directory`);
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, MARKER), `enabled ${new Date().toISOString()}\n`);
  const agents = path.join(root, 'AGENTS.md');
  const current = fs.existsSync(agents) ? fs.readFileSync(agents, 'utf8') : '';
  const stripped = current.replace(blockRe, '\n');
  const sep = stripped && !stripped.endsWith('\n') ? '\n\n' : stripped ? '\n' : '';
  fs.writeFileSync(agents, `${stripped}${sep}${BEGIN}\n${RULES}\n${END}\n`);
  const git = fs.existsSync(path.join(root, '.git'));
  return { root, enabled: true, agentsMd: agents, gitRepo: git, note: git ? undefined : 'not a git repo: the Stop audit of shell-made changes is skipped here' };
}

export function disable(dir) {
  const root = path.resolve(dir);
  fs.rmSync(path.join(root, MARKER), { force: true });
  const agents = path.join(root, 'AGENTS.md');
  if (fs.existsSync(agents)) {
    const left = fs.readFileSync(agents, 'utf8').replace(blockRe, '\n').replace(/^\s+$/, '');
    if (left.trim()) fs.writeFileSync(agents, left);
    else fs.rmSync(agents, { force: true }); // the file held only our block
  }
  return { root, enabled: false };
}

export const status = (dir) => {
  const root = path.resolve(dir);
  const agents = path.join(root, 'AGENTS.md');
  return { root, enabled: fs.existsSync(path.join(root, MARKER)), rulesInAgentsMd: fs.existsSync(agents) && blockRe.test(fs.readFileSync(agents, 'utf8')) };
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, dir] = process.argv.slice(2);
  try {
    if (!cmd || !dir || !['enable', 'disable', 'status'].includes(cmd)) throw new Error('usage: node poc/tools/enable.mjs enable|disable|status <dir>');
    console.log(JSON.stringify({ enable, disable, status }[cmd](dir), null, 2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
