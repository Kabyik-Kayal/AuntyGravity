// Stub AuntyGravity MCP server: one `consult` tool over stdio, no dependencies.
// It does NOT call Gemini. It returns a deterministic plan so the hook enforcement can be proven first.
// Protocol: newline-delimited JSON-RPC 2.0 on stdin/stdout. Only stderr may be used for logs.
import readline from 'node:readline';
import { adapterPath, lastConsultPath, writeJson } from '../shared/state.mjs';
import { ConsultError } from './adapter/errors.mjs';
import { buildPrompt, parseResponse, renderResult } from './adapter/prompt.mjs';

// AUNTY_ADAPTER: "stub" (fixed plan, default), "chrome" (your signed-in Chrome via the Bridge extension), "fake" (tests).
const ADAPTER = process.env.AUNTY_ADAPTER || 'stub';
// Tell the hooks which adapter is live: any real adapter makes the gate demand per-call user approval.
writeJson(adapterPath(), { adapter: ADAPTER, ts: Date.now() });

async function loadAsk() {
  if (ADAPTER === 'chrome') return (await import('./adapter/chrome-bridge.mjs')).ask;
  if (ADAPTER === 'fake') return (await import('./adapter/fake-adapter.mjs')).ask;
  return null;
}

const INTENTS = ['plan', 'decision', 'review'];
const MODELS = ['neon', 'hydrogen'];
const MAX_TASK = 8000;

const TOOL = {
  name: 'consult',
  description:
    'Ask the Gemini planner for a plan, decision or review. Gemini decides; you execute. ' +
    'Call this before any edit or command, and again for any deviation or missing decision. ' +
    'If it replies PENDING, call it again with collect: true (same task and model) to fetch the answer; never resend.',
  inputSchema: {
    type: 'object',
    properties: {
      intent: { type: 'string', enum: INTENTS, default: 'plan' },
      model: { type: 'string', enum: MODELS, default: 'neon' },
      task: { type: 'string', description: 'What needs planning or deciding.' },
      context: {
        type: 'array',
        items: {
          type: 'object',
          properties: { label: { type: 'string' }, text: { type: 'string' } },
          required: ['label', 'text'],
        },
      },
      constraints: { type: 'array', items: { type: 'string' } },
      acceptance_criteria: { type: 'array', items: { type: 'string' } },
      collect: { type: 'boolean', description: 'Only after a PENDING reply: fetch the answer to the prompt already sent. Pass the same task and model.' },
    },
    required: ['task'],
  },
};

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

const isStrArr = (v) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
const isCtx = (v) => v === undefined || (Array.isArray(v) && v.every((c) => typeof c?.label === 'string' && typeof c?.text === 'string'));

// Failure: record it for the hooks (which halt the run) and tell the executor not to improvise.
function fail(code, reason) {
  writeJson(lastConsultPath(), { status: 'error', code, reason, ts: Date.now() });
  return {
    isError: true,
    content: [{ type: 'text', text: `${code}: ${reason}\nDo not proceed, retry blindly, or substitute another model. Tell the user what is needed.` }],
  };
}

async function consult(args = {}) {
  // Mark this call as in flight so a stale result from an earlier call is never mistaken for this one.
  writeJson(lastConsultPath(), { status: 'pending', ts: Date.now() });
  const intent = args.intent ?? 'plan';
  const model = args.model ?? 'neon';
  const task = args.task;
  const collect = args.collect === true;
  const problem =
    !collect && (typeof task !== 'string' || !task.trim()) ? 'task is required'
    : typeof task === 'string' && task.length > MAX_TASK ? `task exceeds ${MAX_TASK} characters`
    : !INTENTS.includes(intent) ? `intent must be one of ${INTENTS.join(', ')}`
    : !MODELS.includes(model) ? `model must be one of ${MODELS.join(', ')}`
    : !isCtx(args.context) ? 'context must be a list of {label, text} strings'
    : !isStrArr(args.constraints) || !isStrArr(args.acceptance_criteria) ? 'constraints and acceptance_criteria must be lists of strings'
    : null;

  if (problem) return fail('INVALID_INPUT', problem);

  const ask = await loadAsk();
  if (ask) {
    try {
      const prompt = collect ? undefined : buildPrompt({ intent, task, context: args.context, constraints: args.constraints, acceptance_criteria: args.acceptance_criteria });
      const { text: raw, modelUsed } = await ask({ prompt, model, collect });
      const parsed = parseResponse(raw);
      const text = renderResult(parsed, { modelUsed, intent });
      writeJson(lastConsultPath(), {
        schema: 2, status: 'complete',
        id: `c_${Date.now().toString(36)}`,
        ts: Date.now(),
        model_used: modelUsed,
        intent,
        plan: parsed.plan,
        text,
      });
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      if (e instanceof ConsultError && e.code === 'GENERATION_PENDING') {
        // Not a failure: the prompt was sent once; the answer can be collected from the open tab.
        writeJson(lastConsultPath(), { schema: 2, status: 'waiting', ts: Date.now() });
        return {
          content: [{ type: 'text', text: 'PENDING: Gemini is still working on your request. The prompt was sent once and will NOT be resent. Do not change anything yet. Call consult again with collect: true (same task and model) to fetch the answer.' }],
        };
      }
      const code = e instanceof ConsultError ? e.code : 'BROWSER_UNAVAILABLE';
      return fail(code, e instanceof ConsultError ? e.message : `Unexpected adapter failure: ${String(e.message).split('\n')[0]}`);
    }
  }

  const plan = [
    {
      step: 'Create the file poc-output.txt in the workspace root containing exactly: planned-by-stub',
      files: ['poc-output.txt'],
      verification: ['Read poc-output.txt and confirm its contents match exactly'],
    },
    { step: 'Report the verification result of each step to the user', files: [], verification: [] },
  ];
  const text = [
    'PLAN FROM GEMINI (BINDING): execute in order; call consult for any deviation.',
    `[STUB: model=${model}, intent=${intent}; no real Gemini call was made]`,
    ...plan.flatMap((p, i) => [
      `${i + 1}. ${p.step}`,
      ...p.verification.map((v) => `   Verify: ${v}`),
    ]),
  ].join('\n');

  writeJson(lastConsultPath(), {
    schema: 2, status: 'complete',
    id: `c_${Date.now().toString(36)}`,
    ts: Date.now(),
    model_used: `stub-${model}`,
    intent,
    plan,
    text,
  });
  return { content: [{ type: 'text', text }] };
}

// If the client sent a progressToken, report progress every 15s. Some clients reset their tool-call timeout on
// progress; whether Antigravity does is unverified (it cancels calls at 180s otherwise).
async function withProgress(params, fn) {
  const token = params?._meta?.progressToken;
  let n = 0;
  const timer = token === undefined ? null : setInterval(() => send({ method: 'notifications/progress', params: { progressToken: token, progress: ++n, message: 'waiting for Gemini' } }), Number(process.env.AUNTY_PROGRESS_MS || 15000));
  try {
    return await fn();
  } finally {
    if (timer) clearInterval(timer);
  }
}

function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notification, e.g. notifications/initialized
  switch (method) {
    case 'initialize':
      return send({
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18', // echo the client's version
          capabilities: { tools: {} },
          serverInfo: { name: 'auntygravity-stub', version: '0.0.1' },
        },
      });
    case 'ping':
      return send({ id, result: {} });
    case 'tools/list':
      return send({ id, result: { tools: [TOOL] } });
    case 'tools/call':
      if (params?.name !== 'consult') {
        return send({ id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
      }
      return withProgress(params, () => consult(params.arguments)).then(
        (result) => send({ id, result }),
        (e) => send({ id, error: { code: -32603, message: String(e.message) } }),
      );
    default:
      return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch (e) {
    console.error('bad message:', e.message);
  }
});
