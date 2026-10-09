# Installation details

## Install the CLI globally

Use Node.js 22 or 24 and Git on macOS or Linux. Choose one package manager:

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
rivet setup
rivet setup --write
```

The package is published on [npm](https://www.npmjs.com/package/@agilno-tech/rivet); its executable is `rivet` with every package manager. Installing without a version selects npm’s `latest` tag. Rivet is still alpha software, even though it uses this default tag. Append an exact published version, such as `@0.1.0-alpha.0`, to install that version. Use a user-owned installation directory rather than running the installer as root. Installing Rivet does not change your application's package manager.

Confirm `rivet --help` works before setup:

- **Yarn Classic 1.22:** `yarn global bin` shows the directory to put on PATH. Modern Yarn does not provide `yarn global`.
- **npm:** global executables are in the `bin` directory under `npm prefix --global` on macOS/Linux. A Node version manager normally configures this PATH.
- **pnpm:** if the global executable directory is missing, run `pnpm setup`, reopen your terminal, and retry. `pnpm bin --global` shows the directory.

See the package managers' [Yarn global](https://classic.yarnpkg.com/lang/en/docs/cli/global/), [npm install](https://docs.npmjs.com/cli/v11/commands/npm-install/) and [pnpm setup](https://pnpm.io/cli/setup) documentation.

## Install for one project without a global CLI

From the project root, create a temporary Yarn Classic installation and use it to pin Rivet for this project:

```sh
rivet_bootstrap=$(mktemp -d)
yarn global add @agilno-tech/rivet \
  --global-folder "$rivet_bootstrap/global" --prefix "$rivet_bootstrap" \
  --cache-folder "$rivet_bootstrap/cache" --ignore-scripts
"$rivet_bootstrap/bin/rivet" install --project-runtime
node .rivet.cjs setup
node .rivet.cjs setup --write
```

Append an exact published version, such as `@0.1.0-alpha.0`, for reproducible version selection. Use Node 22 or newer, Yarn Classic 1.22, and Git. The project-only runtime installer also requires npm 10 or newer, included with the supported Node distribution, to install its dependencies. Unsupported Node versions are rejected before installation changes. The initial command requires access to the npm registry; it does not require a global Rivet executable.

Project installation snapshots the running Rivet package and installs its runtime and dependencies into your private `~/.cache/rivet/project-runtimes` cache. A small owned `.rivet.cjs` file pins the Rivet source. Each user keeps their platform-specific runtime and resolved dependency inventory privately. Your application's `package.json`, lockfile and dependencies are preserved. The selected minimal harness instructions use this project reference even when another Rivet version is available globally. Use `--target=claude` or `--target=codex` to install only one target; both are the default. Use `--project=<path>` only when automatic project discovery is insufficient.

From the project root, use the same commands through the reference:

```sh
node .rivet.cjs run "Implement the requested change"
node .rivet.cjs task status
node .rivet.cjs task resume
node .rivet.cjs doctor
```

The reference uses your current Node runtime and validates the pinned Rivet source and private dependency inventory before loading Rivet. It keeps the current working directory and needs no PATH export. The installed harness discovers the project root and uses the reference for its own commands. Review and commit the project reference, configuration and instructions before starting a workflow that requires a clean checkout. Another collaborator needs their own private runtime installation; the cache is not committed to the project.

To update the pin to the latest release, run `rivet update --project` from this project using a current global CLI. Without a global CLI, repeat the temporary Yarn installation and `install --project-runtime` commands above with the selected package version. See [Updating Rivet](./updating.md). Unchanged managed harness instructions can also be upgraded by rerunning setup. Unchanged sources reuse a verified cache. Edited or unowned project references and instructions stop replacement. Later ordinary `setup` calls preserve the pinned harness routing. Interrupted installation preserves existing application files; inspect any reported partial instruction installation before retrying.

Remove the owned project installation with:

```sh
node .rivet.cjs uninstall --project-runtime
```

Uninstall preserves project policy and application files. Removing only one harness target retains the reference while another managed target still needs it. Shared cached runtimes are retained because other projects may use them. Global CLI installation and global harness instructions are separate scopes.

## Install a verified candidate tarball

When a maintainer supplies an approved candidate tarball and its trusted SHA-256 checksum, use the thin bootstrap from a reviewed Rivet checkout:

```sh
sh /path/to/rivet/scripts/install.sh \
  --artifact "/path/to/agilno-tech-rivet-0.1.0-alpha.0.tgz" \
  --sha256 "<trusted-64-character-sha256>" \
  --prefix "$HOME/.local"
```

Use the checksum from the approved release record. A checksum supplied only beside an untrusted download does not establish authenticity. For the normal published alpha, use the registry installation above. This tarball path is for a specific artifact supplied by a maintainer.

The bootstrap requires Node 22 or newer, npm 10 or newer, Git, and tar on PATH. It copies the local tarball into a private temporary directory and checks that copy and its Rivet package identity before invoking npm. It then installs those verified bytes with lifecycle scripts disabled, verifies the installed Rivet command, and prints PATH and project setup instructions. Registry access may be needed for dependencies, which are resolved separately from the checksummed Rivet tarball.

Omit `--prefix` to use your current npm global prefix. Use a user-owned prefix or runtime manager. The bootstrap keeps your existing PATH, does not modify shell profiles, and removes its temporary copy on completion or failure. A failed npm installation can leave partial content in the selected prefix; inspect the reported location before retrying.

For published-channel availability and upgrade guidance, see [versions and updates](./release.md).

## Project or global instructions

`setup` defaults to the current directory and both supported harness targets. It previews by default. `--write` applies the setup. Global setup installs instructions without writing project policy:

```sh
rivet setup --global --target=both
rivet setup --global --target=both --write
```

Project preview is read-only. It lists exact root or immediate-child package-script steps, provenance, unresolved required checks, and warnings; it does not run the checks. Generated child steps are written only after `--write`. Repeating setup preserves an existing complete valid `.rivet` configuration byte-for-byte, including later user edits.

To install just the minimal instructions, with no project configuration:

```sh
rivet install --minimal --project=. --target=codex
rivet install --minimal --global --target=claude
```

The minimal installer uses `.agents/skills/rivet/` for Codex and `.claude/skills/rivet/` for Claude Code. Global paths use the same directories under your home directory. These follow the documented [Codex skill locations](https://developers.openai.com/codex/skills) and [Claude Code skill locations](https://code.claude.com/docs/en/skills).

It records ownership and installed-content hashes alongside the skill. Repeating the command is safe; updates replace only unmodified managed files. Collisions or user edits stop the operation so you can review them. It does not rewrite `AGENTS.md` or `CLAUDE.md`, install unrelated capability packs, or configure provider credentials.

## Update or remove

Update the CLI using the same global installation command for your chosen package manager, then repeat minimal installation for the original scope and targets. Remove managed instructions with:

```sh
rivet uninstall --minimal --project=. --target=both
rivet uninstall --minimal --global --target=both
```

Removal preserves unowned files and refuses to delete modified managed content. Project policy is retained. Remove the globally installed CLI with the package manager used to install it:

::: code-group

```sh [Yarn Classic]
yarn global remove @agilno-tech/rivet
```

```sh [npm]
npm uninstall --global @agilno-tech/rivet
```

```sh [pnpm]
pnpm remove --global @agilno-tech/rivet
```

:::

## Advanced legacy capability packs

The earlier `install --all` and interactive installers remain available. They install the optional skill collection and use their original harness paths, including `.codex/skills` for Codex. They are separate from the new minimal installation lifecycle; use matching legacy uninstall options to remove those packs.

## Advanced: install from GitHub source

Use this only when you need a change that has not reached the registry or a specific reviewed commit. Choose one package manager:

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

`main` changes over time. Replace it with a reviewed commit SHA for reproducible source selection. To return to a published release, repeat the registry installation command at the top of this page with the same package manager.

## Contributor checkout

```sh
git clone https://github.com/Agilno-Tech/rivet.git
cd rivet
npm ci --ignore-scripts
npm run build
node bin/cli.js --help
```

`npm ci` uses the committed `package-lock.json`, the authoritative dependency baseline. `--ignore-scripts` prevents dependency lifecycle scripts; build Rivet explicitly afterward. See [contributing](./contributing.md) for Yarn Classic and pnpm alternatives without adding another lockfile.

Use `--json` with setup and minimal install/uninstall for machine-readable results. If setup reports partial completion, preserve the written configuration, resolve the installation conflict, and rerun. Configuration and harness installation are separate transactions.

## Application language

Node.js is required to run Rivet itself. Your application uses its own language, framework and verification commands. See [Python, Django and other project languages](./getting-started.md#_2-connect-your-project) for language-neutral setup and custom verification commands.
