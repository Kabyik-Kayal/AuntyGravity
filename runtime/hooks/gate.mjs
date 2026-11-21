// PreToolUse gate (fail-closed): only read-only tools and `consult` run until Gemini has planned.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapterPath, appendLog, isConsultCall, out, readJson, readStdinJson, sessionPath, spawnFlagPath } from '../shared/state.mjs';
import { allowedFromPlan, extractPaths, isAllowed, isFileMutatingTool, norm } from '../shared/plan-scope.mjs';
import { inactive } from '../shared/optin.mjs';

// Names are provisional: confirm against real transcripts (see state/tool-names.log). Override with AUNTY_READONLY_RE.
const READONLY = new RegExp(
  process.env.AUNTY_READONLY_RE ||
    '^(view_file|view_file_outline|view_code_item|list_dir|grep_search|find_by_name|read_url_content|search_web|read_.*|list_.*|search_.*)$',
);

const payload = readStdinJson();
if (inactive(payload)) {
  out({ decision: 'allow' });
  process.exit(0);
}
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
const PROTECTED = /(\.agents[\\/](hooks\.json|aunty\.enabled)|\.auntygravity|mcp_config\.json|[\\/]\.gemini[\\/]config)/i;

// The executor must not kill processes (observed: Flash ran Stop-Process on the consult MCP server mid-task).
const KILLS = /(stop-process|taskkill|\bkill(all)?\b|\bpkill\b|stop-service|wmic\s+process|\.terminate\(\))/i;
// Sub-agents and swarm workers run in their own conversations. It is unverified whether hooks reach them, so the
// spawn point itself is blocked. Tool names are inferred from Antigravity's swarm skill and may need extending.
const SPAWN = /^(swarm|swarm_wait|post_message|read_board)$|subagent|spawn|(start|create|launch|invoke)_?(sub)?_?agent/i;
const spawnAllowed = () => fs.existsSync(spawnFlagPath());

const killsProcess = (args) => KILLS.test(String(args?.CommandLine ?? args?.command ?? ''));
// With a global install the enforcement lives in the AuntyGravity checkout, outside the project being worked on, so
// the relative-name pattern above is not enough: also protect these directories by absolute path. The PoC's own
// dev workspace files (dev/workspace/*.txt) stay writable; only dev/workspace/.agents is protected.
const INSTALL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INSTALL_PROTECTED = ['runtime', 'extension', 'test', 'node_modules', 'dev/workspace/.agents'].map((d) => norm(path.join(INSTALL_ROOT, d)));
const slashes = (s) => (process.platform === 'win32' ? s.toLowerCase() : s).replace(/\\/g, '/');
const inInstall = (s) => INSTALL_PROTECTED.some((p) => slashes(s).includes(p));
const touchesProtected = (v) =>
  typeof v === 'string' ? PROTECTED.test(v) || inInstall(v) : v && typeof v === 'object' ? Object.values(v).some(touchesProtected) : false;

// The bridge pairing token must never reach the executor, even through read-only tools.
const touchesSecret = (v) =>
  typeof v === 'string' ? /ext-token/i.test(v) : v && typeof v === 'object' ? Object.values(v).some(touchesSecret) : false;

if (touchesSecret(payload.toolCall.args)) {
  decision = 'deny';
  reason = 'Blocked by AuntyGravity: the bridge pairing token is secret.';
} else if (killsProcess(payload.toolCall.args)) {
  decision = 'deny';
  reason = 'Blocked by AuntyGravity: stopping or killing processes is not permitted. If a tool such as consult misbehaves, report it to the user instead.';
} else if (SPAWN.test(name) && !spawnAllowed()) {
  decision = 'deny';
  reason = 'Blocked by AuntyGravity: sub-agents, swarms and workers are not permitted because their actions may bypass this gate. Do the work yourself under the Gemini plan.';
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
} else if (READONLY.test(name) && !touchesProtected(payload.toolCall.args)) {
  decision = 'allow';
} else if (touchesProtected(payload.toolCall.args)) {
  decision = 'deny';
  reason = 'Blocked by AuntyGravity: hook, state and MCP config files are protected and cannot be changed by the executor.';
} else if (session?.planned) {
  decision = 'allow';
  // Plan content: direct file-writing tools may only touch files the Gemini plan lists. Shell commands are
  // audited at Stop instead. Fail-closed: a file tool whose target cannot be determined is denied.
  if (isFileMutatingTool(name)) {
    const base = payload.cwd || payload.workspacePaths?.[0] || process.cwd();
    const targets = extractPaths(payload.toolCall.args);
    const allowed = allowedFromPlan(session.plan, base);
    const outside = targets.filter((t) => !isAllowed(t, allowed, base));
    if (!targets.length || outside.length) {
      decision = 'deny';
      reason = !targets.length
        ? 'Blocked by AuntyGravity: cannot tell which file this tool changes. Use a tool call whose target file is explicit, or call consult.'
        : `Blocked by AuntyGravity: ${outside.length === 1 ? 'this file is' : 'these files are'} outside the Gemini plan: ${outside.join(', ')}. ` +
          `The plan allows: ${allowed.length ? allowed.map((a) => a.abs + (a.dir ? '/' : '')).join(', ') : 'no files'}. ` +
          'If the change is needed, call consult for a revised plan that includes it.';
    }
  }
} else {
  decision = 'deny';
  reason =
    'Blocked by AuntyGravity: no Gemini plan exists for this session. ' +
    (session?.waiting
      ? "Gemini's answer is still pending. Call consult again with collect: true (same task and model) to fetch it. Do not resend the prompt."
      : 'Call the consult tool first (Gemini plans, you execute), then retry this action.');
}

// Tool name and argument KEY names (to verify tool schemas); never argument values.
const keys = payload.toolCall.args && typeof payload.toolCall.args === 'object' ? ` argKeys=${Object.keys(payload.toolCall.args).join(',')}` : '';
appendLog('gate.log', `${decision} ${name}${keys} conv=${String(payload.conversationId ?? '?').slice(0, 8)}`); // conversation id prefix shows whether sub-agents reach the hooks
out(reason ? { decision, reason } : { decision });
