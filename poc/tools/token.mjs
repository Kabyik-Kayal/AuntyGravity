// Prints the pairing token path and copies the token to the clipboard (Windows `clip`) for pasting into the extension options.
import { spawnSync } from 'node:child_process';
import { getToken, tokenPath } from '../mcp/adapter/chrome-bridge.mjs';

const token = getToken();
if (process.platform === 'win32') spawnSync('clip', { input: token });
console.log(`Token file: ${tokenPath()}`);
console.log(process.platform === 'win32' ? 'The token is on your clipboard. Paste it in the extension options page.' : 'Open the file and paste its contents into the extension options page.');
