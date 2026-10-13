// Executable selection lives in trusted source, never in a profile or JSON command.
const scenario = (id, file, entries) => ({ id, file, criteria: entries.map(([id, test]) => ({ id, test })) });
export const catalog = {
  schemaVersion: 1,
  scenarios: [
    scenario('intake', 'test/integrations/context-intake.test.js', [
      ['sourced-criteria', 'normalizes both trackers and linked design context with source assurance and user additions'],
      ['reject-forged-context', 'rejects missing criteria, resource ambiguity, wrong project, auth failures and forged assurance'],
    ]),
    scenario('host', 'test/feature/host-execution.test.js', [
      ['durable-handoff', 'prepare and nextAction durably hand one Worker to the host without a model client'],
      ['verified-human-gate', 'submitResult integrates an exact restarted host action and verify stops at final human approval'],
    ]),
    scenario('repository-adapter', 'test/adapters/github.test.js', [
      ['source-contract', 'reads GitHub repository, branch, PR, check, review, and artifact metadata'],
      ['conditional-authority', 'GitHub child comments require trusted atomic parent-state compare-and-mutate'],
    ]),
    scenario('authority', 'test/core/authority.test.js', [
      ['delegation-ceiling', 'worker cannot inherit authority its manager does not have'],
      ['approval-binding', 'approval authority, principal, policy, and decision mismatches fail closed'],
    ]),
    scenario('recovery', 'test/runtime/recovery.test.js', [
      ['version-authority', 'retry and cancellation mutations require exact version and structural authority'],
      ['bounded-recovery', 'corrective and stale recovery nodes stay bounded, parented, and evidence-reasoned'],
    ]),
    scenario('model', 'test/models/delegation.test.js', [
      ['unverified-output', 'delegation makes one pinned hosted request and returns explicitly unverified output'],
      ['reject-unsupported', 'invalid profiles, prompts, credentials, spend limits and unsupported providers fail before network'],
    ]),
    scenario('orchestration-routing', 'test/models/execution-policy.test.js', [
      ['legacy-compatible', 'accepts managed policy without changing legacy enabled:false'],
      ['bounded-profiles', 'rejects unsafe profiles, unknown efforts, missing/ambiguous routes and advisory writes'],
      ['pinned-selection', 'resolves immutable approved identity and never falls back to another route'],
    ]),
    scenario('orchestration-telemetry', 'test/runtime/session-capabilities.test.js', [
      ['literal-arguments', 'bounded selected model and effort become literal argv'],
      ['independent-selection', 'independent review dispatches selection without duplicate legacy model'],
      ['unknown-measurements', 'telemetry distinguishes unknown billing and context from measured zero'],
      ['bounded-codex-config', 'Codex config escape hatches remain rejected'],
    ]),
    scenario('orchestration-handoff', 'test/feature/host-execution.test.js', [
      ['dirty-work-continuity', 'managed host checkpoint stopped successor completion preserves dirty work and rejects late results before integration'],
      ['uncertain-transfer-blocked', 'managed host unknown stop and changed dirty bytes block successor without resetting cumulative budgets'],
    ]),
    scenario('orchestration-capacity', 'test/runtime/resource-coordinator.test.js', [
      ['task-fairness', 'lazy reads and five task FIFO admissions share four slots'],
      ['cross-project-cap', 'independent processes contend for one agent without overadmission'],
      ['uncertain-owner-retained', 'restart with reused parent PID cannot release dispatched unknown descendants'],
      ['attempt-bound-no-execution', 'no-execution proof is bound to one dispatched attempt and rejects fabricated evidence'],
    ]),
    scenario('orchestration-supervision', 'test/cli/managed-orchestration.test.js', [
      ['explicit-enrollment', 'normal CLI persists explicit registration pause resume limits and planning renewal'],
      ['durable-deadline', 'managed watch preserves run deadline across restarted services and stops at decisions'],
    ]),
    scenario('orchestration-process-lifecycle', 'test/runtime/process-runner.test.js', [
      ['settled-cancellation', 'managed watch cancellation awaits real owned process settlement before capacity release'],
      ['descendant-retention', 'managed successful provider with surviving descendant retains unknown machine capacity'],
      ['proven-preflight-failure', 'actual Codex preflight without a child releases only its current machine attempt'],
      ['probe-descendant-retention', 'surviving compatibility probe blocks main execution and retains machine capacity'],
      ['stopped-probe-control', 'stopped compatibility probe permits the admitted main execution'],
      ['settled-scope-fence', 'settled execution scope fences saved runners and opaque success retains capacity'],
    ]),
    scenario('orchestration-host-admission', 'test/feature/host-execution.test.js', [
      ['queued-first-dispatch', 'enrolled host queues without poisoning state and requires observed stop before normal result'],
      ['queued-verification', 'enrolled host verification queues without recording failed checks then resumes'],
      ['expired-stop-reconciliation', 'application permits stopped host reconciliation after deadline without new admission'],
      ['queued-successor-clock', 'enrolled host successor starts its execution clock after queued admission'],
      ['legacy-admission-guard', 'enrolled legacy host rejects before changing its approved run or checkout'],
    ]),
    scenario('orchestration-task-ownership', 'test/runtime/application.test.js', [
      ['single-task-owner', 'concurrent enrolled calls own one run task slot and release it after settlement'],
      ['cancel-safe-claims', 'public cancel cleans queued and undispatched claims while preserving unknown writers'],
    ]),
    scenario('orchestration-command-admission', 'test/core/commands.test.js', [
      ['observed-command-stop', 'command lifecycle awaits observed process-group stop before release'],
      ['heavy-queue', 'enrolled heavy command waits for capacity then releases only its observed owner'],
      ['no-child-cancellation', 'command cancellation after admission before spawn releases proven unused capacity'],
    ]),
  ],
  deferred: [{ id: 'memory-continuity', status: 'not-implemented', reason: 'Shared memory and two-user continuity are post-MVP.' }],
};
