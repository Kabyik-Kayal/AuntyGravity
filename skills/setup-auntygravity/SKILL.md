---
name: setup-auntygravity
description: Use ONLY when the user asks to set up, enable, check or troubleshoot AuntyGravity, or types /setup-auntygravity. Turns AuntyGravity on for a project of the user's choice: checks the machine, installs the opt-in hooks, guides the Chrome extension pairing, and enables the project. Do not use for any other request.
---

# Set up AuntyGravity

AuntyGravity lets a stronger Gemini webchat model (Neon or Hydrogen) plan and decide while you, the Antigravity model, only execute. It is enforced by hooks: in an enabled project, state-changing tools are blocked until Gemini has returned a plan, and file changes outside the plan are blocked.

This skill is prompt-driven. Explore, present what you found, confirm with the user, then act. Do not run anything that changes the user's setup before they confirm it.

All commands use one entry point, `runtime/tools/aunty.mjs`, located two directories above this file (the plugin root). Run it as `node <plugin root>/runtime/tools/aunty.mjs <command>`. Every command prints JSON.

If a command is blocked by a hook ("no Gemini plan exists", "protected"), you are inside a project that is already enabled. Do not try to work around it. That is the enforcement doing its job: tell the user the exact command and ask them to run it in a terminal, or to run `/setup-auntygravity` from a folder that is not enabled.

## 1. Explore

Run `doctor` with no flags (it is fast and read-only). Add `--project <dir>` once you know the project. Read the checks. A failing check has a `fix`. A check with `warn: true` is advice, not a failure.

Find out:

- **Which project?** Default to the current workspace. Ask whether they want another folder instead, or several. Do not guess.
- Is it a git repository? (the doctor says). If not, offer `git init`: AuntyGravity audits shell-made file changes through git, and without it only direct file edits are checked.
- Does the project have its own `.agents/hooks.json` containing `auntygravity-gate`? Then it is a developer workspace and the global hooks step aside. Nothing to enable.

## 2. Present findings and ask

Summarise what passes and what is missing, then take only the missing items, one at a time, leading with the recommended answer.

**Global hooks** (check `hooks`). If missing, explain: "This adds one entry to `~/.gemini/config/hooks.json` plus four small launcher files in `~/.auntygravity/bin`. The hooks do nothing in any project until it is enabled." Ask before running `install`. Offer `install --dry-run` first if they want to see it.

**Chrome extension** (checks `token`, `extension`). This part cannot be automated. Tell the user, in order:

1. Open `chrome://extensions`, turn on Developer mode, click Load unpacked, choose the `extension` folder in the plugin root.
2. Run `token` (copies the pairing token to the clipboard), open the extension's Options page, paste, Save.
3. Stay signed in to Gemini (gemini.google.com) in that Chrome profile, with Neon and Hydrogen available on the account.

Then run `doctor --ping`. It listens for about 12 seconds for the extension. If the state is `silent`, Chrome is closed or the extension is not paired; if `wrong-token`, the token needs pasting again. Never read, print or ask for the token file's contents; the pairing token is a secret.

**Duplicate server** (check `mcp-duplicate`). If the user also has a hand-written `auntygravity` entry in `~/.gemini/config/mcp_config.json`, say that only one is kept and suggest removing the manual one. Do not edit that file for them without asking.

**Privacy, say this once.** Whatever the executor sends to `consult` (the task and any context it chooses to include) goes to the Gemini webchat in the user's own account. Google may retain or human-review it. Do not include secrets in consult input, and do not enable this on a project whose code the user is not allowed to send to Gemini Apps. Get an explicit yes before enabling.

## 3. Confirm and write

Show the user exactly what will happen and let them change it:

- `enable <dir>` creates one file, `<dir>/.agents/aunty.enabled`. Nothing else in the project is touched; the executor rules are delivered by a hook, not by editing `AGENTS.md`.
- Ask: commit the marker so teammates who also have AuntyGravity get it, or keep it personal? Personal means adding `--exclude`, which hides it in `.git/info/exclude`.

Then run, as agreed: `install` (if needed), then `enable <dir> [--exclude]` for each project.

## 4. Verify

Run `doctor --ping --project <dir>`. Everything should pass. Offer an optional live check: `smoke` sends one harmless synthetic prompt to Gemini (it opens a Chrome tab for a minute or less). Only run it if they say yes.

## 5. Done

Tell the user:

- New conversations in the enabled project start under the executor protocol. In a conversation that was already open, start a new one.
- What they will see: Flash is blocked, calls `consult`, Neon or Hydrogen answers (often under a minute, sometimes minutes: a `PENDING` reply is normal and the executor collects the answer), then Flash executes only the planned steps.
- To turn it off for a project the user runs `node <plugin root>/runtime/tools/aunty.mjs disable <dir>` themselves, and `uninstall` removes the global hooks. The enforcement stops the executor from doing either, on purpose.
- Re-running this skill is only needed to enable another project or after the extension is re-installed.
