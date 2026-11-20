// Fake adapter for interface-level tests (AUNTY_ADAPTER=fake). Behavior is chosen by AUNTY_FAKE_MODE.
import { ConsultError } from './errors.mjs';

const PLAN = {
  summary: 'Create the output file.',
  recommendation: 'Do it directly.',
  plan: [{ step: 'Create fake-output.txt containing "ok"', files: ['fake-output.txt'], verification: ['Read fake-output.txt'] }],
  assumptions: ['Workspace is writable'],
  open_questions: [],
  risks: [],
};

export async function ask({ model }) {
  const mode = process.env.AUNTY_FAKE_MODE || 'ok';
  if (mode === 'signin') throw new ConsultError('NEEDS_SIGN_IN', 'Signed out.');
  if (mode === 'unavailable') throw new ConsultError('MODEL_UNAVAILABLE', `${model} unavailable.`);
  if (mode === 'prose') return { text: 'Sure! Here is my advice in plain words.', modelUsed: model };
  if (mode === 'crash') throw new Error('boom');
  if (mode === 'slow') await new Promise((r) => setTimeout(r, 400));
  return { text: `Here you go:\n\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\``, modelUsed: model };
}
