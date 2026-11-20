// Simulates Antigravity: drives the stub MCP server over stdio and feeds hook payloads to the hook scripts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hooksDir = path.join(root, 'workspace', '.agents', 'hooks');
const server = path.join(root, 'mcp', 'server.mjs');

const freshEnv = () => ({
  ...process.env,
  AUNTY_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'aunty-')),
});

function hook(name, payload, env, raw) {
  const r = spawnSync('node', [path.join(hooksDir, name)], {
    input: raw ?? JSON.stringify(payload),
    env,
    encoding: 'utf8',
    cwd: hooksDir,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

// Minimal MCP client: one request, one response.
function mcp(env, calls) {
  return new Promise((resolve, reject) => {
    const p = spawn('node', [server], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    const responses = new Map();
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        responses.set(m.id, m);
        if (responses.size === calls.length) {
          p.kill();
          resolve([...responses.values()]);
        }
      }
    });
    p.on('error', reject);
    calls.forEach((c, i) => p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: i + 1, ...c })}\n`));
  });
}

const init = { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
const call = (args) => ({ method: 'tools/call', params: { name: 'consult', arguments: args } });
const tool = (name, conversationId = 'c1', extra = {}) => ({ toolCall: { id: 't', name, args: {} }, conversationId, ...extra });

test('MCP: handshake, tools/list, valid consult, invalid consult', async () => {
  const env = freshEnv();
  const [a, b, c, d] = await mcp(env, [init, { method: 'tools/list' }, call({ task: 'do a thing' }), call({ task: '' })]);
  assert.equal(a.result.protocolVersion, '2025-06-18');
  assert.deepEqual(b.result.tools.map((t) => t.name), ['consult']);
  assert.match(c.result.content[0].text, /^PLAN FROM GEMINI \(BINDING\)/);
  assert.equal(c.result.isError, undefined);
  assert.equal(d.result.isError, true);
  const last = JSON.parse(fs.readFileSync(path.join(env.AUNTY_STATE_DIR, 'last_consult.json'), 'utf8'));
  assert.equal(last.status, 'error');
});

test('gate: denies mutating tools before consult, allows read-only and consult', () => {
  const env = freshEnv();
  assert.equal(hook('gate.mjs', tool('run_command'), env).decision, 'deny');
  assert.equal(hook('gate.mjs', tool('write_to_file'), env).decision, 'deny');
  assert.equal(hook('gate.mjs', tool('some_unknown_tool'), env).decision, 'deny'); // fail closed
  assert.equal(hook('gate.mjs', tool('view_file'), env).decision, 'allow');
  assert.equal(hook('gate.mjs', tool('mcp_auntygravity_consult'), env).decision, 'allow');
  assert.match(hook('gate.mjs', tool('run_command'), env).reason, /consult/);
});

test('gate: Antigravity call_mcp_tool wrapper is matched on exact server and tool', async () => {
  const env = freshEnv();
  const mcpCall = (ServerName, ToolName) => ({
    toolCall: { id: 't', name: 'call_mcp_tool', args: { ServerName, ToolName } },
    conversationId: 'c1',
  });
  assert.equal(hook('gate.mjs', mcpCall('auntygravity', 'consult'), env).decision, 'allow');
  assert.equal(hook('gate.mjs', mcpCall('rea', 'consult'), env).decision, 'deny'); // other server, same tool name
  assert.equal(hook('gate.mjs', mcpCall('auntygravity', 'other'), env).decision, 'deny');
  assert.equal(hook('gate.mjs', { toolCall: { id: 't', name: 'call_mcp_tool', args: {} }, conversationId: 'c1' }, env).decision, 'deny');

  await mcp(env, [init, call({ task: 'x' })]);
  hook('record.mjs', mcpCall('rea', 'consult'), env); // must not unlock
  assert.equal(hook('gate.mjs', tool('run_command'), env).decision, 'deny');
  hook('record.mjs', mcpCall('auntygravity', 'consult'), env);
  assert.equal(hook('gate.mjs', tool('run_command'), env).decision, 'allow');
});

test('gate: even after planning, edits to hooks, state and MCP config are denied', async () => {
  const env = freshEnv();
  await mcp(env, [init, call({ task: 'x' })]);
  hook('record.mjs', tool('mcp_auntygravity_consult', 'c1'), env);
  const withArgs = (name, args) => ({ toolCall: { id: 't', name, args }, conversationId: 'c1' });
  assert.equal(hook('gate.mjs', withArgs('write_file', { TargetFile: 'poc-output.txt' }), env).decision, 'allow');
  for (const args of [
    { TargetFile: 'M:\\x\\poc\\workspace\\.agents\\hooks\\gate.mjs' },
    { TargetFile: 'poc/shared/state.mjs' },
    { CommandLine: 'del C:\\Users\\u\\.gemini\\config\\mcp_config.json' },
    { Edits: [{ file: 'poc/workspace/.agents/hooks.json' }] },
  ]) {
    assert.equal(hook('gate.mjs', withArgs('edit_file', args), env).decision, 'deny', JSON.stringify(args));
  }
  assert.equal(hook('gate.mjs', withArgs('read_file', { AbsolutePath: 'poc/workspace/.agents/hooks.json' }), env).decision, 'allow');
});

test('gate: unreadable payload fails closed', () => {
  assert.equal(hook('gate.mjs', null, freshEnv(), 'not json').decision, 'deny');
});

test('end to end: consult unlocks mutating tools for that conversation only', async () => {
  const env = freshEnv();
  await mcp(env, [init, call({ task: 'build it' })]);
  hook('record.mjs', tool('mcp_auntygravity_consult', 'c1'), env);
  assert.equal(hook('gate.mjs', tool('run_command', 'c1'), env).decision, 'allow');
  assert.equal(hook('gate.mjs', tool('run_command', 'c2'), env).decision, 'deny');
});

test('record: a failed consult does not unlock, and PreInvocation halts the run', async () => {
  const env = freshEnv();
  await mcp(env, [init, call({ task: '' })]);
  hook('record.mjs', tool('mcp_auntygravity_consult', 'c1'), env);
  assert.equal(hook('gate.mjs', tool('run_command', 'c1'), env).decision, 'deny');
  const r = hook('inject-plan.mjs', { conversationId: 'c1' }, env);
  assert.equal(r.terminationBehavior, 'terminate');
  assert.ok(r.injectSteps[0].errorMessage.userMessage);
});

test('record: a tool error does not unlock even with a fresh complete result', async () => {
  const env = freshEnv();
  await mcp(env, [init, call({ task: 'ok' })]);
  hook('record.mjs', tool('mcp_auntygravity_consult', 'c1', { error: 'timeout' }), env);
  assert.equal(hook('gate.mjs', tool('run_command', 'c1'), env).decision, 'deny');
});

test('inject-plan: reminds once when unplanned, injects the plan once when planned', async () => {
  const env = freshEnv();
  const first = hook('inject-plan.mjs', { conversationId: 'c1' }, env);
  assert.match(first.injectSteps[0].systemMessage.systemMessage, /call the consult tool/);
  assert.deepEqual(hook('inject-plan.mjs', { conversationId: 'c1' }, env), {});

  await mcp(env, [init, call({ task: 'x' })]);
  hook('record.mjs', tool('mcp_auntygravity_consult', 'c1'), env);
  const planned = hook('inject-plan.mjs', { conversationId: 'c1' }, env);
  assert.match(planned.injectSteps[0].systemMessage.systemMessage, /PLAN FROM GEMINI \(BINDING\)/);
  assert.deepEqual(hook('inject-plan.mjs', { conversationId: 'c1' }, env), {}); // no repeat injection
});

test('stop-check: forces one report-back after planning, never loops, ignores unplanned sessions', async () => {
  const env = freshEnv();
  assert.equal(hook('stop-check.mjs', { conversationId: 'c1' }, env).decision, 'allow');
  await mcp(env, [init, call({ task: 'x' })]);
  hook('record.mjs', tool('mcp_auntygravity_consult', 'c1'), env);
  assert.equal(hook('stop-check.mjs', { conversationId: 'c1', continuationActive: false }, env).decision, 'continue');
  assert.equal(hook('stop-check.mjs', { conversationId: 'c1', continuationActive: true }, env).decision, 'allow');
});
