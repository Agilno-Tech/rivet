# Runtime reference

Start with [Getting started](./getting-started.md) or the [five-step orchestration guide](./orchestration.md). This page contains configuration contracts, advanced commands and recovery details for the current alpha runtime.

Find a reference:

- [Execution policy](#execution-policy-contract), [manual configuration](#managed-execution-configuration) and [model detection](#model-detection-and-routing-details).
- [Deadlines and capacity](#task-deadlines-and-capacity), [parallel work](#parallel-work-within-a-task) and [machine diagnostics](#machine-wide-diagnostics).
- [Host actions and handoffs](#managed-session-checkpoints-and-handoffs).
- [Batch verification](#verification-batch-configuration), [exact-result reuse](#optional-verification-reuse) and [cleanup](#completed-work-cleanup).
- [Provider profiles and text delegation](#model-providers-and-delegation).

## Versions and updates

`rivet --version` reports the running package version. `rivet update` updates the global CLI and current configured project; use `--global` or `--project` to choose one scope, and `--check` for a read-only inspection. `--json` provides structured results. See [Updating Rivet](./updating.md).

## Project policy and diagnostics

Run `rivet --help` for command syntax. `rivet init --project=<path>` previews project policy; `--write` creates reviewed `.rivet` configuration. `rivet preflight --project=<path>` reports orchestration readiness; `--mode=host` checks host repository, tool, and script readiness without requiring a private goal or unused provider credentials. `rivet doctor --project=<path>` reports general project readiness.

Node.js 22 or 24 runs Rivet itself. The application can use any language with project-configured verification commands. Existing Node project configuration uses schema version 1, where each logical command is one three-token package-manager invocation, or schema version 2 for structured package-script steps:

```yaml
schemaVersion: 2
commands:
  build:
    steps:
      - {cwd: backend, argv: [yarn, run, build]}
      - {cwd: frontend, argv: [yarn, run, build]}
  test:
    steps:
      - {cwd: backend, argv: [yarn, run, test]}
```

Supported schema-v2 logical checks are `build`, `test`, `lint`, and `typecheck`; `typecheck` may invoke a package script named `typecheck` or `type-check`. Every required step must pass. Doctor and preflight verify the exact bounded directory, `package.json`, script, package manager, and executable resolved by the same runtime resolver, without executing project scripts. Runtime verification revalidates each exact package manifest before executing steps sequentially relative to the isolated integration worktree through the existing shell-free package-manager policy. New setup proposals never add `dev` as a quality gate; an existing valid schema-v1 configuration may retain its previously configured `dev` command or gate.

### Checks for any project language

Schema version 3 supports exact executable arguments without a Node package manifest. The following is the command portion of a Django project configuration:

```yaml
schemaVersion: 3
commands:
  check:
    steps:
      - {cwd: '.', argv: [python3, manage.py, check]}
  test:
    steps:
      - {cwd: '.', argv: [python3, manage.py, test]}
```

Supported logical checks are `test`, `check`, `build`, `lint`, and `typecheck`. The quality configuration must require at least one `test` or `check` gate; `build` is optional. Each step names an executable on `PATH` or a bounded `./` path relative to its `cwd`, exact arguments, and a safe relative `cwd` inside the isolated checkout. Arguments are passed directly, without a shell, expansion, or chaining. Shell executables and privilege wrappers are rejected. Review these commands as executable project policy. Doctor and preflight inspect the configured executables and directories without running the checks.

Setup proposes conventional commands for root Django `manage.py`, Python metadata identifying pytest, Go modules, and Cargo projects. Review those proposals for the actual application. When no checks are detected, interactive `rivet setup --write` asks for one verification command. For noninteractive setup or custom commands, provide argv arrays or step groups:

```sh
rivet setup --checks-json='{"test":["python3","-m","pytest"]}'
rivet setup --write --checks-json='{"check":{"steps":[{"cwd":"backend","argv":["python3","manage.py","check"]}]},"test":["python3","-m","pytest"]}'
```

`rivet init --project=<path>` also accepts `--checks-json`, with `--write` to publish the reviewed proposal. The JSON value is limited to 16 KiB. Existing valid setup configuration is preserved; edit its project and quality files together to change checks. Setup saves policy without installing application dependencies. Use the reviewed dependency plan below or the project’s documented environment procedure for each isolated checkout.

### Project dependency installation

Schema 3 can declare `dependencies` with `inputs`, `provides`, and ordered `steps`. Inputs are tracked repository-relative files whose contents bind the approval; `provides` names project-relative executables the plan creates. Steps contain exact `cwd` and `argv`, just like checks. Example project configuration fragment:

```yaml
dependencies:
  inputs: [requirements.txt]
  provides: [./.rivet-deps/venv/bin/python]
  steps:
    - {cwd: '.', argv: [python3, -m, venv, .rivet-deps/venv]}
    - cwd: '.'
      argv: [./.rivet-deps/venv/bin/python, -m, pip, --isolated, install, --require-virtualenv, --no-user, -r, requirements.txt]
```

Use `./.rivet-deps/venv/bin/python` as the Python executable in the quality checks for this plan. Setup proposes this layout for conventionally detected Python projects with root `requirements.txt`. Other layouts and tools require explicit review; Rivet does not infer every package manager or framework dependency procedure.

For a custom Node project using Yarn, an explicit plan can be supplied during setup:

```sh
rivet setup --checks-json='{"test":["yarn","run","test"]}' \
  --dependencies-json='{"inputs":["package.json","yarn.lock"],"provides":[],"steps":[{"cwd":".","argv":["yarn","install","--frozen-lockfile"]}]}'
```

Review the preview, then repeat with `--write`. This example is for Yarn Classic with an existing Yarn lockfile; do not create a second lockfile just to use it. Existing valid project policy is preserved by setup. Dependencies can also be configured with `rivet init --project=<path> --dependencies-json='<json>'` alongside the project checks.

`rivet task deps` prepares the active clean host Worker or accepted integration checkout after showing the exact plan for approval. Spawned tasks request equivalent approvals for their checkouts. Installation rechecks checkout identity and tracked inputs; a declined or failed installation does not become successful verification. The source checkout is not the installation target. A managed `.rivet-deps` directory gets its own ignore file only after approval; Rivet does not rewrite the source `.gitignore`.

Doctor and preflight can report `preparation-required` for missing executables declared in a valid dependency plan. This means preparation may proceed, not that checks ran. All required checks must still execute successfully against the accepted integration commit before final approval. Exact argv and checkout binding are not an operating-system filesystem sandbox: dependency tools can run installation code, so review their behavior and follow the repository’s environment policy.

Rivet supports two execution styles. Host mode lets the active coding harness plan and perform each sealed action without launching another model process. This is the portable path for Claude Code, Codex, Gemini CLI, OpenCode, editor agents, and future harnesses. Spawned mode can still launch the selected Claude or Codex client. For spawned mode, configure `RIVET_CLAUDE_EXECUTABLE` or `RIVET_CODEX_EXECUTABLE` to the canonical installed executable. During terminal harness discovery (`rivet run` and task resume), exact `#!/usr/bin/env node` entrypoints use the canonical native Node executable running Rivet when no interpreter override is set. Other script entrypoints and direct low-level client construction require explicit interpreter configuration. Discovery rejects project-local interpreters and still checks required CLI capabilities. Project checks use the exact executables configured by project policy. Legacy Node schemas use npm, pnpm, yarn, or bun package scripts; schema 3 also supports other toolchains. Setup does not install those tools or project dependencies.

For interactive terminal use, `rivet run "task"` finds the configured Git root from the current directory, discovers a compatible installed Claude or Codex adapter, shows the complete bounded plan and required checks, and asks for approval before execution. Saved coordination routing selects the harness; without saved routing, Rivet offers a choice when both adapters are eligible. `--harness=claude|codex` selects one directly. `--project=<path>` is only needed outside the project or to choose a root explicitly. `rivet task status` selects the sole active run in that project and shows the next action and verification evidence. `rivet task start` reviews and activates a saved terminal proposal. `rivet task resume` also offers review for a proposed terminal task, or continues an approved or blocked spawned run; it does not duplicate one marked running. Before a spawned Worker starts, Rivet shows the configured dependency installation commands and asks for separate approval; accepted integration preparation has its own approval. `rivet task deps` applies the same approval to a clean active host Worker or accepted integration checkout. Multiple active runs offer a numbered task selection in an interactive terminal; noninteractive use requires `--run=<id>`. Use `--details` with `run` or `task` for full graph/state identifiers. Successful terminal execution immediately offers final review; `task resume` reopens it for verified work. These human commands keep the exact run ID, version, and proposal digest internal in the usual case. A ticket ID by itself is not accepted as an inline request.

The terminal flow needs a real interactive terminal for review; piped input cannot approve a plan. Direct adapters check required CLI options without a release allowlist; see [harness compatibility](#harness-compatibility). It uses the selected installed CLI and its existing authentication. It does not grant credentials or install a harness. Spawned verification records the accepted integration commit and a durable check report for both pass and failure. A failed check returns nonzero; an environment-only repair can be retried at the same unchanged commit. Final approval requires a matching report, runtime, and clean checkout. A spawned run marked running after an interruption needs process and state inspection before recovery because Rivet cannot prove the prior worker has stopped.

## Feature lifecycle

Use `rivet --help` for everyday commands and `rivet --help --advanced` for the complete command reference. Existing `feature` and `work` lifecycle commands accept either the positional run ID shown below or `--run=<id>` / `--run <id>`. Use one form only. Project, version and proposal-digest requirements remain unchanged; proposal-creation commands do not accept a run selector.

The feature commands accept a Markdown request or configured Jira/Linear intake. `feature propose` produces a reviewable plan; `feature start` requires the exact reviewed proposal and current version. `feature status` reports progress. `feature resume` applies to spawned runs; host runs use the `work` commands. The CLI does not silently replace stale approvals or widen scope.

Direct ticket intake accepts `--acceptance-criteria '<user criteria>'` alongside `--ticket` on `work propose`, `feature propose` and `feature run`. Separate multiple criteria with newlines. Rivet retains their user origin separately from tracker criteria and includes them in the request digest. When both sources are empty, ask the user for criteria and retry; do not invent them. This option is invalid for Markdown, inline or MCP requests. See [tracker criteria](./integrations.md#direct-tracker-acceptance-criteria).

Host mode uses this lifecycle:

```text
rivet work propose --project=<path> --request-text=<text> --decomposition-json='<json>'
rivet feature start <run-id> --project=<path> --expected-version=<n> --proposal-digest=<digest>
rivet work prepare <run-id> --project=<path> --expected-version=<n>
rivet work next <run-id> --project=<path> --expected-runtime-version=<n>
rivet work submit <run-id> --project=<path> --expected-runtime-version=<n> --action-json='<json>' --result-json='<json>'
rivet work verify <run-id> --project=<path> --expected-version=<n> --expected-runtime-version=<n>
rivet work status <run-id> --project=<path>
```

Direct JSON inputs avoid temporary files and keep the Git baseline clean. Each inline JSON value is limited to 64 KiB of UTF-8. Pass it as one argument, preferably using a shell-free argument array; JSON serialization alone is not shell escaping. Existing `--decomposition`, `--action`, and `--result` file inputs remain available for project-contained files up to 128 KiB. Choose exactly one form per object; mixed file/inline submissions are supported. File path and runtime contract checks are unchanged. Credentials do not belong in payloads; command arguments can appear in history or process listings. Review and commit setup configuration and required scripts before proposing from a clean default branch. `work next` prepares isolated Worker checkouts and returns canonical launch/result contracts within the approved capacity. Legacy serial plans return one action; dependency-aware plans return an `actions` array as described below. `work submit` rejects stale actions, changed contracts, evidence mismatches, and edits outside the sealed paths before integration. `work verify` inspects the real integration commit and runs configured gates, then stops at final human approval. It stores a bounded private report for both passing and failed checks; failed checks return nonzero and do not advance the run to final approval.

By default, the selected CLI performs both planning and implementation. A configured worker harness can override the implementation client; see [worker routing](#choose-a-harness-for-workflow-workers). Planning is read-only; implementation is limited to its approved worktree. Plans with explicit dependencies can run independent Workers concurrently within approved capacity, checking each integration candidate before acceptance. Legacy plans retain serial fast-forward integration. Checkouts remain under the sibling `.rivet-worktrees` directory until deliberately cleaned up.

`work status` reads existing private state without preparing worktrees. Its `workerCheckouts` report identifies reserved and active Worker paths, expected/observed branches, edits and lease expiry, including interrupted preparation. See [task and checkout status](./statuses.md) for recovery guidance. It reports the integration path and branch, changed paths, worker claims, executed check results, blocked nodes when present, and a next action. Call `work next` with the current runtime version after an interruption to recover the same pending action. A failed check can be retried against the same unchanged commit after an environment or dependency repair; source corrections and blocked submissions need a new reviewed proposal. Dependencies must be prepared in the isolated checkout where they are needed: eligible Worker paths for editing, a pending candidate for its checks, or the accepted integration path for final verification. `rivet task deps` offers eligible checkouts from the private run and reservation state, validates its Git identity and dependency inputs, and asks for explicit approval. They are not copied from the original checkout or installed by Rivet's quality commands. Host preflight requires a clean checkout of the configured default branch and a fresh or ahead corresponding remote-tracking ref. It checks the same configured branch used for proposal admission.

Successful final approval status requires a coherent private verification report, accepted integration identity, runtime state, and clean checkout at the tested commit. Missing evidence is reported as undeliverable. After an interrupted host command, `rivet task recover` explicitly attempts safe recovery of abandoned host-operation, run, runtime and state locks. It selects the sole eligible host task or terminal task at final review; use `--run=<id>` when there are several or to select a completed task with an interrupted local approval. For a harness, use `rivet work recover <run-id> --project=<absolute-path> --json`. Recovery validates saved state and the current project configuration, requires an unchanged lock owner on this machine whose process is provably dead and whose lock is at least five minutes old, and preserves task snapshots and worktrees. It never resumes Workers. A blocked result can list locks already recovered before reaching another owner; inspect that result before retrying. There is no force option. See [interruption recovery](./troubleshooting.md#a-host-action-was-interrupted-or-blocked).

Successful execution stops at `awaiting-final-approval`. `rivet task approve` offers explicit local application or pull-request preparation. Local application requires unchanged committed policy and clean checkouts, fast-forwards the original default branch to the verified commit, records local acceptance and marks the run `completed`. It does not execute remote delivery gates. The feature workflow does not automatically push, merge, deploy or publish. Worker claims and a model's success message are different from executed checks; delivery still requires the relevant human decision.

## State and status

Run state belongs under Rivet's directory in the repository's Git common directory. `rivet status <instance-id>` serves the selected orchestration instance on loopback. Treat its session URL as private. An explicit `--fixture=<tracked-relative-path>` is for synthetic status inspection; it does not execute work or prove live-provider compatibility.

## Harness compatibility

Rivet checks CLI capabilities instead of requiring a specific release. Before a spawned task, bounded version and help probes verify the installed executable and required options. Claude uses `--help`; Codex uses `exec --help`. Selection records the observed version and checks it again before launch. Advanced explicitly configured clients detect their installed version unless their caller supplies an optional `expectedVersion` consistency check.

Claude requires print mode, text input, JSON output, no session persistence, model/effort selection, permission modes, tool restrictions, JSON schema, and a cost limit. Codex requires exec, ephemeral execution, ignored user configuration, color control, and sandbox selection. Each launch also checks its selected optional flags. Rivet never drops required safety flags. Executable identity checks, cancellation, output limits, and strict result validation still apply.

Help checks establish advertised options; they cannot prove unchanged semantics, authentication, model availability, or future output formats. Incompatible results fail validation. Tested releases are evidence, not an allowlist: prior fixtures cover Claude `2.1.207` and Codex `0.148.0-alpha.9`; small authenticated macOS terminal trials completed with Claude `2.1.280` and Codex `0.155.0-alpha.16`. Regression tests also exercise unfamiliar version labels.

Spawned process adapters currently support macOS and Linux. Native Windows execution is not supported; an app running on Windows does not remove that runtime limit. WSL needs its own compatible environment and qualification.

### Claude spending caps

Set optional overrides in the tracked `.rivet/project.yaml`:

```yaml
claude:
  planningMaxCostUsd: 3.50
  workerMaxCostUsd: 5
```

Omitting `planningMaxCostUsd` keeps the **$1 per planning call** default. Omitting `workerMaxCostUsd` keeps the **$2 per Worker launch** default. Each value must be a number from `0.000001` through `10000`, with at most six decimal places; zero does not mean unlimited. A planning repair call has its own cap, so the planning setting is not a cumulative task budget.

Rivet captures these limits in the proposal, displays them for approval, and passes them to Claude's `--max-budget-usd`. A Worker's effective limit is the lower of its captured ceiling and its approved allocation. Raising `workerMaxCostUsd` therefore does not override a lower orchestration budget. These settings apply to Claude even when a Codex planner delegates to a Claude Worker; they do not change Codex or host execution.

Commit configuration changes before proposing a task. Changing these settings invalidates the old policy match; create and approve a new proposal to use different limits. Existing saved profiles retain their original values, including the $1/$2 limits on older plans.

### Native usage and task budgets

Claude Worker results use the CLI's native `modelUsage` counters and `total_cost_usd`, rather than usage figures written by the model. Token totals include input, output, cache creation and cache reads across all reported models, including delegated agents. Missing or invalid native accounting stops the result. The native cost is a client-side estimate, not a billing receipt; see [Claude's usage documentation](https://code.claude.com/docs/en/agent-sdk/cost-tracking).

A measured overrun or native cost-cap stop records the observed usage and ends the task as `budget-exhausted`. It cannot accept success evidence or start another reconciliation. An operation already in progress may finish, but its result cannot advance an exhausted task to completion. Limits are checked against the approved allocation; counts are never clamped to make a task pass.

Large contexts can consume a token allowance even when cache use keeps the estimated cost low. Review the project's orchestration budgets and approve a new plan when a different allowance is needed. Existing approved runs keep their limits. Codex's current direct-result adapter still uses model-reported usage; those figures are estimates, not native usage measurements or billing guarantees.

### CLI and desktop host sessions

Host mode uses the current session's model and tools without checking its app or CLI version.

| Surface | Host workflow requirements |
| --- | --- |
| Claude Code CLI | Rivet skill, terminal/file tools, project access, operation permissions |
| Claude desktop Code tab, local session | Same requirements; open the repository in a coding session |
| Codex CLI | Rivet skill, terminal/file tools, project access, operation permissions |
| Codex app, local task | Same requirements; attach the repository and make the skill available |
| Ordinary chat or restricted remote session | An execution environment exposing those capabilities; chat alone is insufficient |

The [Claude desktop reference](https://code.claude.com/docs/en/desktop) describes local Code sessions, skills, and permission modes. The [Codex app features](https://developers.openai.com/codex/app/features) describe its coding environment. Product capabilities do not establish completed Rivet desktop qualification.

The host needs permission to invoke Rivet, edit the exact reserved checkout, write private Git state, create isolated worktrees, run checks, and present human approvals. `rivet preflight --mode=host --project=<path>` checks project readiness; it cannot prove the surrounding app grants every later operation.

**Host permissions:** private Git state and sibling worktrees require permission. Use normal operation approvals for those exact operations, or the terminal `rivet run` flow if permissions cannot be granted. Automated host lifecycle coverage is not live desktop qualification; full real-harness and fresh-user trials remain open.


### Host proposal input format

`--request-text` requires Markdown with a `# Title` and a nonempty `## Acceptance Criteria` bullet list. The active harness converts the user's request into this format. It must preserve the requested scope rather than inventing criteria.

`--decomposition-json` contains exactly `schemaVersion: 1`, `kind: "agilno.feature-decomposition"`, and `workItems`. Each of 1–16 work items has `objective`, `ownedPaths`, and `acceptanceCriterionIndexes`. Indexes start at one and must cover every request criterion. Owned paths list files to change, not files merely read. Roles, commands, budgets, and approval gates come from project policy and are not decomposition fields. The installed Rivet skill includes a complete example.

## Task decisions and review evidence

Use the task's decision record for design choices, assumptions and trade-offs that affect acceptance. Record the options considered, the reason for the selected option and supporting evidence. Material changes to scope or architecture need human approval; recording a decision does not expand the approved task.

```sh
rivet task decisions
rivet task decide --input=./review/decision.json
rivet task approve-decision --decision=<decision-id>
```

For example, record a bounded implementation choice without creating a file:

```sh
rivet task decide --input-json='{"id":"health-response","tier":1,"title":"Health response format","options":[{"id":"json","description":"Return a JSON object using the existing API convention"},{"id":"text","description":"Return plain text"}],"choice":"json","rationale":"The approved endpoint task follows the existing JSON API convention."}'
```

Choose the tier honestly; it does not grant additional task authority:

| Tier | Recorded behavior |
| --- | --- |
| 0 | Reuses a matching choice from the approved plan. Requires `approvedPlanDecisionId` referencing that existing decision. |
| 1 | Records an implementation choice within existing authority, without a new human approval. |
| 2 | Remains pending until explicit human approval. |
| 3 | Escalates the decision for human resolution; it also remains pending until explicit human approval. |

Use either `--input=<project-local-json-file>` (up to 128 KiB) or `--input-json=<serialized-json>` (up to 64 KiB), never both. Inline JSON avoids creating an untracked file on the clean source checkout. File examples above assume an already ignored private input directory; creating an ordinary untracked `review/` directory can make the source checkout dirty and block workflow checks. Keep private context and credentials out of inputs. `approve-decision` requires an interactive human confirmation; an agent must not pipe an answer or approve its own exception. Use `--run=<id>` when the task cannot be selected unambiguously.

Review the plan before execution and the accepted changes before delivery:

```sh
rivet task review --phase=plan
rivet task review --phase=final
rivet task review --input=./review/report.json
```

Without `--input`, the command exports the review context for the selected phase. With `--input` or `--input-json`, it records a structured reviewer judgment against the matching task, request, plan and commit/diff identity. Re-export context after those inputs change. A review for different source or a different plan does not approve the current task. Rivet does not automatically send source to another model or launch an independent reviewer. Use your approved reviewer or harness, inspect the report, then submit it. The same mutually exclusive file/inline input limits apply; prefer inline input when a file would dirty the approved source checkout.

Configure review requirements in `.rivet/quality.yaml` and commit the policy before proposing a task:

```yaml
review:
  required: true
  maxRounds: 3
  strictCoverage: true
  reviewers:
    - id: security-reviewer
      paths: ["src/auth/**"]
      required: true
```

The exported context includes `reportTemplates` and reviewer path assignments in `review.reviewerPaths`. Start with the template for the assigned reviewer and preserve its exact task, request, plan, commit and diff identities. Templates deliberately begin with `status: FAIL`, `blocking: true`, empty coverage and a finding stating that review has not happened.

Complete the review before submitting: replace the reviewer actor placeholder with the actual independent reviewer identity; record reviewed files, executed commands and the review time; and map each acceptance criterion by its one-based `criterionIndex` to assigned `planNodeIds`, reviewed paths and test/manual evidence with a reference and summary. Record missing requirements, unrequested work and other problems as findings. Use `PASS` only after the required coverage is complete and no blocking finding remains. Editing the template to say `PASS` without performing the review does not produce valid evidence.

Review is opt-in: `required` defaults to `false`. The default review-round limit is three per task phase, across accepted revisions. Changing the commit does not reset that limit; only reports for the current commit satisfy the review gate. Assigned reviewers can complete the same round for that commit, including the final permitted round. Path rules select the required reviewer coverage; use reviewer identities that are independent of the implementation actors. A structured report supports an accountable review but does not itself prove that a separate person or model performed the work. Missing required coverage, unresolved findings or exhausted rounds require correction or human resolution, not a manufactured passing report.

## Optional changed-content checks

Add `contentScan` to `.rivet/quality.yaml` and commit the policy before proposing a task to scan changed committed content during verification. The scanner uses the accepted Git content, not a worker's description of its edits.

```yaml
contentScan:
  secrets: true
  unicode: warn
  maxFiles: 1000
  maxBytes: 2097152
  allowlist: []
```

The built-in secret checks look for private-key markers and high-confidence GitHub, npm and AWS credential patterns. Findings include the file, line and rule, without matched values or source snippets. Detection is limited to those patterns; passing this scan does not prove the absence of secrets.

Unicode checks flag bidirectional control characters and mixed Latin/Cyrillic/Greek identifiers in recognized code files. `warn` is the default; `required` makes those findings blocking and `off` disables Unicode checks. The identifier scan is a lexical heuristic, not a language parser. Ordinary multilingual prose, strings, mathematical text and emoji are not banned, and legitimate joiners are not blanket-rejected.

Exceptions must specify one exact relative file path, one known rule and a nonempty explanation. Wildcard suppression and arbitrary regular expressions are not supported. For example, a reviewed fixture containing a private-key marker can use:

```yaml
allowlist:
  - ruleId: private-key
    path: test/fixtures/key-marker.txt
    reason: Contains a marker only for a scanner regression test
```

The example is nested under `contentScan`. Do not use an exception to accept a real credential. Resource-limit failures and unreadable scan inputs require investigation rather than being treated as a pass.

Projects can also opt into the known `type-suppression` rule for explicit file paths through `shortcutRules`, with a reason and optional `required: true`. This reports `@ts-ignore` and `@ts-nocheck`; it does not establish whether every shortcut or placeholder is acceptable. Use existing configured command gates for broader tools such as Gitleaks, language-specific linters and project-specific checks. Rivet does not install or launch extra scanners implicitly.

## Execution policy contract

The optional `orchestration.executionPolicy` has `version: 1`, `mode: managed`, and these required fields:

| Field | Contract |
| --- | --- |
| `limits` | Positive integers up to 64 for `activeTasks`, `agentExecutions`, `workersPerTask`, `heavyVerification`, and `dependencyInstalls` |
| `profiles` | 1–32 named profiles with `harness` (`claude` or `codex`), a safe model identifier, explicit `effort`, and requested `capabilities` |
| `routing` | Exactly one profile ID for each of `bounded-fix`, `implementation`, `independent-review`, and `coordination` |
| `sessions` | `maxReplacements` (0–32), `maxActions` (1–10000), `maxMinutes` (1–1440), and `contextThresholdPercent` (1–99) |

The schema accepts effort labels `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`. Syntactic acceptance is separate from model/client support. The schema does not fill in model selections; `models configure` proposes defaults for human approval. Explicit routes must reference existing profiles, and advisory routes cannot request edit or command capabilities.

`rivet models configure ["policy"] [--harness=claude|codex] [--project=<path>]` proposes a recommended setup when policy text is omitted, with accept/customize choices before final approval. It reuses a saved policy first and lets you review or edit the proposed mapping without calling a model. Codex recommendations select visible Astra/Sol/Luna model IDs by role from the local `models_cache.json`, respecting advertised reasoning support. Saved Rivet routing and an explicit `RIVET_CODEX_MODEL` override take precedence. Missing families use the saved Codex model or an eligible catalog entry with a visible explanation; unresolved setups request manual input. The cached catalog is not a live access check. This is a setup-time suggestion, not discovery of an active chat or all effective Codex configuration layers. With policy text, it translates plain-language model/reasoning preferences through an installed harness, clarifies model alternatives and unresolved IDs, and presents the four existing routes for interactive approval. It updates `executionPolicy` and, when approved in the concurrency wizard, the worker role capacity together using a snapshot-bound atomic configuration edit. Decline, cancellation, invalid output or a changed configuration leaves the file unchanged. Existing limits/session settings are preserved; adding the first policy shows the defaults before approval. This does not execute a task or modify previously approved plans. See [model policy configuration](./models.md#model-and-reasoning-policy).

`resolveExecutionSelection` returns an immutable, versioned selection with policy/profile identity and a recorded reason; `executionPolicyIdentity` pins the complete policy in a proposal. Validation rechecks these identities against current configuration when loading a governed plan. The policy does not widen role budgets, create a second scheduler, or enable dispatch by itself. See [routing identity and compatibility](#routing-identity-and-compatibility) for legacy and host behavior.

### Managed model dispatch and session telemetry

When `orchestration.executionPolicy` is configured, the approved `coordination`
route selects the planning model and effort. Each worker uses its pinned execution
selection; distinct profiles on the same harness remain distinct executions.
Standalone PR reviews use the project's `independent-review` route. An explicit
review harness that conflicts with that route is rejected. Host selections remain
recommendations. Without an execution policy, the existing fixed client profiles
and serial workflow remain in effect.

Claude receives `--model` and `--effort`; Codex receives `--model` and a single
bounded `--config model_reasoning_effort="<level>"` setting. Rivet never accepts
arbitrary Codex configuration through an effort field. Required options are checked
against the installed executable's help before dispatch. Missing options fail;
there is no automatic model or account fallback. Requested effort is not a claim
about effective provider effort: model support and provider caps can reject or
clamp settings. See the [Claude CLI reference](https://code.claude.com/docs/en/cli-reference),
[Claude model configuration](https://code.claude.com/docs/en/model-config), and
[Codex configuration reference](https://developers.openai.com/codex/config-reference/).

Native adapters expose version 1 session telemetry through an optional
`onTelemetry` callback, awaited before completing the call. This side channel
preserves existing result-envelope readers. Every metric carries its value, source,
and assurance. Claude's native nested-agent totals are measured tokens and a
native cost estimate. Codex's current result-envelope tokens are model-reported;
its native cost is unknown (`null`). Missing telemetry and host measurements are
unknown, never measured zero. Native token totals are cumulative usage, not
current context occupancy; context usage and window size remain unknown.

The managed-dispatch checks use subprocess fixtures, including missing-option
failures, for planning, workers and reviews. Installed CLI help/version probes on
2026-10-12 covered Claude `2.1.280` and Codex `0.162.0-alpha.17.2`; these probes are
not authenticated execution or billing evidence. No live paid call was made for
this change.

## Managed session checkpoints and handoffs

### Host actions for dependency-aware plans

For plans with explicit work dependencies, `work next` returns `status: "actions"`, a current `runtimeVersion`, and an `actions` array. Handle each offer independently: only `action` authorizes dispatch; `queued` and `waiting` do not. A queued sibling does not block another admitted offer. `result-required` authorizes submission of completed work, never another execution. Legacy serial plans retain the single-action response.

Keep each issued action unchanged with its result. Submit using that action's issuance runtime version. Rivet permits unrelated peer progress only when the intent, payload, session generation and checkout ownership still match. Use the current runtime version for checkpoint and handoff mutations. With multiple active sessions, select the exact session and generation in handoff input; observation and release receipts already carry those fields.

Each successful worker result is checked in an isolated integration candidate before acceptance. If those checks fail or dependencies are missing, inspect `task status`, use `task deps` for approved candidate dependency setup, then retry the exact action and result. Do not edit or replace the pinned worker source and replay an old result. Candidate evidence does not replace final `work verify` or delivery approval.

These operations require an approved plan with `executionPolicy`. They preserve the worker checkout and pending edits; they do not commit a checkpoint. Sessions belong to the existing runtime launch intent. A replacement increments its generation and keeps the retry attempt, decisions, review rounds, and cumulative budget accounting.

`rivet task checkpoint --input=<file>` accepts this wrapper. The `action` is the complete action returned by `rivet work next`, without modifications:

```json
{
  "expectedRuntimeVersion": 12,
  "action": { "...": "the complete work action" },
  "input": {
    "summary": "Completed the parser; next run the focused regression checks. No unresolved blockers.",
    "usage": { "tokens": 1200, "costUsd": 0.03 },
    "nativeHandle": "native-child-reference",
    "actorId": "owning-host",
    "observedAtMs": 1791792000000
  }
}
```

The timestamp is the observation time in Unix milliseconds. Use the current value, not the example timestamp. Checkpoint observations must not precede the latest session observation. A host stop receipt must be at least as recent as the latest observation, checkpoint and persisted fence; an old receipt for the same handle is insufficient. Usage describes this session only. Optional `timeMinutes` and `tasks` must be nonnegative integers; reported time cannot reduce independently observed elapsed time. A checkpoint continues the same task, so an omitted `tasks` counts no additional task; explicitly reported nested tasks still consume the budget.

The equivalent machine-facing command is:

```sh
rivet work checkpoint <run-id> --project=<absolute-path> \
  --expected-runtime-version=<n> --action=<action.json> --input=<checkpoint-input.json> --json
```

For `work checkpoint`, the input file contains only the inner `input` object. Every file input stays within the project. `--input-json` and `--action-json` are bounded inline alternatives. Supply the current runtime version from each response.

The stored checkpoint binds the approved proposal and execution profile, worktree reservation, repository identity, HEAD, Git index, and a bounded digest manifest of dirty files. Staged and unstaged changes, untracked files, deletions, permissions and filesystem identities are retained. Changed content, HEAD, reservation, symlinks or replaced paths block transfer. The summary is private context, not new authority.

### Native host transfer

The owning harness performs its own native child-session operations. Rivet never sends terminal reset instructions to an unrelated conversation. Native receipts are **host-reported observations**, not cryptographic proof of independence or liveness. The first native handle and actor are bound to the current session; later operations cannot substitute them.

Call `rivet task handoff --input=<file>` with `{ "expectedRuntimeVersion": 13, "input": { "operation": "fence" } }`. This persists `stopping` before the host stops its old writer. Then use the owning harness's native stop/inspect tools and submit:

```json
{
  "expectedRuntimeVersion": 14,
  "input": {
    "operation": "stop",
    "receipt": {
      "sessionId": "session-returned-by-rivet",
      "generation": 1,
      "nativeHandle": "native-child-reference",
      "actorId": "owning-host",
      "observedAtMs": 1791792001000,
      "status": "stopped",
      "source": "host-observation",
      "assurance": "host-reported"
    }
  }
}
```

Report `status: "unknown"` if the harness cannot establish that the writer stopped. Unknown ownership retains the checkout and cannot transfer. A known stop settles usage exactly once, including before a replacement-cap refusal. After a known stop, submit `{ "expectedRuntimeVersion": 15, "input": { "operation": "transfer" } }`. Rivet revalidates the checkpoint and admits the next generation. Retrieve its fresh action with `work next`; do not resume the old writer. Late predecessor results cannot create a commit or integrate changes.

The machine-facing equivalent is `rivet work handoff <run-id> --project=<absolute-path> --expected-runtime-version=<n> --input=<handoff-input.json> --json`. Its file contains the inner `input` object. The phases are `active`, `checkpoint-requested`, `checkpoint-ready`, `stopping`, `stopped`, then the successor's `active`. An interrupted checkpoint can be observed again using the same action and current runtime version. Unknown ownership or interrupted Git reconciliation requires inspection; recovery does not authorize another writer. Each persisted phase survives restarting the command.

### Observations and bounded turnover

An active host may use handoff operation `observe` with a receipt containing `sessionId`, `generation`, `nativeHandle`, `actorId`, `observedAtMs`, `source: "host-observation"`, `assurance: "host-reported"`, cumulative `actions`, and `telemetry`. Actions and observation time must not decrease. Count observed Rivet actions; do not infer the provider's internal tool count. Telemetry has this shape:

```json
{
  "version": 1,
  "provider": "host",
  "tokens": { "value": null, "source": "unavailable", "assurance": "unknown" },
  "costUsd": { "value": null, "source": "unavailable", "assurance": "unknown" },
  "contextUsedTokens": { "value": null, "source": "unavailable", "assurance": "unknown" },
  "contextWindowTokens": { "value": null, "source": "unavailable", "assurance": "unknown" }
}
```

Known host observations use a nonnegative value, a bounded source label, and `assurance: "host-reported"`. Host input cannot label itself `native-measured`. Measured context turnover requires native measured occupancy and capacity from an executor; total consumed tokens are not context occupancy. Current CLI adapters report context as unknown. `task status` shows the session phase, generation, stop status, telemetry and turnover reason. Reaching an observed action/time boundary returns `checkpoint-required`; the host should request a cooperative checkpoint from its existing writer.

Owned CLI execution remains one-shot. Its managed launch contract explicitly permits `status: "checkpoint"` with the existing summary, evidence and usage envelope. A valid yield plus observed process-group termination creates a fresh bounded call from the verified checkpoint, in the same checkout and within the remaining budget. Legacy contracts reject this status. `retry` still means the existing retry policy. A time cutoff before a valid checkpoint blocks and preserves edits; it does not invent a successful checkpoint. CLI process receipts use a live owned-process nonce; after a crash, a bare PID is insufficient authority to signal or replace a writer. Native model calls and host tools were not exercised by the deterministic fixtures.

### Cooperative machine admission

Approved tasks with a managed execution policy join machine admission automatically before execution. `rivet run` and `rivet task start|resume` use the existing task and approval identity; no separate enrollment command or registration ID is required. The normal default is a one-hour execution allowance. `--for=90s|30m|1h` supplies a positive duration on those commands. It requires a managed policy. Rivet saves the resulting deadline; repeat execution and resume cannot extend it. A shorter explicit duration may reduce the remaining window.

The private store defaults to `~/.rivet-machine`; `RIVET_MACHINE_STATE_ROOT` selects an isolated existing-parent location outside Git. Read-only status, proposed or declined plans, and legacy tasks without managed policy do not automatically create it. Automatic run participation does not enroll unrelated projects or standalone planning/review calls.

`rivet task status` shows the selected task's capacity, deadline, paused state and waiting reasons. `rivet task pause` prevents new admission without killing a writer. `rivet task resume` restores eligibility within the original deadline and follows the existing workflow: terminal tasks may continue, while host tasks remain with their owning harness. Running spawned tasks cannot be duplicated through resume. Expired tasks may reconcile stopped work but require a new approved task for a new execution allowance.

Advanced `rivet orchestrate status --json` reports machine capacity and participating tasks without exposing registration IDs. `orchestrate limits --limits-json='{"activeTasks":4,"agentExecutions":4,"heavyVerification":1,"dependencyInstalls":1}'` changes machine ceilings when permitted by outstanding claims. Approved policy may only lower scoped limits. Registration and claim IDs, FIFO ordering and bounded watch ticks remain private runtime mechanics. No unrelated processes or repositories are scanned.

The owning executor's deadline aborts owned work and awaits lifecycle settlement. Unknown descendants retain capacity. Host agents use the normal `work` action protocol, including its queue and decision responses, rather than a second registration-based watch workflow. Shared admission never grants approval or changes the delivery boundary.

For a managed host action, use the existing `work handoff` observation receipt to identify the native writer. On normal completion, stop that writer and submit `{"operation":"release","receipt":<labelled stopped receipt>}` through `work handoff` (or `task handoff`). This checks the session, generation, native handle, actor and observed time, and durably records the stopped receipt in the session. Release returns the updated runtime version. If interrupted, read the current runtime version and retry release with the identical receipt; a changed receipt is rejected. Repeat `work next` at the returned runtime version to obtain the refreshed `result-required` action, then submit the result. That action is for result submission only: do not execute it again. Checkpoint replacement instead uses the existing fence → stop → transfer sequence; its validated stopped receipt also releases the old machine agent claim. A host active-task claim persists across these short CLI calls until verification or an idle blocked decision releases it.


## Managed execution configuration

An optional `orchestration.executionPolicy` selects a configured profile for coordination, implementation, bounded fixes and independent review. Each approved plan pins its policy/profile identity and explains the selection. Changed policy requires renewed plan validation. Absent policy preserves the existing serial workflow.

Configured model and effort values reach the selected Claude or Codex CLI as separate arguments. Missing support fails explicitly. Provider acceptance and effective effort remain provider-specific; an argument receipt alone does not prove that a provider used the requested effort. Rivet never switches accounts or silently substitutes a model.

Host actions show profile recommendations. A host tool receipt must distinguish requested settings from observed settings; Rivet cannot independently prove what an external desktop agent ran.

For manual configuration, add an `executionPolicy` to the existing `.rivet/orchestration.yaml`; keep its other fields, including `enabled: false`. Replace the example model IDs with models supported by your installed CLIs and account:

```yaml
executionPolicy:
  version: 1
  mode: managed
  limits:
    activeTasks: 4
    agentExecutions: 4
    workersPerTask: 2
    heavyVerification: 1
    dependencyInstalls: 1
  profiles:
    implementation:
      harness: codex
      model: your-coding-model
      effort: high
      capabilities: [read, edit, commands]
    review:
      harness: claude
      model: your-review-model
      effort: low
      capabilities: [read]
  routing:
    bounded-fix: implementation
    implementation: implementation
    independent-review: review
    coordination: review
  sessions:
    maxReplacements: 3
    maxActions: 100
    maxMinutes: 30
    contextThresholdPercent: 80
```

This example allows three replacements per node. Action and time bounds remain available when native context occupancy is unknown. Existing role budgets still apply across all generations. An approved managed task participates in shared machine capacity automatically when execution starts. There is no separate registration step.


## Task deadlines and capacity

Default ceilings are four active tasks, four agent executions, one heavy verification and one dependency installation. These are cooperative limits for participating Rivet processes. They do not measure or control unrelated applications. Approved project limits apply across active runs in the same project, while run limits may lower them further. Stricter limits from an active run remain in force until its held work settles; other projects retain their own limits. Task deadlines remain independent.

An agent slot represents an admitted Rivet executor invocation or host action. With a managed execution policy, initial planning and standalone `rivet review` also wait for project and machine agent capacity. Their internal operation allowance is two minutes, including queue time; cancellation while queued does not launch a model. Projects without a managed policy keep their existing behavior. Provider-internal tool calls are not independent machine measurements. Hosts must use the admission workflow for each action they dispatch.

The default execution allowance is one hour. `--for` requires a managed task and accepts a positive duration in seconds, minutes or hours, such as `90s`, `30m` or `2h`. It is available on `run`, `task start` and `task resume`. The deadline is saved when managed execution first starts. Restarting or resuming never extends it; an explicit shorter allowance may shorten it. An expired task needs a new approved task to receive a fresh execution allowance.

`task status` shows the deadline, paused state, capacity and waiting reasons. Rivet selects the current task automatically. If several active tasks exist, the interactive chooser asks which one; scripts can select the existing task with `--run=<run-id>`. No registration ID is needed.

Pause prevents new work from starting. It does not terminate an existing writer. Resume restores eligibility within the saved deadline and continues through the existing workflow. A host task stays with its owning coding harness; the terminal does not launch a second worker. The harness handles action and checkpoint receipts using Rivet's agent protocol.

Deadline expiry prevents new execution. It still permits recording an exact stopped receipt or reconciling a result from already admitted work. Cancellation removes queued and safely undispatched claims; dispatched work with unknown liveness retains its capacity. A running terminal or coding harness is required; closing the desktop application does not leave an always-on execution service.

Adding a managed policy to project configuration does not upgrade an older approval. Review a new plan before managed execution.


## Parallel work within a task

The planner can describe work items with stable IDs, dependencies and shared resources. Rivet validates the dependency graph and adds ordering for overlapping owned paths or shared resources. Review the resulting dependencies, scope and worker concurrency ceiling before activation. Without a managed policy the ceiling is one. Fresh interactive setup recommends two and aligns the worker role capacity with `executionPolicy.limits.workersPerTask`; the customization menu changes both together. Existing custom capacities are retained by default. Configured manager limits, parent limits and available machine slots still apply.

Each worker uses an isolated checkout. Completed work is merged into a separate integration candidate and checked with the project's configured quality gates before acceptance. A dependent starts only after its prerequisites have been accepted; unrelated workers can continue while that happens. If another worker advances the integration branch, Rivet rebuilds and checks the candidate against the accepted commit. Conflicts and failed checks preserve the checkout for inspection.

Use `rivet task status` to inspect worker checkouts and the accepted integration commit. For host-owned tasks, `rivet task deps` offers dependency setup in eligible worker or pending candidate checkouts. If candidate verification fails, the owning harness may retry the same recorded action and result after resolving the check environment. Changed source commits, results or session generations require reconciliation rather than replaying the old result.

Parallel acceptance does not skip final task verification or human approval. Candidate checks certify the exact combined commit; a worker's original branch is not independently certified by those checks.


## Machine-wide diagnostics

For advanced inspection and machine ceilings:

```sh
rivet orchestrate status --json
rivet orchestrate limits --limits-json='{"activeTasks":4,"agentExecutions":4,"heavyVerification":1,"dependencyInstalls":1}' --json
```

These commands complement task status. Approved policy limits may lower machine ceilings. Inspect outstanding work before changing ceilings. Expiry and parent-process death do not prove child processes stopped, so an uncertain owner keeps its capacity until reconciled.

The private coordinator lives at `~/.rivet-machine`. `RIVET_MACHINE_STATE_ROOT` selects a different private root, primarily for isolated environments. Participating processes must share the same root. Read-only inspection before the first managed task does not create coordinator state. Registrations and claim identities are implementation details; users operate on projects and tasks. Settled task history moves out of the active machine snapshot automatically. Task lookups retain their original deadlines, cancellation state and execution identities; compaction does not restart a task or release an uncertain owner. Machine diagnostics show active and recent records rather than an unlimited task history.


## Session continuity rules

A checkpoint preserves the task's approved scope, acceptance criteria, decision references, summary, usage and a verified manifest of the worker checkout. Dirty edits stay in that checkout; checkpointing does not commit them. The manifest binds the current HEAD, index, file contents, modes and identities. A changed checkout requires reconciliation before transfer.

The runtime records checkpoint preparation, fences the old generation, records the stop outcome, revalidates the checkout, and transfers ownership to a successor. Old results cannot commit or integrate after the generation changes. A crash during a transition leaves durable state for inspection; it does not silently launch another writer.

Replacement sessions retain the task's spending limits, retry count and review history. Session replacement has its own configured cap. A missing or uncertain stop receipt retains ownership and blocks transfer. A process ID or an expired heartbeat alone is not proof that a writer stopped.

Reliable measured context occupancy can trigger turnover. When it is unavailable, Rivet uses configured time bounds and observed action boundaries. These count Rivet actions, not hidden provider tool calls. A timeout before a valid checkpoint is a recovery condition, not a successful handoff.

The owning harness uses the checkpoint and handoff protocol for host sessions; normal users continue with `rivet task resume`. See the [exact input and receipt contracts](./runtime-reference.md#managed-session-checkpoints-and-handoffs). Owned CLI tasks yield at bounded call boundaries; these commands do not reset a running CLI process.


## Optional verification reuse

By default, Rivet runs the configured quality gates each time. Projects with reproducible, local checks can opt into sharing an exact passing result in `.rivet/quality.yaml`:

```yaml
verificationReuse:
  enabled: true
  reproducible: true
  dependencyRoots: [node_modules]
  toolchainRoots: [tools]
```

Replace these directories with the actual dependency and toolchain inputs used by the checks. Both lists must explicitly name existing checkout-relative directories. `reproducible: true` asserts that the checks do not depend on changing external services or undeclared local inputs. Leave reuse disabled when that cannot be established.

Reuse requires the same clean checkout and commit, loaded project configuration, commands, authority, environment, executables and declared input contents. Rivet fingerprints bounded inputs and keeps environment values out of the persisted records. Unsafe or oversized inputs, unsupported interpreter resolution, and gates that produce evidence artifacts bypass reuse and execute normally. Changed inputs invalidate the result.

Spawned tasks and host task verification use this policy automatically. Task verification reports include `verificationReuse`, such as `executed`, `reused`, `disabled`, or a reason reuse was bypassed. Concurrent callers share verification ownership; stopping a waiter does not stop the owner. Uncertain ownership never authorizes a second execution. Reuse certifies the same checkout and commit; it does not certify a different task branch or replace delivery CI.


## Accounting and qualification

Claude structured output provides native token accounting and a native cost estimate. Codex's current result envelope supplies model-reported tokens; cost is unknown. Context occupancy is unknown for both current adapters. Unknown values stay null with their source and assurance; they are not measured zero.

A fresh bounded invocation can continue a verified checkpoint. This does not imply arbitrary live compaction or provider-session reset support. Host tools have their own capabilities and trust boundary.

The managed fixture tests exercise lifecycle and admission mechanics using disposable Git repositories and subprocesses. Paid live-model execution, desktop child-session behavior and long unattended operation require separate qualification. Fixture checks do not establish token savings or production throughput.

On 2026-10-12, the two-worker fixtures in `test/runtime/feature-runtime-bridge.test.js` produced the following sample on macOS with Node 22.22.0. Times include disposable Git setup and simulated model work, and are not provider benchmarks:

| Fixture | Worker calls | Maximum concurrent workers | Installs | Verification commands | Elapsed |
| --- | ---: | ---: | ---: | ---: | ---: |
| Legacy serial | 2 | 1 | 2 | 3 | 9.1 s |
| Managed routing | 2 | 1 | 2 | 3 | 9.2 s |
| Managed, one successor per worker | 4 | 1 | 2 | 3 | 11.7 s |

The successor case preserves dirty work without repeating dependency installation or final verification. Native token/cost coverage is unmeasured in these fixtures. Separate tests exercise cross-project resource contention, restart with uncertain owners, and cancellation against real owned subprocesses. These qualify local mechanics, not an unattended live-model pilot.


## Completed-work cleanup

Run `rivet task cleanup --preview` to inspect owned Worker checkouts for a selected task. Completed or cancelled tasks need recorded proof that the owner stopped, an unchanged checkout identity, a preserved branch and a clean checkout. Protected Rivet install receipts permit removal of the exact owned `node_modules` and `.rivet-deps` directories; tracked files or unknown artifacts prevent removal. Unsafe or unproven checkouts are retained with a reason.

The preview removes nothing and is not approval for later deletion. Run `rivet task cleanup` to display the exact eligible checkout paths, branches and commits, then confirm removal interactively. Declining keeps everything. Noninteractive calls cannot approve removal.

Rivet rechecks the task, stopped owner generation, reservation, checkout identity, branch tip and clean working tree while holding the task and runtime locks. Removal preserves branches, commits and task evidence. A private journal records each approved checkout before removal, so an interrupted operation can be inspected and explicitly retried without adopting a replacement directory. Removed checkouts remain visible as removed with their branches preserved.

Integration and verification candidate checkouts are retained. Unknown ignored files, build outputs, foreign dependency directories, and older `.rivet-deps` directories with only a checkout marker are retained. Cleanup never deletes branch refs, commits, task evidence or global caches. The preview lists each protected dependency directory and its receipt identity. Interrupted artifact removal is journaled; a replacement directory cannot inherit the old approval.

To approve future cleanup separately, run `rivet task cleanup --retention=7d` (1–365 days). The confirmation covers this canonical project, its current configuration, eligible Worker checkouts and the two protected dependency roots. Declining changes nothing; `rivet task cleanup --retention=off` revokes approval. Configuration or project identity changes suspend the policy until you approve it again.

Retention is disabled by default. Approved retention runs only during foreground task resume/watch or host prepare/next-action operations. Discovery reads at most 256 task records; a sweep attempts removal from at most four eligible old tasks and eight checkouts, with a time limit checked between removals. Already-cleaned and ineligible tasks do not consume that removal allowance. Status and cleanup preview never delete anything. There is no background daemon. Busy owners, incomplete installer receipts and unknown contents remain untouched; foreground execution reports retained or removed outcomes.


## Verification batch configuration

For advanced customization, the equivalent `.rivet/quality.yaml` settings are:

```yaml
verificationBatch:
  enabled: true
  maxTasks: 3          # 2–5 task heads
  waitMs: 2000        # 1–30000 milliseconds
  maxIsolationTasks: 2 # 0–5 diagnostic singleton checks after failure
```

Run `rivet task verify --batch` to select from tasks that pass the current readiness checks, or use `--run=<task>` to enroll one task. Only selected, completed implementations with clean accepted integration heads can join. Paused, cancelled or expired task or project admission is excluded from the chooser. Listing reads existing state without refreshing admission or creating claims; dispatch rechecks readiness. The foreground command waits for the configured size or oldest queued deadline, including a singleton. It stops waiting when its bounded observation period ends; retry the command to continue queued work. There is no background service.

Compatible tasks share an exact baseline, configuration, gate definitions and environment identity. Rivet freezes membership, creates an isolated combined candidate, and runs configured checks there. Later arrivals join a later batch. Command execution uses ordinary machine admission without claiming a second outer heavy slot. Unknown running owners are retained for inspection and never reclaimed by timeout or missing PID.

A fresh candidate needs its own dependencies. Interactive `rivet task verify --batch` shows the exact isolated dependency installation for approval, then resumes the same frozen candidate. Diagnostic candidates can need their own approval. Declining or running noninteractively leaves installation pending; retry interactively later, or use `rivet task deps` followed by the batch command. Installation failures retain their diagnostic output and candidate for inspection. The foreground loop is bounded and never repeats an approval for the same candidate in one invocation; changed participant heads, cancelled tasks, configuration or baseline changes invalidate it. No dependency directories are copied between checkouts.

`rivet task status` shows the combined candidate, exact participant commits, criteria, checks and private report path. Failed combined checks can run the bounded number of singleton diagnostics; unchecked tasks remain explicitly untested. These reports are advisory: they do not advance any task, certify its original branch, satisfy independent review or replace ordinary final verification and delivery approval. Candidate checkouts and reports remain available for inspection.

Each retry runs fresh checks. If an isolation diagnostic needs dependencies, approving that install and retrying may repeat the combined check and earlier diagnostics; an older result is never reused merely because its candidate commit stayed the same.

Re-enrolling a ready task refreshes an older queued head. If its head or approval changed while a frozen batch was waiting for dependencies, Rivet blocks that old batch, preserves its evidence and enrolls the new head separately. Running owners are never replaced. Reports retain bounded diagnostic output separately from the compact queue index, so verbose commands cannot fill the ownership record.

Machine admission applies to every task in the frozen batch, including tasks enrolled by an earlier caller. A paused, cancelled or expired member prevents new checks and dependency installation. The earliest applicable task or project deadline bounds execution. Rivet rechecks the whole batch after waiting for command capacity and before publishing evidence, while each verification command still uses only one heavy-verification slot.


## Model providers and delegation

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

### Validate a profile

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

### Delegate one text request

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

#### Limits and current scope

- Explicit `timeoutMs` from 1 to 120000 and `maxOutputTokens` from 1 to 1000000 are required. The chosen model may support a smaller output limit.
- Prompts are limited to 64 KiB, response bodies to 1 MiB and returned text to 256 KiB.
- Only complete text responses with valid reported usage are accepted. Tool calls, refusals, truncation and incomplete responses fail. Usage is provider-reported, not independently measured or a billing guarantee.
- `maxCostUsd` profiles can be validated by `models check`, but direct delegation rejects them because monetary limits cannot currently be enforced. No currency budget is silently ignored.
- `--json` and unattended delegation are unavailable. There are no automatic retries, fallback models, tool calls or streaming output.
- Arbitrary model names are allowed, but a model must support this provider's request and response contract. This does not promise compatibility with every model or server version. Both requested and reported model identities are retained by the runtime.

Explicit role selection is described below. Live API/local account testing and broader workflow integration remain incomplete.

### Select a model or harness by role

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

### Choose a harness for workflow workers

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

### Extending the registry

`src/models/registry.js` exports `createModelRegistry()`. Register an adapter descriptor with a stable ID, protocol, kind, capabilities, and implementation status, then resolve profiles against it. Registration rejects duplicate IDs and unsupported profile fields. Descriptors are immutable copies.

Registering metadata does not install an executor. Custom executors, broader role routing and live qualification require additional implementation and testing.


## Model detection and routing details

Interactive `rivet setup --write` offers model routing as part of project setup: accept recommendations, customize, or skip it for later. To revisit the same wizard in a configured project:

```sh
rivet models configure
```

Rivet detects installed harnesses and proposes a complete setup. Choose a harness when both Claude Code and Codex are installed, then select **Accept recommendations** or **Customize**. Customize lets you change individual routes, models, reasoning levels and **Worker concurrency**. Fresh project setup recommends two concurrent workers and updates the selected worker role and policy together after approval. Existing custom capacities are preserved unless you explicitly change concurrency. The preview shows the effective project ceiling and remaining manager/execution limits; machine and parent limits can still reduce available slots. A final preview asks for approval before saving. A saved Rivet policy takes precedence and can be kept or customized. This setup flow makes no model call.

| Work | Codex recommendation | Claude recommendation |
| --- | --- | --- |
| Coordination and technical decisions | Detected Astra model | `opus` |
| Independent review | Detected Astra model | `opus` |
| Substantial implementation and complex debugging | Detected Sol model | `sonnet` |
| Bounded fixes, focused tests and investigations | Detected Luna model | `haiku` |

For Codex, Rivet reads the local `models_cache.json` under `$CODEX_HOME` or `~/.codex`. It selects exact visible model IDs from that catalog, preferring its priority and ordering within each family. It recommends high reasoning when advertised; otherwise it proposes the model's advertised default and explains the change. Cached metadata may be stale and does not prove current account access. Rivet does not refresh the cache or guess IDs for missing models.

If a family is missing, the preview explains the alternative: the configured Codex model, then an eligible catalog model. If neither is known, Rivet asks for an exact ID. `RIVET_CODEX_MODEL` remains an explicit override for all routes. The model editor offers detected models plus custom ID entry; known catalog models show their advertised reasoning options. Claude recommendations use [provider-resolved aliases](https://code.claude.com/docs/en/model-config), with high requested reasoning; they are not pinned model versions.

The configured Codex model comes from `$CODEX_HOME/config.toml`, or `~/.codex/config.toml`. A selected legacy `[profiles.<name>]` model takes precedence over the top-level model; a valid selected profile without a model inherits the top-level value. Rivet never chooses an unselected profile. Missing, unreadable, malformed or unsafe files are treated as unresolved without displaying their contents. Detection does not infer the model selected in another chat, one-off CLI flags, or project, system and cloud overrides. Provider and authentication settings are not imported. See [Codex configuration](https://developers.openai.com/codex/config-basic).

Use `--harness=claude` or `--harness=codex` to select the initial harness when creating a policy. Existing Rivet policies still take precedence. Recommendations and any alternatives are shown before approval; later catalog or Codex setting changes do not silently change a saved Rivet policy. Neither Codex configuration nor task execution is changed by previewing a setup.

Or describe your preferences in plain language:

```sh
rivet models configure "Use high reasoning throughout. Use Astra or Opus for coordination, technical decisions and independent review; Sol for substantial implementation and complex debugging; Luna for bounded fixes, focused tests and investigations."
```

Rivet uses an installed Claude Code or Codex CLI to propose the mapping. If both are available, choose the translator interactively or pass `--harness=claude` or `--harness=codex`. The translator is separate from the models you choose for future tasks. This command makes a bounded model call using that CLI's existing account.

The flow is:

1. Describe the policy.
2. Resolve alternatives and any model names that need an exact harness/model ID. Existing configured profiles and known Claude aliases can be reused. Astra, Sol and Luna resolve to an exact visible Codex catalog model when that family has a single match. Ambiguous versions and unknown nicknames require an exact choice; Rivet never invents a model ID.
3. Review all four routes, their exact models and reasoning levels, and any interpretation of your description.
4. Approve the mapping to save it in `.rivet/orchestration.yaml`, or decline to leave configuration unchanged.

For the example, coordination and technical decisions map to `coordination`, independent review to `independent-review`, substantial implementation and complex debugging to `implementation`, and bounded fixes, focused tests and investigations to `bounded-fix`. These remain the four existing task classes. The planner selects a work item's class, and you review it with the task plan.

Rivet preserves your existing machine/session limits and unrelated configuration. The concurrency editor changes only the selected worker role capacity and the per-task worker limit, in one approved write; it does not widen manager or machine capacity. When adding the first managed policy to existing configuration, the proposed worker limit matches its effective current capacity. A later `rivet run` reuses the saved coordination harness without asking you to select one again. If that harness is unavailable, execution stops; a conflicting `--harness` flag asks you to review a routing change through `models configure`. Projects without saved routing retain the harness chooser. The translator cannot grant permissions or change task budgets. Configuration changes during review require a fresh proposal rather than overwriting newer edits.

Saving a policy does not start work, approve a task or switch an account. Review and commit the configuration before starting a new task. Existing approvals retain their pinned policy; they are not silently updated. Model IDs and supported reasoning options must be available to the executing harness. A translated mapping is not a live availability check, and there is no automatic fallback between models.

### Routing identity and compatibility

An optional version 1 `executionPolicy` in `.rivet/orchestration.yaml` defines named harness profiles and four explicit routes: `bounded-fix`, `implementation`, `independent-review`, and `coordination`. Profiles contain `harness`, `model`, `effort`, and `capabilities`. Coding routes require `read`, `edit`, and `commands`; review and coordination profiles permit only `read`. These are requested capabilities, subject to executor qualification, not proof of provider availability.

The plan compiler records policy and profile digests alongside each worker's classification, model, effort, capabilities and selection reason. An optional work-item `executionClass` selects `bounded-fix` or `implementation`; omission means `implementation`. The manager receives the coordination recommendation. Host plans mark selections `recommendationOnly: true`; recording a recommendation does not spawn an agent. Direct independent review uses the review route; the route does not add a review node by itself.

Policy changes, including wider machine limits or changed session settings, invalidate the saved managed plan at activation or resume. Node budgets and authority remain bounded by existing roles and approval identity. There is no implicit model fallback or escalation route. Effort syntax is bounded; actual model, effort and tool support must be checked by the executor before dispatch. Managed terminal planning, worker execution and independent review pass the selected model and effort to their CLI adapters. Bounded session handoffs and automatic managed-task admission use the same policy. Independent workers within a task can run concurrently when the approved dependency graph and configured capacities allow it; plans without explicit dependencies remain sequential. See [managed orchestration](./orchestration.md) for operational limits and qualification.

When `executionPolicy` is absent, legacy serial plans retain their configured Claude spending caps. The existing `enabled: false` field keeps its legacy meaning; it is not a managed-execution switch.

Configured `project.claude` spending caps also apply when a managed route selects Claude from a Codex-started task. Rivet captures these caps in the approved plan, shows them alongside managed routing before activation, and requires renewed validation when they change.
