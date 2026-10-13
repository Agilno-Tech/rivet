# What's next

Current work focuses on clearer task decisions, reviewable evidence, simpler onboarding and real-world integration testing. See [task decisions and review evidence](./runtime-reference.md#task-decisions-and-review-evidence) for the supported commands and their limits.

The following capabilities are deferred and are not available today:

- Dependency-aware parallel feature work with verified candidate integration. [Managed orchestration](./orchestration.md) initially keeps each task's feature nodes sequential.
- Exact-result verification reuse, multi-task verification batches and automatic completed-worktree cleanup. Shared admission limits concurrent heavy checks; it does not certify several branches with one result.
- Optional protected client deliverables with versioned archives and an explicit retention policy. This should not require copying deliverables into every repository.
- A dedicated lessons-retrieval and memory subsystem, including shared project memory and Obsidian integration. Teams can record reviewed lessons in existing [project protocols](./memory-and-protocols.md) now; this does not provide automatic retrieval, synchronization or indefinite retention.
- Automatic Bitbucket merging. Continue to merge Bitbucket reviews manually.

No release date is promised for these items. For what you can use now, see [capabilities and limitations](./status.md). To suggest an improvement or report a problem, [open an issue](https://github.com/Agilno-Tech/rivet/issues).
