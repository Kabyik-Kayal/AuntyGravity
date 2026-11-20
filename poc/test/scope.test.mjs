// Plan-content enforcement: scope matching, the gate's file-tool check, and the Stop audit against a real git repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { allowedFromPlan, extractPaths, isAllowed, isFileMutatingTool } from '../shared/plan-scope.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hooksDir = path.join(root, 'workspace', '.agents', 'hooks');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ---------- scope matching ----------
const base = path.join(os.tmpdir(), 'ws-scope');
const plan = (...files) => [{ step: 's', files, verification: [] }];
const ok = (t, ...files) => isAllowed(t, allowedFromPlan(plan(...files), base), base);

test('scope: exact files, relative resolution, directories and sibling-prefix confusion', () => {
  assert.ok(ok('a.txt', 'a.txt'));
  assert.ok(ok(path.join(base, 'a.txt'), 'a.txt')); // absolute form of the same file
  assert.ok(ok('src/x/y.js', 'src/')); // directory by trailing slash
  assert.ok(ok('src/x/y.js', 'src/**')); // directory by /**
  assert.ok(ok('a.txt', path.join(base, 'a.txt'))); // absolute entry
  assert.ok(!ok('a.txt.bak', 'a.txt'));
  assert.ok(!ok('srcfoo/x.js', 'src/')); // "src/" must not allow "srcfoo/"
  assert.ok(!ok('other.txt', 'a.txt'));
  assert.ok(!ok('a.txt')); // empty plan allows nothing
});

test('scope: traversal, workspace root, parents, globs and junk entries never widen access', () => {
  assert.ok(!ok('../escape.txt', 'a.txt'));
  assert.ok(!ok('src/../../escape.txt', 'src/'));
  for (const broad of ['.', './', '/', '..', base, `${base}/`, path.dirname(base), '*', 'src/*.js', '', '   ']) {
    assert.ok(!ok('a.txt', broad), `entry ${JSON.stringify(broad)} must not allow anything`);
  }
  assert.deepEqual(allowedFromPlan([{ step: 'x' }, { files: 'no' }, null], base), []);
});

test('scope: file:// URIs are understood', () => {
  assert.ok(isAllowed(pathToFileURL(path.join(base, 'a.txt')).href, allowedFromPlan(plan('a.txt'), base), base));
});

test('scope: path matching is case-insensitive only on Windows', () => {
  assert.equal(ok('A.TXT', 'a.txt'), process.platform === 'win32');
});

test('extractPaths: finds file/path/uri arguments, ignores code text and commands', () => {
  const args = {
    TargetFile: 'a.txt',
    TargetContent: 'some/path.txt in the code being replaced',
    ReplacementContent: 'x',
    CommandLine: 'del b.txt',
    Edits: [{ AbsolutePath: 'c.txt' }, { FileUri: 'file:///d.txt' }],
    FilePaths: ['e.txt'],
  };
  assert.deepEqual(extractPaths(args).sort(), ['a.txt', 'c.txt', 'e.txt', 'file:///d.txt']);
});

test('isFileMutatingTool: writers yes; readers, shell and the MCP wrapper no', () => {
  for (const n of ['write_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content', 'delete_file', 'move_file', 'create_file']) assert.ok(isFileMutatingTool(n), n);
  for (const n of ['read_file', 'view_file', 'run_command', 'call_mcp_tool', 'list_dir', 'grep_search']) assert.ok(!isFileMutatingTool(n), n);
});

// ---------- gate integration ----------
function planned(files, cwd) {
  const dir = tmp('aunty-sc-');
  const env = { ...process.env, AUNTY_STATE_DIR: dir };
  fs.writeFileSync(path.join(dir, 'adapter.json'), JSON.stringify({ adapter: 'chrome' }));
  fs.writeFileSync(path.join(dir, 'last_consult.json'), JSON.stringify({ schema: 2, status: 'complete', id: 'c1', ts: Date.now(), plan: plan(...files), text: 'PLAN' }));
  const run = (script, payload) => {
    const r = spawnSync('node', [path.join(hooksDir, script)], { input: JSON.stringify({ conversationId: 'cv', cwd, ...payload }), env, encoding: 'utf8', cwd: hooksDir });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  run('record.mjs', { toolCall: { name: 'mcp_auntygravity_consult', args: {} } });
  return { run, dir };
}
const tc = (name, args) => ({ toolCall: { id: 't', name, args } });

test('gate: file tools may only touch files in the plan; others are unaffected', () => {
  const cwd = tmp('aunty-ws-');
  const { run } = planned(['allowed.txt', 'out/'], cwd);
  assert.equal(run('gate.mjs', tc('write_file', { TargetFile: 'allowed.txt', CodeContent: 'x' })).decision, 'allow');
  assert.equal(run('gate.mjs', tc('write_file', { TargetFile: path.join(cwd, 'out', 'deep', 'f.js') })).decision, 'allow');
  assert.equal(run('gate.mjs', tc('edit_file', { TargetFile: 'allowed.txt', TargetContent: 'other/file.txt', ReplacementContent: 'y' })).decision, 'allow');

  const bad = run('gate.mjs', tc('write_file', { TargetFile: 'secret.env' }));
  assert.equal(bad.decision, 'deny');
  assert.match(bad.reason, /outside the Gemini plan: secret\.env/);
  assert.match(bad.reason, /consult for a revised plan/);
  assert.equal(run('gate.mjs', tc('edit_file', { TargetFile: '../escape.txt' })).decision, 'deny');
  assert.equal(run('gate.mjs', tc('write_file', { TargetFile: 'allowed.txt', Other: 'x' })).decision, 'allow');

  const none = run('gate.mjs', tc('write_file', { Weird: 'x' }));
  assert.equal(none.decision, 'deny'); // target unknown: fail closed
  assert.match(none.reason, /cannot tell which file/);

  assert.equal(run('gate.mjs', tc('run_command', { CommandLine: 'echo hi' })).decision, 'allow'); // audited at Stop instead
  assert.equal(run('gate.mjs', tc('read_file', { AbsolutePath: 'anything.txt' })).decision, 'allow');
});

test('gate: killing processes and reading enforcement internals are denied, before and after a plan', () => {
  const cwd = tmp('aunty-ws-');
  const none = planned(['a.txt'], cwd);
  const fresh = (() => { const dir = tmp('aunty-np-'); fs.writeFileSync(path.join(dir, 'adapter.json'), '{"adapter":"chrome"}'); return dir; })();
  const noPlan = (payload) => JSON.parse(spawnSync('node', [path.join(hooksDir, 'gate.mjs')], { input: JSON.stringify({ conversationId: 'x', cwd, ...payload }), env: { ...process.env, AUNTY_STATE_DIR: fresh }, encoding: 'utf8', cwd: hooksDir }).stdout);
  for (const cmd of ['Stop-Process -Id 15204 -Force', 'taskkill /F /IM node.exe', 'kill -9 123', 'pkill node', 'Get-Process node | Stop-Process']) {
    for (const run of [(p) => none.run('gate.mjs', p), noPlan]) {
      const r = run(tc('run_command', { CommandLine: cmd }));
      assert.equal(r.decision, 'deny', cmd);
      assert.match(r.reason, /killing processes/);
    }
  }
  assert.equal(none.run('gate.mjs', tc('run_command', { CommandLine: 'Get-ChildItem' })).decision, 'allow');
  for (const p of ['poc/mcp/server.mjs', 'M:\\x\\poc\\shared\\state.mjs', 'C:\\Users\\u\\.auntygravity\\state\\last_consult.json', 'poc/workspace/.agents/hooks/gate.mjs']) {
    assert.equal(none.run('gate.mjs', tc('read_file', { Path: p })).decision, 'deny', p);
    assert.equal(noPlan(tc('read_file', { Path: p })).decision, 'deny', p);
  }
  assert.equal(none.run('gate.mjs', tc('read_file', { Path: 'AGENTS.md' })).decision, 'allow');
});

test('record: a plan from an outdated server (no schema 2) fails with restart guidance instead of unlocking', () => {
  const dir = tmp('aunty-old-');
  fs.writeFileSync(path.join(dir, 'adapter.json'), '{"adapter":"chrome"}');
  fs.writeFileSync(path.join(dir, 'last_consult.json'), JSON.stringify({ status: 'complete', id: 'old', ts: Date.now(), plan: [{ step: 's', verification: [] }], text: 'PLAN' }));
  const env = { ...process.env, AUNTY_STATE_DIR: dir };
  const run = (script, payload) => JSON.parse(spawnSync('node', [path.join(hooksDir, script)], { input: JSON.stringify({ conversationId: 'cv', cwd: dir, ...payload }), env, encoding: 'utf8', cwd: hooksDir }).stdout);
  run('record.mjs', { toolCall: { name: 'mcp_auntygravity_consult', args: {} } });
  assert.equal(run('gate.mjs', tc('write_file', { Path: 'a.txt' })).decision, 'deny');
  const r = run('inject-plan.mjs', {});
  assert.equal(r.terminationBehavior, 'terminate');
  assert.match(r.injectSteps[0].errorMessage.userMessage, /outdated[\s\S]*Restart Antigravity/);
});

test('record: failure reasons are accurate (stale file is not "outdated"; client timeout and tool error are reported as such)', () => {
  const mk = (last, payloadExtra = {}) => {
    const dir = tmp('aunty-rs-');
    fs.writeFileSync(path.join(dir, 'adapter.json'), '{"adapter":"chrome"}');
    if (last) fs.writeFileSync(path.join(dir, 'last_consult.json'), JSON.stringify(last));
    const env = { ...process.env, AUNTY_STATE_DIR: dir };
    const run = (script, payload) => JSON.parse(spawnSync('node', [path.join(hooksDir, script)], { input: JSON.stringify({ conversationId: 'cv', cwd: dir, ...payload }), env, encoding: 'utf8', cwd: hooksDir }).stdout);
    run('record.mjs', { toolCall: { name: 'mcp_auntygravity_consult', args: {} }, ...payloadExtra });
    return JSON.parse(fs.readFileSync(path.join(dir, 'sessions', 'cv.json'), 'utf8')).failReason;
  };
  const old = Date.now() - 60 * 60 * 1000;
  // An hour-old complete result without schema 2, and the call itself errored (client-side timeout): NOT "outdated".
  const r1 = mk({ status: 'complete', id: 'x', ts: old, plan: [{ step: 's' }], text: 'T' }, { error: 'context deadline exceeded' });
  assert.doesNotMatch(r1, /outdated/);
  assert.match(r1, /context deadline exceeded/);
  assert.match(r1, /not resent/);
  // The call was cancelled while the server was still working (marker still pending): says so.
  assert.match(mk({ status: 'pending', ts: Date.now() }), /did not return in time[\s\S]*180s/);
  // A stale file with no error and no pending marker is just stale.
  assert.match(mk({ status: 'complete', id: 'x', ts: old, plan: [{ step: 's' }], text: 'T' }), /stale or missing/);
  // A FRESH complete result without schema 2 really is an outdated server.
  assert.match(mk({ status: 'complete', id: 'x', ts: Date.now(), plan: [{ step: 's' }], text: 'T' }), /outdated/);
});

test('gate: real Antigravity argument names (write_file: Content/Overwrite/Path, edit_file: Path/Target/Replacement)', () => {
  const cwd = tmp('aunty-ws-');
  const { run } = planned(['notes.txt'], cwd);
  const inPlan = path.join(cwd, 'notes.txt');
  const outPlan = path.join(cwd, 'other.txt');
  assert.equal(run('gate.mjs', tc('write_file', { Content: 'x', Overwrite: true, Path: inPlan })).decision, 'allow');
  assert.equal(run('gate.mjs', tc('edit_file', { Path: inPlan, Target: 'other.txt', Replacement: 'y' })).decision, 'allow'); // Target is code text, not a path
  assert.equal(run('gate.mjs', tc('write_file', { Content: 'x', Overwrite: true, Path: outPlan })).decision, 'deny');
  assert.equal(run('gate.mjs', tc('edit_file', { Path: outPlan, Target: 'notes.txt', Replacement: 'y' })).decision, 'deny');
});

test('gate: a plan with no files blocks every file write; the re-consult path stays open', () => {
  const { run } = planned([], tmp('aunty-ws-'));
  assert.equal(run('gate.mjs', tc('write_file', { TargetFile: 'a.txt' })).decision, 'deny');
  assert.equal(run('gate.mjs', tc('mcp_auntygravity_consult', {})).decision, 'allow');
});

// ---------- Stop audit ----------
const hasGit = spawnSync('git', ['--version']).status === 0;
const skip = hasGit ? false : 'git not available';
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });

function repo() {
  const cwd = tmp('aunty-git-');
  git(cwd, 'init', '-q');
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'one');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'init');
  fs.writeFileSync(path.join(cwd, 'predirty.txt'), 'before'); // already dirty when the plan is recorded
  return cwd;
}
const touch = (f, text) => {
  fs.writeFileSync(f, text);
  fs.utimesSync(f, new Date(Date.now() + 5000), new Date(Date.now() + 5000)); // distinct mtime regardless of fs granularity
};

test('audit: Stop flags files changed outside the plan, ignores in-plan and pre-existing dirt, and is bounded', { skip }, () => {
  const cwd = repo();
  const { run } = planned(['allowed.txt'], cwd);
  const stop = () => run('stop-check.mjs', { executionNum: 0, continuationActive: false });

  touch(path.join(cwd, 'allowed.txt'), 'ok'); // inside the plan
  let r = stop();
  assert.equal(r.decision, 'continue');
  assert.match(r.reason, /Before finishing/); // normal report-back, not an audit failure
  assert.doesNotMatch(r.reason, /outside the Gemini plan/);

  touch(path.join(cwd, 'sneaky.txt'), 'x'); // new, outside
  touch(path.join(cwd, 'tracked.txt'), 'two'); // tracked file modified, outside
  touch(path.join(cwd, 'predirty.txt'), 'changed again'); // dirty before the plan AND changed since
  r = stop();
  assert.equal(r.decision, 'continue');
  assert.match(r.reason, /outside the Gemini plan/);
  for (const f of ['sneaky.txt', 'tracked.txt', 'predirty.txt']) assert.ok(r.reason.toLowerCase().includes(f), f);
  assert.ok(!r.reason.toLowerCase().includes('allowed.txt'));

  stop();
  stop(); // rounds 2 and 3
  r = stop(); // cap reached: no more audit continues
  assert.doesNotMatch(r.reason ?? '', /outside the Gemini plan/);
});

test('audit: a clean tree, deletions of in-plan files, and non-git workspaces do not trigger it', { skip }, () => {
  const cwd = repo();
  const { run } = planned(['tracked.txt'], cwd);
  fs.rmSync(path.join(cwd, 'tracked.txt')); // in-plan deletion
  assert.doesNotMatch(run('stop-check.mjs', { executionNum: 0 }).reason ?? '', /outside/);

  const plain = tmp('aunty-nogit-');
  const second = planned(['a.txt'], plain);
  fs.writeFileSync(path.join(plain, 'anything.txt'), 'x');
  assert.doesNotMatch(second.run('stop-check.mjs', { executionNum: 0 }).reason ?? '', /outside/); // no git: audit skipped
});
