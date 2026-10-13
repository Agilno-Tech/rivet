# Model providers

For task routing, [review detected defaults or describe your model and reasoning policy](#model-and-reasoning-policy) with `rivet models configure`. Rivet shows the mapping for approval before saving.

Rivet's registry distinguishes coding harnesses, hosted APIs, local models, and compatible endpoints. Model IDs are configured by the user rather than restricted to a list of product model names.

```sh
rivet models list
rivet models list --json
```

| Provider ID | Kind | Current execution status |
| --- | --- | --- |
| `claude-code` | Harness | CLI execution; installed capabilities and authentication required |
| `codex` | Harness | CLI execution; installed capabilities and authentication required |
| `anthropic` | Hosted API | One-shot text delegation adapter |
| `openai` | Hosted API | One-shot text delegation adapter |
| `gemini` | Hosted API | One-shot text delegation adapter |
| `ollama` | Local models | One-shot text delegation adapter |
| `openai-compatible` | Compatible API, including local endpoints | One-shot text delegation adapter |

These adapters have automated protocol and transport coverage; live provider qualification remains open. A listed provider is not a claim that its model was called or its account authenticated.

### Local provider detection

`models list` and `models configure` report local evidence for all seven providers. Claude Code and Codex use Rivet's existing executable and CLI compatibility probes. Other providers use these environment settings:

| Provider | Detection evidence |
| --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` is nonempty |
| OpenAI | `OPENAI_API_KEY` is nonempty |
| Gemini | `GEMINI_API_KEY` or `GOOGLE_API_KEY` is nonempty |
| Ollama | `OLLAMA_HOST` contains a supported endpoint |
| OpenAI-compatible | `OPENAI_BASE_URL` contains a supported endpoint |

Detection shows evidence names, never credential values. It does not contact API endpoints, validate authentication, list account-accessible models, or scan for local servers. Missing evidence means *not detected*, not unsupported. API and local providers remain available for text delegation; task execution uses Claude Code or Codex.

## Validate a profile

Create a JSON file:

```json
{
  "provider": "ollama",
  "model": "your-installed-model",
  "endpoint": "http://localhost:11434",
  "timeoutMs": 30000,
  "maxOutputTokens": 2048
}
```

```sh
rivet models check --profile=./model-profile.json --json
```

This validates configuration locally and reports execution readiness separately. It does not contact the endpoint or run a model. Hosted profiles may name a credential environment variable using `credentialEnv`; never store the credential value in the profile. HTTPS is required except for explicitly supported loopback endpoints.

## Delegate one text request

```sh
rivet models delegate "Review this approach and identify risks" --profile=./model-profile.json
```

Run in an interactive terminal. Rivet displays the exact prompt, provider, model, destination and limits before asking for approval. Approval expires after 30 seconds. It rereads the profile before dispatch and stops if it changed. Only the supplied prompt is sent; Rivet does not collect project files or start another coding harness. Keep secrets out of prompts and shell history. Credential-shaped prompts are conservatively rejected, which can also reject example assignments that resemble secrets.

The returned text is **unverified advice**. It is displayed, never executed or recorded as successful project verification. Terminal control characters are removed from displayed responses. Ctrl+C cancels approval or the request. A cancelled or failed request is not retried; a provider may already have received it and charged usage.

Hosted profiles require `credentialEnv` naming an existing environment variable. For example:

```json
{
  "provider": "openai",
  "model": "your-model-id",
  "credentialEnv": "OPENAI_API_KEY",
  "timeoutMs": 60000,
  "maxOutputTokens": 2048
}
```

| Provider | Wire protocol and endpoint |
| --- | --- |
| `anthropic` | Messages at `https://api.anthropic.com/v1/messages` |
| `openai` | Responses at `https://api.openai.com/v1/responses`, with storage disabled |
| `gemini` | GenerateContent at `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent` |
| `ollama` | Chat at explicit loopback base, such as `http://localhost:11434`; appends `/api/chat` |
| `openai-compatible` | Explicit public HTTPS or loopback HTTP base, such as `http://localhost:8080/v1`; appends `/chat/completions` |

Hosted services use their fixed origins. For compatible endpoints, `credentialEnv` is optional; set it if authentication is required. HTTP is limited to `localhost`, `127.0.0.1` and `[::1]`, pinned to loopback. Loopback HTTPS, private network endpoints and redirects are unsupported. Public HTTPS uses validated and pinned DNS addresses.

### Limits and current scope

- Explicit `timeoutMs` from 1 to 120000 and `maxOutputTokens` from 1 to 1000000 are required. The chosen model may support a smaller output limit.
- Prompts are limited to 64 KiB, response bodies to 1 MiB and returned text to 256 KiB.
- Only complete text responses with valid reported usage are accepted. Tool calls, refusals, truncation and incomplete responses fail. Usage is provider-reported, not independently measured or a billing guarantee.
- `maxCostUsd` profiles can be validated by `models check`, but direct delegation rejects them because monetary limits cannot currently be enforced. No currency budget is silently ignored.
- `--json` and unattended delegation are unavailable. There are no automatic retries, fallback models, tool calls or streaming output.
- Arbitrary model names are allowed, but a model must support this provider's request and response contract. This does not promise compatibility with every model or server version. Both requested and reported model identities are retained by the runtime.

Explicit role selection is described below. Live API/local account testing and broader workflow integration remain incomplete.

## Select a model or harness by role

Keep reusable profiles and role choices in a JSON file, for example `model-roles.json`:

```json
{
  "schemaVersion": 1,
  "profiles": {
    "local-review": {
      "provider": "ollama",
      "model": "your-installed-model",
      "endpoint": "http://localhost:11434",
      "timeoutMs": 30000,
      "maxOutputTokens": 2048
    }
  },
  "roles": {
    "review": { "kind": "text", "profile": "local-review" },
    "implementation": { "kind": "harness", "harness": "codex" },
    "planning": { "kind": "active-harness" }
  }
}
```

```sh
rivet models role --roles=./model-roles.json --role=review --json
rivet models delegate "Review this approach" --roles=./model-roles.json --role=review
rivet models delegate "Add a greeting module" --roles=./model-roles.json --role=implementation
```

Inspection validates the whole file locally and reports the selected target without calling a model. Role and profile names use lowercase letters, digits and hyphens, beginning with a letter. Each map holds at most 64 entries; the file is limited to 64 KiB. Unknown fields, invalid targets and missing profile references are rejected.

An unassigned role defaults to `active-harness`. That selection starts no account request or nested process: the command tells you to continue using the Rivet workflow in your current harness. It does **not** perform the task or claim it completed.

A `text` role uses the same prompt preview, approval and bounded advisory response described above. A `harness` role explicitly selects `claude` or `codex` and runs the existing terminal task workflow, with capability discovery, plan approval, isolated checkout, dependency approval and recorded checks. Run inside your configured project, or supply `--project=<path>` for a harness role. Harness tasks retain the existing 4,000-byte task limit and installed CLI/authentication requirements. Text roles do not read project files.

The selected role, referenced profile and target are reread across approval. Changes stop dispatch or activation. An unavailable target fails without switching to another model. Delegating to a different harness requires an installed CLI; desktop applications alone do not provide a spawned executor.

These are explicit role delegation operations. The file is not automatically loaded by `rivet run` or used to assign individual nodes inside an existing workflow. A harness role delegates the whole task through the current workflow. Worker harness routing is configured separately below. Live cross-harness/API demonstrations remain open; fixture tests do not qualify a real provider account or desktop host.

## Choose a harness for workflow workers

For terminal feature workflows, add `harness: claude` or `harness: codex` to the existing worker role in `.rivet/orchestration.yaml`. For example, the relevant fields of your existing role become:

```yaml
id: implementation-worker
kind: worker
harness: codex
# Include the role's existing capacity, delegation, authority,
# permissions, budget and completion-profile fields.
```

Then start a task with the planning harness you want:

```sh
rivet run "Add a greeting module" --harness=claude
```

In this example Claude plans the work and Codex executes the worker nodes. The compiler selects its existing boss/manager/worker role chain; every worker node from that decomposition uses the selected worker role's configured harness. Without `harness`, workers use the run's selected harness as before.

Rivet records the worker executor and its client limits in the exact plan you approve. The terminal preview shows these assignments, and both installed CLIs must pass capability checks. A changed role selection invalidates the existing plan at activation or resume. An unavailable executor blocks work without switching providers. Workers retain the same scoped launch contract, isolated worktree, result validation, evidence requirements and project checks.

The optional field applies to worker roles. Boss and manager nodes retain their existing governance responsibilities and human approval gates. Active-host workflows reject a configured spawned-worker override; remove that override to work entirely through the active agent. API/local text profiles remain advisory and cannot execute implementation nodes.

This setting selects a CLI adapter. It does not select arbitrary per-node model IDs, assign a different model to every role, or qualify desktop app execution. Claude's existing bounded client profile still applies when Claude is selected as a worker. Cross-harness fixture coverage is automated evidence; live cross-harness and desktop demonstrations remain incomplete.

## Extending the registry

`src/models/registry.js` exports `createModelRegistry()`. Register an adapter descriptor with a stable ID, protocol, kind, capabilities, and implementation status, then resolve profiles against it. Registration rejects duplicate IDs and unsupported profile fields. Descriptors are immutable copies.

Registering metadata does not install an executor. Custom executors, broader role routing and live qualification require additional implementation and testing.

## Model and reasoning policy

Start with detected defaults from a configured project:

```sh
rivet models configure
```

Rivet detects installed Claude Code and Codex harnesses and shows local configuration evidence for the other supported providers. A saved routing policy takes precedence. For a new policy, choose a harness if both are installed, then review or edit the proposed routes before approving the save. This defaults flow makes no model call.

Claude defaults use `opus` for coordination and independent review, `sonnet` for implementation, and `haiku` for bounded fixes, with high requested reasoning. These are [Claude Code model aliases](https://code.claude.com/docs/en/model-config), resolved by the provider rather than pinned model versions. For Codex, Rivet reads the saved model from `$CODEX_HOME/config.toml`, or `~/.codex/config.toml` when `CODEX_HOME` is unset. `RIVET_CODEX_MODEL` remains an optional override. The preview identifies the source, and the initial proposal reuses the detected model across the four routes. Rivet asks for a model ID only when it cannot resolve one. You can change the proposal before saving. Use `--harness=claude` or `--harness=codex` to select the initial harness when creating a policy; an existing policy still takes precedence.

Codex detection reads only the saved user configuration; it does not infer the model selected in another running chat, one-off CLI flags, or project, system and cloud overrides. A selected legacy `[profiles.<name>]` model takes precedence over the top-level model; a valid selected profile without a model inherits the top-level value. Rivet does not choose among unselected profiles. Missing, unreadable, malformed or unsafe configuration falls back to a prompt without displaying the file contents. Only the model ID is proposed; provider and authentication settings are not imported, and Rivet keeps its requested reasoning policy. No Codex configuration is changed. The detected model is copied into the routing proposal for your approval; future Codex setting changes do not silently change the saved Rivet policy. See [Codex configuration](https://developers.openai.com/codex/config-basic).

Or describe your preferences in plain language:

```sh
rivet models configure "Use high reasoning throughout. Use Astra or Opus for coordination, technical decisions and independent review; Sol for substantial implementation and complex debugging; Luna for bounded fixes, focused tests and investigations."
```

Rivet uses an installed Claude Code or Codex CLI to propose the mapping. If both are available, choose the translator interactively or pass `--harness=claude` or `--harness=codex`. The translator is separate from the models you choose for future tasks. This command makes a bounded model call using that CLI's existing account.

The flow is:

1. Describe the policy.
2. Resolve alternatives and any model names that need an exact harness/model ID. Existing configured profiles and the known Claude aliases can be reused. Rivet asks about unknown nicknames instead of substituting another model.
3. Review all four routes, their exact models and reasoning levels, and any interpretation of your description.
4. Approve the mapping to save it in `.rivet/orchestration.yaml`, or decline to leave configuration unchanged.

For the example, coordination and technical decisions map to `coordination`, independent review to `independent-review`, substantial implementation and complex debugging to `implementation`, and bounded fixes, focused tests and investigations to `bounded-fix`. These remain the four existing task classes. The planner selects a work item's class, and you review it with the task plan.

Rivet preserves your existing machine/session limits and unrelated configuration. When adding the first managed policy, it shows the default limits with the mapping. The translator cannot grant permissions or change task budgets. Configuration changes during review require a fresh proposal rather than overwriting newer edits.

Saving a policy does not start work, approve a task or switch an account. Review and commit the configuration before starting a new task. Existing approvals retain their pinned policy; they are not silently updated. Model IDs and supported reasoning options must be available to the executing harness. A translated mapping is not a live availability check, and there is no automatic fallback between models.

### Configuration reference

An optional version 1 `executionPolicy` in `.rivet/orchestration.yaml` defines named harness profiles and four explicit routes: `bounded-fix`, `implementation`, `independent-review`, and `coordination`. Profiles contain `harness`, `model`, `effort`, and `capabilities`. Coding routes require `read`, `edit`, and `commands`; review and coordination profiles permit only `read`. These are requested capabilities, subject to executor qualification, not proof of provider availability.

The plan compiler records policy and profile digests alongside each worker's classification, model, effort, capabilities and selection reason. An optional work-item `executionClass` selects `bounded-fix` or `implementation`; omission means `implementation`. The manager receives the coordination recommendation. Host plans mark selections `recommendationOnly: true`; recording a recommendation does not spawn an agent. Direct independent review uses the review route; the route does not add a review node by itself.

Policy changes, including wider machine limits or changed session settings, invalidate the saved managed plan at activation or resume. Node budgets and authority remain bounded by existing roles and approval identity. There is no implicit model fallback or escalation route. Effort syntax is bounded; actual model, effort and tool support must be checked by the executor before dispatch. Managed terminal planning, worker execution and independent review pass the selected model and effort to their CLI adapters. Bounded session handoffs and automatic managed-task admission use the same policy. Feature workers within one task remain sequential; see [managed orchestration](./orchestration.md) for operational limits and qualification.

When `executionPolicy` is absent, legacy serial plans and the fixed Claude profile remain unchanged. The existing `enabled: false` field keeps its legacy meaning; it is not a managed-execution switch.
