// Builds the explicit prompt sent to Gemini and parses its answer. Pure functions, no I/O.
import { ConsultError } from './errors.mjs';

export const MAX_PROMPT_CHARS = 12000;

export function buildPrompt({ intent = 'plan', task, context = [], constraints = [], acceptance_criteria = [] }) {
  const list = (title, items) => (items.length ? [`${title}:`, ...items.map((x) => `- ${x}`), ''] : []);
  const ctx = context.flatMap((c) => [`[${c.label}]`, c.text, '']);
  const prompt = [
    `You are the planner for a coding agent. Intent: ${intent}.`,
    'The agent will execute exactly the steps you give, so be concrete and ordered.',
    'Do not include hidden reasoning. Give a concise rationale only.',
    '',
    `Task: ${task}`,
    '',
    ...(ctx.length ? ['Context:', ...ctx] : []),
    ...list('Constraints', constraints),
    ...list('Acceptance criteria', acceptance_criteria),
    'Reply with ONE fenced ```json block and nothing after it, with exactly these keys:',
    '{"summary": string, "recommendation": string,',
    ' "plan": [{"step": string, "verification": [string]}],',
    ' "assumptions": [string], "open_questions": [string], "risks": [string]}',
  ].join('\n');
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new ConsultError('INVALID_INPUT', `prompt exceeds ${MAX_PROMPT_CHARS} characters; send less context`);
  }
  return prompt;
}

const strArr = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

function candidates(text) {
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) blocks.push(text.slice(a, b + 1));
  return blocks.reverse(); // prefer the last fenced block
}

// Throws UNSTRUCTURED_RESPONSE unless the answer contains a valid plan object.
export function parseResponse(text) {
  for (const c of candidates(String(text ?? ''))) {
    let j;
    try {
      j = JSON.parse(c);
    } catch {
      continue;
    }
    const planOk =
      Array.isArray(j?.plan) &&
      j.plan.length > 0 &&
      j.plan.every((p) => typeof p?.step === 'string' && p.step.trim() && (p.verification === undefined || strArr(p.verification)));
    if (!planOk) continue;
    return {
      summary: typeof j.summary === 'string' ? j.summary : '',
      recommendation: typeof j.recommendation === 'string' ? j.recommendation : '',
      plan: j.plan.map((p) => ({ step: p.step.trim(), verification: p.verification ?? [] })),
      assumptions: strArr(j.assumptions) ? j.assumptions : [],
      open_questions: strArr(j.open_questions) ? j.open_questions : [],
      risks: strArr(j.risks) ? j.risks : [],
    };
  }
  throw new ConsultError('UNSTRUCTURED_RESPONSE', 'Gemini did not return a valid plan block; response was not used.');
}

// The text the executor sees. Fixed header so the binding instruction is unmistakable.
export function renderResult(parsed, { modelUsed, intent }) {
  const bullets = (t, a) => (a.length ? ['', `${t}:`, ...a.map((x) => `- ${x}`)] : []);
  return [
    'PLAN FROM GEMINI (BINDING): execute in order; call consult for any deviation.',
    `[model=${modelUsed}, intent=${intent}]`,
    ...(parsed.summary ? ['', `Summary: ${parsed.summary}`] : []),
    ...(parsed.recommendation ? [`Recommendation: ${parsed.recommendation}`] : []),
    '',
    ...parsed.plan.flatMap((p, i) => [`${i + 1}. ${p.step}`, ...p.verification.map((v) => `   Verify: ${v}`)]),
    ...bullets('Assumptions', parsed.assumptions),
    ...bullets('Open questions', parsed.open_questions),
    ...bullets('Risks', parsed.risks),
  ].join('\n');
}
