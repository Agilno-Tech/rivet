# Live CLI trial — 2026-10-21

An agent-operated smoke trial exercised the working branch in a disposable local Git repository with authenticated Codex and, after sign-in, Claude. This is evidence of small tasks, not a broad quality benchmark or an independent human usability study.

## Environment and setup

- Rivet source checkout: `feature/managed-orchestration-release-a`, based on `fcfa063`, with the status/session corrections described below applied for the second task.
- macOS arm64; terminal CLI used Node 25.2.1. The supported Node 22/24 matrix remains covered separately by CI.
- Codex CLI: `0.163.0-alpha.11`.
- Normal `rivet setup`, interactive `rivet setup --write`, and `rivet doctor` flow. Setup detected both harnesses and offered model routing for approval. Doctor reported ready local checks; the optional Git provider was disabled.
- Accepted recommended Codex routing: Astra for coordination, Luna for bounded fixes, with requested high reasoning. These are the configured selections; effective provider reasoning was not independently measured.
- Dependency-free Node greeting utility, real build/test commands, no remote repository or deployment.

## Observed results

| Task | Actual model work | Verification | Result |
| --- | --- | --- | --- |
| Trim names and use `World` for empty names | Changed the implementation and added three regression tests | Build and 4 tests passed | Reviewed, left for later, resumed, applied locally, worker checkout cleaned |
| Default an omitted argument to an empty name | Changed the parameter default and added one regression test | Build and 5 tests passed | Reviewed, applied locally, worker checkout cleaned |

Both tasks used real planning and worker CLI processes, isolated Git worktrees, committed changes, integration checks, interactive plan approval and separate final application/cleanup approvals. The operator inspected each diff before applying it. No fixture response replaced the model output. Cleanup preserved branches, commits, task evidence, and integration/candidate checkouts.

The second task confirmed that active execution no longer reports premature missing-integration recovery advice. Its finished session was `completed` with a `stopped` receipt; active task, agent and heavy-verification capacity returned to zero.

## Defects found and regression coverage

1. Status treated an initially ready final-review node as proof that worker dependencies were complete. It now requires all non-human work to finish before checking final integration readiness. Regression tests cover active work and still reject genuinely missing integration after completion.
2. Successful managed completion read a stale node object after the graph transition, incorrectly marking the session blocked. Session phase now uses the transitioned graph state. Regression tests cover successful stopped workers and retain unknown-writer failure handling.

3. Headless Claude could not run its checks and kept trying. Workers now explicitly defer denied or unavailable checks to trusted-host verification; actual failed checks remain blocking. Regression tests prove host gates cannot be skipped.
4. Automatic provider retries unnecessarily repeated dependency preparation after preserving in-scope Worker edits. A retry can now reuse preparation completed in the same execution only when checkout identity, dependency inputs and owned installation identities remain unchanged. Failed/incomplete or uncacheable preparation does not gain that reuse. Regressions cover retained edits, failed preparation, dependency drift, replaced directories and large lockfiles.
5. Status suggested recovery after a completed Worker checkout had been removed. It now directs the operator to cleanup history and says not to restart that completed Worker.

Independent review checked the real task diffs, build/tests, verification and local-approval evidence, cleanup results, and fixes.

## Claude follow-up

Claude Code `2.1.280` initially reported unauthenticated and stopped before planning. After sign-in, real Opus/high planning and Haiku/high implementation ran. The first Worker exceeded its 100,000-token allowance (447,225 cumulative tokens, $0.1781634 estimated cost). A bounded diagnostic confirmed that headless `acceptEdits` denied the npm checks.

The execution protocol now tells Workers to explicitly defer denied or unavailable checks to trusted-host verification without claiming they passed or bypassing permissions. Passing host gates remain mandatory. A retry also encountered a provider execution failure; the dirty checkout was preserved. A subsequent captured real response returned implementation success with checks explicitly deferred, but its native total of 285,971 tokens still exceeded the unchanged allowance ($0.1096373 estimated cost). Cached tokens are included in cumulative usage, not discarded.

The successful disposable Claude trial explicitly raised the Worker token allowance to 500,000, with Manager/Boss allowances of 750,000/1,000,000. The $2 Worker spending cap and 20-minute task deadline stayed unchanged. Product defaults were not changed during this trial. With that reviewed allowance, Claude completed the null-handling fix and added one regression test. Trusted-host build and all six tests passed. The operator reviewed the two-file diff, applied the verified commit locally, and approved cleanup of the completed Worker checkout while preserving its branch and evidence. Native usage was 221,258 cumulative tokens with $0.0584548 estimated cost. A local diagnostic observer forwarded the real CLI input/output unchanged and retained the result; no model response was substituted.

This qualifies the small Claude task with an explicitly adjusted budget, not reliable completion under the then-default 100,000-token allowance. Failed attempts and their dirty Worker checkouts were retained.

## Limits

This trial does not qualify parallel multi-worker execution, batch verification, dependency installation, external issue intake, PR delivery, deployment, long-running recovery, or default-budget Claude reliability. Those need separate live trials; deterministic tests are distinct evidence.

The subsequent default update recommends 500,000 Worker tokens, with 1,250,000 for Managers and 2,500,000 for the Boss to retain parallel allocation headroom. Spending caps remain unchanged; existing saved configurations are preserved.
