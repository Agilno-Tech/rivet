# Review a pull request

Use Rivet to review a teammate’s pull request from your own checkout. You do not need the author’s private Rivet task state, and the PR does not need to have been created by Rivet.

## From your terminal

Inside a project configured with `rivet setup`, run:

```sh
rivet review https://github.com/your-team/your-project/pull/42
```

Rivet captures the PR’s description, commit identities and text diff, then asks an installed coding CLI to inspect that diff. It prefers Claude when both supported CLIs are available. Choose one explicitly when needed:

```sh
rivet review https://github.com/your-team/your-project/pull/42 --harness=codex
rivet review https://github.com/your-team/your-project/pull/42 --harness=claude
```

GitLab.com merge requests and Bitbucket Cloud pull requests use their normal URLs too. The URL must belong to your configured repository remote. Use `--remote=upstream` or `--provider=team-github` when needed; use `--project=/path/to/project` from elsewhere.

Configure a scoped `git-ci` provider with `repository-read`, its normal provider API endpoint and a token environment reference. See [repository inspection](./repositories.md) and [integration setup](./integrations.md). Your coding CLI must also be installed and authenticated. Rivet checks required command capabilities, without requiring a specific CLI version.

Findings are saved privately in the Git directory and printed with paths and line numbers. The command does not change your checkout, run project commands, approve or merge the PR, or publish findings automatically.

## From Claude Code, Codex or another coding harness

Ask your harness:

> Use Rivet to review this PR: https://github.com/your-team/your-project/pull/42. Export the review context, inspect the supplied diff, and save a report matching its schema. Keep findings local.

The harness can obtain the exact review snapshot and report schema with:

```sh
rivet review https://github.com/your-team/your-project/pull/42 --context --json
```

Have it create a JSON report using `result.reportSchema`. The report must copy `url`, `headSha`, `baseSha` and `diffDigest` from `result.snapshot`. Findings must cite a path and line present in the captured diff; deleted files use old-side line numbers. Reports include a summary, findings and explicit limitations.

Import that report into the saved review:

```sh
rivet review https://github.com/your-team/your-project/pull/42 --input=review-report.json
```

Rivet rejects reports for another snapshot or a PR that changed. Capture and review the new diff when that happens. The author’s `rivet task review` evidence is separate from this independent PR review.

## Publish a summary when ready

To publish your saved findings, give the scoped provider `review-comment` capability and `read-write-with-approval` mode, then run:

```sh
rivet review https://github.com/your-team/your-project/pull/42 --publish
```

Rivet shows the exact comment in your terminal and asks for confirmation. It rechecks configuration, repository identity and PR commits before posting. The comment identifies the reviewed commits and diff; it is a summary comment, not a formal approval or request-changes vote. Provider comment APIs do not atomically condition posting on the PR’s head, so the commit references remain important if someone pushes concurrently.

After an uncertain network outcome, Rivet preserves the pending attempt and blocks retries for that saved review to avoid duplicate comments. Inspect the PR and retain the private state when reporting the problem. Automatic reconciliation of an uncertain comment is not yet available.

## What this review covers

This is a **diff review**. The installed harness receives the captured description and diff in an isolated temporary directory. It does not receive the project checkout or run your configured checks. Claude tools are disabled; Codex shell execution, external apps and plugins are disabled, with a read-only sandbox. The active-harness context workflow leaves the host’s tool permissions under your control.

A report with no findings does not prove correctness. Surrounding code, ticket acceptance criteria absent from the PR description, runtime behavior and tests still need your normal review process.

Rivet bounds the captured diff to 384 KiB and 500 changed files, checks reported file counts, and rejects incomplete hunks or unsupported binary/path representations. Binary-only changes, changes without text hunks and quoted Git paths require manual review. Descriptions and findings are checked for credential-shaped content before delegation or sharing. Avoid placing secrets in PR content.
