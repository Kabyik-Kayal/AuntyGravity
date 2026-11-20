// Service worker: long-polls the local AuntyGravity bridge for one job at a time, opens a visible Gemini tab
// in the user's own profile, has the content script do the asking, and posts the result back.
// Only talks to 127.0.0.1:9334 with a pairing token; only opens gemini.google.com.
const BASE = 'http://127.0.0.1:9334';
const GEMINI = 'https://gemini.google.com/app';
const MODELS = ['neon', 'hydrogen'];
const MAX_PROMPT = 12000;
// Leave the tab open when a human must act or the prompt may still be running.
const KEEP_OPEN = new Set(['NEEDS_SIGN_IN', 'CONSENT_REQUIRED', 'CHALLENGE_REQUIRED', 'GENERATION_TIMEOUT', 'GENERATION_PENDING']);

// The tab holding a prompt that was sent but not yet answered, so a later `collect` job can fetch the answer.
const getPending = async () => (await chrome.storage.local.get('pendingTab')).pendingTab;
const setPending = (tabId) => chrome.storage.local.set({ pendingTab: { tabId, ts: Date.now() } });
const clearPending = () => chrome.storage.local.remove('pendingTab');

// Fetch the answer for a prompt already sent in the remembered tab. Never sends anything.
async function runCollect(req) {
  const pending = await getPending();
  if (!pending) return { ok: false, code: 'UI_CHANGED', message: 'No pending Gemini answer to collect (the tab is gone or no prompt is waiting).' };
  let tab;
  try {
    tab = await chrome.tabs.get(pending.tabId);
  } catch {
    await clearPending();
    return { ok: false, code: 'UI_CHANGED', message: 'The pending Gemini tab was closed; nothing to collect.' };
  }
  if (!(tab.url ?? '').startsWith('https://gemini.google.com/')) {
    await clearPending();
    return { ok: false, code: 'UI_CHANGED', message: 'The pending tab is no longer on Gemini; refusing to interact.' };
  }
  let result;
  try {
    result = await chrome.tabs.sendMessage(tab.id, { type: 'collect', req: { model: req.model } });
  } catch (e) {
    result = { ok: false, code: 'BROWSER_UNAVAILABLE', message: String(e.message || e).split('\n')[0] };
  }
  if (result?.ok || !KEEP_OPEN.has(result?.code)) {
    await clearPending();
    chrome.tabs.remove(tab.id).catch(() => {});
  }
  return result ?? { ok: false, code: 'UI_CHANGED', message: 'No result from the Gemini tab.' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getToken = async () => (await chrome.storage.local.get('token')).token;

function waitComplete(tabId, ms) {
  return new Promise((resolve, reject) => {
    // Gemini keeps loading resources for a long time; on timeout carry on and let the URL and content-script checks decide.
    const timer = setTimeout(() => done(), ms);
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') done();
    };
    const done = (err) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      err ? reject(err) : resolve();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((t) => t.status === 'complete' && done());
  });
}

async function runJob(job) {
  const req = job?.req;
  if (req?.collect === true && MODELS.includes(req.model)) return runCollect(req);
  if (!req || typeof req.prompt !== 'string' || !req.prompt.trim() || req.prompt.length > MAX_PROMPT || !MODELS.includes(req.model)) {
    return { ok: false, code: 'INVALID_INPUT', message: 'Bridge rejected a malformed job.' };
  }
  // A new consult supersedes any old pending tab: close it so tabs do not pile up.
  const old = await getPending();
  if (old) {
    await clearPending();
    chrome.tabs.remove(old.tabId).catch(() => {});
  }
  let tab;
  let result;
  try {
    tab = await chrome.tabs.create({ url: GEMINI, active: true });
    await waitComplete(tab.id, 15000);
    const url = (await chrome.tabs.get(tab.id)).url ?? '';
    if (url.startsWith('https://accounts.google.com/')) {
      result = { ok: false, code: 'NEEDS_SIGN_IN', message: 'Signed out: sign in to Gemini in this Chrome profile, then retry.' };
    } else if (!url.startsWith('https://gemini.google.com/')) {
      result = { ok: false, code: 'UI_CHANGED', message: 'Unexpected page after opening Gemini; refusing to interact.' };
    } else {
      let ready = false;
      for (let i = 0; i < 20 && !ready; i++) {
        ready = await chrome.tabs.sendMessage(tab.id, { type: 'ping' }).then((r) => !!r?.ok, () => false);
        if (!ready) await sleep(500);
      }
      result = ready
        ? await chrome.tabs.sendMessage(tab.id, { type: 'ask', req: { prompt: req.prompt, model: req.model } })
        : { ok: false, code: 'UI_CHANGED', message: 'Gemini page did not load the bridge content script.' };
    }
  } catch (e) {
    result = { ok: false, code: 'BROWSER_UNAVAILABLE', message: String(e.message || e).split('\n')[0] };
  }
  if (tab && result && !result.ok && result.code === 'GENERATION_PENDING') await setPending(tab.id);
  if (tab && !(result && !result.ok && KEEP_OPEN.has(result.code))) chrome.tabs.remove(tab.id).catch(() => {});
  return result ?? { ok: false, code: 'UI_CHANGED', message: 'No result from the Gemini tab.' };
}

let running = false;
async function loop() {
  if (running) return;
  running = true;
  // MV3 workers are killed after ~30s idle; a cheap extension API call every 20s keeps the poll loop alive.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  try {
    for (;;) {
      const token = await getToken();
      if (!token) {
        await sleep(5000);
        continue;
      }
      let res;
      try {
        res = await fetch(`${BASE}/job`, { headers: { 'X-Aunty-Token': token }, signal: AbortSignal.timeout(25000) });
      } catch {
        await sleep(2500); // bridge not running (no consult in progress)
        continue;
      }
      if (res.status === 401) {
        await sleep(10000);
        continue;
      }
      if (res.status !== 200) continue; // 204: nothing yet, poll again
      const job = await res.json();
      const result = await runJob(job);
      await fetch(`${BASE}/result`, {
        method: 'POST',
        headers: { 'X-Aunty-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: job.id, ...result }),
      }).catch(() => {});
    }
  } finally {
    clearInterval(keepAlive);
    running = false;
  }
}

chrome.runtime.onStartup.addListener(loop);
chrome.runtime.onInstalled.addListener(loop);
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(loop);
loop();
