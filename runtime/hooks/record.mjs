// PostToolUse on consult: mark this conversation as planned, waiting (answer pending) or failed,
// from the server-written result.
import { appendLog, isConsultCall, lastConsultPath, out, readJson, readStdinJson, sessionPath, writeJson } from '../shared/state.mjs';
import { snapshot } from '../shared/audit.mjs';
import { inactive } from '../shared/optin.mjs';

const FRESH_MS = 10 * 60 * 1000;
const MAX_PENDING_ROUNDS = 4; // consecutive PENDING replies before giving up (each collect waits ~2 minutes)
const payload = readStdinJson();
if (inactive(payload)) {
  out({});
  process.exit(0);
}

if (payload?.toolCall?.name && isConsultCall(payload.toolCall)) {
  const last = readJson(lastConsultPath());
  const fresh = last && Date.now() - last.ts < FRESH_MS;
  // Schema 2 = plans carry per-step `files`. An older running MCP server returns plans the gate cannot scope.
  // Only a FRESH result can be judged outdated; a stale file from an earlier call says nothing about this one.
  const outdated = Boolean(fresh && last.status === 'complete' && last.schema !== 2);
  const ok = !payload.error && fresh && last.status === 'complete' && !outdated;
  // "waiting": the prompt was sent once and Gemini is still answering. Not a failure; Flash must collect, not act.
  const prev = readJson(sessionPath(payload.conversationId), {});
  const pending = Boolean(!payload.error && fresh && last.status === 'waiting' && last.schema === 2);
  const rounds = pending ? (prev.pendingRounds ?? 0) + 1 : 0;
  const gaveUp = pending && rounds > MAX_PENDING_ROUNDS;
  const waiting = pending && !gaveUp;
  const failed = !ok && !waiting;

  writeJson(sessionPath(payload.conversationId), {
    ...prev,
    planned: ok,
    waiting,
    pendingRounds: rounds,
    failed,
    failReason: !failed
      ? null
      : gaveUp
        ? `Gemini did not finish after ${MAX_PENDING_ROUNDS} collection attempts; the prompt was not resent. Check the Gemini tab`
        : outdated
          ? 'the running auntygravity MCP server is outdated (plan has no file scope). Restart Antigravity or toggle the auntygravity MCP server, then retry'
          : payload.error
            ? `the consult call returned an error (${String(payload.error).slice(0, 200)}); Gemini may still be answering in its browser tab, so the prompt was not resent`
            : last?.status === 'pending'
              ? 'the consult call did not return in time (Antigravity cancels MCP calls after about 180s); Gemini may still be answering in its browser tab'
              : last?.reason || last?.code || 'stale or missing consult result',
    consultId: ok ? last.id : null,
    plan: ok ? last.plan : null,
    // Baseline for the Stop audit: files already dirty now are not blamed on this plan.
    cwd: payload.cwd ?? null,
    baseline: ok ? snapshot(payload.cwd) : null,
    auditRounds: 0,
    planText: ok ? last.text : null,
    injectedConsultId: ok && prev.injectedConsultId === last.id ? prev.injectedConsultId : null,
    ts: Date.now(),
  });
  appendLog('gate.log', `record ${ok ? 'planned' : waiting ? `waiting round=${rounds}` : 'failed'} ${payload.toolCall.name}`);
}
out({});
