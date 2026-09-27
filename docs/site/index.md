# Rivet

Rivet helps teams use coding agents with a consistent development workflow: review a plan, work in an isolated checkout, run the project's checks, and review the result before delivery.

Use it from Claude Code, Codex or another capable coding harness, or start a task from your terminal:

```sh
rivet run "Add a GET /health endpoint with a regression test"
```

Rivet works with configured checks and dependency commands for Node.js, Python/Django, Go, Rust and other projects. Node.js is required to run Rivet itself.

**Rivet is an alpha.** Install from GitHub while registry distribution is being prepared. See [supported environments and limitations](./compatibility.md) before adopting it for your team.

## Start here

1. [Install Rivet and complete a first task](./getting-started.md).
2. [Connect Jira, Linear or other context](./integrations.md) when your workflow needs it.
3. [Add your team's project procedures](./memory-and-protocols.md).
4. [Prepare a verified change for review and delivery](./delivery.md).

For command details, use the [runtime reference](./runtime-reference.md). If something fails, start with [troubleshooting](./troubleshooting.md).
