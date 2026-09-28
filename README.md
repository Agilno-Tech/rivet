# Rivet

A shared development workflow for teams and their coding agents.

Review a plan, work in an isolated Git checkout, run your project's checks, and review the result before delivery. Use Rivet through a coding harness or from your terminal.

## Get started

Install Node.js 22 or 24, Yarn Classic 1.22 and Git on macOS or Linux, then:

```sh
yarn global add "https://github.com/FraneAgilno/rivet.git#main"
```

From your project root:

```sh
rivet setup
rivet setup --write
rivet doctor
```

Review the setup preview before applying it. Resolve required checks and commit the configuration. With an installed, authenticated Claude Code or Codex CLI:

```sh
rivet run "Add a GET /health endpoint with a regression test"
rivet task status
rivet task approve
```

At final review, choose local application or pull-request delivery. Local application updates your clean default branch to the verified commit after confirmation; publishing remains separately approved. Use `rivet task start` to reopen a saved proposal.

Alternatively, ask your coding harness to read the Rivet skill and complete the task. Rivet detects the project, requests approval and keeps the verification results for review.

Node.js runs Rivet itself. Your application can use Python/Django, Node.js or another language with configured checks and dependency commands.

**Alpha:** install from GitHub while registry distribution is being prepared. The package is currently `UNLICENSED`. See [compatibility](https://franeagilno.github.io/rivet/compatibility.html) for tested environments and limitations.

## Documentation

- [Quickstart](https://franeagilno.github.io/rivet/getting-started.html)
- [Configuration and commands](https://franeagilno.github.io/rivet/runtime-reference.html)
- [Integrations](https://franeagilno.github.io/rivet/integrations.html)
- [Review and delivery](https://franeagilno.github.io/rivet/delivery.html)
- [Troubleshooting](https://franeagilno.github.io/rivet/troubleshooting.html)
- [Contributing](CONTRIBUTING.md)

Found a problem or have an improvement? [Open an issue or pull request](https://github.com/FraneAgilno/rivet). Rivet is developed by Agilno.
