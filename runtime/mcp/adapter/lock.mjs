// One active consultation at a time, so conversations never mix. Stale locks (dead pid or too old) are replaced.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConsultError } from './errors.mjs';

export const home = () => path.join(os.homedir(), '.auntygravity');
const lockFile = () => process.env.AUNTY_LOCK_FILE || path.join(home(), 'consult.lock');

export function acquireLock(maxAgeMs = 15 * 60 * 1000) {
  const file = lockFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const take = () => fs.writeFileSync(file, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' });
  try {
    take();
  } catch {
    let stale = true;
    try {
      const l = JSON.parse(fs.readFileSync(file, 'utf8'));
      let alive = true;
      try {
        process.kill(l.pid, 0);
      } catch {
        alive = false;
      }
      stale = !alive || Date.now() - l.ts > maxAgeMs;
    } catch {
      /* unreadable lock counts as stale */
    }
    if (!stale) throw new ConsultError('BUSY', 'Another consultation is already running; not starting a second one.');
    fs.rmSync(file, { force: true });
    take();
  }
  return () => fs.rmSync(file, { force: true });
}
