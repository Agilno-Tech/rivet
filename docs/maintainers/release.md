# Release candidate checklist

Rivet uses package name `@agilno-tech/rivet`, Apache License 2.0 and initial version `0.1.0-alpha.0`. Package metadata permits public publication under the `alpha` tag. The npm package has not been published yet; changing metadata does not publish it.

This runbook describes the evidence required for a candidate. The manual candidate workflow builds a draft prerelease and checks the exact artifact on Linux/macOS with Node 22/24. Actual published-channel qualification remains pending; current installation instructions are in [Get started](../site/getting-started.md).

## Record the candidate

Before a versioned prerelease, record:

- Exact source commit and reviewed version change.
- Prerelease tag matching the package version, pointing to that commit.
- Tarball filename, SHA-256 checksum and release manifest.
- Build operating system, architecture, Node and npm versions, and dependency lockfile digest.
- Links to CI, artifact installation checks, Pages deployment and user-trial evidence.
- Implemented capabilities and remaining qualification from the [compatibility matrix](../site/compatibility.md).
- Named support/triage owner and escalation route, agreed before inviting the pilot.
- Explicit publication decision and intended pilot audience.

Do not move an existing tag or replace an asset under the same version. A changed candidate needs a new version and evidence.

## Build a draft candidate

Review and merge the candidate first. Create an immutable prerelease tag matching `package.json`, such as `v0.1.0-alpha.0`, on the intended reviewed commit. The tag must already exist and its commit must belong to the default branch history. The workflow never creates or moves tags.

From GitHub Actions, run **Rivet candidate artifact** on the default branch and supply that tag. It runs build/tests, docs and fixture evaluations, checks generated distribution consistency, then packs once. Packaging rejects lifecycle hooks and packs a private snapshot verified against the exact commit blobs, with Git replacement objects disabled. Ignored/untracked files are excluded; symlink and submodule entries are currently unsupported. The artifact contains Rivet's existing built files; npm publication is not performed.

All four installation jobs download that same tarball and check its expected checksum, source and version. They record runtime and resolved dependency versions plus actual setup/readiness/local-check outcomes. Only after every job passes does the workflow create a **draft prerelease** containing:

- `agilno-tech-rivet-<version>.tgz`
- `release-manifest.json`
- `SHA256SUMS`
- Installation evidence for each tested OS/Node combination

Only the final draft job has repository write permission. Existing releases/assets are never replaced by this workflow. A failed or partially uploaded draft needs investigation; rerunning does not overwrite it. Publication and audience selection remain explicit owner decisions. A draft is not a public installation channel.

For a local rehearsal, use a clean tagged checkout and a new output directory outside the repository:

```sh
node scripts/release-artifact.mjs build --source=/absolute/rivet --out=/absolute/new-candidate --tag=v0.1.0-alpha.0 --sha=<full-source-commit>
```

This is maintainer tooling. Ordinary users should follow the published installation instructions.

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

## Preparing registry publication

The existing candidate workflow creates GitHub draft assets only. npm publication is a separate, explicitly authorized manual step:

1. Confirm your npm account has publishing access to the `agilno-tech` organization, and enable the account authentication required by npm. Keep credentials and one-time codes out of Git and issue reports.
2. Confirm the reviewed package has name `@agilno-tech/rivet`, license `Apache-2.0`, the complete `LICENSE` file, and public `publishConfig` using the `alpha` tag and npm registry. Release validation checks these fields. The package must not be private.
3. Build and verify one immutable candidate tarball using the procedure above. Keep version `0.1.0-alpha.0` only if that version has never been published; subsequent candidates need a new version. Review the manifest, checksum, package contents and installation evidence.
4. Authenticate locally, then dry-run publication of that exact tested tarball. Do not publish from the working directory or repack after testing:

   ```sh
   npm login --registry=https://registry.npmjs.org/
   npm publish /absolute/candidate/agilno-tech-rivet-0.1.0-alpha.0.tgz --access public --tag alpha --registry=https://registry.npmjs.org/ --dry-run
   ```

5. After checking the dry-run and approving publication, publish the same bytes:

   ```sh
   npm publish /absolute/candidate/agilno-tech-rivet-0.1.0-alpha.0.tgz --access public --tag alpha --registry=https://registry.npmjs.org/
   ```

6. Verify the registry package metadata and alpha tag, download its tarball, compare its SHA-256 with the tested artifact, and rerun installation checks against those downloaded bytes. Test fresh registry installation with each documented package manager. Only then replace the source-install quickstart with registry commands and announce availability.

The explicit `alpha` tag keeps this release off the `latest` channel. The executable remains `rivet`. npm is used here as the registry publishing client; users can install with Yarn Classic, npm or pnpm. A future automated publisher should use a separately reviewed npm trusted-publishing workflow with short-lived OIDC credentials.

A future repository move need not change the npm package name. Keep npm ownership/access, update repository and support URLs, and replace the trusted-publisher binding with one for the new repository/workflow before publishing there. A different npm scope or package name is a different package identity, so choose that separately from the GitHub location.

References: [scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/), [distribution tags](https://docs.npmjs.com/adding-dist-tags-to-packages/), [trusted publishing](https://docs.npmjs.com/trusted-publishers/) and [package metadata](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/).
