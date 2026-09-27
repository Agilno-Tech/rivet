# Troubleshooting

## Git fails before planning

Rivet accepts standard installed Git binaries, including systems that give the same executable multiple hardlinked names. It still checks the executable path, permissions and file identity before use.

If Git cannot be found or used, the error now identifies Git and explains how to correct it. Normally Git on `PATH` is sufficient. If you explicitly configured `RIVET_GIT_EXECUTABLE`, ensure it names an existing canonical executable file, or remove the override to use discovery. Older versions may report only `Rivet runtime configuration is missing or invalid` for this failure. This occurs before Claude or Codex planning and does not, by itself, indicate a harness problem.

## The public install command does not resolve

No Rivet package has been published from this repository yet. Use the source installation instructions. The temporary package name does not establish ownership of a public namespace.

## Installation succeeds but rivet is missing

Run `yarn global bin` and ensure the returned directory is on your shell PATH, then verify `rivet --help`. These installation examples require Yarn Classic 1.22; modern Yarn does not provide `yarn global`. Reinstall using the [documented source command](./installation.md) if the installed binary is missing. Package-manager success alone does not prove the CLI is available.

## Setup cannot install the harness skill

Codex and other coding-agent sandboxes may protect their instruction directories, including `.agents/skills`. If installation reports a permission denial, run the reviewed `rivet setup --write` command from your regular terminal, or grant the exact operation through the harness's normal approval flow. Reload the harness afterward. Existing project configuration is preserved if skill installation stops partway through setup; inspect the reported partial state before retrying.

## A provider is listed but cannot execute

Run `rivet models list`. `planned` means the descriptor/profile contract exists but its executor is not implemented. `adapter-available` still needs runtime/authentication checks. Profile validation does not call a model.

## Project configuration is not recognized

Rivet uses `.rivet` and `RIVET_*`. Preview a fresh configuration with `rivet init --project=<path>` and review it before writing.

## A Python or other non-Node project asks for package.json

Node.js runs the Rivet CLI, but your application does not need a Node manifest. Older installations required `package.json` during discovery and could report its absence as `REPOSITORY_CONFLICT`. Update Rivet using the [installation instructions](./installation.md), then preview `rivet setup` in the project root. Do not add a dummy manifest as a workaround.

Django, pytest metadata, Go modules, and Cargo projects have conventional checks proposed for review. If no commands can be detected, interactive `rivet setup --write` asks for a verification command. A harness or automated setup can pass explicit arguments:

```sh
rivet setup --checks-json='{"test":["python3","-m","pytest"]}'
rivet setup --write --checks-json='{"test":["python3","-m","pytest"]}'
rivet doctor
```

Use the actual command your project runs. At least one required `test` or `check` is needed; a build command is optional. See [schema 3 checks](./runtime-reference.md#checks-for-any-project-language). Setup preserves existing valid policy, so review its project and quality files if they still contain unsuitable commands.

## A configured check cannot find its executable or dependencies

Read `rivet doctor` for the exact failing command and working directory. Make that executable available on the `PATH` used to launch Rivet. Checks execute in isolated checkouts, so prepare dependencies at the Worker or integration path shown by task status. Use `rivet task deps` for a configured dependency plan and approve its exact commands, or follow the project’s documented environment procedure. Generated Python setup uses the checkout’s `.rivet-deps/venv`. Rivet does not copy source dependencies or install packages through verification commands. `preparation-required` means the configured plan can create a missing executable; it does not certify successful tests.

## Both Claude and Codex are installed

Interactive `rivet run "task"` offers a choice between compatible installed adapters. Use `--harness=claude` or `--harness=codex` to choose directly. Older versions stopped with a choice error instead of prompting. A runtime configuration failure before planning does not establish a Claude or Codex failure; inspect the reported Git or project-check diagnostic first.

## Tests cannot open a local server

The status-server tests require loopback networking. A sandbox that prohibits listeners can fail these checks independently of application behavior. Run them in an environment that permits loopback, and record that environment with the result.

## A Claude task exhausts its token budget despite a low cost

Cached context still contributes to the token count. Rivet uses Claude's native counters, including repeated cache reads, and retains an overrun as `budget-exhausted`. Inspect task status, review the token and cost allocations in project orchestration policy, then create and approve a new plan if a larger allowance is appropriate. Resuming the same approved task does not increase its budget. See [native usage and task budgets](./runtime-reference.md#native-usage-and-task-budgets).

## A branch is already checked out

Run `rivet task status` to see reserved and active Worker checkout paths, expected branches and their registered locations. `git worktree list` also lists the repository's checkouts. Inspect and preserve existing edits; do not delete worktrees or force-reset branches to get past this error. See [task and checkout status](./statuses.md) for the observation meanings.

## Host preflight asks for a private goal

Run `rivet preflight --project=<path> --mode=host --json` for the host workflow. The default mode includes separate orchestration goal readiness. Commit reviewed setup files and required package scripts first; the first proposal requires a clean configured default branch.

## Verification fails after the Worker submitted

Run `rivet task status` inside the project, or `rivet work status <run-id> --project=<path> --json` for the full report. Its `verification` report identifies the tested commit, isolated integration checkout, changed paths, and executed checks. A failed `work verify` exits nonzero and keeps the run before final approval. For missing configured dependencies in the clean accepted integration checkout, run `rivet task deps`; review and approve its exact installation commands, then retry verification of the unchanged commit. The same command prepares a clean active host Worker before editing. It validates the configured dependency inputs and requires an interactive terminal. Other environment issues still need repair. A source correction requires a new reviewed proposal. Rivet does not install dependencies through its quality commands.

## A host action was interrupted or blocked

If an older installed skill tries to create `.git/rivet-inputs/`, update it with `rivet setup --write` and reload the harness skill. Current commands support `--decomposition-json`, `--action-json`, and `--result-json`, avoiding temporary input files. If Rivet reports that it lacks filesystem permission, private Git state or isolated worktree access may be denied. Request normal harness approval for the exact command. If unavailable, use an approved interactive environment or terminal `rivet run`. Do not disable sandbox controls to force progress.

For a pending action, get `runtime.version` from `work status`, then call `work next` with that version. `waiting-for-result` returns the same action. For a blocked submission, retain the `work submit` response and inspect blocked nodes in `work status`; create a new reviewed corrective proposal. `feature resume` is only for spawned runs and cannot resume host work.

If `work verify` reports a missing accepted integration identity, the private record of the reconciled Worker commit is unavailable. The run cannot be verified by treating the checkout's current HEAD as accepted; create a new reviewed proposal. If `work status` reports missing or inconsistent final approval evidence, do not deliver that checkout.

An interrupted host operation can leave private locks. From the configured project, inspect task status and then explicitly request recovery:

```sh
rivet task recover
rivet task status
```

If several active host tasks exist, add `--run=<id>` using the displayed list. Outside the project, add `--project=<path>`. Harnesses can use `rivet work recover <run-id> --project=<absolute-path> --json`.

Recovery only removes an unchanged abandoned owner on the same machine, with a provably dead process and a lock at least five minutes old. Fresh, live, foreign, malformed or already-claimed owners stay blocked. Saved run/runtime state and the current configuration must validate before recovery; missing state after execution began is blocked. An interrupted preparation can be recovered before it created a runtime snapshot. Do not edit private state or delete locks to bypass these checks.

The response lists exactly which locks were recovered. A later blocked lock produces a nonzero result even if earlier locks were recovered. Task state, verification evidence and worktrees are preserved; recovery does not launch or resume a Worker. Read status afterward and continue through the owning harness. Spawned tasks are excluded because removing a host lock cannot establish that their Worker has stopped.


## No compatible CLI was found

Read the reported reason. `missing-options` lists required features the CLI does not advertise. Inspect `claude --help` or `codex exec --help`, update or select an installation providing those options, then retry. `capability-probe-failed` means a bounded version/help probe failed, timed out, or produced invalid output. Rivet does not require a specific release and does not drop safety or output flags to force compatibility. Exact `#!/usr/bin/env node` launchers use Rivet's own canonical native Node executable automatically. Other script installations need a canonical compatible interpreter as described by the error; invalid explicit overrides are rejected.

If the CLI changes after discovery, retry to discover it again. A help probe can pass while authentication, model access, or output compatibility fails later; retain the failure report when diagnosing that case.

## Collect a support bundle

```sh
rivet support
rivet support --json > rivet-support.json
```

Run from your project or a nested folder. Use `--project=<path>` to select another directory. A missing or invalid Rivet configuration is included as a diagnostic result, so setup problems can still be reported.

The bundle contains selected diagnostic fields: Rivet and runtime versions, platform/architecture, known tool versions and readiness, aggregate integration/credential readiness and fixed error categories. It excludes project identifiers, paths, provider URLs, environment values, prompts, source files, diffs, raw logs, private run history and vault content. Version strings are reduced to numeric version components.

To include installed harness capability checks:

```sh
rivet support --probe-harnesses --json > rivet-support.json
```

These bounded local probes inspect version/help output. They do not execute a model task, authenticate an account or check external provider connectivity. Without the flag, harness capabilities are reported as not checked. Optional integration unavailability is recorded separately from required readiness failures.

`support` reports whether collection completed; it does not certify that the project is ready. A successfully generated bundle can contain failed readiness checks or an incomplete diagnostic category. Use `rivet doctor` for the readiness exit status. The command writes to terminal output only; shell redirection creates the JSON file. Nothing is uploaded automatically.
