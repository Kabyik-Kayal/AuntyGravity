// Health check for an AuntyGravity setup. Pure checks plus an optional live ping of the Chrome extension.
// Prints nothing secret. Usage: node runtime/tools/aunty.mjs doctor [--ping] [--project <dir>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, pingExtension, tokenPath } from '../mcp/adapter/chrome-bridge.mjs';
import { findUp, hasLocalInstall, MARKER } from '../shared/optin.mjs';
import { KEY, binDir, configDir, status as hooksStatus } from './install.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const mcpEntryInUserConfig = () => {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(configDir(), 'mcp_config.json'), 'utf8'));
    return j?.mcpServers?.auntygravity ?? null;
  } catch {
    return null;
  }
};

export async function doctor({ ping = false, project } = {}) {
  const checks = [];
  const add = (id, ok, detail, fix, warn = false) => checks.push({ id, ok, ...(warn ? { warn: true } : {}), detail, ...(fix && (!ok || warn) ? { fix } : {}) });

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 18, `Node ${process.versions.node}`, 'Install Node 18 or newer.');

  const chrome = findChrome();
  add('chrome', Boolean(chrome), chrome ?? 'Chrome not found', 'Install Chrome, or set AUNTY_BROWSER_PATH to its executable.');

  const hasPluginFiles = fs.existsSync(path.join(repoRoot, 'plugin.json')) && fs.existsSync(path.join(repoRoot, 'mcp_config.json'));
  const manual = mcpEntryInUserConfig();
  add(
    'mcp-server',
    hasPluginFiles || Boolean(manual),
    hasPluginFiles ? `declared by the plugin at ${repoRoot}` : 'registered by hand in mcp_config.json',
    'Install the plugin, or add an "auntygravity" server entry to ~/.gemini/config/mcp_config.json.',
  );
  if (hasPluginFiles && manual) {
    add('mcp-duplicate', true, 'both the plugin and ~/.gemini/config/mcp_config.json define "auntygravity"', 'Remove the manual entry: server names are global and only one is kept.', true);
  }

  const hooks = hooksStatus();
  const shims = ['gate.mjs', 'record.mjs', 'inject-plan.mjs', 'stop-check.mjs'].every((f) => fs.existsSync(path.join(binDir(), f)));
  add('hooks', hooks.installed && shims, hooks.installed ? (shims ? `${KEY} installed in ${hooks.file}` : 'hooks.json entry present but shims are missing') : 'global hooks are not installed', 'Run: node runtime/tools/aunty.mjs install');

  add('token', fs.existsSync(tokenPath()), fs.existsSync(tokenPath()) ? 'pairing token exists' : 'no pairing token yet', 'Run: node runtime/tools/aunty.mjs token, then paste it in the extension options page.');

  if (ping) {
    try {
      const { state } = await pingExtension();
      const fix = {
        silent: 'Open Chrome with the AuntyGravity Bridge extension loaded (chrome://extensions, Developer mode, Load unpacked: the extension folder), and paste the pairing token in its options page.',
        'wrong-token': 'The extension has a different token saved. Run the token command again and paste the new one in the extension options.',
      }[state];
      add('extension', state === 'connected', state === 'connected' ? 'the Chrome extension answered' : `extension ${state}`, fix);
    } catch (e) {
      add('extension', false, e.message, 'Another consult may be running; retry in a minute.');
    }
  }

  if (project) {
    const dir = path.resolve(project);
    const marker = findUp(dir, MARKER);
    add('project', Boolean(marker), marker ? `enabled (marker at ${marker})` : `not enabled: ${dir}`, `Run: node runtime/tools/aunty.mjs enable "${dir}"`, !marker);
    if (hasLocalInstall(dir)) add('project-local-hooks', true, 'this project has its own .agents/hooks.json with the gate; the global hooks step aside', undefined, true);
    if (!fs.existsSync(path.join(dir, '.git'))) add('project-git', true, 'not a git repository: the Stop audit of shell-made changes is skipped', 'Run git init if you want that audit.', true);
  }

  return { ok: checks.every((c) => c.ok || c.warn), home: os.homedir(), pluginRoot: repoRoot, checks };
}
