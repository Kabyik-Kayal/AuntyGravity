# Gemini–Antigravity integration: primary-source findings

**Research date:** 2026-11-19. Sources below were accessed on this date with the Firecrawl CLI. Sources are first-party documentation from the provider being described: Google product documentation, terms, and support pages, plus the official MCP specification.

## Findings

### User-provided product constraint

The user says their Gemini Apps account can access Gemini 4 Neon and Hydrogen, while Antigravity currently offers only Gemini 3.8 Flash. This is project context supplied by the user, not independently verified account state. The system design now treats Gemini Apps webchat as a hard requirement rather than recommending the Developer API.

### Model names and access paths

**Documented:** Gemini 4 Neon and Gemini 4 Hydrogen are official Google model names. Google’s Gemini Developer API model catalog lists their API model codes as `gemini-4-neon` and `gemini-4-hydrogen`. Separately, Google’s Gemini Apps support page lists Neon and Hydrogen as consumer app models. For personal accounts, Hydrogen is available in task mode even without a Google AI plan and in chats on Plus, Pro, and Ultra; Neon is listed for chats and tasks on Pro and Ultra. The page says access depends on plan and remaining usage; work or school accounts depend on their Workspace license. The consumer guide shows manual switching at [gemini.google.com](https://gemini.google.com/). ([API model catalog](https://ai.google.dev/gemini-api/docs/models), [Gemini Apps model guide](https://support.google.com/gemini/answer/18648722?hl=en))

Google documents two distinct interfaces: the Gemini Apps web experience at `gemini.google.com`, and the Gemini Developer API, which is called programmatically with a Google GenAI SDK and model ID. The API docs are the supported programmatic route; the model guide documents consumer web access and subscription-based model selection. Availability and labels in the app do not by themselves establish API entitlement, and vice versa. ([Gemini Apps model guide](https://support.google.com/gemini/answer/18648722?hl=en), [Gemini API models](https://ai.google.dev/gemini-api/docs/models), [API migration guide](https://ai.google.dev/gemini-api/docs/migrate-to-cloud))

### Antigravity MCP and model routing

**Documented:** Antigravity supports MCP servers in its App, CLI, and IDE; the App has an MCP Servers manager, while the CLI accepts local `stdio` and remote host configurations. Antigravity’s model guide documents a built-in **Orchestrator** option that pairs a selected planner (Neon, Carbon, or Argon) with Gemini 4 Hydrogen for implementation. ([Antigravity MCP guide](https://antigravity.google/docs/mcp/), [Antigravity model guide](https://antigravity.google/docs/models/))

**Scope:** Orchestrator is documented as a built-in model pairing, not a generic user-configurable router: its implementation model is Hydrogen. The docs do not describe an MCP server as a way to replace that executor with whichever model is currently selected.

**Inference for this design:** An Antigravity MCP server can expose a tool that invokes a local browser adapter, interacts with the Gemini Apps web UI, and returns the displayed answer as tool output. Antigravity's MCP support is the documented integration surface; browser automation itself is not a documented Gemini Apps integration. Treat this as an experimental UI automation flow, not as a first-party Antigravity model-routing feature. The sources do not promise that Antigravity will run arbitrary follow-up work with a specific currently selected model after every such tool call, so verify the handoff in the target surface.

**MCP roles and reasoning/execution seam (spec facts and inference):** The current MCP specification (version 2026-07-28) assigns orchestration to the **host**: it creates and manages clients, enforces connection permissions and consent, handles authorization, coordinates the AI/LLM, and keeps the full conversation context. Each client connects to one server; the server exposes tools/resources/prompts and receives only the context sent to it. For tools, the model may select a tool from the available descriptions, the client sends `tools/call`, and the result returns for the model to process. The spec recommends that applications let a human deny calls and show tool-use/confirmation UI. **Inference:** An MCP server can invoke a local browser adapter or a separate Developer API adapter and return a plan, but MCP defines no server-side directive for choosing Antigravity’s next model or executor; that follow-on choice remains with the host/model integration. ([MCP Specification — Architecture](https://modelcontextprotocol.io/specification/2026-07-28/architecture), [MCP Specification — Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools))

### Terms and privacy constraints

**Consumer Gemini Apps:** Google’s Gemini Apps Privacy Notice (last updated 2026-11-16) says prompts and related data are used to provide, maintain, and improve/develop services; some data may be reviewed by humans. It advises against entering confidential information one would not want a reviewer to see or Google to use to improve services. It also says that turning off Gemini History does not stop use needed to respond and protect the service, including human review. The notice states that the Google Terms of Service and Generative AI Prohibited Use Policy apply to Gemini Apps. ([Gemini Apps Privacy Hub](https://support.google.com/gemini/answer/13594961?hl=en))

Google’s general Terms of Service prohibit using automated means to access service content **when that access violates machine-readable instructions** on the page (for example, a robots.txt rule). This is a conditional restriction, not a blanket statement that all browser automation is prohibited. The product sources reviewed document human use of the Gemini web app and a programmatic Developer API; they do not document a supported external browser-automation interface for Gemini Apps. The latter is an observation about the documentation reviewed, not a finding that all automation is forbidden. ([Google Terms of Service](https://policies.google.com/terms?hl=en-US), [Gemini API docs](https://ai.google.dev/gemini-api/docs/models))

**Gemini Developer API:** Google’s Additional Terms distinguish unpaid and paid services. Unpaid AI Studio use and unpaid API quota may use prompts and outputs to improve/develop Google products and machine-learning technologies, and human reviewers may read/process them; Google says not to submit sensitive, confidential, or personal information to unpaid services. For Gemini API use through a Cloud Project with active billing, Google says it does not use prompts or responses to improve products and processes them under its Data Processing Addendum; it logs prompts/responses for a limited period for safety/security and legal or regulatory purposes. The terms say these paid data-use terms also apply to free services for users in the EEA, Switzerland, or UK. ([Gemini API Additional Terms](https://ai.google.dev/gemini-api/terms))

## Design impact

- Given the user-provided webchat requirement, an experimental user-visible browser adapter is the path aligned with current access. Antigravity's MCP support can expose the consultation tool, but Google's reviewed Gemini Apps docs do not document an external automation interface. Use only the visible web UI, never private endpoints or copied session credentials, and fail closed if model selection or page state cannot be verified.
- Keep the consumer Gemini Apps data terms prominent: prompts may be used to improve services and may be reviewed by people. Do not send confidential source code through that account unless its applicable account terms and settings explicitly permit it. The Developer API is a separate access path and is not the chosen route for this project.
- Antigravity's native Orchestrator already provides Neon/Carbon/Argon planning followed by Hydrogen implementation. It is a useful comparison, but it does not document using the user's selected Flash model as the executor. A custom MCP tool should be described as consultation, not guaranteed exclusive routing; the host still controls tool invocation and follow-up execution.

## Sources and dates

| Source | Source date shown | Accessed |
| --- | --- | --- |
| [Google AI for Developers — Gemini API models](https://ai.google.dev/gemini-api/docs/models) | No publication/update date shown | 2026-11-19 |
| [Google Gemini Help — About Gemini models](https://support.google.com/gemini/answer/18648722?hl=en) | No publication/update date shown; availability subject to change | 2026-11-19 |
| [Google Antigravity — MCP](https://antigravity.google/docs/mcp/) | No publication/update date shown | 2026-11-19 |
| [Google Antigravity — Choose a model](https://antigravity.google/docs/models/) | No publication/update date shown | 2026-11-19 |
| [MCP Specification — Architecture](https://modelcontextprotocol.io/specification/2026-07-28/architecture) | Version 2026-07-28 (shown as latest) | 2026-11-19 |
| [MCP Specification — Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) | Version 2026-07-28 (shown as latest) | 2026-11-19 |
| [Google Gemini API Additional Terms](https://ai.google.dev/gemini-api/terms) | Effective 2026-03-23 | 2026-11-19 |
| [Gemini Apps Privacy Hub](https://support.google.com/gemini/answer/13594961?hl=en) | Privacy Notice last updated 2026-11-16 | 2026-11-19 |
| [Google Terms of Service](https://policies.google.com/terms?hl=en-US) | No publication/update date shown | 2026-11-19 |


