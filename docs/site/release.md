# Versions and updates

Rivet is currently an alpha, with package version `0.1.0-alpha.0`. A public registry package has not been published yet. Use the [GitHub installation instructions](./installation.md).

## Update a source installation

For the global Yarn Classic installation:

```sh
yarn global add "https://github.com/FraneAgilno/rivet.git#main"
rivet --help
rivet doctor
rivet task status
```

The `main` branch changes over time. Use a reviewed commit SHA instead of `main` when you need to select the same source revision across a team. Project-only and verified-tarball installations have separate [installation instructions](./installation.md).

Review active tasks and keep your project configuration, private task state and worktrees before updating. Do not delete unfinished work to resolve an upgrade problem. Older versions may not understand newer task state; downgrades are not guaranteed.

See [recent changes](https://github.com/FraneAgilno/rivet/commits/main/) and [compatibility](./compatibility.md). Maintainers preparing a package should use the [release procedure](https://github.com/FraneAgilno/rivet/blob/main/docs/maintainers/release.md).

## License

The package is currently marked `UNLICENSED`. Public repository access does not grant an open-source license. Distribution terms must be selected before an open-source release.
