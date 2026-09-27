# Get started

Rivet needs **Node.js 22 or 24, Yarn Classic 1.22 and Git** on macOS or Linux. Your application can use any language; it does not need a `package.json`.

## 1. Install Rivet

The alpha is currently installed from GitHub:

```sh
yarn global add "https://github.com/FraneAgilno/rivet.git#main"
rivet --help
```

For a pinned source revision, PATH help or a project-only installation, see [installation](./installation.md).

## 2. Connect your project

From the project root in your regular terminal:

```sh
rivet setup
rivet setup --write
rivet doctor
```

The first command previews the configuration. Review the checks and dependency commands before applying it with `--write`. Setup installs project policy and Rivet skills for Claude Code and Codex. It preserves existing valid configuration and does not run project checks or install application dependencies.

Rivet proposes checks for supported Node, Django, pytest, Go and Rust layouts. If it cannot find a check, interactive setup asks for your verification command. Use your project's normal tools, including Docker if required. See [custom check and dependency configuration](./runtime-reference.md#checks-for-any-project-language) for other layouts.

Resolve the required checks shown by `doctor`. A `preparation-required` result means a reviewed dependency plan can prepare an isolated checkout later; dependencies are not installed yet. Review and commit setup files, then start from a clean checkout of the configured default branch. Host workflows also require a fresh or ahead remote-tracking ref; `rivet preflight --mode=host` reports readiness.

If setup cannot write the harness skill, use your regular terminal or approve the exact operation through the harness. See [permission troubleshooting](./troubleshooting.md#setup-cannot-install-the-harness-skill).

## 3. Complete a task

Choose one of these entry points.

### In a terminal

Install and authenticate Claude Code or Codex CLI, then run:

```sh
rivet run "Add a GET /health endpoint with a regression test"
```

Run from the project root or any folder inside it. Rivet detects the project and offers a choice if both CLIs are available. To select one directly:

```sh
rivet run "Add a GET /health endpoint with a regression test" --harness=claude
# Alternatively:
rivet run "Add a GET /health endpoint with a regression test" --harness=codex
```

Review the proposed files, checks and budgets before approving. Rivet works in isolated Git checkouts and asks separately before preparing their dependencies. Existing dependencies in your source checkout are not copied. Installing Rivet with Yarn does not change your project's package manager; Yarn, pnpm, npm and Bun project scripts remain supported.

### In Claude Code, Codex or another coding harness

Open your configured project, reload the harness if needed, and ask:

> Read the Rivet skill. Add a GET /health endpoint with a regression test using this project's framework. Show me the plan before starting, work in Rivet's isolated checkout, and show the changed files and executed checks for final review.

The harness manages the detailed Rivet commands and task identifiers. Approve the required file, Git and worktree operations through its normal permission flow. See [compatibility](./compatibility.md) for tested CLI paths and current desktop limitations.

## 4. Inspect the result

```sh
rivet task status
```

Status shows the next action, checkout and verification results. At `awaiting-final-approval`, review the diff and actual check results. Local completion does not push, merge or deploy your work; [delivery](./delivery.md) requires separate approval.

For interrupted terminal tasks or missing dependencies:

```sh
rivet task resume
rivet task deps
```

Resume an eligible terminal task after correcting the reported problem. For a task owned by your coding harness, continue through that harness. `task deps` prepares a clean active Worker or accepted integration checkout using its configured dependency plan. Source corrections may require a new reviewed plan. See [troubleshooting](./troubleshooting.md) for blocked tasks.

You normally do not need a task ID or `--project`. When several tasks are active, select the one listed by status with `--run=<id>`. Use `--project=<path>` when running outside the project.

## Add more when you need it

- [Jira, Linear, Figma and Confluence](./integrations.md): optional context and ticket connections.
- [Project protocols](./memory-and-protocols.md): your team's reviewed procedures.
- [Model selection](./models.md): worker harnesses and advisory text models.
- [Runtime reference](./runtime-reference.md): configuration and advanced commands.
