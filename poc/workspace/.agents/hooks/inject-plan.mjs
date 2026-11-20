// PreInvocation: inject the Gemini plan as binding instructions (once per plan, since systemMessage persists),
// remind an unplanned session once, and halt the run if the last consult failed.
import { out, readJson, readStdinJson, sessionPath, writeJson } from '../../../shared/state.mjs';

const sys = (systemMessage) => ({ systemMessage: { systemMessage } });
const payload = readStdinJson();
const file = sessionPath(payload?.conversationId);
const s = readJson(file, {});

if (s.failed) {
  out({
    injectSteps: [
      { errorMessage: { userMessage: `AuntyGravity: Gemini consult failed (${s.failReason}). Stopping instead of improvising.` } },
    ],
    terminationBehavior: 'terminate',
  });
} else if (s.planned && s.injectedConsultId !== s.consultId) {
  writeJson(file, { ...s, injectedConsultId: s.consultId });
  out({
    injectSteps: [
      sys(
        `${s.planText}\n\nThe plan above is binding. Execute only these steps, in order. ` +
          'Do not add, skip, reorder or redesign steps. If a step is impossible or a decision is missing, call consult instead of deciding yourself.',
      ),
    ],
  });
} else if (!s.planned && !s.reminded) {
  writeJson(file, { ...s, reminded: true });
  out({
    injectSteps: [
      sys('You are the executor; Gemini plans. Before any edit or command, call the consult tool. State-changing tools are blocked until you do.'),
    ],
  });
} else {
  out({});
}
