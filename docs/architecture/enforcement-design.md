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
