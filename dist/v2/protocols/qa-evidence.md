# QA Evidence Protocol

Protocol version: 1

Completion is a traceable evidence decision, not a narrative claim.

## Authority

The Quality Manager configures and reviews the required test and evidence map within the approved completion profile. Workers may produce evidence but cannot approve their own results. A human retains final approval for visual baselines, manual-review exceptions, release delivery, and durable publication.

## State transitions

Quality work follows `declared -> executed -> collected -> validated -> reviewed -> approved -> published`. A failed deterministic gate creates a failed record and corrective work. An evidence bundle is draft until all referenced files are bounded, checksummed, and validated. Publication is durable only when an approved remote location and checksum are recorded.

## Stop conditions

Stop when an acceptance criterion has no test or approved manual review, a command differs from its configured executable and argument array, provenance is missing, an artifact changed after hashing, a test is skipped without authorization, a visual environment is not controlled, or required independent and human reviews are absent.

## Evidence

For each gate capture command provenance, start and end time, working directory, commit SHA, exit status, sanitized output summary, artifact paths, and SHA-256 checksums. Journey evidence also records route, persona, browser, viewport, data mode, and design version. The final manifest maps each in-scope acceptance criterion to a passed deterministic test or an approved manual item.

## Recovery

Preserve the failed run and its checksums. Correct the cause in a new bounded node, rerun affected gates, and produce a new evidence revision. Never edit a failed result into a pass or reuse artifacts from a different commit.

## Client adapter boundaries

CI, browser, storage, and provider adapters return bounded versioned metadata. They cannot declare a gate passed, approve a manual exception, or claim publication without independently verifiable identity and checksums. Logs and screenshots are redacted before entering prompts, events, or bundles.

## Evidence provenance and positive controls

Tie each numerical claim to its command or measurement procedure, tested commit, environment, time, units and retained artifact. Separate observed values from estimates and model-reported values. Do not present an estimated context-window percentage or a model's self-reported usage as provider telemetry. If the source is unavailable, mark the measurement unavailable.

For checks intended to detect a defect, include a positive control when practical: show that the check fails on a bounded known-bad fixture and passes on the corrected case. Preserve both results. Run controls in disposable test fixtures; do not weaken production checks, introduce real secrets, or damage a working repository to demonstrate a failure.

Review acceptance-criterion coverage, relevant unchanged behavior and documentation together. User-facing behavior, commands, configuration and their documentation belong in the same pull request. Record missing evidence as an explicit gap rather than filling it with an unsupported success claim.

## Structured task review

Use `rivet task review --phase=plan` or `--phase=final` to obtain the current subject, and `rivet task review --input-json=<serialized-report>` to submit reviewer judgments. Review identity must match the task, request, plan and source/diff being reviewed. Required review policy and reviewer path coverage must be satisfied before delivery. A changed subject invalidates earlier approval; reaching the configured round limit requires human resolution.

Rivet records and validates review evidence; it does not automatically dispatch a separate model or authenticate a reviewer's independence. Keep implementation and review actors separate through the team's actual review process. Never fabricate reviewer identities, findings, tested measurements or approvals.
