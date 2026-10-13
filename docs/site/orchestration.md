# Managed orchestration

Managed orchestration coordinates explicitly enrolled projects and approved tasks on one machine. It reuses Rivet's task plans, decision records, isolated worktrees and verification evidence. It does not create work or grant delivery authority on its own.

## Scope

Managed orchestration adds approved model/effort routing, bounded session replacement and shared resource admission. Feature nodes within one task remain sequential. Dependency-aware parallel integration, verification batching and automatic worktree cleanup belong to later releases.

Default ceilings are four active tasks, four agent executions, one heavy verification and one dependency installation. These are cooperative limits for participating Rivet processes. They do not measure or control unrelated applications. Project and run limits may lower machine ceilings.

An agent slot represents an admitted Rivet executor invocation or host action. Provider-internal tool calls are not independent machine measurements. Hosts must use the admission workflow for each action they dispatch.

## Profiles

An optional `orchestration.executionPolicy` selects a configured profile for coordination, implementation, bounded fixes and independent review. Each approved plan pins its policy/profile identity and explains the selection. Changed policy requires renewed plan validation. Absent policy preserves the existing serial workflow.

Configured model and effort values reach the selected Claude or Codex CLI as separate arguments. Missing support fails explicitly. Provider acceptance and effective effort remain provider-specific; an argument receipt alone does not prove that a provider used the requested effort. Rivet never switches accounts or silently substitutes a model.

Host actions show profile recommendations. A host tool receipt must distinguish requested settings from observed settings; Rivet cannot independently prove what an external desktop agent ran.

Add an `executionPolicy` to the existing `.rivet/orchestration.yaml`; keep its other fields, including `enabled: false`. Replace the example model IDs with models supported by your installed CLIs and account:

```yaml
executionPolicy:
  version: 1
  mode: managed
  limits:
    activeTasks: 4
    agentExecutions: 4
    workersPerTask: 2
    heavyVerification: 1
    dependencyInstalls: 1
  profiles:
    implementation:
      harness: codex
      model: your-coding-model
      effort: high
      capabilities: [read, edit, commands]
    review:
      harness: claude
      model: your-review-model
      effort: low
      capabilities: [read]
  routing:
    bounded-fix: implementation
    implementation: implementation
    independent-review: review
    coordination: review
  sessions:
    maxReplacements: 3
    maxActions: 100
    maxMinutes: 30
    contextThresholdPercent: 80
```

This example allows three replacements per node. Action and time bounds remain available when native context occupancy is unknown. Existing role budgets still apply across all generations. The policy enables routing and session contracts; machine resource coordination additionally requires explicit project enrollment.

## Enroll a project and inspect capacity

Register each participating repository by its canonical root. Supply an absolute deadline in Unix milliseconds. For example, this enrolls the current repository for one hour:

```sh
deadline=$(node -e 'console.log(Date.now() + 60 * 60 * 1000)')
rivet orchestrate register --project="$PWD" --deadline-ms="$deadline" --json
rivet orchestrate status --json
```

Registration does not create or approve a task. Continue using `rivet run` or the host task workflow. Approved runs in an enrolled project receive durable run registrations; use the registration ID shown by orchestration status to inspect one. Existing runs can be registered explicitly with `--run=<run-id>`.

Enrolled host work requires an approved plan with the managed session policy. Adding that policy to project configuration does not upgrade an older approval; review a new plan before managed host execution. Unenrolled legacy workflows keep their existing behavior.

The private coordinator lives at `~/.rivet-machine`. `RIVET_MACHINE_STATE_ROOT` selects a different private root, primarily for isolated environments. All participating processes must use the same root to share capacity. Reading status before enrollment does not create coordinator state.

```sh
rivet orchestrate status <registration-id> --json
rivet orchestrate pause <registration-id> --json
rivet orchestrate resume <registration-id> --json
rivet orchestrate watch <run-registration-id> --deadline-ms="$deadline" --max-ticks=10 --interval-ms=1000 --json
```

Pause prevents new admissions; it does not terminate an existing writer. Resume restores eligibility within the original deadline. A watch operates on one registered run, preserves existing plan and delivery approvals, and returns when it reaches a decision or another bounded stopping condition. It needs a running terminal process; closing the desktop application is not an always-on execution service.

Re-registering a run cannot extend its deadline. A project registration can be renewed explicitly with `rivet orchestrate renew <project-registration-id> --deadline-ms=<new-deadline>` when it has no held or queued claims. Renewal applies to future work and does not renew existing run deadlines.

Deadline expiry prevents new execution. It does not prevent recording an exact stopped receipt or reconciling a result from already admitted work. Cancellation removes queued and safely undispatched claims; dispatched work with unknown liveness retains its lease.

Machine ceilings can be changed explicitly; project/run registration accepts lower limits with `--limits-json`. For example:

```sh
rivet orchestrate limits --limits-json='{"activeTasks":4,"agentExecutions":4,"heavyVerification":1,"dependencyInstalls":1}' --json
```

Inspect outstanding claims before changing ceilings. Status reports queued work and retained owners. Expiry and parent-process death do not prove that child processes stopped, so an uncertain owner keeps its capacity until reconciled.

## Continue a task in a fresh session

A checkpoint preserves the task's approved scope, acceptance criteria, decision references, summary, usage and a verified manifest of the worker checkout. Dirty edits stay in that checkout; checkpointing does not commit them. The manifest binds the current HEAD, index, file contents, modes and identities. A changed checkout requires reconciliation before transfer.

The runtime records checkpoint preparation, fences the old generation, records the stop outcome, revalidates the checkout, and transfers ownership to a successor. Old results cannot commit or integrate after the generation changes. A crash during a transition leaves durable state for inspection; it does not silently launch another writer.

Replacement sessions retain the task's spending limits, retry count and review history. Session replacement has its own configured cap. A missing or uncertain stop receipt retains ownership and blocks transfer. A process ID or an expired heartbeat alone is not proof that a writer stopped.

Reliable measured context occupancy can trigger turnover. When it is unavailable, Rivet uses configured time bounds and observed action boundaries. These count Rivet actions, not hidden provider tool calls. A timeout before a valid checkpoint is a recovery condition, not a successful handoff.

Use `rivet task checkpoint --run=<id> --input=<file>` and `rivet task handoff --run=<id> --input=<file>` for host sessions. See the [exact input and receipt contracts](./runtime-reference.md#managed-session-checkpoints-and-handoffs). Owned CLI tasks yield at bounded call boundaries; these commands do not reset a running CLI process.

## Evidence and limits

Claude structured output provides native token accounting and a native cost estimate. Codex's current result envelope supplies model-reported tokens; cost is unknown. Context occupancy is unknown for both current adapters. Unknown values stay null with their source and assurance; they are not measured zero.

A fresh bounded invocation can continue a verified checkpoint. This does not imply arbitrary live compaction or provider-session reset support. Host tools have their own capabilities and trust boundary.

The managed fixture tests exercise lifecycle and admission mechanics using disposable Git repositories and subprocesses. Paid live-model execution, desktop child-session behavior and long unattended operation require separate qualification. Fixture checks do not establish token savings or production throughput.

On 2026-10-12, the two-worker fixtures in `test/runtime/feature-runtime-bridge.test.js` produced the following sample on macOS with Node 22.22.0. Times include disposable Git setup and simulated model work, and are not provider benchmarks:

| Fixture | Worker calls | Maximum concurrent workers | Installs | Verification commands | Elapsed |
| --- | ---: | ---: | ---: | ---: | ---: |
| Legacy serial | 2 | 1 | 2 | 3 | 9.1 s |
| Managed routing | 2 | 1 | 2 | 3 | 9.2 s |
| Managed, one successor per worker | 4 | 1 | 2 | 3 | 11.7 s |

The successor case preserves dirty work without repeating dependency installation or final verification. Native token/cost coverage is unmeasured in these fixtures. Separate tests exercise cross-project resource contention, restart with uncertain owners, and cancellation against real owned subprocesses. These qualify local mechanics, not an unattended live-model pilot.
