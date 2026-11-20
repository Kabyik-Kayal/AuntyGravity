// Live probe: sends ONE synthetic, non-sensitive consult through the Bridge extension and prints the outcome.
// Usage: node poc/tools/probe.mjs [neon|hydrogen]
import { ask } from '../mcp/adapter/chrome-bridge.mjs';
import { buildPrompt, parseResponse, renderResult } from '../mcp/adapter/prompt.mjs';

const model = process.argv[2] || 'neon';
const prompt = buildPrompt({
  intent: 'plan',
  task: 'Synthetic connectivity test, no real project. Plan how to create a file named hello.txt containing the word hi.',
  acceptance_criteria: ['hello.txt exists and contains exactly: hi'],
});

try {
  const { text, modelUsed } = await ask({ prompt, model }, { launch: false, connectMs: 45000 });
  console.log(`ANSWER RECEIVED (model=${modelUsed}, ${text.length} chars)`);
  try {
    console.log(renderResult(parseResponse(text), { modelUsed, intent: 'plan' }));
  } catch (e) {
    console.log(`PARSE FAILED: ${e.code}\n--- raw answer ---\n${text.slice(0, 1500)}`);
  }
} catch (e) {
  console.log(`FAILED: ${e.code}: ${e.message}`);
  process.exitCode = 1;
}
