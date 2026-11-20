# AuntyGravity — Feasibility Assessment

**Date:** 2026-11-20
**Basis:** `docs/architecture/initial-system-design.md` and `docs/research/gemini-antigravity-integration-research.md`. No source code exists yet. Nothing below was tested against live Gemini or Antigravity; findings rest on the 2026-11-19 research.

## Verdict

| Goal | Feasible? | Notes |
| --- | --- | --- |
| Antigravity (Flash) can ask a Gemini webchat model (Neon/Hydrogen) for a plan via one MCP tool | **Yes, with moderate risk** | MCP stdio is documented for Antigravity; the browser step is the fragile part. |
| Gemini **decides**, Flash only **executes** (enforced split) | **Yes for "no action without a consult", not for plan content (updated 2026-11-20)** | MCP alone cannot enforce it, but Antigravity's documented lifecycle hooks can deny tool calls, inject the plan and block stopping. See `enforcement-design.md`. Not yet runtime-tested. |
| Fully unattended operation | **Unlikely** | Sign-in, consent prompts, challenges and usage limits all need a human. |

The advisory "consult" design is buildable. The enforced-delegation reading of the requirement is not, with what has been documented so far.

## Component feasibility

| Component | Rating | Why |
| --- | --- | --- |
| MCP server (`consult` tool, stdio) | Low risk | Standard. Node 22 is installed here. The CLI is the documented local-stdio surface. |
| Browser adapter to gemini.google.com | **High risk** | Google documents no automation interface for Gemini Apps. The UI can change without notice. Selectors, model-picker state and "generation finished" detection are all brittle. Possible bot challenges. |
| Model verification (Neon/Hydrogen) | Medium risk | The design requires reading the selected model from the UI. Availability depends on plan and usage limits. The model names are user-supplied and unverified here. |
| Structured result parsing | Medium risk | Webchat output is free text. The design already falls back to `UNSTRUCTURED_RESPONSE`. |
| Privacy | **Constraint** | Consumer Gemini prompts may be human-reviewed and used for training. Source code should not be sent until the user accepts this. |
| Terms of Service | Gray area | The ToS bars automated access only where it violates machine-readable instructions (e.g. robots.txt). The design stays within a visible, user-signed-in UI with no private endpoints. Google could still block or rate-limit the account. |

## Local environment (this machine)

- Node v22.23.2, npm and Python 3.12 are present.
- An Antigravity install folder exists at `%LOCALAPPDATA%\Programs\Antigravity`. No `antigravity` or `agy` command is on PATH.
- No Chrome or Edge on PATH. Playwright's bundled Chromium would work, but a signed-in Google account in an automation-launched browser is more likely to trigger challenges than a normal one.

## Key risks, ranked

1. **Enforced split is unachievable via MCP.** Flash may skip `consult`, or reinterpret the plan. Mitigation: prompt and rules files that require consultation (soft only). Decide whether advisory is acceptable.
2. **Webchat automation fragility and blocking.** The adapter may break on any UI change or hit a challenge. The design correctly says to stop and report instead of working around it.
3. **Data exposure.** Code context goes to a consumer service with human review. Mitigation: explicit context only, per-call approval, a data review gate.
4. **Latency.** Neon-class models in a webchat can take minutes. The MCP client timeout may be shorter than generation time. Check Antigravity's tool-call timeout early.
5. **Account risk.** Automated use of a personal Google account could trigger limits or a lock. Use a dedicated profile, visible, human-paced, one request at a time.

## Recommended spike order (go/no-go gates)

1. **Gate 1, browser PoC (about 0.5 day).** Persistent visible profile, manual sign-in, select Neon, send a synthetic prompt, detect the completed answer. **No-go** if challenged or blocked, or if the final answer cannot be detected reliably.
2. **Gate 2, MCP handshake (about 0.5 day).** A stub `consult` tool called from the Antigravity CLI. Confirm approval UI, tool timeout limit and that Flash uses the result.
3. **Gate 3, end-to-end MVP (about 2 days).** Allowlist, size limits, typed errors, no-content logging, fake-page adapter tests.
4. **Gate 4, enforcement check.** Search Antigravity docs for an official hook (rules, workflows, custom agent or orchestrator config) that makes consultation mandatory. If none exists, accept advisory mode.

Estimates are rough and assume no UI blocking.

## Decisions needed from you

1. Is advisory consultation enough, or is enforced delegation mandatory? If mandatory, the project is blocked on a documented Antigravity hook.
2. Which Antigravity surface first: CLI (documented stdio) or App/IDE?
3. Are you willing to send code context to the consumer Gemini app, given human review and training use?
4. Neon only, or Neon and Hydrogen?

## Alternative worth comparing

Antigravity's built-in Orchestrator already pairs a Neon/Carbon/Argon planner with Hydrogen for implementation. If it is available on your account, it may satisfy the intent with no custom work. The research says only Flash is shown in your Antigravity, so confirm whether Orchestrator is exposed there.
