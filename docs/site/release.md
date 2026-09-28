# Versions and updates

Rivet is currently an alpha, with package version `0.1.0-alpha.0`. A public registry package has not been published yet. Use the [GitHub installation instructions](./installation.md).

## Moving from `@agilno/rivet`

If the old `@agilno/rivet` package is installed globally, remove it with the package manager that installed it before installing the new package. Both use the `rivet` executable. Follow the [one-time package migration](./installation.md#upgrade-from-the-previous-package-name); project configuration, task state and worktrees are preserved. Project runtime pins require a separate explicit update.

## Update a source installation

Repeat the installation command with the package manager you originally used:

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

Then check the installation:

```sh
rivet --help
rivet doctor
rivet task status
```

The `main` branch changes over time. Use a reviewed commit SHA instead of `main` when you need to select the same source revision across a team. Project-only and verified-tarball installations have separate [installation instructions](./installation.md).

Review active tasks and keep your project configuration, private task state and worktrees before updating. Do not delete unfinished work to resolve an upgrade problem. Older versions may not understand newer task state; downgrades are not guaranteed.

See [recent changes](https://github.com/Agilno-Tech/rivet/commits/main/) and [compatibility](./compatibility.md). Maintainers preparing a package should use the [release procedure](https://github.com/Agilno-Tech/rivet/blob/main/docs/maintainers/release.md).

## License

Rivet is licensed under [Apache License 2.0](https://github.com/Agilno-Tech/rivet/blob/main/LICENSE). Preserve the license and applicable attribution notices when redistributing it.
