// Runs inside the user's own signed-in gemini.google.com tab. All Gemini-UI knowledge is in SELECTORS below.
// These are best guesses from role/label conventions and are UNVERIFIED against the live page.
// Rules: act only on an allowed host; stop with a typed error on anything unexpected; never resend a prompt;
// never touch challenges or consent; never switch to a different model than requested.
(() => {
  if (globalThis.__auntyDriver) return;

  const DEFAULTS = {
    allowedHosts: ['gemini.google.com'],
    sendConfirmMs: 10000,
    generateTimeoutMs: 150000, // Antigravity cancels MCP tool calls at 180s (measured), so finish earlier
    stableMs: 3000,
    pollMs: 500,
  };
  const CHALLENGE_TEXT = /unusual traffic|captcha|verify (it'?s|that you'?re) (you|human)|not a robot/i;
  const USAGE_TEXT = /(reached|hit) (your )?(usage )?limit|come back (later|tomorrow)|limit.*(reset|refresh)/i;
  const MODEL_LABELS = { neon: /neon/i, hydrogen: /hydrogen/i };

  class DriverError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const nameOf = (el) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
  const ROLE = {
    button: 'button, [role="button"]',
    link: 'a[href], [role="link"]',
    menuitem: '[role="menuitem"], [role="menuitemradio"], [role="radio"], mat-option',
    option: '[role="option"]',
    dialog: '[role="dialog"], dialog[open]',
    textbox: '[role="textbox"], textarea, input[type="text"]',
  };
  const byRole = (role, re) => [...document.querySelectorAll(ROLE[role])].filter((el) => visible(el) && re.test(nameOf(el)));
  const disabled = (el) => el.disabled || el.getAttribute('aria-disabled') === 'true';

  const SELECTORS = {
    input: () =>
      byRole('textbox', /prompt|message|ask gemini|enter a/i)[0] ||
      [...document.querySelectorAll('rich-textarea [contenteditable="true"], div.ql-editor[contenteditable="true"]')].find(visible),
    send: () => byRole('button', /^send( message)?$/i)[0],
    stop: () => byRole('button', /^stop\b|stop (response|generating|answer)/i),
    // Live page (verified from a screenshot): the picker shows the current model, e.g. "Neon High", and its menu lists
    // "Everyday help 4 Hydrogen", "Deeper analysis 4 Neon", "Code & complex work 4 Carbon" (item names carry the model).
    modelPicker: () =>
      [...document.querySelectorAll(ROLE.button)].filter(visible).find(
        (el) => /mode picker|model|switch/i.test(el.getAttribute('aria-label') || '') || /^\s*(auto|neon|hydrogen|carbon|argon|fast|thinking|pro)\b/i.test(el.textContent || ''),
      ),
    modelOption: (re) => {
      const direct = [...byRole('menuitem', re), ...byRole('option', re)][0];
      if (direct) return direct;
      // Fallback: deepest visible element inside an overlay or menu whose text names the model.
      const pool = [...document.querySelectorAll('.cdk-overlay-container *, [role="menu"] *, [role="listbox"] *')].filter(
        (el) => visible(el) && re.test(el.textContent || '') && (el.textContent || '').length < 120,
      );
      return pool.find((el) => ![...el.children].some((c) => re.test(c.textContent || '')));
    },
    responses: () => [...document.querySelectorAll('message-content, .model-response-text, [data-test-id="response-text"]')],
    signIn: () => byRole('link', /^sign in$/i)[0] || byRole('button', /^sign in$/i)[0],
    consentDialog: () => byRole('dialog', /agree|consent|privacy|terms|before you continue/i)[0],
  };

  // Diagnostic for selector tuning: STRUCTURE only (tags, ids, classes), never page text.
  function describeResponseArea() {
    try {
      const hits = [...document.querySelectorAll('body *')].filter((el) => visible(el) && /"plan"|hello\.txt/.test(el.textContent || ''));
      const leaf = hits.sort((a, b) => a.textContent.length - b.textContent.length)[0];
      const chain = [];
      for (let el = leaf, i = 0; el && el !== document.body && i < 8; el = el.parentElement, i++) {
        const cls = [...el.classList].slice(0, 2).join('.');
        const dt = el.getAttribute('data-test-id');
        chain.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls ? `.${cls}` : ''}${dt ? `[dtid=${dt}]` : ''}`);
      }
      const lens = SELECTORS.responses().map((el) => (el.innerText || '').length); // lengths only, never text
      return `responsesMatched=${lens.length} responseTextLengths=${JSON.stringify(lens)} stopButtons=${SELECTORS.stop().length} answerChain=${JSON.stringify(chain)}`;
    } catch (e) {
      return `diag failed: ${e.message}`;
    }
  }

  const bodyText = () => document.body?.innerText ?? '';
  const textOf = (el) => (el.value ?? el.textContent ?? '');

  function guard(cfg) {
    if (!cfg.allowedHosts.includes(location.hostname)) throw new DriverError('UI_CHANGED', `Unexpected page origin "${location.hostname}"; refusing to interact.`);
    if (CHALLENGE_TEXT.test(bodyText())) throw new DriverError('CHALLENGE_REQUIRED', 'Google is showing a verification challenge. Complete it yourself in the tab; AuntyGravity will not.');
    if (SELECTORS.signIn()) throw new DriverError('NEEDS_SIGN_IN', 'Signed out: sign in to Gemini in this Chrome profile, then retry.');
    if (SELECTORS.consentDialog()) throw new DriverError('CONSENT_REQUIRED', 'A consent dialog is open. Review and answer it yourself in the tab, then retry.');
    if (USAGE_TEXT.test(bodyText()) && !SELECTORS.responses().length) throw new DriverError('USAGE_LIMIT', 'Gemini reports a usage limit for this account or model.');
  }

  async function waitFor(fn, ms, pollMs = 100) {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v && (!Array.isArray(v) || v.length)) return v;
      if (Date.now() > end) return null;
      await sleep(pollMs);
    }
  }

  const pickerLabel = (el) => `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`.trim();

  async function selectModel(model) {
    const want = MODEL_LABELS[model];
    if (!want) throw new DriverError('INVALID_INPUT', `model "${model}" is not allowed`);
    const picker = await waitFor(SELECTORS.modelPicker, 4000);
    if (!picker) {
      const labels = [...document.querySelectorAll(ROLE.button)].filter(visible).slice(0, 40).map((el) => nameOf(el).slice(0, 40));
      throw new DriverError('UI_CHANGED', `Model picker not found on the page. [diag buttons=${JSON.stringify(labels)}]`);
    }
    if (want.test(pickerLabel(picker))) return;

    picker.click();
    const option = await waitFor(() => SELECTORS.modelOption(want), 3000);
    if (!option || disabled(option)) {
      // Diagnostic for selector tuning: UI labels only (menu items and the picker), never page content.
      const labels = [...document.querySelectorAll(`${ROLE.menuitem}, ${ROLE.option}`)].filter(visible).slice(0, 30).map((el) => nameOf(el).slice(0, 60));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      throw new DriverError(
        'MODEL_UNAVAILABLE',
        `${model} is not available in the Gemini model menu for this account. [diag picker="${pickerLabel(picker).slice(0, 80)}" menu=${JSON.stringify(labels)} found=${!!option}]`,
      );
    }
    option.click();
    await sleep(600);
    const after = SELECTORS.modelPicker();
    if (!after || !want.test(pickerLabel(after))) throw new DriverError('MODEL_UNAVAILABLE', `Could not verify that ${model} is selected; not sending the prompt.`);
  }

  function fill(input, text) {
    input.focus();
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, text);
    }
  }

  async function send(prompt, before, cfg) {
    const input = await waitFor(SELECTORS.input, 5000);
    if (!input) throw new DriverError('UI_CHANGED', 'Prompt box not found on the page.');
    fill(input, prompt);
    if (!textOf(input).trim().length) throw new DriverError('UI_CHANGED', 'The prompt text did not enter the prompt box.');

    const btn = await waitFor(() => { const b = SELECTORS.send(); return b && !disabled(b) ? b : null; }, 2000);
    if (!btn) throw new DriverError('UI_CHANGED', 'Send button not found or disabled.');
    btn.click();

    const end = Date.now() + cfg.sendConfirmMs;
    while (Date.now() < end) {
      if (SELECTORS.stop().length || SELECTORS.responses().length > before || !textOf(input).trim().length) return;
      await sleep(cfg.pollMs);
    }
    throw new DriverError('UI_CHANGED', `The prompt was not accepted by the page (nothing started). [diag ${describeResponseArea()}]`);
  }

  async function waitForAnswer(before, cfg) {
    const end = Date.now() + cfg.generateTimeoutMs;
    let last = '';
    let changedAt = Date.now();
    while (Date.now() < end) {
      const rs = SELECTORS.responses();
      const text = rs.length > before ? rs[rs.length - 1].innerText.trim() : '';
      if (text !== last) {
        last = text;
        changedAt = Date.now();
      }
      const generating = SELECTORS.stop().length > 0;
      if (last && !generating && Date.now() - changedAt >= cfg.stableMs) return last;
      if (!last && USAGE_TEXT.test(bodyText())) throw new DriverError('USAGE_LIMIT', 'Gemini reports a usage limit for this account or model.');
      await sleep(cfg.pollMs);
    }
    // Do NOT resubmit: the prompt may still be running or may have completed.
    throw new DriverError('GENERATION_TIMEOUT', `Gemini did not finish in time. The prompt was not resent; check the tab. [diag ${describeResponseArea()}]`);
  }

  async function ask({ prompt, model }, overrides = {}) {
    const cfg = { ...DEFAULTS, ...overrides };
    try {
      if (typeof prompt !== 'string' || !prompt.trim()) throw new DriverError('INVALID_INPUT', 'empty prompt');
      guard(cfg);
      await selectModel(model);
      const before = SELECTORS.responses().length;
      await send(prompt, before, cfg);
      return { ok: true, text: await waitForAnswer(before, cfg), modelUsed: model };
    } catch (e) {
      return { ok: false, code: e.code || 'UI_CHANGED', message: String(e.message || e) };
    }
  }

  globalThis.__auntyDriver = { ask };

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if (msg?.type === 'ping') reply({ ok: true });
      else if (msg?.type === 'ask') ask(msg.req).then(reply);
      else return false;
      return true; // async reply
    });
  }
})();
