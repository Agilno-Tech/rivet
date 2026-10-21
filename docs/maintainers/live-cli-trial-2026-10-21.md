# Live CLI trial — 2026-10-21

An agent-operated smoke trial exercised the working branch in a disposable local Git repository with authenticated Codex. This is evidence of two small successful tasks, not a broad quality benchmark or an independent human usability study.

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

Independent review checked the real task diff, build/tests, verification and local-approval evidence, cleanup results, and both fixes.

## Limits

Claude Code `2.1.280` was detected, but its authentication status was `loggedIn: false`. The Claude attempt stopped before planning with provider-unavailable; it is not counted as a successful Claude trial.

This trial does not qualify parallel multi-worker execution, batch verification, dependency installation, external issue intake, PR delivery, deployment, long-running recovery, or live Claude behavior. Those need separate live trials; deterministic tests are distinct evidence.
