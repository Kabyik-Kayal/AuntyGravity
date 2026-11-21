// Single entry point used by the /setup-auntygravity skill and by people.
//   doctor [--ping] [--project <dir>]   check the setup (--ping also tests the Chrome extension, ~12 s)
//   install [--dry-run] | uninstall     global hooks in ~/.gemini/config/hooks.json (opt-in, inert until a project is enabled)
//   enable <dir> [--exclude]            opt a project in (--exclude keeps the marker out of git)
//   disable <dir> | status <dir>
//   token                               create the pairing token and copy it to the clipboard
//   smoke [neon|hydrogen]               one harmless synthetic consult through Chrome to Gemini
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctor } from './doctor.mjs';
import { disable, enable, status } from './enable.mjs';
import { install, uninstall } from './install.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [cmd, ...rest] = process.argv.slice(2);
const flag = (f) => rest.includes(f);
const value = (f) => (rest.includes(f) ? rest[rest.indexOf(f) + 1] : undefined);
const positional = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--project');
const print = (o) => console.log(JSON.stringify(o, null, 2));

try {
  switch (cmd) {
    case 'doctor':
      print(await doctor({ ping: flag('--ping'), project: value('--project') }));
      break;
    case 'install':
      print(install({ dryRun: flag('--dry-run') }));
      break;
    case 'uninstall':
      print(uninstall());
      break;
    case 'enable':
      if (!positional[0]) throw new Error('usage: aunty.mjs enable <dir> [--exclude]');
      print(enable(positional[0], { exclude: flag('--exclude') }));
      break;
    case 'disable':
      if (!positional[0]) throw new Error('usage: aunty.mjs disable <dir>');
      print(disable(positional[0]));
      break;
    case 'status':
      if (!positional[0]) throw new Error('usage: aunty.mjs status <dir>');
      print(status(positional[0]));
      break;
    case 'token':
      process.exitCode = spawnSync(process.execPath, [path.join(here, 'token.mjs')], { stdio: 'inherit' }).status ?? 1;
      break;
    case 'smoke':
      process.exitCode = spawnSync(process.execPath, [path.join(here, 'probe.mjs'), positional[0] || 'neon', '--launch'], { stdio: 'inherit' }).status ?? 1;
      break;
    default:
      throw new Error('usage: aunty.mjs doctor|install|uninstall|enable|disable|status|token|smoke ...');
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
