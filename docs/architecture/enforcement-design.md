# AuntyGravity — Enforced Delegation via Antigravity Lifecycle Hooks

**Date:** 2026-11-20
**Status:** Proposed. Supersedes the "strict-routing gate: out of scope" stance in `initial-system-design.md`.
**Evidence:** Antigravity's own bundled docs on this machine, `~/.gemini/antigravity/builtin/skills/agy-customizations/docs/{hooks,rules,mcp_servers}.md` and `antigravity_guide/references/sdk.md`. Not yet tested at runtime. Tool names and payload details below must be confirmed in the spike.

## Finding

The earlier "blocked, no hook" conclusion was wrong for Antigravity. It documents official **lifecycle hooks** (`hooks.json`) that run local commands and can **hard-deny tool calls**, inject instructions before every model call, and block the agent from stopping. Hooks run in the CLI as well (`transcriptPath` is `antigravity-cli/`). MCP alone still cannot enforce anything. MCP plus hooks can.

| Hook | Documented capability | Use here |
| --- | --- | --- |
| `PreToolUse` | `decision: deny` hard-blocks; `reason` is shown to the agent | Block every non-read tool until a consult plan exists |
| `PostToolUse` | Sees the tool name, args and error | Record that `consult` succeeded for this `conversationId` |
| `PreInvocation` | `injectSteps` adds a persistent `systemMessage`; `terminate` stops the run | Re-inject the Gemini plan as binding instructions each turn |
| `Stop` | `decision: continue` stops the agent from finishing | Make Flash finish or report on every plan step |
| `AGENTS.md` / `GEMINI.md` | Always-on rule text, 24 KB cap | Tell Flash the protocol so it complies without hitting denials |
| Python SDK | Programmatic agent driver | Fallback if hooks prove insufficient |

## Design: make Antigravity accept and follow Gemini's plan

Two layers. The rule makes Flash *want* to comply. Hooks make non-compliance *impossible* for state-changing actions.

### 1. Rule layer (`AGENTS.md` at the repo root)

Short, imperative, no ambiguity:

> You are the executor. Gemini (via the `consult` tool) is the planner and decision-maker.
> 1. Before any edit or command, call `consult` with the task and the relevant facts. Read-only exploration is allowed first.
> 2. Treat the returned plan as binding. Execute its steps in order. Do not add, skip or reorder steps. Do not substitute your own design.
> 3. If a step is impossible or a decision is missing, call `consult` again with `intent: "decision"`. Do not decide yourself.
> 4. After each step, run that step's verification and report the result.

### 2. Enforcement layer (`.agents/hooks.json`)

```json
{
  "auntygravity-gate": {
    "PreToolUse": [
      { "matcher": "*", "hooks": [{ "command": "node ./hooks/gate.mjs", "timeout": 10 }] }
    ],
    "PostToolUse": [
      { "matcher": "<consult tool name>", "hooks": [{ "command": "node ./hooks/record.mjs" }] }
    ],
    "PreInvocation": [
      { "type": "command", "command": "node ./hooks/inject-plan.mjs" }
    ],
    "Stop": [
      { "type": "command", "command": "node ./hooks/stop-check.mjs" }
    ]
  }
}
```

- **`gate.mjs` (PreToolUse, fail-closed):** allow an allowlist of read-only tools and the `consult` tool. For anything else, allow only if the state file for this `conversationId` says a consult plan exists. Otherwise return `{"decision":"deny","reason":"Call consult first. Gemini plans, you execute."}`. The reason reaches the agent, which then self-corrects by calling `consult`. Using `matcher: "*"` with an allowlist means a tool name I don't know about is denied, not allowed.
- **`record.mjs` (PostToolUse on `consult`):** if there is no `error`, mark `conversationId` as planned. It reads the plan from `last_consult.json`, which the MCP server writes. That file lives outside the repo and is deleted after the session, to respect the no-content-persistence rule. PostToolUse input does not document the tool result, so the server-written file is the carrier. One request per profile keeps this unambiguous.
- **`inject-plan.mjs` (PreInvocation):** inject a `systemMessage` containing the plan and the rule "Gemini's plan is binding; call `consult` for any deviation". If consult returned `needs_input` or a typed error, return `terminationBehavior: "terminate"` plus an `errorMessage`, so Flash cannot improvise past a failure.
- **`stop-check.mjs` (Stop):** if plan steps lack reported verification, return `decision: "continue"`. Check `continuationActive` so it asks only once and cannot loop.

### 3. Make the consult result easy to follow

Return the plan as numbered imperative steps, each with a verification command, not prose. Add a fixed header line: `PLAN FROM GEMINI (BINDING): execute in order; call consult for any deviation.` Flash follows short, explicit, step-ordered instructions far more reliably than rationale text.

## What this guarantees and what it does not

| Guaranteed (hook-enforced) | Not guaranteed |
| --- | --- |
| No edit or command runs before a Gemini consult in the session | Flash faithfully implements each step's *content* |
| Consult failure halts the run rather than falling back to Flash's own judgment | Flash cannot be stopped from reading files or answering text-only |
| Flash cannot finish with steps unreported | Plan quality from Gemini |

To tighten content compliance later, `gate.mjs` can compare the proposed tool args against the current step (for example, allowed file paths listed in the plan) and deny out-of-plan edits. That needs plan steps to carry a target-files list.

## Open items to verify in the spike

1. Exact tool names (mutating and read-only) and the MCP tool's name in `PreToolUse` and `PostToolUse`. Capture them from `transcript.jsonl`.
2. Whether `deny` is honored under your current settings (`permissionPreset: TURBO`, eager auto-execution). Docs call it a "hard block"; confirm.
3. Whether hooks fire for sub-agents and the Swarm plugin. If they do not, disable those or gate them separately.
4. The Antigravity MCP tool-call timeout versus Gemini webchat generation time.
5. Hook cost: hooks run synchronously on every tool call, so keep `gate.mjs` under about 50 ms (state file lookup only).

## Cross-check against the online docs (subagent report, 2026-11-20)

A research subagent read antigravity.google/docs via a summarizing fetch tool, so field names are unverified. Re-check them on the pages themselves. It agrees with the local docs:

- **Hooks** (`/docs/hooks/`): `PreToolUse` `deny` is a hard block and can also `overwrite` args. Config goes in `.agents/hooks.json` or `~/.gemini/config/hooks.json`.
- **Permissions** (`/docs/permissions/`): Deny, Ask and Allow lists, with `action(target)` rules, where Deny beats Ask beats Allow. It covers `write_file`, `command` and `mcp(server/tool)`. For the CLI they live in `~/.gemini/antigravity-cli/settings.json`. This can be a second, independent layer behind the hook. Not documented: a deny-by-default mode.
- **Rules / AGENTS.md:** advisory only. Do not rely on them alone.
- **Headless `agy -p` and stream-json:** input accepts user text only, so an external program cannot supply plans or tool calls. Denials in headless mode are soft, since the run continues and exits 0. Do not build on headless mode for enforcement.
- **ACP (`agy acp`):** the message-level behavior is undocumented, so it is unknown whether a controller can supply plans. Worth a spike only if hooks fail.
- **Python SDK** (`/docs/sdk/policies/`, `/docs/sdk/tools/`): `deny("*")` followed by `allow(...)`, and `CapabilitiesConfig` to remove built-in tools. This is the only documented way to strip built-ins entirely, but it is SDK-only and its hook surface is smaller (`pre_turn`, `on_tool_error`).
- **Executor model:** Orchestrator uses a fixed configuration, and no per-hook or per-subagent model selection is documented.

Net: the hook-plus-permissions route is the best CLI path, and the SDK is the fallback if built-in tools must be removed rather than gated.

## Revised delivery sequence

1. Browser PoC (unchanged).
2. Hook PoC with a **stub** `consult`: prove deny, inject and stop work in the CLI before building the browser part.
3. Wire the real MCP `consult` to the browser adapter.
4. Pilot on a throwaway repo. Send no real code until the data-review gate passes.

## Status after live runs (2026-11-20)

Verified against real systems:

- **Hooks in Antigravity (app):** `PreToolUse` deny is honored under the Turbo preset. MCP tools arrive as `call_mcp_tool` with `ServerName`, `ToolName`, `Arguments`. Real tool names are `read_file`, `write_file`, `edit_file`, `run_command`.
- **Executor behavior:** after a consult, Flash followed the plan (it wrote `poc-output.txt` per the plan, not the literal request). It also edited the hook scripts mid-run, so the gate now protects `.agents/`, `poc/shared/`, MCP config and the bridge token.
- **Webchat access:** Chrome 158 refuses remote debugging on the default profile, so the Playwright/CDP route was dropped. A Manifest V3 extension (`poc/extension`) in the user's own signed-in profile talks to the consult server over a token-protected loopback bridge. WebMCP was ruled out: it exposes page-registered tools to in-browser agents and gives an external process no way to call them.
- **Live consults:** Neon and Hydrogen both returned structured plans through the extension; the response was parsed, validated and rendered with the binding header. Model switching Neon to Hydrogen was verified.

Not yet verified: a full Antigravity run with the `chrome` adapter, whether `force_ask` prompts under Turbo, sub-agent hook coverage, and Antigravity's MCP tool-call timeout versus answer time (a Neon answer can take minutes; the bridge cap is 270 s).

## Plan-content enforcement (added 2026-11-20)

Gemini now declares, per plan step, a required `files` list (exact files or directories ending in `/`). Plans without a valid `files` array on every step are rejected as `UNSTRUCTURED_RESPONSE`. Two layers hold the executor to it:

1. **Gate (before the action):** after a plan exists, direct file-writing tools (`write_file`, `edit_file`, and similar names) may only touch listed files. Paths are resolved against the workspace (`cwd`), so `..` traversal, sibling-prefix names and `file://` URIs cannot widen access. Entries that cover the whole workspace or a parent, and globs, are ignored. A file tool whose target cannot be determined is denied. The denial text names the offending file and tells Flash to call consult for a revised plan, which is the escape hatch.
2. **Stop audit (after the fact):** shell commands cannot be scoped in advance, so a git baseline of dirty files (path, size, mtime) is taken when the plan is recorded. At Stop, any file that is new or changed and not in the plan sends the agent back to revert it or re-consult, at most 3 rounds per plan. Requires a git repository; otherwise the audit is skipped.

Limits: `run_command` itself is not blocked, so a command can still write outside the plan until the Stop audit catches it (the audit sees only changes to files git can see, so it misses ignored files and anything outside the workspace). Symlinks are not resolved. Plan quality is still Gemini's. The real argument names for `write_file` and `edit_file` are inferred from the key-name suffix (`...File`, `...Path`, `...Uri`) and are logged to `gate.log` as key names for verification. A live Antigravity run is needed to confirm them.

## Sub-agents and swarm workers (added 2026-11-20)

Antigravity's `swarm` skill runs workers as separate agents in their own conversations, optionally in their own working copy or clone. The hooks documentation says nothing about whether hooks reach them. Two risks follow: a worker's tool calls might skip the gate entirely, and a worker working from a different directory might not discover `.agents/hooks.json` at all, since discovery walks up from the working directory to the repository root.

Until that is verified, the spawn point is blocked instead of trusted:

- The gate denies `swarm`, `swarm_wait`, `post_message`, `read_board` and any tool whose name contains `subagent` or `spawn`, with or without a plan. `AGENTS.md` tells the executor not to use them.
- Fail-closed by design: a worker conversation never has a plan, so if hooks do reach it, every state-changing call is denied there too.
- `gate.log` now records an 8-character conversation id prefix per decision, so a run shows whether other conversations hit the hooks.
- Experiment switch: creating `~/.auntygravity/state/allow-spawn` lets spawn tools through so the question can be answered. If a worker's actions never appear in `gate.log` but its files appear on disk, hooks do not reach workers and the spawn block must stay permanently.

The spawn tool names are inferred from the bundled swarm skill and may need extending after a live run.

## Slow answers: PENDING and collect (added 2026-11-20)

Antigravity cancels MCP tool calls at 180 s (measured: a call at 14:38:35 was cut at 14:41:35). Neon answered one consult in 42 s and another not within about 150 s, so a single blocking call is not reliable.

- The extension waits up to 125 s for the answer. If Gemini is still working it returns `GENERATION_PENDING`, leaves the tab open and remembers it. This is not a failure.
- `consult` then replies `PENDING: ... will NOT be resent ... call consult again with collect: true`. Flash calls `consult` with `collect: true` (same task and model). The extension reads the answer from the remembered tab and never sends anything. A new consult closes an old pending tab.
- Hooks: a PENDING reply puts the session in a `waiting` state. It is not failed, so the run continues, but state-changing tools stay blocked with a message that says to collect. The Stop hook sends the agent back to collect (at most 3 times). After 4 consecutive PENDING replies the session fails with a clear reason.
- A collected plan goes through the same parsing, scope and baseline steps as a direct one.

Verified live (probe with a 12 s wait): the first call returned PENDING at 21 s (the diagnostic showed a stop button present and empty response containers, i.e. still generating), and one collect call at 27 s returned the finished Neon plan, parsed and rendered. The prompt was sent exactly once. `tools/probe.mjs --wait N [--launch]` reproduces this. The server can shorten, never lengthen, the extension's wait (clamped to 5 to 125 s).

## Global install, opt-in per project (added 2026-11-21)

A global `~/.gemini/config/hooks.json` entry (`auntygravity-global`, written by `tools/install.mjs`) applies to every Antigravity conversation. To avoid gating projects that did not ask for it, every hook is started with `--opt-in` and exits as a no-op unless `.agents/aunty.enabled` exists in the workspace or an ancestor (`tools/enable.mjs`). Unknown workspaces stay ungated. A workspace-local hooks.json that already carries the gate wins, so hooks never run twice and injected system messages are not duplicated. Because the enforcement now lives outside the project being edited, the gate also protects the checkout's enforcement directories by absolute path for reads, writes and shell commands.

Not verified live: that Antigravity applies `~/.gemini/config/hooks.json` as the docs describe, and the per-call cost of starting node four times per step in inactive projects.

## Distribution as an Antigravity plugin (added 2026-11-21)

Modelled on how `mattpocock/skills` ships: a repo of skills, plus a one-time user-invoked setup skill that explores the project, shows its findings, asks, and only then writes (`setup-matt-pocock-skills`). Equivalent here:

- **Repo root is the plugin root** (`plugin.json`, `mcp_config.json`, `skills/`). The server is declared with `${PLUGIN_ROOT}/runtime/mcp/server.mjs`; install is `agy plugin install <git url>`, the Marketplace, or a copy into `~/.gemini/config/plugins/`.
- **`/setup-auntygravity`** (`skills/setup-auntygravity/SKILL.md`) is the only thing a user types. It drives `runtime/tools/aunty.mjs` (doctor, install, enable, token, smoke). Antigravity skills have no user-invoked-only flag, so the description says to use it ONLY on request.
- **No per-project file edits.** The executor rules ride in the PreInvocation hook (`runtime/shared/protocol.mjs`), so a project gains one file, `.agents/aunty.enabled`, optionally hidden via `.git/info/exclude`.
- **Hooks are not shipped inside the plugin.** The hooks doc scopes a plugin's hooks.json to the CLI only, and a plugin copy plus the global copy would run every hook twice. The setup skill installs the opt-in global hooks instead (documented for every surface). A test asserts the repo root has no `hooks.json`.
- **The agent cannot undo its own enforcement.** In an enabled project the gate blocks running the CLI against the plugin's files, so `disable`, `uninstall` and enabling another project from inside an enabled project need the user's terminal or a folder that is not enabled.
- **Unverified:** that `${PLUGIN_ROOT}` expands in MCP `args` as the docs summary says, how the app discovers a git-installed plugin, and that a skill's relative script path resolves for the agent. The Chrome extension still has to be loaded by hand (and a Chrome Web Store listing would remove that step).
