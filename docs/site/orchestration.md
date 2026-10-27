# Managed orchestration

Rivet plans a task, runs approved work in isolated checkouts, and records the checks for your review. Independent parts can run in parallel; dependent work waits until its prerequisites are accepted.

Follow these five steps. You do not need to edit YAML or manage registration IDs.

## 1. Set up your project {#profiles}

From your project root:

```sh
rivet setup --write
rivet doctor
```

Setup guides you through project checks, models and worker concurrency. **Accept recommendations**, **Customize**, or skip model routing for later. Fresh setup recommends two concurrent workers; existing custom settings are preserved unless you change them. Available capacity can reduce how many workers run at once.

Setup also asks whether to enable optional batch verification. You can decline and enable it later by rerunning setup. Review and commit the generated files before starting a task, then start from a clean checkout of your configured default branch. See [Getting started](./getting-started.md) for installation and readiness checks.

To revisit models and concurrency, run `rivet models configure`. You can also [describe your model preferences in plain language](./models.md#model-and-reasoning-policy) and approve the proposed mapping.

## 2. Run a task {#start-and-continue-a-task}

```sh
rivet run "Add a health endpoint with a regression test"
```

Rivet reuses your saved model routing. Review the plan, acceptance criteria, proposed changes and checks before approving. It asks separately before installing dependencies in an isolated checkout.

Workers stay within the approved plan. Rivet checks their combined changes before accepting them. At final review, inspect the result and choose whether to apply it locally, begin [pull-request delivery](./delivery.md), or leave it saved for later.

<span id="scope"></span>
**Current scope:** Terminal tasks automatically review the accepted integration revision in a fresh, tool-disabled reviewer process using saved `independent-review` routing. Blocking findings return to a correction worker with the original scope, objective, implementation summary and remaining allowance. Rivet reruns checks and independently reviews the corrected revision before final approval. Corrections use a new session because the current adapters do not retain provider sessions. Host-owned tasks and plan reviews still use explicit `rivet task review` reports; PR/CI follow-through is not automatic. Publishing and delivery retain separate approvals.

Product questions stop dependent execution. In an interactive run or resume, Rivet presents the question and options and waits for your answer. Leaving it pending keeps the task blocked; later use `rivet task approve-decision` and resume. Agent recommendations never count as human answers.

## 3. Check or continue your task

```sh
rivet task status
rivet task resume
```

Status shows progress, waiting reasons and the next step. Resume continues eligible work or reopens final review. With several active tasks, the interactive chooser asks which one you mean. For a task owned by a coding harness, continue through that same harness as directed.

Use `rivet task pause` to prevent new work from starting. Already running work continues.

Managed tasks default to a **one-hour execution allowance**. Set another allowance when starting, for example `rivet run "Add a health endpoint" --for=2h`. Resuming never extends the saved deadline; an expired task needs a new approved task for new execution. Keep the terminal or owning harness running—there is no always-on background service.

If dependencies are missing, follow the prompt or use `rivet task deps`. Other blocked states include a reason and recovery guidance; see [troubleshooting](./troubleshooting.md).

## 4. Check ready tasks together — optional {#verify-selected-tasks-together}

If you enabled batching during setup:

```sh
rivet task verify --batch
```

Choose from the ready tasks. Rivet combines compatible task results in an isolated checkout and runs the configured checks. If that checkout needs dependencies, the command shows the installation for approval and then continues. Declining leaves the batch available for a later retry.

Read the report with `rivet task status`. **Batch results are advisory:** each task still needs its own final verification, required review and delivery approval. A batch does not merge or publish your tasks.

See the [batch reference](./runtime-reference.md#verification-batch-configuration) for compatibility rules, queue behavior and advanced settings.

## 5. Clean up finished work {#completed-work-cleanup}

Preview first, then review and confirm removal:

```sh
rivet task cleanup --preview
rivet task cleanup
```

Rivet removes only eligible worker checkouts whose owners have stopped. It keeps branches, commits and task evidence. Checkouts with unknown ownership or unrecognized files are retained with an explanation. Integration and batch-candidate checkouts are also retained.

For optional age-based cleanup, `rivet task cleanup --retention=7d` asks for a separate approval. It runs during foreground task execution, not in the background. Use `--retention=off` to disable it. Status and preview never delete anything.

See the [cleanup reference](./runtime-reference.md#completed-work-cleanup) for eligibility, retained files and interrupted cleanup.

## Advanced reference

Model and YAML settings, shared machine limits, session handoffs, exact verification reuse and accounting are in the [runtime reference](./runtime-reference.md). Automated tests cover these orchestration mechanics; live-model, desktop and long unattended use still need separate qualification. See [capabilities and limitations](./status.md) for the current scope.
