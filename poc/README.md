# AuntyGravity hook-enforcement PoC

Proves that Antigravity lifecycle hooks can force "consult Gemini before acting" using a **stub** `consult` tool.
It makes no Gemini calls and touches no browser. Design: `docs/architecture/enforcement-design.md`.

## Layout

- `mcp/server.mjs`: zero-dependency stdio MCP server exposing `consult` (returns a fixed plan).
- `workspace/`: throwaway workspace. `AGENTS.md` (advisory protocol) and `.agents/hooks.json` plus `hooks/*.mjs` (enforcement).
- `shared/state.mjs`: state helpers. State goes to `~/.auntygravity/state` (override with `AUNTY_STATE_DIR`), outside the repo.
- `mcp/adapter/`: prompt building and strict response parsing, typed errors, lock, fake adapter, and `chrome-bridge.mjs` (loopback bridge to the extension).
- `extension/`: Chrome MV3 extension (service worker, Gemini content script, options page).
- `test/`: `poc.test.mjs` (server and hooks), `adapter.test.mjs` (prompt, parse, fake adapter), `bridge.test.mjs` (bridge protocol, manifest, content script on a fixture page).

## Run the simulated tests

```bash
cd poc && npm install && npm test
```

## Try it in Antigravity (manual, not done by the tests)

1. Register the server. Add this to the `mcpServers` map in `~/.gemini/config/mcp_config.json` (global, so back it up first), using the absolute path to `poc/mcp/server.mjs`:

   ```json
   "auntygravity": { "command": "node", "args": ["M:\\Git-Hub Projects\\AuntyGravity\\poc\\mcp\\server.mjs"] }
   ```

2. Start Antigravity with `poc/workspace` as the working directory. Hooks load from `workspace/.agents/hooks.json`.
3. Ask it to do anything that edits a file, for example "create hello.txt". Expected:
   - A direct `write` or `run_command` attempt is denied with the "Call the consult tool first" reason.
   - The agent calls `consult`, then follows the injected plan and creates `poc-output.txt`.
   - Before finishing, the Stop hook makes it report on each step.
4. Inspect `~/.auntygravity/state/gate.log`. It lists real tool names and the allow or deny decisions. Use it to fix the provisional read-only allowlist in `gate.mjs` and the `consult` matcher in `hooks.json`.

Verified in a live run: hooks fire, `deny` is honored under Turbo, MCP tools arrive as `call_mcp_tool` (`ServerName`, `ToolName`).

## Real Gemini via your own signed-in Chrome (the `chrome` adapter)

Chrome 136+ refuses remote debugging on your default profile, so there is no Playwright/CDP route to your real session.
Instead a small extension runs inside your normal Chrome profile. There is no new profile and no login handling.
Each consult opens a visible Gemini tab, asks, and closes it.

One-time setup:

1. `chrome://extensions` -> turn on Developer mode -> Load unpacked -> choose `poc/extension`.
2. Run `node poc/tools/token.mjs` (copies the pairing token to your clipboard), open the extension's Options page, paste, Save.
3. In `~/.gemini/config/mcp_config.json`, add `"env": { "AUNTY_ADAPTER": "chrome" }` to the `auntygravity` entry. Consults then run without a per-call approval prompt (chosen for Turbo mode). The task text you send goes to Gemini webchat, so keep secrets out of consult inputs. An unknown or missing adapter state still forces an approval.

How it works: while a consult runs, the server listens on `127.0.0.1:9334`. The extension long-polls it with the token, gets one job, drives the Gemini tab, and posts the answer back. If the extension has not connected after 6 seconds the server starts your default Chrome. Nothing listens when no consult is running.

Other modes: `AUNTY_ADAPTER=stub` (default, fixed plan) and `fake` (tests). Selectors for the Gemini page are in `extension/content.js` and are **unverified** against the live page.

## Plan-content enforcement

Every plan step lists the `files` it may change. The gate blocks `write_file`/`edit_file` outside them, and the Stop hook audits git changes made by shell commands. See `docs/architecture/enforcement-design.md`. If Flash is blocked by a wrong plan it re-consults for a revised one.

## Using it on your real projects (opt-in)

The hooks currently live in `poc/workspace`, so only that workspace is gated. To gate other projects without gating everything:

```bash
node poc/tools/install.mjs install --dry-run   # preview what would go into ~/.gemini/config/hooks.json
node poc/tools/install.mjs install             # writes it (backs up an existing file once)
node poc/tools/enable.mjs enable <project-dir> # opt one project in
node poc/tools/enable.mjs disable <project-dir>
node poc/tools/install.mjs uninstall           # remove the global hooks again
```

The global hooks start with `--opt-in`, so in any project without `.agents/aunty.enabled` (checked up the directory tree) they do nothing: no gating, no state, no logging. `enable` also adds the executor rules to the project's `AGENTS.md` inside a marked block, and `disable` removes exactly that block. A project that already has its own `.agents/hooks.json` with the gate (like `poc/workspace`) makes the global hooks step aside so nothing runs twice. The checkout's `shared/`, `mcp/`, `extension/`, `tools/`, `test/` and `workspace/.agents` are protected by absolute path, so the executor cannot read or edit the enforcement from a different project.

## Still unverified

- Argument names of `write_file`/`edit_file` in a live run (check the `argKeys` lines in `~/.auntygravity/state/gate.log`).
- Whether hooks fire for sub-agents.
- The Antigravity tool-call timeout versus Gemini generation time.
