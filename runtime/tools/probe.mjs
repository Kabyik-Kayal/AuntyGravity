// Live probe: sends ONE synthetic, non-sensitive consult through the Bridge extension and prints the outcome.
// Usage: node runtime/tools/probe.mjs [neon|hydrogen] [--wait SECONDS] [--launch]   (--launch starts your default Chrome if the extension is not connected)
// With --wait, the first call waits only that long for the answer, so a slow answer exercises PENDING and then
// collect (each collect also waits that long, up to 6 tries). The prompt is sent exactly once.
import { ask } from '../mcp/adapter/chrome-bridge.mjs';
import { buildPrompt, parseResponse, renderResult } from '../mcp/adapter/prompt.mjs';

const args = process.argv.slice(2);
const model = args.find((a) => /^(neon|hydrogen)$/.test(a)) || 'neon';
const wi = args.indexOf('--wait');
const waitMs = wi >= 0 ? Number(args[wi + 1]) * 1000 : undefined;
const opts = { launch: args.includes('--launch'), launchAfterMs: 3000, connectMs: 60000, ...(waitMs ? { waitMs } : {}) };

const prompt = buildPrompt({
  intent: 'plan',
  task: 'Synthetic connectivity test, no real project. Plan how to create a file named hello.txt containing the word hi.',
  acceptance_criteria: ['hello.txt exists and contains exactly: hi'],
});

const show = (text, modelUsed) => {
  console.log(`ANSWER RECEIVED (model=${modelUsed}, ${text.length} chars)`);
  try {
    console.log(renderResult(parseResponse(text), { modelUsed, intent: 'plan' }));
  } catch (e) {
    console.log(`PARSE FAILED: ${e.code}\n--- raw answer ---\n${text.slice(0, 1500)}`);
  }
};

const t0 = Date.now();
const secs = () => `${Math.round((Date.now() - t0) / 1000)}s`;
try {
  let r;
  try {
    r = await ask({ prompt, model }, opts);
    console.log(`first call returned an answer after ${secs()}`);
  } catch (e) {
    if (e.code !== 'GENERATION_PENDING') throw e;
    console.log(`[${secs()}] PENDING: ${e.message.slice(0, 160)}`);
    for (let i = 1; i <= 6 && !r; i++) {
      try {
        r = await ask({ model, collect: true }, opts);
        console.log(`[${secs()}] collect #${i} returned the answer`);
      } catch (e2) {
        if (e2.code !== 'GENERATION_PENDING') throw e2;
        console.log(`[${secs()}] collect #${i}: still pending`);
      }
    }
    if (!r) throw new Error('still pending after 6 collects');
  }
  show(r.text, r.modelUsed);
} catch (e) {
  console.log(`FAILED after ${secs()}: ${e.code || ''} ${e.message}`);
  process.exitCode = 1;
}
