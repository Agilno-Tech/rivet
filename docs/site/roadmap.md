# What's next

Current work focuses on clearer task decisions, reviewable evidence, simpler onboarding and real-world integration testing. See [task decisions and review evidence](./runtime-reference.md#task-decisions-and-review-evidence) for the supported commands and their limits.

[Managed orchestration](./orchestration.md) supports bounded independent final review, corrections and re-review for terminal tasks, dependency-aware parallel work, opt-in exact-result reuse, selected-task verification batches and approved Worker checkout cleanup with optional foreground retention. Batch reports remain advisory and do not certify each participant’s original branch.

The following capabilities are not available today:

- Automatic PR/CI follow-through after authorized delivery, and automatic reviewer scheduling for host-owned tasks. Terminal tasks now support the bounded implementation/review/correction loop and stop on unresolved findings, human questions or exhausted limits.
- Shared delivery of an exact multi-task candidate, allowing one expensive verification to replace separate branch checks. Current verification batches are advisory.
- Terminal delivery cleanup for integration and verification candidate checkouts. Current cleanup covers eligible owned Worker checkouts.
- Optional protected client deliverables with versioned archives and an explicit retention policy. This should not require copying deliverables into every repository.
- A dedicated lessons-retrieval and memory subsystem, including shared project memory and Obsidian integration. Teams can record reviewed lessons in existing [project protocols](./memory-and-protocols.md) now; this does not provide automatic retrieval, synchronization or indefinite retention.
- Automatic Bitbucket merging. Continue to merge Bitbucket reviews manually.

No release date is promised for these items. For what you can use now, see [capabilities and limitations](./status.md). To suggest an improvement or report a problem, [open an issue](https://github.com/Agilno-Tech/rivet/issues).
