# Managed orchestration

Managed orchestration coordinates approved tasks on one machine through the normal `run` and `task` workflow. It reuses Rivet's task plans, decision records, isolated worktrees and verification evidence. It does not create work or grant delivery authority on its own.

## Scope

Managed orchestration adds approved model/effort routing, bounded session replacement, shared resource admission and dependency-aware work within a task. Independent work can run concurrently when the approved plan and role capacities allow it. Plans without explicit work dependencies retain serial execution. Opt-in multi-task verification batches check selected task heads in an isolated combined candidate through `rivet task verify --batch`; their reports are advisory and preserve each task’s separate verification and delivery approval. Completed-work cleanup offers a read-only preview and explicit confirmation before removing eligible Worker checkouts. Optional retention uses a separately approved policy during foreground execution.

Default ceilings are four active tasks, four agent executions, one heavy verification and one dependency installation. These are cooperative limits for participating Rivet processes. They do not measure or control unrelated applications. Approved project limits apply across active runs in the same project, while run limits may lower them further. Stricter limits from an active run remain in force until its held work settles; other projects retain their own limits. Task deadlines remain independent.

An agent slot represents an admitted Rivet executor invocation or host action. Provider-internal tool calls are not independent machine measurements. Hosts must use the admission workflow for each action they dispatch.

## Profiles

An optional `orchestration.executionPolicy` selects a configured profile for coordination, implementation, bounded fixes and independent review. Each approved plan pins its policy/profile identity and explains the selection. Changed policy requires renewed plan validation. Absent policy preserves the existing serial workflow.

Configured model and effort values reach the selected Claude or Codex CLI as separate arguments. Missing support fails explicitly. Provider acceptance and effective effort remain provider-specific; an argument receipt alone does not prove that a provider used the requested effort. Rivet never switches accounts or silently substitutes a model.

Host actions show profile recommendations. A host tool receipt must distinguish requested settings from observed settings; Rivet cannot independently prove what an external desktop agent ran.

To choose models without editing YAML, describe your preferences:

```sh
rivet models configure "Use high reasoning. Use my lead model for coordination and independent review, my coding model for implementation, and my fast model for bounded fixes."
```

Rivet clarifies model names and alternatives, shows the exact mapping, and saves it only after approval. See [plain-language model policies](./models.md#model-and-reasoning-policy) for the full flow.

For manual configuration, add an `executionPolicy` to the existing `.rivet/orchestration.yaml`; keep its other fields, including `enabled: false`. Replace the example model IDs with models supported by your installed CLIs and account:

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

## Parallel work within a task

The planner can describe work items with stable IDs, dependencies and shared resources. Rivet validates the dependency graph and adds ordering for overlapping owned paths or shared resources. Review the resulting dependencies, scope and worker concurrency ceiling before activation. The ceiling defaults to one; `executionPolicy.limits.workersPerTask` may raise it for new plans, subject to configured worker and manager capacities and available machine slots.

Each worker uses an isolated checkout. Completed work is merged into a separate integration candidate and checked with the project's configured quality gates before acceptance. A dependent starts only after its prerequisites have been accepted; unrelated workers can continue while that happens. If another worker advances the integration branch, Rivet rebuilds and checks the candidate against the accepted commit. Conflicts and failed checks preserve the checkout for inspection.

Use `rivet task status` to inspect worker checkouts and the accepted integration commit. For host-owned tasks, `rivet task deps` offers dependency setup in eligible worker or pending candidate checkouts. If candidate verification fails, the owning harness may retry the same recorded action and result after resolving the check environment. Changed source commits, results or session generations require reconciliation rather than replaying the old result.

Parallel acceptance does not skip final task verification or human approval. Candidate checks certify the exact combined commit; a worker's original branch is not independently certified by those checks.

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

### Optional verification reuse

By default, Rivet runs the configured quality gates each time. Projects with reproducible, local checks can opt into sharing an exact passing result in `.rivet/quality.yaml`:

```yaml
verificationReuse:
  enabled: true
  reproducible: true
  dependencyRoots: [node_modules]
  toolchainRoots: [tools]
```

Replace these directories with the actual dependency and toolchain inputs used by the checks. Both lists must explicitly name existing checkout-relative directories. `reproducible: true` asserts that the checks do not depend on changing external services or undeclared local inputs. Leave reuse disabled when that cannot be established.

Reuse requires the same clean checkout and commit, loaded project configuration, commands, authority, environment, executables and declared input contents. Rivet fingerprints bounded inputs and keeps environment values out of the persisted records. Unsafe or oversized inputs, unsupported interpreter resolution, and gates that produce evidence artifacts bypass reuse and execute normally. Changed inputs invalidate the result.

Spawned tasks and host task verification use this policy automatically. Task verification reports include `verificationReuse`, such as `executed`, `reused`, `disabled`, or a reason reuse was bypassed. Concurrent callers share verification ownership; stopping a waiter does not stop the owner. Uncertain ownership never authorizes a second execution. Reuse certifies the same checkout and commit; it does not certify a different task branch or replace delivery CI.

### Accounting

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

### Completed-work cleanup

Run `rivet task cleanup --preview` to inspect owned Worker checkouts for a selected task. Completed or cancelled tasks need recorded proof that the owner stopped, an unchanged checkout identity, a preserved branch and a clean checkout. Protected Rivet install receipts permit removal of the exact owned `node_modules` and `.rivet-deps` directories; tracked files or unknown artifacts prevent removal. Unsafe or unproven checkouts are retained with a reason.

The preview removes nothing and is not approval for later deletion. Run `rivet task cleanup` to display the exact eligible checkout paths, branches and commits, then confirm removal interactively. Declining keeps everything. Noninteractive calls cannot approve removal.

Rivet rechecks the task, stopped owner generation, reservation, checkout identity, branch tip and clean working tree while holding the task and runtime locks. Removal preserves branches, commits and task evidence. A private journal records each approved checkout before removal, so an interrupted operation can be inspected and explicitly retried without adopting a replacement directory. Removed checkouts remain visible as removed with their branches preserved.

Integration and verification candidate checkouts are retained. Unknown ignored files, build outputs, foreign dependency directories, and older `.rivet-deps` directories with only a checkout marker are retained. Cleanup never deletes branch refs, commits, task evidence or global caches. The preview lists each protected dependency directory and its receipt identity. Interrupted artifact removal is journaled; a replacement directory cannot inherit the old approval.

To approve future cleanup separately, run `rivet task cleanup --retention=7d` (1–365 days). The confirmation covers this canonical project, its current configuration, eligible Worker checkouts and the two protected dependency roots. Declining changes nothing; `rivet task cleanup --retention=off` revokes approval. Configuration or project identity changes suspend the policy until you approve it again.

Retention is disabled by default. Approved retention runs only during foreground task resume/watch or host prepare/next-action operations. Discovery reads at most 256 task records; a sweep attempts removal from at most four eligible old tasks and eight checkouts, with a time limit checked between removals. Already-cleaned and ineligible tasks do not consume that removal allowance. Status and cleanup preview never delete anything. There is no background daemon. Busy owners, incomplete installer receipts and unknown contents remain untouched; foreground execution reports retained or removed outcomes.

### Verify selected tasks together

Batch verification is optional. Enable it in committed `.rivet/quality.yaml` before creating tasks:

```yaml
verificationBatch:
  enabled: true
  maxTasks: 3          # 2–5 task heads
  waitMs: 2000        # 1–30000 milliseconds
  maxIsolationTasks: 2 # 0–5 diagnostic singleton checks after failure
```

Run `rivet task verify --batch` to select tasks, or use `--run=<task>` to enroll one task. Only selected, completed implementations with clean accepted integration heads can join. The foreground command waits for the configured size or oldest queued deadline, including a singleton. It stops waiting when its bounded observation period ends; retry the command to continue queued work. There is no background service.

Compatible tasks share an exact baseline, configuration, gate definitions and environment identity. Rivet freezes membership, creates an isolated combined candidate, and runs configured checks there. Later arrivals join a later batch. Command execution uses ordinary machine admission without claiming a second outer heavy slot. Unknown running owners are retained for inspection and never reclaimed by timeout or missing PID.

A fresh candidate needs its own dependencies. If prompted by status, run `rivet task deps`, review and approve the install, then retry `rivet task verify --batch`. This resumes the frozen candidate; changed participant heads, cancelled tasks, configuration or baseline changes invalidate it. No dependency directories are copied between checkouts.

`rivet task status` shows the combined candidate, exact participant commits, criteria, checks and private report path. Failed combined checks can run the bounded number of singleton diagnostics; unchecked tasks remain explicitly untested. These reports are advisory: they do not advance any task, certify its original branch, satisfy independent review or replace ordinary final verification and delivery approval. Candidate checkouts and reports remain available for inspection.

Each retry runs fresh checks. If an isolation diagnostic needs dependencies, approving that install and retrying may repeat the combined check and earlier diagnostics; an older result is never reused merely because its candidate commit stayed the same.

Re-enrolling a ready task refreshes an older queued head. If its head or approval changed while a frozen batch was waiting for dependencies, Rivet blocks that old batch, preserves its evidence and enrolls the new head separately. Running owners are never replaced. Reports retain bounded diagnostic output separately from the compact queue index, so verbose commands cannot fill the ownership record.

Machine admission applies to every task in the frozen batch, including tasks enrolled by an earlier caller. A paused, cancelled or expired member prevents new checks and dependency installation. The earliest applicable task or project deadline bounds execution. Rivet rechecks the whole batch after waiting for command capacity and before publishing evidence, while each verification command still uses only one heavy-verification slot.
