// Bridge protocol (simulating the extension with fetch), extension manifest hygiene, and the content-script
// UI driver run against a local fixture page that imitates the Gemini UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { ask as bridgeAsk, getToken } from '../mcp/adapter/chrome-bridge.mjs';
import { parseResponse } from '../mcp/adapter/prompt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = path.join(root, 'extension');
const PORT = 9391;
const BASE = `http://127.0.0.1:${PORT}`;

function isolate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aunty-br-'));
  process.env.AUNTY_TOKEN_FILE = path.join(dir, 'ext-token');
  process.env.AUNTY_LOCK_FILE = path.join(dir, 'lock');
  return getToken();
}

// A fake extension: polls /job, answers with `reply(job)`.
async function fakeExtension(token, reply) {
  for (let i = 0; i < 100; i++) {
    const r = await fetch(`${BASE}/job`, { headers: { 'X-Aunty-Token': token } }).catch(() => null);
    if (r?.status === 200) {
      const job = await r.json();
      const body = { id: job.id, ...(await reply(job)) };
      await fetch(`${BASE}/result`, { method: 'POST', headers: { 'X-Aunty-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return job;
    }
    await new Promise((r2) => setTimeout(r2, 50));
  }
  throw new Error('no job seen');
}

const opts = { port: PORT, launch: false, connectMs: 3000, totalMs: 5000 };

test('bridge: job goes out, answer comes back, server and lock are released', async () => {
  const token = isolate();
  const ext1 = fakeExtension(token, () => ({ ok: true, text: 'ANSWER', modelUsed: 'neon' }));
  const r = await bridgeAsk({ prompt: 'hello', model: 'neon' }, opts);
  const job = await ext1;
  assert.deepEqual(r, { text: 'ANSWER', modelUsed: 'neon' });
  assert.deepEqual(job.req, { prompt: 'hello', model: 'neon' });
  assert.equal(await fetch(`${BASE}/job`).catch(() => 'closed'), 'closed'); // nothing listening afterwards
  assert.ok(!fs.existsSync(process.env.AUNTY_LOCK_FILE));
});

test('bridge: wrong or missing token gets 401 and never receives the job', async () => {
  const token = isolate();
  const p = bridgeAsk({ prompt: 'secret prompt', model: 'neon' }, { ...opts, connectMs: 1200 });
  await new Promise((r) => setTimeout(r, 200));
  for (const headers of [{}, { 'X-Aunty-Token': 'f'.repeat(64) }]) {
    const r = await fetch(`${BASE}/job`, { headers });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('access-control-allow-origin'), null); // web pages cannot read it either
  }
  await assert.rejects(p, (e) => e.code === 'BROWSER_UNAVAILABLE'); // nobody legitimate picked it up
  assert.ok(token);
});

test('bridge: extension-reported failures become typed errors', async () => {
  for (const code of ['NEEDS_SIGN_IN', 'MODEL_UNAVAILABLE', 'CONSENT_REQUIRED', 'GENERATION_TIMEOUT']) {
    const token = isolate();
    const ext1 = fakeExtension(token, () => ({ ok: false, code, message: `m-${code}` }));
    await assert.rejects(bridgeAsk({ prompt: 'p', model: 'neon' }, opts), (e) => e.code === code && e.message === `m-${code}`);
    await ext1;
  }
});

test('bridge: empty answer, wrong result id, no extension and busy port are all refused', async () => {
  let token = isolate();
  let ext1 = fakeExtension(token, () => ({ ok: true, text: '   ' }));
  await assert.rejects(bridgeAsk({ prompt: 'p', model: 'neon' }, opts), (e) => e.code === 'UI_CHANGED');
  await ext1;

  token = isolate();
  await assert.rejects(bridgeAsk({ prompt: 'p', model: 'neon' }, { ...opts, connectMs: 400 }), (e) => e.code === 'BROWSER_UNAVAILABLE' && /extension/.test(e.message));

  token = isolate();
  const p = bridgeAsk({ prompt: 'p', model: 'neon' }, { ...opts, connectMs: 1500 });
  await new Promise((r) => setTimeout(r, 200));
  const bad = await fetch(`${BASE}/result`, { method: 'POST', headers: { 'X-Aunty-Token': token }, body: JSON.stringify({ id: 'nope', ok: true, text: 'x' }) });
  assert.equal(bad.status, 409);
  await assert.rejects(p, (e) => e.code === 'BROWSER_UNAVAILABLE');
});

test('bridge: a concurrent consult is refused with BUSY and does not disturb the first', async () => {
  const token = isolate();
  const first = bridgeAsk({ prompt: 'a', model: 'neon' }, opts);
  await new Promise((r) => setTimeout(r, 200));
  await assert.rejects(bridgeAsk({ prompt: 'b', model: 'neon' }, opts), (e) => e.code === 'BUSY');
  await fakeExtension(token, () => ({ ok: true, text: 'A' }));
  assert.equal((await first).text, 'A');
});

test('manifest: minimal permissions, fixed hosts, no broad access', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  assert.equal(m.manifest_version, 3);
  assert.deepEqual([...m.permissions].sort(), ['alarms', 'storage']);
  assert.deepEqual([...m.host_permissions].sort(), ['http://127.0.0.1:9334/*', 'https://gemini.google.com/*']);
  assert.deepEqual(m.content_scripts.map((c) => c.matches), [['https://gemini.google.com/*']]);
  assert.ok(!JSON.stringify(m).includes('<all_urls>'));
  assert.ok(!('externally_connectable' in m)); // no web page may message the extension
});

// ---------- content-script driver on a fixture page ----------
const CHROME = [process.env.AUNTY_BROWSER_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', '/usr/bin/google-chrome']
  .filter(Boolean)
  .find((p) => fs.existsSync(p));
const skip = CHROME ? false : 'no Chrome/Edge available';

const ANSWER = 'Here:\n```json\n{"summary":"s","recommendation":"r","plan":[{"step":"do x","verification":["check x"]}]}\n```';

const FIXTURE = (mode) => `<!doctype html><title>fixture</title><body>
${mode === 'signedout' ? '<a href="#">Sign in</a>' : ''}
${mode === 'challenge' ? '<p>Our systems have detected unusual traffic from your computer network.</p>' : ''}
${mode === 'consent' ? '<div role="dialog">Before you continue, agree to the terms and privacy policy</div>' : ''}
${mode === 'limit' ? '<p>You have reached your usage limit. Come back tomorrow.</p>' : ''}
<div id="picker" role="button" aria-label="Model picker">Fast</div>
<div id="menu" hidden>
  ${mode === 'noneon' ? '' : '<div role="menuitem" id="neon">Neon</div>'}
  <div role="menuitem" id="hydrogen">Hydrogen</div>
</div>
<div id="in" role="textbox" contenteditable="true" aria-label="Enter a prompt here"></div>
<button id="send" aria-label="Send message">Send</button>
<div id="out"></div>
<script>
const $ = (i) => document.getElementById(i);
window.sends = 0;
window.sentText = '';
$('picker').onclick = () => { $('menu').hidden = !$('menu').hidden; };
for (const id of ['neon', 'hydrogen']) { const el = $(id); if (el) el.onclick = () => { $('picker').textContent = el.textContent; $('menu').hidden = true; }; }
$('send').onclick = () => {
  if ('${mode}' === 'deadsend') return;
  window.sends++;
  window.sentText = $('in').innerText;
  const stop = document.createElement('button'); stop.setAttribute('aria-label', 'Stop response'); stop.textContent = 'Stop'; document.body.append(stop);
  $('in').textContent = '';
  if ('${mode}' === 'slow') return;
  setTimeout(() => {
    const m = document.createElement('message-content');
    m.textContent = ${JSON.stringify(ANSWER)};
    $('out').append(m);
    stop.remove();
  }, 400);
};
</script>`;

const FAST = { stableMs: 300, pollMs: 50, sendConfirmMs: 1500, generateTimeoutMs: 6000, allowedHosts: ['gemini.test'] };

async function withPage(mode, fn) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  await page.route('https://gemini.test/**', (r) => r.fulfill({ contentType: 'text/html', body: FIXTURE(mode) }));
  await page.goto('https://gemini.test/app');
  await page.addScriptTag({ path: path.join(ext, 'content.js') });
  const driverAsk = (req, cfg = {}) => page.evaluate(([rq, c]) => window.__auntyDriver.ask(rq, c), [req, { ...FAST, ...cfg }]);
  try {
    return await fn(page, driverAsk);
  } finally {
    await browser.close();
  }
}

test('content driver: selects Neon, sends the full multi-line prompt, returns the finished answer', { skip }, async () => {
  await withPage('ok', async (page, ask) => {
    const r = await ask({ prompt: 'PLAN PLEASE\nline two', model: 'neon' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.modelUsed, 'neon');
    assert.equal(parseResponse(r.text).plan[0].step, 'do x');
    assert.equal(await page.evaluate(() => document.getElementById('picker').textContent), 'Neon');
    assert.equal(await page.evaluate(() => window.sends), 1);
    assert.match(await page.evaluate(() => window.sentText), /PLAN PLEASE[\s\S]*line two/);
  });
});

test('content driver: hydrogen is selectable too', { skip }, async () => {
  await withPage('ok', async (page, ask) => {
    assert.equal((await ask({ prompt: 'p', model: 'hydrogen' })).ok, true);
    assert.equal(await page.evaluate(() => document.getElementById('picker').textContent), 'Hydrogen');
  });
});

test('content driver: missing model -> MODEL_UNAVAILABLE and nothing is sent', { skip }, async () => {
  await withPage('noneon', async (page, ask) => {
    const r = await ask({ prompt: 'p', model: 'neon' });
    assert.equal(r.code, 'MODEL_UNAVAILABLE');
    assert.equal(await page.evaluate(() => window.sends), 0);
  });
});

test('content driver: sign-in, challenge, consent and usage limit each stop with a typed error', { skip }, async () => {
  for (const [mode, code] of [['signedout', 'NEEDS_SIGN_IN'], ['challenge', 'CHALLENGE_REQUIRED'], ['consent', 'CONSENT_REQUIRED'], ['limit', 'USAGE_LIMIT']]) {
    await withPage(mode, async (page, ask) => {
      const r = await ask({ prompt: 'p', model: 'neon' });
      assert.equal(r.ok, false, mode);
      assert.equal(r.code, code, mode);
      assert.equal(await page.evaluate(() => window.sends), 0);
    });
  }
});

test('content driver: a page outside the allowed origin is refused before interacting', { skip }, async () => {
  await withPage('ok', async (page, ask) => {
    const r = await ask({ prompt: 'p', model: 'neon' }, { allowedHosts: ['gemini.google.com'] });
    assert.equal(r.code, 'UI_CHANGED');
    assert.equal(await page.evaluate(() => window.sends), 0);
  });
});

test('content driver: prompt not accepted -> UI_CHANGED; never-finishing answer -> GENERATION_TIMEOUT, sent once', { skip }, async () => {
  await withPage('deadsend', async (page, ask) => assert.equal((await ask({ prompt: 'p', model: 'neon' })).code, 'UI_CHANGED'));
  await withPage('slow', async (page, ask) => {
    const r = await ask({ prompt: 'p', model: 'neon' }, { generateTimeoutMs: 1500 });
    assert.equal(r.code, 'GENERATION_TIMEOUT');
    assert.equal(await page.evaluate(() => window.sends), 1); // exactly one submission, no retry
  });
});
