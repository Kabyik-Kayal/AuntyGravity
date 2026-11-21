// Global install: the opt-in switch, install/uninstall of ~/.gemini/config/hooks.json, per-project enable/disable,
// and absolute-path protection of the AuntyGravity checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isActive } from '../runtime/shared/optin.mjs';
import { KEY, buildEntry, install, status, uninstall } from '../runtime/tools/install.mjs';
import { disable, enable, status as enableStatus } from '../runtime/tools/enable.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hooksDir = path.join(root, 'runtime', 'hooks');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function runHook(script, payload, { optIn = false, stateDir } = {}) {
  const r = spawnSync('node', [path.join(hooksDir, script), ...(optIn ? ['--opt-in'] : [])], {
    input: JSON.stringify(payload),
    env: { ...process.env, AUNTY_STATE_DIR: stateDir },
    encoding: 'utf8',
    cwd: hooksDir,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const call = (name, args = {}) => ({ toolCall: { id: 't', name, args } });

// ---------- opt-in switch ----------
test('opt-in: without the flag always active; with it only under a marked workspace; a local install steps the global one aside', () => {
  const ws = tmp('aunty-oi-');
  const sub = path.join(ws, 'a', 'b');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(isActive(sub, false), true);
  assert.equal(isActive(sub, true), false); // no marker
  assert.equal(isActive(undefined, true), false); // unknown workspace: stay out of the way
  enable(ws);
  assert.equal(isActive(sub, true), true); // marker found by walking up
  fs.mkdirSync(path.join(ws, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.agents', 'hooks.json'), '{"auntygravity-gate":{}}');
  assert.equal(isActive(sub, true), false); // local hooks.json already carries the gate
  assert.equal(isActive(sub, false), true);
});

test('opt-in hooks: in a project that is not enabled every hook is a no-op, even for blocked actions', () => {
  const dir = tmp('aunty-no-');
  const stateDir = tmp('aunty-st-');
  const base = { conversationId: 'cv', cwd: dir };
  for (const c of [call('run_command', { CommandLine: 'Stop-Process -Id 1 -Force' }), call('swarm', { action: 'add' }), call('write_file', { Path: path.join(dir, 'a.txt') })]) {
    assert.equal(runHook('gate.mjs', { ...base, ...c }, { optIn: true, stateDir }).decision, 'allow', c.toolCall.name);
  }
  assert.deepEqual(runHook('inject-plan.mjs', base, { optIn: true, stateDir }), {});
  assert.deepEqual(runHook('record.mjs', { ...base, ...call('mcp_auntygravity_consult') }, { optIn: true, stateDir }), {});
  assert.equal(runHook('stop-check.mjs', base, { optIn: true, stateDir }).decision, 'allow');
  assert.ok(!fs.existsSync(path.join(stateDir, 'sessions')), 'no session state is created');
  assert.ok(!fs.existsSync(path.join(stateDir, 'gate.log')), 'nothing is logged');
});

test('opt-in hooks: once the project is enabled the gate enforces again', () => {
  const dir = tmp('aunty-yes-');
  const stateDir = tmp('aunty-st-');
  fs.writeFileSync(path.join(stateDir, 'adapter.json'), '{"adapter":"chrome"}');
  enable(dir);
  const base = { conversationId: 'cv', cwd: dir };
  assert.equal(runHook('gate.mjs', { ...base, ...call('run_command', { CommandLine: 'echo hi' }) }, { optIn: true, stateDir }).decision, 'deny');
  assert.equal(runHook('gate.mjs', { ...base, ...call('read_file', { Path: 'a.txt' }) }, { optIn: true, stateDir }).decision, 'allow');
});

// ---------- install / uninstall ----------
function withConfigDir(fn) {
  const dir = tmp('aunty-cfg-');
  process.env.AUNTY_GEMINI_CONFIG_DIR = dir;
  process.env.AUNTY_BIN_DIR = path.join(dir, 'bin');
  try {
    return fn(dir);
  } finally {
    delete process.env.AUNTY_GEMINI_CONFIG_DIR;
    delete process.env.AUNTY_BIN_DIR;
  }
}

test('install: dry run writes nothing; install writes absolute, opt-in commands and keeps other hooks; backup is made once', () => {
  withConfigDir((dir) => {
    const file = path.join(dir, 'hooks.json');
    fs.writeFileSync(file, JSON.stringify({ 'my-linter': { PostToolUse: [] } }));

    const dry = install({ dryRun: true });
    assert.equal(dry.wrote, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { 'my-linter': { PostToolUse: [] } });

    const r = install();
    assert.equal(r.wrote, true);
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(written).sort(), [KEY, 'my-linter'].sort());
    assert.deepEqual(written[KEY], buildEntry());
    const cmds = JSON.stringify(written[KEY]);
    for (const f of ['gate.mjs', 'record.mjs', 'inject-plan.mjs', 'stop-check.mjs']) assert.ok(cmds.includes(f), f);
    assert.equal((cmds.match(/--opt-in/g) || []).length, 4); // every hook is opt-in
    const gateCmd = written[KEY].PreToolUse[0].hooks[0].command;
    assert.ok(!/["\s]/.test(gateCmd.replace(/^node /, '').replace(/ --opt-in$/, '')), 'no quotes or spaces in the command path');
    for (const f of ['gate.mjs', 'record.mjs', 'inject-plan.mjs', 'stop-check.mjs']) assert.ok(fs.existsSync(path.join(dir, 'bin', f)), `shim ${f}`);
    assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.aunty.backup`, 'utf8')), { 'my-linter': { PostToolUse: [] } });

    install(); // idempotent
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), written);
    assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.aunty.backup`, 'utf8')), { 'my-linter': { PostToolUse: [] } }); // original kept
    assert.equal(status().installed, true);
  });
});

test('uninstall: removes only our entry; deletes the file when nothing else is left; refuses invalid JSON', () => {
  withConfigDir((dir) => {
    const file = path.join(dir, 'hooks.json');
    fs.writeFileSync(file, JSON.stringify({ other: { Stop: [] } }));
    install();
    uninstall();
    assert.ok(!fs.existsSync(path.join(dir, 'bin', 'gate.mjs')), 'shims removed');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { other: { Stop: [] } });
    assert.equal(status().installed, false);

    fs.rmSync(file);
    install();
    uninstall();
    assert.ok(!fs.existsSync(file));
    assert.equal(uninstall().removed, false); // nothing to remove

    fs.writeFileSync(file, '{not json');
    assert.throws(() => install(), /not valid JSON/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{not json'); // untouched
  });
});

// ---------- enable / disable ----------
test('enable: creates only the marker and never touches AGENTS.md; idempotent; disable removes it', () => {
  const dir = tmp('aunty-en-');
  const agents = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(agents, '# My project\n\nExisting rule.\n');

  const r = enable(dir);
  assert.equal(r.enabled, true);
  assert.match(r.note ?? '', /not a git repo/);
  assert.ok(fs.existsSync(path.join(dir, '.agents', 'aunty.enabled')));
  assert.equal(fs.readFileSync(agents, 'utf8'), '# My project\n\nExisting rule.\n'); // untouched

  enable(dir); // idempotent
  assert.deepEqual(fs.readdirSync(path.join(dir, '.agents')), ['aunty.enabled']);
  assert.deepEqual(enableStatus(dir), { root: path.resolve(dir), enabled: true, gitRepo: false });

  disable(dir);
  assert.ok(!fs.existsSync(path.join(dir, '.agents'))); // the folder we created is removed again
  assert.equal(fs.readFileSync(agents, 'utf8'), '# My project\n\nExisting rule.\n');
  assert.equal(enableStatus(dir).enabled, false);
});

test('enable --exclude keeps the marker out of git and disable removes only our exclude line; a pre-existing .agents folder survives', () => {
  const dir = tmp('aunty-en2-');
  fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'info', 'exclude'), '*.log\n');
  fs.mkdirSync(path.join(dir, '.agents'));
  fs.writeFileSync(path.join(dir, '.agents', 'mine.md'), 'keep me');

  const r = enable(dir, { exclude: true });
  assert.equal(r.note, undefined); // git repo: no audit warning
  assert.equal(r.excludedFromGit, true);
  enable(dir, { exclude: true }); // idempotent: the line appears once
  const ex = fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(ex.split('\n').filter((l) => l === '.agents/aunty.enabled').length, 1);
  assert.match(ex, /^\*\.log/);

  disable(dir);
  assert.equal(fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8').includes('aunty.enabled'), false);
  assert.match(fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8'), /^\*\.log/);
  assert.equal(fs.readFileSync(path.join(dir, '.agents', 'mine.md'), 'utf8'), 'keep me'); // the project's own file stays
  assert.throws(() => enable(path.join(dir, 'missing')), /not a directory/);
});

test('disable also removes the AGENTS.md block that earlier versions wrote, and nothing else', () => {
  const dir = tmp('aunty-en3-');
  const agents = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(agents, '# Mine\n\n<!-- auntygravity:begin -->\nold rules\n<!-- auntygravity:end -->\n');
  disable(dir);
  assert.match(fs.readFileSync(agents, 'utf8'), /^# Mine\s*$/);

  const only = tmp('aunty-en4-');
  fs.writeFileSync(path.join(only, 'AGENTS.md'), '<!-- auntygravity:begin -->\nold\n<!-- auntygravity:end -->\n');
  disable(only);
  assert.ok(!fs.existsSync(path.join(only, 'AGENTS.md'))); // it held only our block
});

// ---------- protection of the checkout by absolute path ----------
test('gate: the AuntyGravity checkout is protected by absolute path (reads and writes), the dev workspace files are not', () => {
  const stateDir = tmp('aunty-pr-');
  fs.writeFileSync(path.join(stateDir, 'adapter.json'), '{"adapter":"chrome"}');
  const target = path.join(root, 'dev', 'workspace', 'notes.txt');
  fs.writeFileSync(
    path.join(stateDir, 'last_consult.json'),
    JSON.stringify({ schema: 2, status: 'complete', id: 'c', ts: Date.now(), plan: [{ step: 's', files: [target], verification: [] }], text: 'P' }),
  );
  const gate = (c) => runHook('gate.mjs', { conversationId: 'cv', cwd: path.join(root, 'dev', 'workspace'), ...c }, { stateDir });
  runHook('record.mjs', { conversationId: 'cv', cwd: path.join(root, 'dev', 'workspace'), ...call('mcp_auntygravity_consult') }, { stateDir });

  assert.equal(gate(call('write_file', { Path: target })).decision, 'allow');
  for (const p of ['runtime/shared/state.mjs', 'runtime/mcp/server.mjs', 'runtime/tools/install.mjs', 'runtime/hooks/gate.mjs', 'extension/content.js', 'dev/workspace/.agents/hooks.json', 'node_modules/x/y.js']) {
    const abs = path.join(root, p);
    assert.equal(gate(call('write_file', { Path: abs })).decision, 'deny', `write ${p}`);
    assert.equal(gate(call('read_file', { Path: abs })).decision, 'deny', `read ${p}`);
    assert.equal(gate(call('run_command', { CommandLine: `Get-Content "${abs}"` })).decision, 'deny', `cmd ${p}`);
  }
});

test('install: the shim runs the real gate exactly as the installed command would (no-op unless enabled)', () => {
  withConfigDir((dir) => {
    install();
    const cmd = JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'))[KEY].PreToolUse[0].hooks[0].command;
    const proj = tmp('aunty-shim-');
    const run = () => JSON.parse(spawnSync(cmd, { shell: true, input: JSON.stringify({ conversationId: 't', cwd: proj, toolCall: { name: 'run_command', args: { CommandLine: 'echo hi' } } }), env: { ...process.env, AUNTY_STATE_DIR: tmp('aunty-st-') }, encoding: 'utf8', cwd: dir }).stdout);
    assert.equal(run().decision, 'allow'); // not enabled
    enable(proj);
    assert.equal(run().decision, 'deny'); // enabled, no plan yet
  });
});
