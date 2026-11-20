// Stop: once per user turn, stop the agent finishing before it reports on the plan steps.
import { out, readJson, readStdinJson, sessionPath } from '../../../shared/state.mjs';

const payload = readStdinJson();
const s = readJson(sessionPath(payload?.conversationId), {});

if (s.planned && !payload?.continuationActive) {
  out({
    decision: 'continue',
    reason: 'Before finishing, state for each step of the Gemini plan whether it was executed and what its verification showed. If any step is unfinished, finish it or call consult.',
  });
} else {
  out({ decision: 'allow' });
}
