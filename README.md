# Rivet

A shared development workflow for teams and their coding agents.

Review a plan, work in an isolated Git checkout, run your project's checks, and review the result before delivery. Use Rivet through a coding harness or from your terminal.

## Get started

Install Node.js 22 or 24 and Git on macOS or Linux, then choose one package manager:

```sh
# Yarn Classic 1.22
yarn global add @agilno-tech/rivet

# npm
npm install --global @agilno-tech/rivet

# pnpm
pnpm add --global @agilno-tech/rivet
```

Use one command. Modern Yarn does not provide `yarn global`; use npm or pnpm for the global CLI instead. See [installation](https://agilno-tech.github.io/rivet/installation.html) for PATH setup.

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

After verification, Rivet offers a menu to review the diff, apply locally, prepare pull-request delivery or leave the work for later. Local application updates your clean default branch to the verified commit after confirmation; publishing remains separately approved. Use `rivet task resume` to continue from the saved state, with numbered task selection when needed.

Alternatively, ask your coding harness to read the Rivet skill and complete the task. Rivet detects the project, requests approval and keeps the verification results for review.

Node.js runs Rivet itself. Your application can use Python/Django, Node.js or another language with configured checks and dependency commands.

**Alpha:** available on [npm as `@agilno-tech/rivet`](https://www.npmjs.com/package/@agilno-tech/rivet). The default installation selects npm’s `latest` tag; Rivet is still alpha software. Rivet is licensed under [Apache 2.0](LICENSE). See [compatibility](https://agilno-tech.github.io/rivet/compatibility.html) for tested environments and limitations.

## Documentation

- [Release notes](https://github.com/Agilno-Tech/rivet/releases)
- [Quickstart](https://agilno-tech.github.io/rivet/getting-started.html)
- [Configuration and commands](https://agilno-tech.github.io/rivet/runtime-reference.html)
- [Integrations](https://agilno-tech.github.io/rivet/integrations.html)
- [Review and delivery](https://agilno-tech.github.io/rivet/delivery.html)
- [Troubleshooting](https://agilno-tech.github.io/rivet/troubleshooting.html)
- [Contributing](CONTRIBUTING.md)

Human-readable failures show a private diagnostic report path when available. Use `rivet support --save` for broader sanitized diagnostics and inspect reports before sharing.

Found a problem or have an improvement? [Open an issue or pull request](https://github.com/Agilno-Tech/rivet). Rivet is developed by [Agilno](https://agilno.com/).

## Updating

Run `rivet update` inside your project to update the global CLI and the project’s managed Rivet files. Check your version with `rivet --version`. See the [updating guide](https://agilno-tech.github.io/rivet/updating.html), including the one-time package-manager update for older releases.
