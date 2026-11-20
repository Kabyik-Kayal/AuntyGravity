// Stop: once per user turn, stop the agent finishing before it reports on the plan steps.
import { appendLog, out, readJson, readStdinJson, sessionPath, writeJson } from '../../../shared/state.mjs';

const payload = readStdinJson();
appendLog('stop.log', JSON.stringify(payload));
const file = sessionPath(payload?.conversationId);
const s = readJson(file, {});

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
