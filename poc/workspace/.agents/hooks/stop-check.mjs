// Stop: (1) audit that files changed since the plan are all inside the plan; (2) once per user turn, make the agent
// report on the plan steps before finishing.
import { appendLog, out, readJson, readStdinJson, sessionPath, writeJson } from '../../../shared/state.mjs';
import { allowedFromPlan, isAllowed } from '../../../shared/plan-scope.mjs';
import { changedSince } from '../../../shared/audit.mjs';

const MAX_AUDIT_ROUNDS = 3;
const payload = readStdinJson();
// Control fields only, never the user's prompt or other content.
appendLog('stop.log', JSON.stringify({ executionNum: payload?.executionNum, continuationActive: payload?.continuationActive, terminationReason: payload?.terminationReason }));
const file = sessionPath(payload?.conversationId);
const s = readJson(file, {});

if (s.planned && s.baseline && (s.auditRounds ?? 0) < MAX_AUDIT_ROUNDS) {
  const base = s.cwd || payload?.cwd;
  const allowed = allowedFromPlan(s.plan, base);
  const changed = changedSince(s.baseline, base);
  const outside = (changed ?? []).filter((p) => !isAllowed(p, allowed, base));
  if (outside.length) {
    writeJson(file, { ...s, auditRounds: (s.auditRounds ?? 0) + 1 });
    appendLog('gate.log', `audit outside-plan=${outside.length}`);
    out({
      decision: 'continue',
      reason:
        `Files were changed outside the Gemini plan: ${outside.join(', ')}. ` +
        'Revert those changes, or call consult for a revised plan that covers them, then finish.',
    });
    process.exit(0);
  }
}

// Gemini's answer is still pending: do not let the agent finish with nothing done; send it back to collect.
if (s.waiting && (s.stopWaitRounds ?? 0) < 3) {
  writeJson(file, { ...s, stopWaitRounds: (s.stopWaitRounds ?? 0) + 1 });
  out({
    decision: 'continue',
    reason: "Gemini's answer is still pending. Call consult again with collect: true (same task and model) to fetch it, then follow the plan. Do not resend the prompt.",
  });
  process.exit(0);
}

const isContinuation = Boolean(
  payload?.continuationActive ||
  (typeof payload?.executionNum === 'number' && payload?.executionNum > 0) ||
  s.stopChecked
);

if (s.planned && !isContinuation) {
  writeJson(file, { ...s, stopChecked: true });
  out({
    decision: 'continue',
    reason: 'Before finishing, state for each step of the Gemini plan whether it was executed and what its verification showed. If any step is unfinished, finish it or call consult.',
  });
} else {
  out({ decision: 'allow' });
}
