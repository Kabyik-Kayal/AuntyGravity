// PreToolUse gate (fail-closed): only read-only tools and `consult` run until Gemini has planned.
import { appendLog, out, readJson, readStdinJson, sessionPath } from '../../../shared/state.mjs';

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

if (/consult/i.test(name)) {
  decision = 'allow';
} else if (READONLY.test(name)) {
  decision = 'allow';
} else if (session?.planned) {
  decision = 'allow';
} else {
  decision = 'deny';
  reason =
    'Blocked by AuntyGravity: no Gemini plan exists for this session. ' +
    'Call the consult tool first (Gemini plans, you execute), then retry this action.';
}

appendLog('gate.log', `${decision} ${name}`); // tool name only, never arguments
out(reason ? { decision, reason } : { decision });
