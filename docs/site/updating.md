# Updating Rivet

Read the [release notes](https://github.com/Agilno-Tech/rivet/releases) for changes, fixes and any required upgrade steps before updating.

From a configured project, run:

```sh
rivet update
```

Rivet updates your global CLI using the package manager that installed it, then refreshes that project's managed harness instructions and runtime pin, if present. It uses the newest release on npm's `latest` tag. Rivet remains alpha software.

Restart your Claude or Codex session after updating so it loads the refreshed instructions.

## First update from an older version

If `rivet update` is not recognized, update once with the package manager you originally used:

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

Then run `rivet update` inside your project to refresh its Rivet files too.

## Check or choose what to update

| Command | Effect |
| --- | --- |
| `rivet --version` | Show the version of the CLI being executed. |
| `rivet update --check` | Inspect the update without changing files. Requires registry access. |
| `rivet update --global` | Update the global CLI and existing global harness instructions. |
| `rivet update --project` | Refresh only the current project's existing Rivet instructions and runtime pin. |

For `update`, `--project` is a scope switch. Run it from the project's root or a subdirectory; it does not take a path. Outside a configured project, `rivet update` updates the global installation only.

Each project is updated separately. Repeat `rivet update --project` in other projects when ready. This command preserves project settings and refreshes only harness targets already installed. It does not initialize new projects.

A project with a pinned runtime uses its own version. Check it with:

```sh
node .rivet.cjs --version
```

If the pinned version predates `--version`, refresh the project first. Run updates through the global `rivet` command; the pinned launcher is for project execution. Project-only updates prepare a temporary copy of the latest package using npm, which comes with Node.js; they do not replace your global installation.

## If an update stops

- **Active tasks:** finish or cancel tasks in the current project before updating. Complete saved PR reviews that are still awaiting a report or publication as well. Rivet checks this project, including for `--global`; it cannot find running tasks in every repository on your machine. Finish those before changing the global CLI too.
- **Edited instructions or runtime launcher:** review and preserve your edits before replacing managed files. The updater stops rather than overwriting them.
- **Unknown installation:** source checkouts, unsupported package managers and ambiguous installations require a manual update using their original installation method. Rivet does not guess which installation to replace.
- **Partial update:** the error reports completed phases. Check the installed version, resolve the reported problem and rerun the command. A successful global update is not rolled back if the project refresh fails.

Keep private task state and worktrees. Do not delete unfinished work to make an update pass. Older versions may not understand newer state, so downgrades are not guaranteed.

See [installation](./installation.md) for project-only and source installations, and [versions](./release.md) for release and license information.

Project file refreshes appear as local changes. Review and commit them when your team is ready to adopt the updated instructions or runtime pin.
