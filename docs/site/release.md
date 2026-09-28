# Versions and updates

Rivet is published on [npm](https://www.npmjs.com/package/@agilno-tech/rivet) as `@agilno-tech/rivet`. Install without a version to select npm’s `latest` tag. Rivet is still alpha software; the tag does not mean a stable release. The first published version is `0.1.0-alpha.0`.

## Moving from `@agilno/rivet`

If the old `@agilno/rivet` package is installed globally, remove it with the package manager that installed it before installing the new package. Both use the `rivet` executable. Follow the [one-time package migration](./installation.md#upgrade-from-the-previous-package-name); project configuration, task state and worktrees are preserved. Project runtime pins require a separate explicit update.

## Update the alpha package

Repeat the installation command with the package manager you originally used:

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

Then check the installation:

```sh
rivet --help
rivet doctor
rivet task status
```

The default `latest` tag moves forward when a new release is published. Append an exact published version, such as `@0.1.0-alpha.0`, when your team needs the same version. The legacy `alpha` tag is not updated by automation; reinstall without `@alpha` to receive current releases. Project-only, verified-tarball and advanced source installations have separate [installation instructions](./installation.md).

Review active tasks and keep your project configuration, private task state and worktrees before updating. Do not delete unfinished work to resolve an upgrade problem. Older versions may not understand newer task state; downgrades are not guaranteed.

See [recent changes](https://github.com/Agilno-Tech/rivet/commits/main/) and [compatibility](./compatibility.md). Maintainers preparing a package should use the [release procedure](https://github.com/Agilno-Tech/rivet/blob/main/docs/maintainers/release.md).

## License

Rivet is licensed under [Apache License 2.0](https://github.com/Agilno-Tech/rivet/blob/main/LICENSE). Preserve the license and applicable attribution notices when redistributing it.
