// Production adapter: hands one job to the AuntyGravity Bridge extension running in the user's own Chrome profile.
// Loopback HTTP only, one job per consultation, token required. The server exists only while a consult runs.
// Interface: ask({prompt, model}, opts?) -> {text, modelUsed}; throws ConsultError.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ConsultError } from './errors.mjs';
import { acquireLock, home } from './lock.mjs';

export const tokenPath = () => process.env.AUNTY_TOKEN_FILE || path.join(home(), 'ext-token');

export function getToken() {
  const p = tokenPath();
  try {
    const t = fs.readFileSync(p, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(t)) return t;
  } catch {
    /* create below */
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const t = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(p, t, { mode: 0o600 });
  return t;
}

const sameToken = (given, expected) => {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

function findChrome() {
  return [
    process.env.AUNTY_BROWSER_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean).find((p) => fs.existsSync(p));
}

const DEFAULTS = {
  port: Number(process.env.AUNTY_BRIDGE_PORT || 9334),
  connectMs: 45000, // how long to wait for the extension to pick the job up
  launchAfterMs: 6000, // start the user's default Chrome if the extension has not shown up by then
  totalMs: 170000, // hard cap incl. page load; must stay under Antigravity's 180s MCP tool-call limit (measured); never resends
  holdMs: 20000, // long-poll hold
  launch: true,
};

export async function ask({ prompt, model, collect }, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const release = acquireLock();
  const token = getToken();
  const job = { id: crypto.randomUUID(), req: { prompt, model, collect: collect === true, ...(Number.isFinite(opts.waitMs) ? { waitMs: opts.waitMs } : {}) } };
  let taken = false;
  let finish;
  const done = new Promise((resolve) => (finish = resolve));

  const server = http.createServer((req, res) => {
    if (!sameToken(req.headers['x-aunty-token'], token)) {
      res.writeHead(401).end();
      return;
    }
    if (req.method === 'GET' && req.url === '/job') {
      if (taken) {
        const t = setTimeout(() => res.writeHead(204).end(), o.holdMs);
        res.on('close', () => clearTimeout(t));
        return;
      }
      taken = true;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(job));
      return;
    }
    if (req.method === 'POST' && req.url === '/result') {
      let body = '';
      req.on('data', (d) => {
        body += d;
        if (body.length > 2_000_000) req.destroy();
      });
      req.on('end', () => {
        try {
          const r = JSON.parse(body);
          if (r.id !== job.id) return void res.writeHead(409).end();
          res.writeHead(204).end();
          finish(r);
        } catch {
          res.writeHead(400).end();
        }
      });
      return;
    }
    res.writeHead(404).end();
  });

  const timers = [];
  try {
    await new Promise((resolve, reject) => {
      server.once('error', (e) =>
        reject(new ConsultError(e.code === 'EADDRINUSE' ? 'BUSY' : 'BROWSER_UNAVAILABLE', `Bridge could not listen on 127.0.0.1:${o.port} (${e.code}).`)));
      server.listen(o.port, '127.0.0.1', resolve);
    });

    if (o.launch) {
      timers.push(
        setTimeout(() => {
          const chrome = findChrome();
          if (!taken && chrome) spawn(chrome, ['about:blank'], { detached: true, stdio: 'ignore' }).unref();
        }, o.launchAfterMs),
      );
    }
    const noExt = new Promise((resolve) =>
      timers.push(setTimeout(() => !taken && resolve({ ok: false, code: 'BROWSER_UNAVAILABLE', message: 'The AuntyGravity Bridge extension did not respond. Is Chrome open with the extension loaded and paired (token saved)?' }), o.connectMs)),
    );
    const tooLong = new Promise((resolve) =>
      timers.push(setTimeout(() => resolve({ ok: false, code: 'GENERATION_TIMEOUT', message: 'No answer in time. The prompt was not resent; check the Gemini tab.' }), o.totalMs)),
    );

    const r = await Promise.race([done, noExt, tooLong]);
    if (!r.ok) throw new ConsultError(r.code, r.message || 'Bridge reported a failure.');
    if (typeof r.text !== 'string' || !r.text.trim()) throw new ConsultError('UI_CHANGED', 'Bridge returned an empty answer.');
    return { text: r.text, modelUsed: r.modelUsed || model };
  } finally {
    timers.forEach(clearTimeout);
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    release();
  }
}
