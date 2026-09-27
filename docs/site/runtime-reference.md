# Runtime reference

This describes the current alpha runtime, including the active-harness workflow available through the `rivet work` commands.

## Project policy and diagnostics

Run `rivet --help` for command syntax. `rivet init --project=<path>` previews project policy; `--write` creates reviewed `.rivet` configuration. `rivet preflight --project=<path>` reports orchestration readiness; `--mode=host` checks host repository, tool, and script readiness without requiring a private goal or unused provider credentials. `rivet doctor --project=<path>` reports general project readiness.

Node.js 22 or 24 runs Rivet itself. The application can use another language and does not need a `package.json`. Existing Node project configuration uses schema version 1, where each logical command is one three-token package-manager invocation, or schema version 2 for structured package-script steps:

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

For interactive terminal use, `rivet run "task"` finds the configured Git root from the current directory, discovers a compatible installed Claude or Codex adapter, shows the complete bounded plan and required checks, and asks for approval before execution. When both adapters are eligible, Rivet offers a choice in the same terminal flow. `--harness=claude|codex` selects one directly. `--project=<path>` is only needed outside the project or to choose a root explicitly. `rivet task status` selects the sole active run in that project and shows the next action and verification evidence. `rivet task resume` continues an approved or blocked spawned run; it does not duplicate one marked running. Before a spawned Worker starts, Rivet shows the configured dependency installation commands and asks for separate approval; accepted integration preparation has its own approval. `rivet task deps` applies the same approval to a clean active host Worker or accepted integration checkout. Multiple active runs require `--run=<id>`. These human commands keep the exact run ID, version, and proposal digest internal in the usual case. A ticket ID by itself is not accepted as an inline request.

The terminal flow needs a real interactive terminal for review; piped input cannot approve a plan. Direct adapters check required CLI options without a release allowlist; see [harness compatibility](#harness-compatibility). It uses the selected installed CLI and its existing authentication. It does not grant credentials or install a harness. Spawned verification records the accepted integration commit and a durable check report for both pass and failure. A failed check returns nonzero; an environment-only repair can be retried at the same unchanged commit. Final approval requires a matching report, runtime, and clean checkout. A spawned run marked running after an interruption needs process and state inspection before recovery because Rivet cannot prove the prior worker has stopped.

## Feature lifecycle

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

The same selected client performs planning and implementation. Planning is read-only; implementation is limited to its approved worktree. The current bridge runs one Worker at a time and uses fast-forward integration. Checkouts remain under the sibling `.rivet-worktrees` directory until deliberately cleaned up.

`work status` reads existing private state without preparing worktrees. Its `workerCheckouts` report identifies reserved and active Worker paths, expected/observed branches, edits and lease expiry, including interrupted preparation. See [task and checkout status](./statuses.md) for recovery guidance. It reports the integration path and branch, changed paths, worker claims, executed check results, blocked nodes when present, and a next action. Call `work next` with the current runtime version after an interruption to recover the same pending action. A failed check can be retried against the same unchanged commit after an environment or dependency repair; source corrections and blocked submissions need a new reviewed proposal. Dependencies must be prepared in the isolated checkout where they are needed: the active Worker path for editing, or the accepted integration path for verification. `rivet task deps` selects either eligible checkout from the private run and reservation state, validates its Git identity and dependency inputs, and asks for explicit approval. They are not copied from the original checkout or installed by Rivet's quality commands. Host preflight requires a clean checkout of the configured default branch and a fresh or ahead corresponding remote-tracking ref. It checks the same configured branch used for proposal admission.

Successful final approval status requires a coherent private verification report, accepted integration identity, runtime state, and clean checkout at the tested commit. Missing evidence is reported as undeliverable. After an interrupted host command, `rivet task recover` explicitly attempts safe recovery of abandoned host-operation, run, runtime and state locks. It selects the sole active host task; use `--run=<id>` when there are several. For a harness, use `rivet work recover <run-id> --project=<absolute-path> --json`. Recovery validates saved state and the current project configuration, requires an unchanged lock owner on this machine whose process is provably dead and whose lock is at least five minutes old, and preserves task snapshots and worktrees. It never resumes Workers. A blocked result can list locks already recovered before reaching another owner; inspect that result before retrying. There is no force option. See [interruption recovery](./troubleshooting.md#a-host-action-was-interrupted-or-blocked).

Local success stops at `awaiting-final-approval`. The feature workflow does not automatically push, merge, deploy or publish. Worker claims and a model's success message are different from executed checks; delivery still requires the relevant human decision.

## State and status

Run state belongs under Rivet's directory in the repository's Git common directory. `rivet status <instance-id>` serves the selected orchestration instance on loopback. Treat its session URL as private. An explicit `--fixture=<tracked-relative-path>` is for synthetic status inspection; it does not execute work or prove live-provider compatibility.

## What is retained

Generic project/evidence templates, protocols, schemas and runtime safety checks remain part of the framework. The conference application generator and recording/rehearsal tooling have been removed. Synthetic test fixtures are development-only and are excluded from the npm package.


## Harness compatibility

Rivet checks CLI capabilities instead of requiring a specific release. Before a spawned task, bounded version and help probes verify the installed executable and required options. Claude uses `--help`; Codex uses `exec --help`. Selection records the observed version and checks it again before launch. Advanced explicitly configured clients detect their installed version unless their caller supplies an optional `expectedVersion` consistency check.

Claude requires print mode, text input, JSON output, no session persistence, model/effort selection, permission modes, tool restrictions, JSON schema, and a cost limit. Codex requires exec, ephemeral execution, ignored user configuration, color control, and sandbox selection. Each launch also checks its selected optional flags. Rivet never drops required safety flags. Executable identity checks, cancellation, output limits, and strict result validation still apply.

Help checks establish advertised options; they cannot prove unchanged semantics, authentication, model availability, or future output formats. Incompatible results fail validation. Tested releases are evidence, not an allowlist: prior fixtures cover Claude `2.1.207` and Codex `0.148.0-alpha.9`; small authenticated macOS terminal trials completed with Claude `2.1.274` and Codex `0.155.0-alpha.16`. Regression tests also exercise unfamiliar version labels.

Spawned process adapters currently support macOS and Linux. Native Windows execution is not supported; an app running on Windows does not remove that runtime limit. WSL needs its own compatible environment and qualification.

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

**Current alpha limitation:** direct JSON removes the temporary input writes that blocked earlier noninteractive host trials. Private Git state and sibling worktrees still require permission. Use normal operation approvals for those exact operations, or the terminal `rivet run` flow if permissions cannot be granted. Automated host lifecycle coverage is not live desktop qualification; full real-harness and fresh-user trials remain open.


### Host proposal input format

`--request-text` requires Markdown with a `# Title` and a nonempty `## Acceptance Criteria` bullet list. The active harness converts the user's request into this format. It must preserve the requested scope rather than inventing criteria.

`--decomposition-json` contains exactly `schemaVersion: 1`, `kind: "agilno.feature-decomposition"`, and `workItems`. Each of 1–16 work items has `objective`, `ownedPaths`, and `acceptanceCriterionIndexes`. Indexes start at one and must cover every request criterion. Owned paths list files to change, not files merely read. Roles, commands, budgets, and approval gates come from project policy and are not decomposition fields. The installed Rivet skill includes a complete example.
