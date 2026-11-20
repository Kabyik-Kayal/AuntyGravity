# AuntyGravity hook-enforcement PoC

Proves that Antigravity lifecycle hooks can force "consult Gemini before acting" using a **stub** `consult` tool.
It makes no Gemini calls and touches no browser. Design: `docs/architecture/enforcement-design.md`.

## Layout

- `mcp/server.mjs`: zero-dependency stdio MCP server exposing `consult` (returns a fixed plan).
- `workspace/`: throwaway workspace. `AGENTS.md` (advisory protocol) and `.agents/hooks.json` plus `hooks/*.mjs` (enforcement).
- `shared/state.mjs`: state helpers. State goes to `~/.auntygravity/state` (override with `AUNTY_STATE_DIR`), outside the repo.
- `test/poc.test.mjs`: simulates Antigravity against the server and hooks.

## Run the simulated tests

```bash
node --test poc/test/poc.test.mjs
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

## Still unverified (needs the manual run)

- Real tool names, and what the MCP tool is called in hook payloads (the gate matches `/consult/i`).
- Whether `deny` is honored under the Turbo permission preset.
- Whether hooks fire for sub-agents.
