# Contributing

Use Node.js 22 or 24 and Git. `package-lock.json` is the authoritative dependency baseline, so use npm for an installation matching CI:

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run docs:build
npm run package:smoke
```

For local development, Yarn Classic and pnpm can also install dependencies without writing a second lockfile:

::: code-group

```sh [Yarn Classic]
yarn install --ignore-scripts --no-lockfile
yarn run build
yarn run test
yarn run docs:build
yarn run package:smoke
```

```sh [pnpm]
pnpm install --ignore-scripts --no-lockfile
pnpm run build
pnpm run test
pnpm run docs:build
pnpm run package:smoke
```

:::

These alternatives resolve dependencies independently of `package-lock.json`; they do not reproduce the exact CI dependency tree. Use one package manager per checkout. Do not commit a second lockfile. Build Rivet explicitly after installation because dependency lifecycle scripts are disabled.

Add focused behavioral tests for new functionality, run the existing relevant regressions, and update the user-facing documentation. Keep generated distribution assets in sync with the `build` script.

Use the existing workflow service and validation boundaries. Prefer native harness tools or existing project scripts when they already solve the problem. New model descriptors must distinguish registration, implemented execution, and live qualification.

The public repository is [Agilno-Tech/rivet](https://github.com/Agilno-Tech/rivet). Rivet uses Apache License 2.0 and the package name `@agilno-tech/rivet`. Registry publication is a separate maintainer step. Never include client code, credentials, or private work history in contributions.

## Maintainer guides

- [Release procedure](https://github.com/Agilno-Tech/rivet/blob/main/docs/maintainers/release.md)
- [Evaluation runner](https://github.com/Agilno-Tech/rivet/blob/main/docs/maintainers/evaluations.md)
- [Onboarding study](https://github.com/Agilno-Tech/rivet/blob/main/docs/maintainers/first-task-trial.md)
