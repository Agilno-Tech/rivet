# Get started

Rivet helps you plan a task, build it in isolated Git checkouts, and review the checked result before applying or publishing it. Your application can use any language or framework.

You need **Node.js 22 or 24 and Git** on macOS or Linux. Terminal task execution also needs an installed, authenticated Claude Code or Codex CLI.

## Install Rivet

Install the published alpha package with your preferred tool:

::: code-group

```sh [Yarn Classic]
yarn global add @agilno-tech/rivet
```

```sh [npm]
npm install --global @agilno-tech/rivet
```

```sh [pnpm]
pnpm add --global @agilno-tech/rivet
```

:::

```sh
rivet --help
```

Modern Yarn does not support `yarn global`; use npm or pnpm instead. For pinned versions, PATH help or project-only installation, see [installation](./installation.md).

<span id="_2-connect-your-project"></span>

## 1. Set up your project

From the project root in your regular terminal:

```sh
rivet setup
rivet setup --write
rivet doctor
```

The first command previews setup. With `--write`, review and approve:

- **Project checks and dependencies:** accept detected commands or supply your project's own commands.
- **Models and concurrency:** accept recommendations, customize, or skip for later. Fresh setup recommends two workers, subject to available capacity.
- **Batch verification:** optionally enable checks across selected ready tasks.

Setup installs Rivet policy and harness skills. It preserves existing valid configuration and does not run your checks or install application dependencies. To revisit models, use `rivet models configure`; to enable batching later, rerun setup.

Resolve required issues reported by `doctor`, commit the setup files, and start from a clean checkout of the configured default branch. A `preparation-required` result means dependencies can be prepared later in an isolated checkout after approval. For custom check commands, see the [configuration reference](./runtime-reference.md#checks-for-any-project-language).

## 2. Run a task

In a terminal, from anywhere inside your configured project:

```sh
rivet run "Add a GET /health endpoint with a regression test"
```

Rivet reuses saved model routing. Without saved routing, it offers a choice when both CLIs are available.

Review the plan, acceptance criteria, proposed files, checks and limits before approving. Rivet works in isolated checkouts and asks separately before installing their dependencies. Closing the approval prompt leaves a saved proposal you can reopen with `rivet task resume`.

Alternatively, open your configured project in a coding harness, reload its skills if needed, and ask:

> Read the Rivet skill. Add a GET /health endpoint with a regression test. Show me the plan before starting, work in Rivet's isolated checkout, and show the changes and checks for final review.

The harness manages the detailed commands. Host workflows require a fresh or ahead remote-tracking ref; `rivet preflight --mode=host` checks readiness. See [compatibility](./compatibility.md) for desktop limitations.

Rivet executes the approved plan. Automatic independent review, correction and PR/CI follow-through are still [future work](./roadmap.md).

## 3. Check, continue and finish

```sh
rivet task status
rivet task resume
```

Status shows progress and the next step. Resume continues eligible work or reopens final review. If several tasks are active, the interactive chooser asks which one; you normally do not need a task ID. For harness-owned work, follow the guidance to continue through that same harness.

Managed tasks have a one-hour default allowance. You can choose another when starting, for example with `--for=2h`. Resume never extends the saved deadline. Use `rivet task pause` to prevent new work from starting; it does not stop work already running. Keep the terminal or owning harness running—Rivet is not a background service.

After verification and any required reviews, inspect the final diff and choose:

- **Apply locally:** approve the tested commit for your clean default branch. This does not push or deploy.
- **Pull-request delivery:** follow the [delivery workflow](./delivery.md), with separate publishing approvals.
- **Leave for later:** preserve the work and return with `rivet task resume`.

If dependencies are missing, use `rivet task deps` when prompted. For changed checkouts, expired tasks or other blocked states, follow the reported guidance and [troubleshooting](./troubleshooting.md).

## 4. Check ready tasks together — optional

If you enabled batching during setup:

```sh
rivet task verify --batch
```

Select ready tasks. Approve dependency setup if requested, then inspect the combined report with `rivet task status`. Declining dependency setup preserves the batch for later.

Batch results are advisory. Each task still needs its own final verification, required review and delivery approval. See [batch verification](./orchestration.md#verify-selected-tasks-together).

## 5. Clean up finished work

```sh
rivet task cleanup --preview
rivet task cleanup
```

Preview eligible worker checkouts, then review and confirm removal. Branches, commits and task evidence remain. Uncertain owners and unrecognized files prevent removal; integration and batch-candidate checkouts are retained.

For optional age-based cleanup during foreground execution, use `rivet task cleanup --retention=7d` and approve the policy separately. See [cleanup](./orchestration.md#completed-work-cleanup) for details and how to disable it.

## Help and updates

Command failures show the next step and, when available, a private diagnostic report. Review it before attaching it to an issue; nothing is uploaded automatically. See [reporting a problem](./troubleshooting.md#collect-a-support-bundle).

Use `rivet update` inside your project to update the CLI and the project's managed instructions and runtime pin. See [Updating Rivet](./updating.md).

For more, explore [model choices](./models.md), [managed orchestration](./orchestration.md), [integrations](./integrations.md), [project protocols](./memory-and-protocols.md) or the [runtime reference](./runtime-reference.md).
