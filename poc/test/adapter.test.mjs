// Interface-level tests for the Gemini adapter: pure prompt/parse logic, the server with a fake adapter,
// and the real Playwright UI driver against a local fixture page that imitates the Gemini UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConsultError } from '../mcp/adapter/errors.mjs';
import { buildPrompt, parseResponse, renderResult, MAX_PROMPT_CHARS } from '../mcp/adapter/prompt.mjs';
import { acquireLock } from '../mcp/adapter/lock.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = path.join(root, 'mcp', 'server.mjs');
const GOOD = { summary: 's', recommendation: 'r', plan: [{ step: 'do x', verification: ['check x'] }], assumptions: ['a'], open_questions: [], risks: ['k'] };
const fenced = (o) => `Sure.\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;

// ---------- prompt / parse ----------
test('prompt: contains only explicit inputs and the output contract; enforces size limit', () => {
  const p = buildPrompt({ intent: 'plan', task: 'T', context: [{ label: 'L', text: 'ctx' }], constraints: ['c1'], acceptance_criteria: ['a1'] });
  for (const s of ['Task: T', '[L]', 'ctx', '- c1', '- a1', '```json']) assert.ok(p.includes(s), s);
  assert.throws(() => buildPrompt({ task: 'x'.repeat(MAX_PROMPT_CHARS) }), (e) => e.code === 'INVALID_INPUT');
});

test('parse: accepts a valid fenced plan, prefers the last block, normalizes fields', () => {
  const text = `\`\`\`json\n{"plan":[{"step":"old"}]}\n\`\`\`\nrevised:\n${fenced(GOOD)}`;
  const r = parseResponse(text);
  assert.equal(r.plan[0].step, 'do x');
  assert.deepEqual(parseResponse(fenced({ plan: [{ step: ' a ' }] })).plan, [{ step: 'a', verification: [] }]);
});

test('parse: rejects prose, empty plans and malformed steps as UNSTRUCTURED_RESPONSE', () => {
  for (const bad of ['just words', fenced({ plan: [] }), fenced({ plan: [{ step: 5 }] }), fenced({ plan: [{ step: 'x', verification: 'no' }] }), '```json\n{oops\n```']) {
    assert.throws(() => parseResponse(bad), (e) => e instanceof ConsultError && e.code === 'UNSTRUCTURED_RESPONSE', bad);
  }
});

test('render: fixed binding header, numbered steps and verification lines', () => {
  const t = renderResult(parseResponse(fenced(GOOD)), { modelUsed: 'neon', intent: 'plan' });
  assert.match(t, /^PLAN FROM GEMINI \(BINDING\)/);
  assert.match(t, /1\. do x\n {3}Verify: check x/);
  assert.match(t, /Risks:\n- k/);
});

// ---------- server with a fake adapter ----------
function rpc(env, calls) {
  return new Promise((resolve) => {
    const p = spawn('node', [server], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    const got = new Map();
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        got.set(m.id, m);
        if (got.size === calls.length) {
          p.kill();
          resolve([...got.values()]);
        }
      }
    });
    calls.forEach((c, i) => p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: i + 1, ...c })}\n`));
  });
}
const consultCall = (args) => ({ method: 'tools/call', params: { name: 'consult', arguments: args } });

async function viaFake(mode, args = { task: 'do it' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aunty-ad-'));
  const env = { ...process.env, AUNTY_STATE_DIR: dir, AUNTY_ADAPTER: 'fake', AUNTY_FAKE_MODE: mode };
  const [res] = await rpc(env, [consultCall(args)]);
  const last = JSON.parse(fs.readFileSync(path.join(dir, 'last_consult.json'), 'utf8'));
  return { res: res.result, last, dir };
}

test('server+adapter: a structured answer becomes a complete, rendered plan', async () => {
  const { res, last, dir } = await viaFake('ok');
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /^PLAN FROM GEMINI \(BINDING\)/);
  assert.equal(last.status, 'complete');
  assert.equal(last.plan[0].step, 'Create fake-output.txt containing "ok"');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'adapter.json'), 'utf8')).adapter, 'fake');
});

test('server+adapter: every failure is a typed error recorded as failed, never a fallback', async () => {
  for (const [mode, code] of [['prose', 'UNSTRUCTURED_RESPONSE'], ['signin', 'NEEDS_SIGN_IN'], ['unavailable', 'MODEL_UNAVAILABLE'], ['crash', 'BROWSER_UNAVAILABLE']]) {
    const { res, last } = await viaFake(mode);
    assert.equal(res.isError, true, mode);
    assert.match(res.content[0].text, new RegExp(`^${code}:`), mode);
    assert.match(res.content[0].text, /substitute another model/);
    assert.equal(last.status, 'error');
    assert.equal(last.code, code);
  }
});

test('server+adapter: invalid context shape is rejected before any adapter call', async () => {
  const { res, last } = await viaFake('ok', { task: 't', context: [{ label: 1 }] });
  assert.equal(res.isError, true);
  assert.equal(last.code, 'INVALID_INPUT');
});

// ---------- lock ----------
test('lock: a second concurrent request gets BUSY; a stale lock is replaced', () => {
  const lock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aunty-lk-')), 'x.lock');
  process.env.AUNTY_LOCK_FILE = lock;
  const release = acquireLock();
  assert.throws(() => acquireLock(), (e) => e.code === 'BUSY');
  release();
  fs.writeFileSync(lock, JSON.stringify({ pid: 99999999, ts: Date.now() }));
  acquireLock()();
  delete process.env.AUNTY_LOCK_FILE;
});

