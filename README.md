# AuntyGravity

Let a stronger Gemini model **plan and decide** while Antigravity's own model only **executes**.

Antigravity's model is fast and cheap, but it may not be the one you would pick for the thinking. Your Gemini webchat account may have a stronger one (Neon, Hydrogen). AuntyGravity connects the two. Before the Antigravity agent can change anything, it has to ask Gemini for a plan through a `consult` tool. Hooks enforce that, and then hold the agent to the plan it got.

> **Experimental.** It drives the Gemini web app through your own signed-in Chrome, which Google does not document as an integration. Read [Privacy and limits](#privacy-and-limits) before turning it on. Developed and tested on Windows 11 with the Antigravity desktop app and Chrome.

## Installation

You need Node 18 or newer (developed on 22), Chrome, and a Gemini account where the models you want (Neon, Hydrogen) show up at gemini.google.com.

### 1. Get the plugin

Install from this repository, `https://github.com/Kabyik-Kayal/AuntyGravity`, in whichever way your Antigravity surface supports:

```bash
agy plugin install https://github.com/Kabyik-Kayal/AuntyGravity
```

or, in the Antigravity app, add it from the Customizations page. If neither works for you, this always does:

```bash
git clone https://github.com/Kabyik-Kayal/AuntyGravity "%USERPROFILE%\.gemini\config\plugins\auntygravity"
```

(`~/.gemini/config/plugins/auntygravity` on macOS and Linux.) Then run `npm install` once inside that folder only if you want to run the tests; the plugin itself has no runtime dependencies.

The plugin provides the `consult` MCP server and the `/setup-auntygravity` skill. It does not do anything to a project by itself.

### 2. Run `/setup-auntygravity`

In Antigravity, type `/setup-auntygravity`. The agent does the rest with you, the way [setup-matt-pocock-skills](https://github.com/mattpocock/skills) sets up that repo's skills: it explores, shows what it found, asks, and only then writes.

- checks your machine
- asks **which project** to turn on, and whether to commit the one-file marker or keep it personal
- installs the global hooks (they do nothing until a project is enabled), after you say yes
- walks you through the Chrome extension: load it once, paste a pairing token
- enables the project and verifies it, with an optional one-prompt live test

You write no per-project file by hand. The only file added to your project is `.agents/aunty.enabled`. The rules reach the agent through a hook, so `AGENTS.md` is not edited.

### 3. Use Antigravity as usual

In an enabled project, start a new conversation. The agent is blocked, calls `consult`, Gemini answers with a plan, and the agent carries out only the planned steps.

## How it works

| Piece | What it does |
| --- | --- |
| `consult` (MCP server) | Sends the task to Gemini through your Chrome and returns a validated plan: ordered steps, the files each step may change, and how to verify each |
| Chrome extension | Runs in your own profile (no new profile, no login handling). Opens a visible Gemini tab per consult and reads the answer back over a token-protected loopback link |
| Gate hook | Denies every state-changing tool until a plan exists. After that it denies file edits outside the plan, killing processes, starting sub-agents or swarms, and access to AuntyGravity's own files |
| Stop hook | Audits with git that shell commands changed nothing outside the plan, and makes the agent report on each step |
| `PENDING` / `collect` | A slow Gemini answer returns `PENDING`, and the agent collects it later without resending, to stay under Antigravity's 180 second tool-call limit |

If a consult fails (signed out, model unavailable, a challenge, a timeout) the run **stops** instead of letting the agent improvise.

## Commands

The skill runs these for you. Run them yourself from the plugin folder when you need to:

```bash
node runtime/tools/aunty.mjs doctor [--ping] [--project <dir>]
node runtime/tools/aunty.mjs install [--dry-run]     # global hooks, opt-in per project
node runtime/tools/aunty.mjs enable <dir> [--exclude]
node runtime/tools/aunty.mjs disable <dir>
node runtime/tools/aunty.mjs uninstall               # remove the global hooks
node runtime/tools/aunty.mjs token                   # create the pairing token and copy it
node runtime/tools/aunty.mjs smoke [neon|hydrogen]   # one harmless live consult
```

The agent cannot run `disable` or `uninstall` inside an enabled project, because the gate blocks it on purpose. Run them yourself in a terminal.

## Status: what has and has not been verified

Verified live (Windows 11, Antigravity desktop app, Chrome 158):

- consults to Neon and Hydrogen through the extension, including model switching
- the gate blocking Flash until a plan exists, then limiting it to the planned files, and blocking sub-agent and process-kill attempts
- slow answers: `PENDING`, then `collect`
- the global hooks command running end to end

Not verified yet:

- installing this as a plugin in the Antigravity app: that `${PLUGIN_ROOT}` expands in the MCP server's arguments, and that a git-installed plugin is discovered
- whether hooks reach sub-agents (so starting them is blocked rather than trusted)
- macOS and Linux (Chrome detection has paths for them, but nothing was run there)

## Privacy and limits

- **Your prompts go to the Gemini web app.** Whatever the agent puts in a consult (the task and any context it chooses) is sent to Gemini Apps in your account. Google may retain it and have people review it. Keep secrets out, and do not enable this where you are not allowed to send the code to Gemini Apps.
- **Browser automation is not a supported Google interface.** It uses the normal web UI, visibly, in your own signed-in browser. If the page changes or Google challenges the session, a consult fails with a clear error and stops. Nothing here works around a challenge.
- **Enforcement is strong for what it can see, not total.** Plan quality is Gemini's. Shell commands are audited after the fact and only through git, so files git ignores, or files outside the project, are not covered.
- **Slow answers.** Neon can take minutes. The wait is split across calls (`PENDING`, then `collect`), up to four rounds, and then the run stops.

## Layout

```
plugin.json  mcp_config.json     the Antigravity plugin
skills/setup-auntygravity/       the /setup-auntygravity skill
runtime/                         MCP server, hooks, shared code, CLI tools
extension/                       the Chrome extension
test/                            the test suite (npm test)
dev/workspace/                   a throwaway workspace with the hooks wired in locally, for development
docs/                            design, research and live-run notes
```

Development: `npm install && npm test`. The design, and what was verified in each live run, is in [`docs/architecture/enforcement-design.md`](docs/architecture/enforcement-design.md).

## Author and license

Kabyik Kayal ([@Kabyik-Kayal](https://github.com/Kabyik-Kayal)). MIT licensed, see [LICENSE](LICENSE).
