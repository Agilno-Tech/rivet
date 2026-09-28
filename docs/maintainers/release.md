# Publishing alpha releases

Rivet is published as `@agilno-tech/rivet` under Apache License 2.0. The first registry release is `0.1.0-alpha.0`. Users install `@agilno-tech/rivet` with Yarn Classic, npm or pnpm; see [installation](../site/installation.md).

## Automatic version updates and publication

1. Merge reviewed changes into `main` using conventional commit titles, such as `fix: improve setup` or `feat: add a provider`.
2. **Release Rivet** (`publish.yml`) uses Release Please to create or update a release PR. During this alpha series, it advances the alpha counter, starting with `0.1.0-alpha.1`, and updates the package version, lockfile and changelog.
3. Review the release PR and its checks before merging it. Bot-created PRs do not trigger ordinary GitHub event workflows, so the release workflow explicitly dispatches CI and documentation checks for the release branch.
4. Merging the release PR creates the matching Git tag and GitHub prerelease. The same workflow builds and tests that source, builds documentation, runs fixture evaluations and packs one artifact.
5. Linux and macOS jobs on Node 22 and 24 install that exact artifact. All four jobs must pass before npm publication.
6. The publication job uses the `npm` GitHub environment and npm trusted publishing. It publishes the tested tarball directly with `npm publish --tag=latest`, downloads the registry bytes, verifies the recorded checksum and runs installed-package checks again. It uploads release evidence and dispatches Pages publication.

Feature branches run the verification matrix on pull-request events, without a duplicate branch-push run. Pushes to `main` and explicit workflow dispatch remain supported. New commits cancel obsolete verification runs for the same PR; documentation publication is kept separate from cancellable previews.

A GitHub prerelease may appear before npm publication finishes. Confirm the publication job succeeded before announcing availability. Check results separately from live Claude/Codex, integration and independent-user qualification.

Release Please is bootstrapped at commit `13f109e9d99e0591a7e0c255df50fd9ba1670cea`, the source of the manually published first alpha. The release manifest records that baseline. Changing release channels or moving to a stable version requires a reviewed configuration change.

## One-time repository and npm setup

- In GitHub Actions settings, allow Actions to create pull requests. Workflow permissions remain read-only by default; individual jobs request their required permissions.
- Create the GitHub environment `npm`, restricted to `main`. Additional required reviewers can be configured when the team wants a separate publishing approval.
- In the npm package settings, add a GitHub Actions trusted publisher with organization `Agilno-Tech`, repository `rivet`, workflow filename `publish.yml`, environment `npm`, and direct `npm publish` allowed.
- Use GitHub-hosted runners with Node 24 and npm 11.5.1 or newer. The publishing job requires `id-token: write`; no long-lived npm token is needed.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/). A future repository move can retain the package name, but requires updating repository URLs and the trusted-publisher binding before publishing from the new location.

## Retry or build a draft candidate

Run **Release Rivet** manually on `main`:

- Leave the tag empty to retry release PR preparation and dispatch missing release PR checks.
- Supply an existing alpha tag and leave publication disabled to build and qualify a draft candidate.
- Supply the tag and enable publication to retry a failed publication after investigating its cause.

The tag must match the package version and point to a commit in `main` history. Never move a published tag or reuse a version for changed bytes. Publication checks the registry first: an existing version is accepted only when its tarball matches the candidate exactly. An uncertain publish result is reconciled through registry reads rather than a second write. A new publication cannot move the `latest` channel backwards.

npm can accept a publication before its metadata and tarball are visible from all registry endpoints. Verification allows ten minutes of propagation time, polling every 15 seconds for metadata, matching package bytes and a `latest` tag at that version or newer. A temporary 404 waits; permission errors and mismatched bytes stop immediately. The workflow never repeats the publish command within that attempt, including when an existing version's tarball is still propagating.

If npm reports successful publication but the job ends with `publish-not-confirmed`, wait for registry propagation and inspect availability before retrying the failed job. Do not bump the version or manually publish it again just because verification timed out. A retry first checks the existing version and only accepts the exact tested package bytes. The publishing job has a 25-minute limit that also covers bounded registry requests, installed-package checks and evidence upload.

If verification ends with `latest-not-confirmed`, the package bytes matched but the default tag has not caught up. Inspect the tag before retrying; the workflow never republishes an existing version or moves the tag backwards. A manual tag repair requires an authorized npm account because OIDC cannot run `npm dist-tag`.

New releases publish directly to npm’s `latest` tag, so an unqualified installation receives the current release. Package versions remain `0.1.0-alpha.N`; using `latest` does not change their alpha quality. The legacy `alpha` tag is not updated by automation. Trusted publishing supports `npm publish`, but not a separate `npm dist-tag` update, so the workflow does not maintain an additional alias. Do not use `@alpha` to follow new releases; use the unqualified package name or an exact published version.

Each candidate records the source commit, package version, tarball checksum, build runtime and dependency lockfile digest. Release assets include the tarball, `release-manifest.json`, `SHA256SUMS`, and installation evidence. Packaging rejects lifecycle hooks and packs a private snapshot verified against exact commit blobs, with Git replacement objects disabled. Ignored/untracked files are excluded; symlink and submodule entries are unsupported.

For a local rehearsal, use a clean tagged checkout and a new output directory outside the repository:

```sh
node scripts/release-artifact.mjs build --source=/absolute/rivet --out=/absolute/new-candidate --tag=v0.1.0-alpha.1 --sha=<full-source-commit>
```

## Verify the exact artifact

Run the candidate's build/tests, documentation build, deterministic evaluations and installed-package lifecycle. Artifact verification must consume the tarball that will be distributed, without repacking from a different checkout. Downloaded bytes must match the recorded checksum. Keep the checksum and source identity from a trusted release record; a manifest downloaded beside altered bytes is not independent proof of authenticity.

```sh
node scripts/package-smoke.mjs --artifact-dir=/absolute/candidate --tag=v0.1.0-alpha.0 --source-sha=<full-source-commit> --artifact-sha256=<trusted-sha256> --report=/absolute/new-install-evidence.json
```

For a user-facing installation of an approved local tarball, the [verified bootstrap](../site/installation.md#install-a-verified-candidate-tarball) checks an explicitly trusted SHA-256 before npm runs. Maintainers should still record the broader lifecycle evidence below.

External-artifact mode verifies and installs the supplied tarball without repacking the checkout or testing a different Git source. Keep the three package assets in the candidate directory and put the new report elsewhere. It requires registry access for dependencies and creates disposable local repositories; it makes no model or external delivery requests.

The installation lifecycle must exercise the actual `rivet` executable through PATH, project setup, readiness checks, a small project's real build/test commands, repeated setup and uninstall preservation. Record resolved dependency versions alongside the runtime versions. The tarball checksum covers Rivet's package bytes; registry dependencies are resolved separately during installation.

Keep macOS/Linux and Node 22/24 artifact results distinct from live authenticated coding tasks. A passing package check does not demonstrate a complete Claude/Codex desktop workflow or a first-time user's success.

## Pilot and wider release

Start with a small pilot. Recruit five participants who did not build Rivet. At least four must reach a first valid plan within ten minutes after prerequisites/authentication, and every participant must finish a reviewable task. Record total elapsed time and every intervention, including authentication delays and environment repairs.

Run the task-to-checks-to-review-to-authorized-delivery journey with conversational and terminal entry points represented. Live provider delivery, deployment and model profiles require their own evidence. Shared Obsidian memory is not available; its eventual task handoff and two-user continuity require separate implementation and qualification before being advertised. Fix observed failures and repeat the affected scenarios before wider distribution.

After publication, fetch the artifact from the actual release URL as a new user would, verify its checksum, and rerun installation checks. A local pack or authenticated maintainer download alone cannot close this gate. Report unresolved limitations with the candidate; do not label it production-ready based only on fixture CI.

## Rollback

Keep the previous qualified artifact and checksum available. Before switching versions, preserve project configuration and private run state and inspect active tasks. Reinstall the previously qualified artifact only after checking its checksum and downgrade compatibility, then run help, doctor and task status.

Do not delete configuration, private task records, worktrees or user edits to make an older version run. If the older release cannot read newer state safely, stop and use the documented recovery path for that candidate. Do not infer downgrade support from an unchanged schema number.

The first versioned release has no previous published baseline. Mark release-to-release rollback rehearsal unavailable until a baseline exists, while still verifying preservation and reinstall behavior. Unpublishing or deleting a release is not a substitute for recovering users who already installed it.
