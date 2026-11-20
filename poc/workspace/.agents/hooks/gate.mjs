// PreToolUse gate (fail-closed): only read-only tools and `consult` run until Gemini has planned.
import { adapterPath, appendLog, isConsultCall, out, readJson, readStdinJson, sessionPath } from '../../../shared/state.mjs';

// Names are provisional: confirm against real transcripts (see state/tool-names.log). Override with AUNTY_READONLY_RE.
const READONLY = new RegExp(
  process.env.AUNTY_READONLY_RE ||
    '^(view_file|view_file_outline|view_code_item|list_dir|grep_search|find_by_name|read_url_content|search_web|read_.*|list_.*|search_.*)$',
);

const payload = readStdinJson();
if (!payload?.toolCall?.name) {
  out({ decision: 'deny', reason: 'AuntyGravity gate: unreadable hook payload, failing closed.' });
  process.exit(0);
}

const name = String(payload.toolCall.name);
const session = readJson(sessionPath(payload.conversationId));
let decision;
let reason;

// The executor must not edit the enforcement itself (observed: Flash rewrote stop-check.mjs mid-run).
// Best effort: scans string arguments of non-read-only tools. Pair with a permissions deny rule for real protection.
const PROTECTED = /(\.agents[\\/]|poc[\\/]shared[\\/]|\.auntygravity|mcp_config\.json|[\\/]\.gemini[\\/]config)/i;
const touchesProtected = (v) =>
  typeof v === 'string' ? PROTECTED.test(v) : v && typeof v === 'object' ? Object.values(v).some(touchesProtected) : false;

// The bridge pairing token must never reach the executor, even through read-only tools.
const touchesSecret = (v) =>
  typeof v === 'string' ? /ext-token/i.test(v) : v && typeof v === 'object' ? Object.values(v).some(touchesSecret) : false;

if (touchesSecret(payload.toolCall.args)) {
  decision = 'deny';
  reason = 'Blocked by AuntyGravity: the bridge pairing token is secret.';
} else if (isConsultCall(payload.toolCall)) {
  // The user opted out of per-call approval for the chrome adapter (Turbo workflow). Note the trade-off: the consult
  // task and context go to Gemini webchat without a prompt. Fail-closed: an unknown or missing adapter state still asks.
  const adapter = readJson(adapterPath())?.adapter;
  if (adapter === 'stub' || adapter === 'fake' || adapter === 'chrome') {
    decision = 'allow';
  } else {
    decision = 'force_ask';
    reason = 'AuntyGravity will send this consult (task and context) to the Gemini webchat. Google may retain or human-review it. Approve only if it contains nothing confidential.';
  }
} else if (READONLY.test(name)) {
  decision = 'allow';
} else if (touchesProtected(payload.toolCall.args)) {
  decision = 'deny';
  reason = 'Blocked by AuntyGravity: hook, state and MCP config files are protected and cannot be changed by the executor.';
} else if (session?.planned) {
  decision = 'allow';
} else {
  decision = 'deny';
  reason =
    'Blocked by AuntyGravity: no Gemini plan exists for this session. ' +
    'Call the consult tool first (Gemini plans, you execute), then retry this action.';
}

// Tool name (and arg KEY names for the MCP wrapper, to verify the schema); never argument values.
const keys = name === 'call_mcp_tool' ? ` argKeys=${Object.keys(payload.toolCall.args ?? {}).join(',')}` : '';
appendLog('gate.log', `${decision} ${name}${keys}`);
out(reason ? { decision, reason } : { decision });
