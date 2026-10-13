# Managed orchestration

Managed orchestration coordinates approved tasks on one machine through the normal `run` and `task` workflow. It reuses Rivet's task plans, decision records, isolated worktrees and verification evidence. It does not create work or grant delivery authority on its own.

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

This example allows three replacements per node. Action and time bounds remain available when native context occupancy is unknown. Existing role budgets still apply across all generations. An approved managed task participates in shared machine capacity automatically when execution starts. There is no separate registration step.

## Start and continue a task

Use the existing task workflow. In a project with a managed execution policy:

```sh
rivet run "Add a health endpoint with a regression test" --for=1h
rivet task status
rivet task pause
rivet task resume
```

Review and approve the plan as usual. Rivet records the task's participation and shares capacity automatically. Proposing or declining a plan does not enroll it. Status is read-only. Tasks without a managed policy retain their existing behavior; `--for` requires a managed task.

The default execution allowance is one hour. `--for` accepts a positive duration in seconds, minutes or hours, such as `90s`, `30m` or `2h`. It is available on `run`, `task start` and `task resume`. The deadline is saved when managed execution first starts. Restarting or resuming never extends it; an explicit shorter allowance may shorten it. An expired task needs a new approved task to receive a fresh execution allowance.

`task status` shows the deadline, paused state, capacity and waiting reasons. Rivet selects the current task automatically. If several active tasks exist, the interactive chooser asks which one; scripts can select the existing task with `--run=<run-id>`. No registration ID is needed.

Pause prevents new work from starting. It does not terminate an existing writer. Resume restores eligibility within the saved deadline and continues through the existing workflow. A host task stays with its owning coding harness; the terminal does not launch a second worker. The harness handles action and checkpoint receipts using Rivet's agent protocol.

Deadline expiry prevents new execution. It still permits recording an exact stopped receipt or reconciling a result from already admitted work. Cancellation removes queued and safely undispatched claims; dispatched work with unknown liveness retains its capacity. A running terminal or coding harness is required; closing the desktop application does not leave an always-on execution service.

Adding a managed policy to project configuration does not upgrade an older approval. Review a new plan before managed execution.

## Machine-wide diagnostics

For advanced inspection and machine ceilings:

```sh
rivet orchestrate status --json
rivet orchestrate limits --limits-json='{"activeTasks":4,"agentExecutions":4,"heavyVerification":1,"dependencyInstalls":1}' --json
```

These commands complement task status. Approved policy limits may lower machine ceilings. Inspect outstanding work before changing ceilings. Expiry and parent-process death do not prove child processes stopped, so an uncertain owner keeps its capacity until reconciled.

The private coordinator lives at `~/.rivet-machine`. `RIVET_MACHINE_STATE_ROOT` selects a different private root, primarily for isolated environments. Participating processes must share the same root. Read-only inspection before the first managed task does not create coordinator state. Registrations and claim identities are implementation details; users operate on projects and tasks.

## Continue a task in a fresh session

A checkpoint preserves the task's approved scope, acceptance criteria, decision references, summary, usage and a verified manifest of the worker checkout. Dirty edits stay in that checkout; checkpointing does not commit them. The manifest binds the current HEAD, index, file contents, modes and identities. A changed checkout requires reconciliation before transfer.

The runtime records checkpoint preparation, fences the old generation, records the stop outcome, revalidates the checkout, and transfers ownership to a successor. Old results cannot commit or integrate after the generation changes. A crash during a transition leaves durable state for inspection; it does not silently launch another writer.

Replacement sessions retain the task's spending limits, retry count and review history. Session replacement has its own configured cap. A missing or uncertain stop receipt retains ownership and blocks transfer. A process ID or an expired heartbeat alone is not proof that a writer stopped.

Reliable measured context occupancy can trigger turnover. When it is unavailable, Rivet uses configured time bounds and observed action boundaries. These count Rivet actions, not hidden provider tool calls. A timeout before a valid checkpoint is a recovery condition, not a successful handoff.

The owning harness uses the checkpoint and handoff protocol for host sessions; normal users continue with `rivet task resume`. See the [exact input and receipt contracts](./runtime-reference.md#managed-session-checkpoints-and-handoffs). Owned CLI tasks yield at bounded call boundaries; these commands do not reset a running CLI process.

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
