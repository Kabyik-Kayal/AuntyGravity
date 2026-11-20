// PostToolUse on consult: mark this conversation as planned (or failed) from the server-written result.
import { appendLog, lastConsultPath, out, readJson, readStdinJson, sessionPath, writeJson } from '../../../shared/state.mjs';

const FRESH_MS = 10 * 60 * 1000;
const payload = readStdinJson();

if (payload?.toolCall?.name && /consult/i.test(payload.toolCall.name)) {
  const last = readJson(lastConsultPath());
  const fresh = last && Date.now() - last.ts < FRESH_MS;
  const ok = !payload.error && fresh && last.status === 'complete';
  const prev = readJson(sessionPath(payload.conversationId), {});

  writeJson(sessionPath(payload.conversationId), {
    ...prev,
    planned: ok,
    failed: !ok,
    failReason: ok ? null : payload.error || last?.reason || last?.code || 'stale or missing consult result',
    consultId: ok ? last.id : null,
    plan: ok ? last.plan : null,
    planText: ok ? last.text : null,
    injectedConsultId: ok && prev.injectedConsultId === last.id ? prev.injectedConsultId : null,
    ts: Date.now(),
  });
  appendLog('gate.log', `record ${ok ? 'planned' : 'failed'} ${payload.toolCall.name}`);
}
out({});
