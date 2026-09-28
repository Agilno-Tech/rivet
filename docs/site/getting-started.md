# Get started

Rivet needs **Node.js 22 or 24 and Git** on macOS or Linux. Your application can use any language; it does not need a `package.json`.

## 1. Install Rivet

The alpha is currently installed from GitHub. Choose Yarn Classic, npm or pnpm:

::: code-group

```sh [Yarn Classic]
yarn global add "https://github.com/Agilno-Tech/rivet.git#main"
```

```sh [npm]
npm install --global "https://github.com/Agilno-Tech/rivet.git#main"
```

```sh [pnpm]
pnpm add --global "https://github.com/Agilno-Tech/rivet.git#main"
```

:::

```sh
rivet --help
```

Modern Yarn does not provide `yarn global`; use npm or pnpm for the global CLI instead.

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

Review the task, numbered acceptance criteria, proposed files, checks, permissions and limits before approving. Add `--details` to include full graph identifiers. The activation prompt waits while you read; closing it leaves a saved proposal. To review that proposal again, run `rivet task start` (or `rivet task resume`). Rivet works in isolated Git checkouts and asks separately before preparing their dependencies. Existing dependencies in your source checkout are not copied. Installing Rivet does not change your project's package manager; Yarn, pnpm, npm and Bun project scripts remain supported.

### In Claude Code, Codex or another coding harness

Open your configured project, reload the harness if needed, and ask:

> Read the Rivet skill. Add a GET /health endpoint with a regression test using this project's framework. Show me the plan before starting, work in Rivet's isolated checkout, and show the changed files and executed checks for final review.

The harness manages the detailed Rivet commands and task identifiers. Approve the required file, Git and worktree operations through its normal permission flow. See [compatibility](./compatibility.md) for tested CLI paths and current desktop limitations.

## 4. Review and finish

```sh
rivet task status
```

After verification succeeds, `rivet run` opens final review in the same terminal. Choose:

- **Review changes:** view the exact diff from the starting commit to the tested commit. Large diffs must be inspected in the reported integration checkout.
- **Apply locally:** confirm the exact commit. Rivet fast-forwards your original clean default branch to the tested result and records the task as completed. It does not push or deploy. The branch must still be at the task's starting commit, and the committed project policy must be unchanged.
- **Pull-request delivery:** prepare a local delivery record, then follow the displayed publish and review commands with separate approvals. See [delivery](./delivery.md) for provider setup.
- **Leave for later:** keep the verified work saved.

To pick up where you left off:

```sh
rivet task resume
```

Resume reviews an unapproved plan, continues an eligible interrupted terminal task, or reopens final review. `rivet task start` and `rivet task approve` remain available as direct shortcuts. For a task owned by a coding harness, resume shows how to continue through that harness; verified host work can use the same final-review menu.

If your original checkout has changed, preserve your edits and follow the reported guidance; Rivet will not force a merge. Completed tasks can be inspected with `rivet task status --run=<id>`.

For interrupted terminal tasks or missing dependencies:

```sh
rivet task resume
rivet task deps
```

A saved terminal proposal is reviewed before activation; you do not need to call `feature start` separately. Resume an eligible activated terminal task after correcting the reported problem. For a task owned by your coding harness, continue through that harness. `task deps` prepares a clean active Worker or accepted integration checkout using its configured dependency plan. Source corrections may require a new reviewed plan. See [troubleshooting](./troubleshooting.md) for blocked tasks.

You normally do not need a task ID or `--project`. When several tasks are active, an interactive terminal shows a numbered list of task descriptions and states. Choose one, or use `--run=<id>` explicitly. Noninteractive commands require an explicit selector when the choice is ambiguous. Use `--project=<path>` when running outside the project.

## Report a problem

Human-readable command failures show a next step and the path to a private JSON diagnostic report when it can be saved. Review that file before attaching it to a [GitHub issue](https://github.com/Agilno-Tech/rivet/issues/new), along with reproduction steps and expected behavior. To collect broader sanitized diagnostics:

```sh
rivet support --save
```

Nothing is uploaded automatically. See [report contents and sharing](./troubleshooting.md#collect-a-support-bundle).

## Add more when you need it

- [Jira, Linear, Figma and Confluence](./integrations.md): optional context and ticket connections.
- [Project protocols](./memory-and-protocols.md): your team's reviewed procedures.
- [Model selection](./models.md): worker harnesses and advisory text models.
- [Runtime reference](./runtime-reference.md): configuration and advanced commands.
