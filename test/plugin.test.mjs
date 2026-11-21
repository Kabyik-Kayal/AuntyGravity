// The distributable plugin: manifest files, the /setup-auntygravity skill, the doctor, the ping and the CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctor } from '../runtime/tools/doctor.mjs';
import { install } from '../runtime/tools/install.mjs';
import { enable } from '../runtime/tools/enable.mjs';
import { getToken, pingExtension } from '../runtime/mcp/adapter/chrome-bridge.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const aunty = path.join(root, 'runtime', 'tools', 'aunty.mjs');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const PORT = 9392;

// Isolated machine: config dir, launcher dir and token all live in a temp folder.
function machine(fn) {
  const dir = tmp('aunty-m-');
  const keep = { ...process.env };
  Object.assign(process.env, { AUNTY_GEMINI_CONFIG_DIR: path.join(dir, 'config'), AUNTY_BIN_DIR: path.join(dir, 'bin'), AUNTY_TOKEN_FILE: path.join(dir, 'ext-token'), AUNTY_BRIDGE_PORT: String(PORT) });
  return Promise.resolve(fn(dir)).finally(() => {
    for (const k of ['AUNTY_GEMINI_CONFIG_DIR', 'AUNTY_BIN_DIR', 'AUNTY_TOKEN_FILE', 'AUNTY_BRIDGE_PORT']) {
      if (keep[k] === undefined) delete process.env[k];
      else process.env[k] = keep[k];
    }
  });
}

// ---------- plugin files ----------
test('plugin.json: only fields Antigravity reads, kebab-case name, at most 3 prompts', () => {
  const p = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
  const allowed = ['name', 'displayName', 'description', 'version', 'author', 'homepage', 'repository', 'logo', 'suggestedPrompts', 'disabled'];
  assert.deepEqual(Object.keys(p).filter((k) => !allowed.includes(k)), []);
  assert.match(p.name, /^[a-z][a-z0-9-]*$/);
  assert.ok(p.description.length > 20);
  assert.ok(p.suggestedPrompts.length <= 3);
  assert.match(p.version, /^\d+\.\d+\.\d+$/);
});

test('mcp_config.json: one auntygravity server addressed through ${PLUGIN_ROOT}, pointing at a real file', () => {
  const m = JSON.parse(fs.readFileSync(path.join(root, 'mcp_config.json'), 'utf8'));
  assert.deepEqual(Object.keys(m.mcpServers), ['auntygravity']);
  const s = m.mcpServers.auntygravity;
  assert.equal(s.command, 'node');
  assert.equal(s.env.AUNTY_ADAPTER, 'chrome');
  const arg = s.args[0];
  assert.ok(arg.startsWith('${PLUGIN_ROOT}/'), arg);
  assert.ok(fs.existsSync(path.join(root, arg.replace('${PLUGIN_ROOT}/', ''))), 'the server file exists');
});

test('the plugin does not ship a hooks.json: the global opt-in install owns the hooks (a second copy would run every hook twice)', () => {
  assert.ok(!fs.existsSync(path.join(root, 'hooks.json')));
});

test('skill: frontmatter is valid and narrow, and every command it tells the agent to run exists', () => {
  const dir = path.join(root, 'skills', 'setup-auntygravity');
  const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1];
  assert.match(fm, /^name: setup-auntygravity$/m);
  assert.match(fm, /^description: .*ONLY/m); // the model must not fire it on its own initiative
  assert.deepEqual([...fm.matchAll(/^(\w+):/gm)].map((m) => m[1]).sort(), ['description', 'name']);
  const src = fs.readFileSync(aunty, 'utf8');
  for (const cmd of ['doctor', 'install', 'uninstall', 'enable', 'disable', 'token', 'smoke']) {
    assert.ok(new RegExp(`\`${cmd}[ \`]`).test(text) || text.includes(`aunty.mjs ${cmd}`), `skill mentions ${cmd}`);
    assert.ok(src.includes(`case '${cmd}'`), `dispatcher implements ${cmd}`);
  }
  assert.match(text, /two directories above/); // tells the agent where the entry point is
  assert.match(text, /human-review|human review/); // the privacy warning is part of setup
});

// ---------- doctor ----------
test('doctor: reports missing hooks and token with fixes, passes after install, and never prints the token', async () => {
  await machine(async (dir) => {
    const before = await doctor();
    const byId = (r) => Object.fromEntries(r.checks.map((c) => [c.id, c]));
    assert.equal(byId(before).hooks.ok, false);
    assert.match(byId(before).hooks.fix, /aunty\.mjs install/);
    assert.equal(byId(before).token.ok, false);
    assert.equal(before.ok, false);

    install();
    const token = getToken();
    const after = await doctor();
    assert.equal(byId(after).hooks.ok, true);
    assert.equal(byId(after).token.ok, true);
    assert.equal(byId(after).hooks.fix, undefined); // a fix is shown only for problems
    assert.ok(!JSON.stringify(after).includes(token), 'the pairing token never appears in doctor output');
    assert.equal(byId(after).node.ok, true);
  });
});

test('doctor: project checks (enabled or not, not a git repo) and the duplicate-server warning are advice, not failures', async () => {
  await machine(async (dir) => {
    install();
    getToken();
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { auntygravity: { command: 'node' } } }));
    const proj = tmp('aunty-pj-');
    let r = await doctor({ project: proj });
    const c = Object.fromEntries(r.checks.map((x) => [x.id, x]));
    assert.equal(c.project.ok, false);
    assert.equal(c.project.warn, true);
    assert.match(c.project.fix, /aunty\.mjs enable/);
    assert.equal(c['project-git'].warn, true);
    assert.equal(c['mcp-duplicate'].warn, true); // plugin files exist in this checkout AND a manual entry exists
    assert.equal(r.ok, true, 'warnings do not fail the doctor');

    enable(proj);
    r = await doctor({ project: proj });
    assert.equal(r.checks.find((x) => x.id === 'project').ok, true);
    assert.equal(r.checks.find((x) => x.id === 'project').warn, undefined);
  });
});

// ---------- ping ----------
test('pingExtension: silent, wrong token and connected are told apart', async () => {
  await machine(async () => {
    const token = getToken();
    assert.deepEqual(await pingExtension({ port: PORT, waitMs: 300 }), { state: 'silent' });

    const poll = (t, after = 100) => setTimeout(() => fetch(`http://127.0.0.1:${PORT}/job`, { headers: { 'X-Aunty-Token': t } }).catch(() => {}), after);
    poll('f'.repeat(64));
    assert.deepEqual(await pingExtension({ port: PORT, waitMs: 800 }), { state: 'wrong-token' });

    poll(token);
    assert.deepEqual(await pingExtension({ port: PORT, waitMs: 2000 }), { state: 'connected' });
  });
});

// ---------- CLI ----------
function cli(env, ...args) {
  const r = spawnSync('node', [aunty, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

test('aunty CLI: enable, status and disable a project; usage errors exit non-zero', () => {
  const proj = tmp('aunty-cli-');
  const env = {};
  const en = cli(env, 'enable', proj, '--exclude');
  assert.equal(en.status, 0, en.err);
  assert.equal(JSON.parse(en.out).enabled, true);
  assert.equal(JSON.parse(cli(env, 'status', proj).out).enabled, true);
  assert.equal(JSON.parse(cli(env, 'disable', proj).out).enabled, false);
  assert.equal(JSON.parse(cli(env, 'status', proj).out).enabled, false);

  assert.notEqual(cli(env, 'enable').status, 0);
  assert.notEqual(cli(env, 'nonsense').status, 0);
  assert.match(cli(env, 'nonsense').err, /usage/);
});

test('aunty CLI: install --dry-run writes nothing; doctor runs end to end as JSON', () => {
  const dir = tmp('aunty-cli2-');
  const env = { AUNTY_GEMINI_CONFIG_DIR: path.join(dir, 'config'), AUNTY_BIN_DIR: path.join(dir, 'bin'), AUNTY_TOKEN_FILE: path.join(dir, 'ext-token') };
  const dry = cli(env, 'install', '--dry-run');
  assert.equal(dry.status, 0, dry.err);
  assert.ok(!fs.existsSync(path.join(dir, 'config', 'hooks.json')));
  const d = cli(env, 'doctor');
  assert.equal(d.status, 0, d.err);
  const parsed = JSON.parse(d.out);
  assert.equal(parsed.pluginRoot, root);
  assert.ok(Array.isArray(parsed.checks));
});
