# Runtime reference

This describes the current alpha runtime, including the active-harness workflow available through the `rivet work` commands.

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

For interactive terminal use, `rivet run "task"` finds the configured Git root from the current directory, discovers a compatible installed Claude or Codex adapter, shows the complete bounded plan and required checks, and asks for approval before execution. When both adapters are eligible, Rivet offers a choice in the same terminal flow. `--harness=claude|codex` selects one directly. `--project=<path>` is only needed outside the project or to choose a root explicitly. `rivet task status` selects the sole active run in that project and shows the next action and verification evidence. `rivet task start` reviews and activates a saved terminal proposal. `rivet task resume` also offers review for a proposed terminal task, or continues an approved or blocked spawned run; it does not duplicate one marked running. Before a spawned Worker starts, Rivet shows the configured dependency installation commands and asks for separate approval; accepted integration preparation has its own approval. `rivet task deps` applies the same approval to a clean active host Worker or accepted integration checkout. Multiple active runs offer a numbered task selection in an interactive terminal; noninteractive use requires `--run=<id>`. Use `--details` with `run` or `task` for full graph/state identifiers. Successful terminal execution immediately offers final review; `task resume` reopens it for verified work. These human commands keep the exact run ID, version, and proposal digest internal in the usual case. A ticket ID by itself is not accepted as an inline request.

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

Direct JSON inputs avoid temporary files and keep the Git baseline clean. Each inline JSON value is limited to 64 KiB of UTF-8. Pass it as one argument, preferably using a shell-free argument array; JSON serialization alone is not shell escaping. Existing `--decomposition`, `--action`, and `--result` file inputs remain available for project-contained files up to 128 KiB. Choose exactly one form per object; mixed file/inline submissions are supported. File path and runtime contract checks are unchanged. Credentials do not belong in payloads; command arguments can appear in history or process listings. Review and commit setup configuration and required scripts before proposing from a clean default branch. `work next` creates one isolated Worker checkout and returns a canonical launch/result contract. `work submit` rejects stale actions, changed contracts, evidence mismatches, and edits outside the sealed paths before integration. `work verify` inspects the real integration commit and runs configured gates, then stops at final human approval. It stores a bounded private report for both passing and failed checks; failed checks return nonzero and do not advance the run to final approval.

By default, the selected CLI performs both planning and implementation. A configured worker harness can override the implementation client; see [worker routing](./models.md#choose-a-harness-for-workflow-workers). Planning is read-only; implementation is limited to its approved worktree. The current bridge runs one Worker at a time and uses fast-forward integration. Checkouts remain under the sibling `.rivet-worktrees` directory until deliberately cleaned up.

`work status` reads existing private state without preparing worktrees. Its `workerCheckouts` report identifies reserved and active Worker paths, expected/observed branches, edits and lease expiry, including interrupted preparation. See [task and checkout status](./statuses.md) for recovery guidance. It reports the integration path and branch, changed paths, worker claims, executed check results, blocked nodes when present, and a next action. Call `work next` with the current runtime version after an interruption to recover the same pending action. A failed check can be retried against the same unchanged commit after an environment or dependency repair; source corrections and blocked submissions need a new reviewed proposal. Dependencies must be prepared in the isolated checkout where they are needed: the active Worker path for editing, or the accepted integration path for verification. `rivet task deps` selects either eligible checkout from the private run and reservation state, validates its Git identity and dependency inputs, and asks for explicit approval. They are not copied from the original checkout or installed by Rivet's quality commands. Host preflight requires a clean checkout of the configured default branch and a fresh or ahead corresponding remote-tracking ref. It checks the same configured branch used for proposal admission.

Successful final approval status requires a coherent private verification report, accepted integration identity, runtime state, and clean checkout at the tested commit. Missing evidence is reported as undeliverable. After an interrupted host command, `rivet task recover` explicitly attempts safe recovery of abandoned host-operation, run, runtime and state locks. It selects the sole eligible host task or terminal task at final review; use `--run=<id>` when there are several or to select a completed task with an interrupted local approval. For a harness, use `rivet work recover <run-id> --project=<absolute-path> --json`. Recovery validates saved state and the current project configuration, requires an unchanged lock owner on this machine whose process is provably dead and whose lock is at least five minutes old, and preserves task snapshots and worktrees. It never resumes Workers. A blocked result can list locks already recovered before reaching another owner; inspect that result before retrying. There is no force option. See [interruption recovery](./troubleshooting.md#a-host-action-was-interrupted-or-blocked).

Successful execution stops at `awaiting-final-approval`. `rivet task approve` offers explicit local application or pull-request preparation. Local application requires unchanged committed policy and clean checkouts, fast-forwards the original default branch to the verified commit, records local acceptance and marks the run `completed`. It does not execute remote delivery gates. The feature workflow does not automatically push, merge, deploy or publish. Worker claims and a model's success message are different from executed checks; delivery still requires the relevant human decision.

## State and status

Run state belongs under Rivet's directory in the repository's Git common directory. `rivet status <instance-id>` serves the selected orchestration instance on loopback. Treat its session URL as private. An explicit `--fixture=<tracked-relative-path>` is for synthetic status inspection; it does not execute work or prove live-provider compatibility.

## Harness compatibility

Rivet checks CLI capabilities instead of requiring a specific release. Before a spawned task, bounded version and help probes verify the installed executable and required options. Claude uses `--help`; Codex uses `exec --help`. Selection records the observed version and checks it again before launch. Advanced explicitly configured clients detect their installed version unless their caller supplies an optional `expectedVersion` consistency check.

Claude requires print mode, text input, JSON output, no session persistence, model/effort selection, permission modes, tool restrictions, JSON schema, and a cost limit. Codex requires exec, ephemeral execution, ignored user configuration, color control, and sandbox selection. Each launch also checks its selected optional flags. Rivet never drops required safety flags. Executable identity checks, cancellation, output limits, and strict result validation still apply.

Help checks establish advertised options; they cannot prove unchanged semantics, authentication, model availability, or future output formats. Incompatible results fail validation. Tested releases are evidence, not an allowlist: prior fixtures cover Claude `2.1.207` and Codex `0.148.0-alpha.9`; small authenticated macOS terminal trials completed with Claude `2.1.280` and Codex `0.155.0-alpha.16`. Regression tests also exercise unfamiliar version labels.

Spawned process adapters currently support macOS and Linux. Native Windows execution is not supported; an app running on Windows does not remove that runtime limit. WSL needs its own compatible environment and qualification.

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

`rivet models configure ["policy"] [--harness=claude|codex] [--project=<path>]` proposes detected defaults when policy text is omitted. It reuses a saved policy first and lets you review or edit the proposed mapping without calling a model. Codex defaults use an explicit `RIVET_CODEX_MODEL` override, then the saved user model in `$CODEX_HOME/config.toml` (or `~/.codex/config.toml`), with manual input when unresolved. This is a setup-time suggestion, not discovery of an active chat or all effective Codex configuration layers. With policy text, it translates plain-language model/reasoning preferences through an installed harness, clarifies model alternatives and unresolved IDs, and presents the four existing routes for interactive approval. It updates only `executionPolicy` using a snapshot-bound atomic configuration edit. Decline, cancellation, invalid output or a changed configuration leaves the file unchanged. Existing limits/session settings are preserved; adding the first policy shows the defaults before approval. This does not execute a task or modify previously approved plans. See [model policy configuration](./models.md#model-and-reasoning-policy).

`resolveExecutionSelection` returns an immutable, versioned selection with policy/profile identity and a recorded reason; `executionPolicyIdentity` pins the complete policy in a proposal. Validation rechecks these identities against current configuration when loading a governed plan. The policy does not widen role budgets, create a second scheduler, or enable dispatch by itself. See [Models](./models.md#model-and-reasoning-policy) for legacy and host behavior.

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

For a managed host action, use the existing `work handoff` observation receipt to identify the native writer. On normal completion, stop that writer and submit `{"operation":"release","receipt":<labelled stopped receipt>}` through `work handoff` (or `task handoff`). This checks the session, generation, native handle, actor and observed time. Repeat `work next` at the current runtime version to obtain the refreshed `result-required` action, then submit the result. That action is for result submission only: do not execute it again. Checkpoint replacement instead uses the existing fence → stop → transfer sequence; its validated stopped receipt also releases the old machine agent claim. A host active-task claim persists across these short CLI calls until verification or an idle blocked decision releases it.
