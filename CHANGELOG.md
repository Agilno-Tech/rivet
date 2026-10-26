# Changelog

## [0.1.0-alpha.7](https://github.com/Agilno-Tech/rivet/compare/v0.1.0-alpha.6...v0.1.0-alpha.7) (2026-10-26)


### Bug Fixes

* support approved redaction and agent review context export ([ea0fb3f](https://github.com/Agilno-Tech/rivet/commit/ea0fb3f520d7c109fdbdfe645001d58baa55604e))

## [0.1.0-alpha.6](https://github.com/Agilno-Tech/rivet/compare/v0.1.0-alpha.5...v0.1.0-alpha.6) (2026-10-23)


### Bug Fixes

* avoid false positives in review secret checks ([#68](https://github.com/Agilno-Tech/rivet/issues/68)) ([88c401b](https://github.com/Agilno-Tech/rivet/commit/88c401b3b8ff393fd1ccc34624cc701cd6ff7e41))

## [0.1.0-alpha.5](https://github.com/Agilno-Tech/rivet/compare/v0.1.0-alpha.4...v0.1.0-alpha.5) (2026-10-22)


### Features

* add managed task orchestration and guided setup ([#66](https://github.com/Agilno-Tech/rivet/issues/66)) ([77cdfd2](https://github.com/Agilno-Tech/rivet/commit/77cdfd24bd73786261d0fa8cbb07adee8df3184a))

### Fixes

* Resolve abbreviated Bitbucket pull-request commit hashes, including fork sources, before validating a review. Open PRs are no longer rejected solely because Bitbucket returned a shortened hash.
* Defer denied headless Worker checks to trusted-host verification, preserve safe preparation across provider retries, and clarify status after cleanup.

### Recommended defaults and upgrading

Fresh setup recommends 500,000 cumulative Worker tokens with larger parent allowances for parallel work. Claude's $2 Worker spending cap is unchanged. Existing project configuration and approved task budgets are preserved.

Run `rivet update` from your configured project, confirm `rivet --version` reports `0.1.0-alpha.5` (or newer), and restart your coding session. Then retry `rivet review` with the Bitbucket PR URL. No token or provider configuration change is required specifically for the shortened-hash fix.

## [0.1.0-alpha.4](https://github.com/Agilno-Tech/rivet/compare/v0.1.0-alpha.3...v0.1.0-alpha.4) (2026-10-09)


### Features

* simplify global and project updates ([#63](https://github.com/Agilno-Tech/rivet/issues/63)) ([d01b714](https://github.com/Agilno-Tech/rivet/commit/d01b714930ce02e9af6205d54564aa865a2a2f37))

## [0.1.0-alpha.3](https://github.com/Agilno-Tech/rivet/compare/v0.1.0-alpha.2...v0.1.0-alpha.3) (2026-10-09)


### Features

* add PR reviews and task-aware branch conventions ([#61](https://github.com/Agilno-Tech/rivet/issues/61)) ([0760a0b](https://github.com/Agilno-Tech/rivet/commit/0760a0b5949442a6c4bf52370e83b1c2085f7bba))

## [0.1.0-alpha.2](https://github.com/Agilno-Tech/rivet/compare/v0.1.0-alpha.1...v0.1.0-alpha.2) (2026-09-28)


### Features

* task decisions and configurable review evidence ([#60](https://github.com/Agilno-Tech/rivet/issues/60)) ([a314138](https://github.com/Agilno-Tech/rivet/commit/a3141388beca5edb827fa75bd5f32e39dadfc4f7))


### Bug Fixes

* keep latest release current and upgrade action runtimes ([#59](https://github.com/Agilno-Tech/rivet/issues/59)) ([ce41fc1](https://github.com/Agilno-Tech/rivet/commit/ce41fc1e0c1eabd4f3230f8b443ab63078418be8))
* wait for npm registry propagation before verification ([#57](https://github.com/Agilno-Tech/rivet/issues/57)) ([9c79217](https://github.com/Agilno-Tech/rivet/commit/9c7921702a3674f1acab370b482f631734444b1e))

## [0.1.0-alpha.1](https://github.com/Agilno-Tech/rivet/compare/v0.1.0-alpha.0...v0.1.0-alpha.1) (2026-09-28)


### Features

* automate alpha releases and use registry installation ([#54](https://github.com/Agilno-Tech/rivet/issues/54)) ([62fa9d8](https://github.com/Agilno-Tech/rivet/commit/62fa9d801bb8ff2b83306c1df82651ccfe4a4445))


### Bug Fixes

* dispatch checks for the generated release branch ([#55](https://github.com/Agilno-Tech/rivet/issues/55)) ([23c5739](https://github.com/Agilno-Tech/rivet/commit/23c5739ff95f65f98db786a22834539836491cad))

## 0.1.0-alpha.0 (2026-09-28)

### Implemented

- Global/project installation, setup, project detection, diagnostics and redacted support reports.
- Terminal task planning, status and resume, plus protocols for active coding harnesses.
- Isolated worktrees, dependency preparation, approval boundaries and recorded verification.
- Capability-based Claude/Codex CLI discovery and configurable model delegation.
- Scoped integration registration and sourced Jira, Linear, Figma and Confluence context.
- Repository inspection, separately approved branch publication, GitHub/GitLab review creation and supported merge paths.
- Project-configured GitHub Actions deployment and Jira/Linear delivery comments.
- Durable delivery reconciliation, stale-lock recovery and checkout-preserving status guidance.
- Deterministic fixture evaluations and a draft candidate workflow with checksums, source manifests and exact-artifact installation checks.

### Qualification and remaining work

This alpha release is not a completed pilot or a production-readiness claim. Full host/desktop workflows, independent first-user trials, authenticated integration and delivery scenarios, broader live model profiles and broader installation environments require separate evidence. Shared Obsidian memory is post-MVP and remains unimplemented. Remaining work is tracked in the published status documentation.

Published on [npm](https://www.npmjs.com/package/@agilno-tech/rivet/v/0.1.0-alpha.0) as `@agilno-tech/rivet@0.1.0-alpha.0`, licensed under Apache-2.0, with the `alpha` tag. The first release was published manually; the candidate workflow builds and tests artifacts. See [release guidance](https://agilno-tech.github.io/rivet/release.html) and the [compatibility matrix](https://agilno-tech.github.io/rivet/compatibility.html).
