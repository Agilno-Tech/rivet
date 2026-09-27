# Contributing

Use Node.js 22 or 24 and Yarn Classic 1.22. For a local contributor checkout, run:

```sh
yarn install --ignore-scripts --no-lockfile
yarn run build
yarn run test
yarn run docs:build
yarn run package:smoke
```

The repository currently maintains its existing dependency lockfile. `--no-lockfile` leaves it unchanged without creating a Yarn lockfile; this local installation does not reproduce the exact locked CI dependency tree. CI remains the locked baseline. Do not migrate package managers or commit a second lockfile as part of these steps.

Add focused behavioral tests for new functionality, run the existing relevant regressions, and update the user-facing documentation. Keep generated distribution assets in sync with `yarn run build`.

Use the existing workflow service and validation boundaries. Prefer native harness tools or existing project scripts when they already solve the problem. New model descriptors must distinguish registration, implemented execution, and live qualification.

The public repository is [FraneAgilno/rivet](https://github.com/FraneAgilno/rivet). The license and package namespace are still being selected; npm publication remains disabled. Never include client code, credentials, or private work history in contributions.

## Maintainer guides

- [Release procedure](https://github.com/FraneAgilno/rivet/blob/main/docs/maintainers/release.md)
- [Evaluation runner](https://github.com/FraneAgilno/rivet/blob/main/docs/maintainers/evaluations.md)
- [Onboarding study](https://github.com/FraneAgilno/rivet/blob/main/docs/maintainers/first-task-trial.md)
