# AuntyGravity

Let a stronger Gemini model **plan and decide** while Antigravity's own model only **executes**.

Antigravity's model is fast and cheap but often not the model you'd pick for the thinking. Your Gemini webchat account may have a stronger one (Neon, Hydrogen). AuntyGravity connects the two: before the Antigravity agent can change anything, it must ask Gemini for a plan through a `consult` tool. Hooks enforce that, and then hold the agent to the plan it got.

> **Status: experimental.** It drives the Gemini web app through your own signed-in Chrome, which Google does not document as an integration. Read [Privacy and limits](#privacy-and-limits) before turning it on.

## Installation (about five minutes)

### 1. Get the plugin

```bash
agy plugin install https://github.com/<owner>/auntygravity
```

In the Antigravity app: Customizations > Marketplace > add this repository. Or copy the folder to `~/.gemini/config/plugins/auntygravity`. The plugin ships the `consult` MCP server and the `/setup-auntygravity` skill.

You need Node 18+, Chrome, and a Gemini account where the models you want (Neon, Hydrogen) appear in gemini.google.com.

### 2. Run `/setup-auntygravity`

In Antigravity, type `/setup-auntygravity`. The agent installs the rest with you, the way [setup-matt-pocock-skills](https://github.com/mattpocock/skills) sets up its skills: it explores, shows what it found, asks, then writes.

- checks your machine (`doctor`)
- asks **which project** to turn on, and whether to commit the one-file marker or keep it personal
- installs the global hooks (inert until a project is enabled), after you say yes
- walks you through the Chrome extension (load it once, paste a pairing token)
- enables the project and verifies it, with an optional one-prompt smoke test

There is no per-project file to write by hand. The only file in your project is `.agents/aunty.enabled`; the rules reach the agent through a hook, not through `AGENTS.md`.

### 3. Use Antigravity as usual

In an enabled project, start a new conversation. The agent is blocked, calls `consult`, Gemini answers with a plan, and the agent executes only the planned steps.

## How it works

| Piece | What it does |
| --- | --- |
| `consult` (MCP server) | Sends the task to Gemini via your Chrome and returns a validated plan: ordered steps, the files each may change, and how to verify each |
| Chrome extension | Runs in your own profile (no new profile, no login handling), opens a visible Gemini tab per consult and reads the answer back over a token-protected loopback link |
| Gate hook | Denies every state-changing tool until a plan exists, then denies file edits outside the plan, process killing, sub-agents and swarms, and access to AuntyGravity's own files |
| Stop hook | Audits (via git) that shell commands changed nothing outside the plan, and makes the agent report on each step |
| `PENDING` / `collect` | A slow Gemini answer returns `PENDING`, and the agent collects it without resending, to stay under Antigravity's 180 s tool-call limit |

A consult that fails (signed out, model unavailable, challenge, timeout) **stops the run** instead of letting the agent improvise.

## Commands

All go through one entry point. The skill runs them for you.

```bash
node runtime/tools/aunty.mjs doctor [--ping] [--project <dir>]
node runtime/tools/aunty.mjs install [--dry-run]     # global hooks, opt-in per project
node runtime/tools/aunty.mjs enable <dir> [--exclude]
node runtime/tools/aunty.mjs disable <dir>
node runtime/tools/aunty.mjs uninstall               # remove the global hooks
node runtime/tools/aunty.mjs token                   # create and copy the pairing token
node runtime/tools/aunty.mjs smoke [neon|hydrogen]   # one harmless live consult
```

The agent cannot run `disable` or `uninstall` inside an enabled project: the gate blocks it, on purpose. Run them yourself in a terminal.

## Privacy and limits

- **Your prompts go to the Gemini web app.** Whatever the agent puts in a consult (the task, any context it picks) is sent to Gemini Apps in your account. Google may retain it and have it reviewed by people. Keep secrets out, and do not enable it where you may not send the code to Gemini Apps.
- **Browser automation is unsupported by Google.** It uses the normal web UI, visibly, in your signed-in browser. If the page changes or Google challenges the session, consults fail with a clear error and stop. Nothing works around a challenge.
- **Enforcement is strong for what it can see, not total.** Plan quality is Gemini's. Shell commands are audited after the fact, only through git, so files git ignores or that sit outside the project are not covered. Whether hooks reach sub-agents is unverified, so the gate blocks starting them.
- **Slow answers.** Neon can take minutes. The wait is split across calls (`PENDING`, then `collect`), up to four rounds, then the run stops.

## Layout

```
plugin.json  mcp_config.json        the Antigravity plugin
skills/setup-auntygravity/          the /setup-auntygravity skill
runtime/                            MCP server, hooks, shared code, CLI tools
extension/                          the Chrome extension
test/                               80 tests (node --test)
dev/workspace/                      a throwaway workspace with the hooks wired in locally, for development
docs/                               design, research and the live-run log
```

Development: `npm install && npm test`. The design and what was verified live are in `docs/architecture/enforcement-design.md`.
