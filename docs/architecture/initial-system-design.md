# AuntyGravity — Webchat-First Initial System Design

**Status:** Proposed, based on first-party research reviewed 2026-11-19  
**Scope:** Initial architecture only; no implementation code exists yet.

## Product requirement

AuntyGravity connects Antigravity to the user's signed-in Gemini webchat so Gemini 4 Neon or Hydrogen can provide plans and decisions while Antigravity's available Gemini 3.8 Flash model carries out edits and commands.

The user says Neon and Hydrogen are available in their Gemini Apps account, while Antigravity exposes only Gemini 3.8 Flash. Treat this as the target environment; account access was supplied by the user and is not independently verified here.

## Recommendation

Keep the Gemini **webchat** requirement. Expose one AuntyGravity MCP tool, consult, to Antigravity. Behind it, a local browser adapter uses a dedicated, visible, user-authenticated browser profile to interact with gemini.google.com through its normal UI.

This is an experimental integration: Google documents Gemini Apps for people using the website, but the reviewed docs do not document a supported external automation interface. Respect any current site instructions and stop if a challenge, block, or UI change prevents a normal interaction. Do not call private endpoints, copy session credentials, bypass access controls, or automate around a restriction. Google's Terms restrict automated access when it violates machine-readable instructions; they do not state that all browser automation is categorically forbidden. ([Gemini Apps model guide](https://support.google.com/gemini/answer/18648722?hl=en), [Google Terms of Service](https://policies.google.com/terms?hl=en-US))

The Developer API is not part of this design. It is a distinct programmatic access path and does not inherit the user's webchat subscription or account history. ([Gemini API models](https://ai.google.dev/gemini-api/docs/models), [Gemini Apps model guide](https://support.google.com/gemini/answer/18648722?hl=en))

## Research findings that shape the design

- Google's Gemini Apps guide lists Neon and Hydrogen as selectable webchat models, subject to account plan, license, and usage limits. Google's separate Developer API catalog also lists model IDs, but that is outside this requirement. ([Gemini Apps model guide](https://support.google.com/gemini/answer/18648722?hl=en), [Gemini API model catalog](https://ai.google.dev/gemini-api/docs/models))
- Antigravity supports MCP servers. Its built-in Orchestrator pairs a selected planner (Neon, Carbon, or Argon) with Hydrogen for implementation. That may be useful for comparison, but the docs do not say it runs the user's selected Flash model as executor. ([Antigravity MCP guide](https://antigravity.google/docs/mcp/), [Antigravity model guide](https://antigravity.google/docs/models/))
- Gemini Apps prompts may be used to improve services and may be reviewed by people. The privacy notice advises against entering confidential information. Treat source code and repository context as sensitive unless the user's applicable account and settings explicitly permit sending it. ([Gemini Apps Privacy Hub](https://support.google.com/gemini/answer/13594961?hl=en))
- MCP gives Antigravity tools to call; the host coordinates the model and the tool flow. An MCP server cannot force Antigravity to call Gemini for every decision or control which Antigravity model acts next. That strict split requires an additional supported control mechanism. ([MCP Architecture](https://modelcontextprotocol.io/specification/2026-07-28/architecture), [MCP Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools))

## Proposed architecture

Start with the Antigravity CLI, whose documentation explicitly accepts a local stdio MCP server. If the target is the App or IDE, use that surface's documented MCP configuration and verify the same handoff there. The MCP process owns a visible browser session in a dedicated persistent profile stored outside the repository checkout. The user signs into Gemini Apps interactively; AuntyGravity never exports or reads browser credentials.

~~~mermaid
flowchart LR
    user["User"] --> host["Antigravity<br/>Gemini 3.8 Flash"]
    host -->|"MCP call: consult"| mcp["AuntyGravity MCP process"]
    mcp --> consult["Webchat Consultation module"]
    consult --> browser["Visible browser adapter<br/>dedicated signed-in profile"]
    browser -->|"normal Gemini Apps UI"| gemini["gemini.google.com<br/>Neon or Hydrogen"]
    gemini --> browser
    browser --> consult
    consult -->|"validated response"| mcp
    mcp --> host
    host -->|"existing workspace tools<br/>and approval settings"| execute["Antigravity execution"]
~~~

### Request flow

1. The user gives Antigravity a task. Antigravity's selected model invokes consult for a plan, decision, or review.
2. The MCP host presents the tool call for user approval where the selected Antigravity surface supports it. The user can inspect the task and context that will leave the machine.
3. The Webchat Consultation module validates and size-limits the explicit input. It does not read files or retrieve previous chat history.
4. The browser adapter verifies the Gemini page and requested model in the visible UI. If the user is signed out, the model is unavailable, a consent prompt appears, or the page state is unexpected, it stops and asks for human action.
5. The adapter submits the request through the visible UI, waits for the final response, and returns the displayed answer. It does not automate CAPTCHA solving or call undocumented network endpoints.
6. The module validates the response and returns it to Antigravity. If the expected output format is missing or invalid, it reports that explicitly rather than silently substituting another model.
7. Gemini's answer is advisory. Antigravity Flash interprets the result and executes through Antigravity's own tools and approval settings.

## Deep module and interface

The **Webchat Consultation module** hides browser startup, session checks, model selection, prompt formatting, generation waits, response extraction, and UI error handling behind one MCP tool: consult.

### consult input

~~~json
{
  "intent": "plan | decision | review",
  "model": "neon | hydrogen",
  "task": "string",
  "context": [
    { "label": "string", "text": "string" }
  ],
  "constraints": ["string"],
  "acceptance_criteria": ["string"]
}
~~~

Task is required. Context, constraints, and acceptance criteria are optional and must be provided explicitly by Antigravity. Model is restricted to the configured allowlist; default it to Neon for planning. The adapter must verify the selected model in the UI and return MODEL_UNAVAILABLE rather than falling back to Flash or another model.

### consult result

~~~json
{
  "status": "complete | needs_input",
  "model_used": "neon | hydrogen",
  "response_text": "string",
  "summary": "string",
  "recommendation": "string",
  "plan": [
    { "step": "string", "verification": ["string"] }
  ],
  "assumptions": ["string"],
  "open_questions": ["string"],
  "risks": ["string"]
}
~~~

Ask Gemini for a concise rationale and structured plan, not hidden chain-of-thought. Keep response_text so the result remains usable if the web app does not follow the requested structure. Mark a response that cannot be parsed as UNSTRUCTURED_RESPONSE; do not pass it off as validated data.

The module's **Interface** guarantees:

- Each call is stateless from AuntyGravity's perspective. The active Gemini chat may persist in the browser, but the server does not depend on it; start a fresh chat per request unless the user explicitly chooses otherwise.
- The adapter only operates on gemini.google.com in its dedicated visible profile.
- It reads no local files and performs no Antigravity execution.
- It sends no implicit conversation history, browser history, or hidden Antigravity instructions.
- It returns a validated result or a typed error: NEEDS_SIGN_IN, MODEL_UNAVAILABLE, USAGE_LIMIT, CONSENT_REQUIRED, UI_CHANGED, GENERATION_TIMEOUT, UNSTRUCTURED_RESPONSE, or BROWSER_UNAVAILABLE.
- It never silently changes models, retries a new prompt, or bypasses a human challenge.

The external **seam** is the MCP consult tool. The internal browser seam has one production adapter for the visible Gemini Apps UI and a fake page adapter for interface-level tests. Keep all selectors, waits, and UI-specific work inside that adapter. This gives the module depth: callers learn one tool while UI changes stay localized.

## Browser and privacy controls

- Store the dedicated browser profile outside the repository checkout, and have the user sign into it manually. Do not read, copy, export, or synchronize cookies or credentials through AuntyGravity.
- Keep the browser visible while a request is running. The user should be able to see the selected Google account, selected model, prompt, and response.
- Require user approval for each request where Antigravity can do so. If a surface cannot provide per-call approval, make webchat calls user-invoked only and show a clear external-processing notice before enabling them.
- Send only the explicit text needed for the consultation. Do not send the full repository, full transcript, environment variables, secrets, or private keys.
- Do not persist prompts or responses in AuntyGravity logs. Gemini Apps may keep or review content under its own settings and policies; local deletion cannot change Google's handling.
- Treat browser content and Gemini output as untrusted. Never interpret model text as a command.

## Failure handling and reliability

Web UI automation is less stable than a documented programmatic interface. Use accessible labels and visible page state where possible. Check the page origin, login state, selected model, and generation completion before returning success. Any selector drift, unexpected dialog, usage limit, or challenge stops the call with a typed error and a human-readable explanation. Do not work around a block.

The browser adapter should allow only one active request per profile to avoid mixing conversations. Use a bounded wait for completion. Do not automatically resubmit after a timeout because the first prompt may still be running or may already have completed.

## What this design can and cannot promise

This MCP design can give Antigravity a way to request a Gemini webchat answer and return it to the task. It cannot guarantee that Gemini makes every decision: Antigravity Flash still decides whether to call consult, can interpret the response, and selects its own next action. A prompt rule can encourage consultation, but it is not enforcement.

If exclusive reasoning delegation is mandatory, first identify an official Antigravity control hook that lets another controller provide decisions while Antigravity's selected model executes. The current MCP documentation does not establish such a hook. Do not simulate it by driving Antigravity's UI or bypassing its controls.

## Delivery sequence

1. **Browser proof of concept:** in a dedicated visible profile, manually sign in, select Neon, submit a synthetic prompt, and confirm AuntyGravity can detect the correct final answer through the visible UI. Stop if the site blocks or challenges automation.
2. **MCP handshake:** verify the intended Antigravity surface can call a local MCP tool and receive the browser result. The CLI is the documented local-stdio starting point; verify App or IDE configuration separately.
3. **MCP MVP:** implement one local consult tool, model allowlisting, explicit context limits, per-call user confirmation, typed errors, and no-content logging.
4. **Antigravity pilot:** verify tool approval and handoff in the intended App, CLI, or IDE surface. Confirm that Flash executes after receiving the consultation result, while recognizing that the host can still make its own decisions.
5. **Data review:** do not send repository content until the user has reviewed applicable Gemini Apps privacy settings and accepts the possibility of service improvement and human review.
6. **Strict-routing gate:** keep strict delegation out of scope unless an officially supported Antigravity control mechanism is found.

## Open questions

- Should Neon be the only model used for planning, or should Hydrogen also be selectable?
- Should every request require an explicit user approval, or only requests containing project context?
- Which Antigravity surface is the first target: App, CLI, or IDE?
- Is advisory consultation enough, or is enforced delegation a product requirement?

## Research notes

See the [primary-source research report](../research/gemini-antigravity-integration-research.md) for the model availability, MCP support, terms, privacy, and source dates reviewed on 2026-11-19.
