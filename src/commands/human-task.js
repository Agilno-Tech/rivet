import { previewTaskWorktreeCleanup, applyTaskWorktreeCleanup, confirmTaskWorktreeCleanup } from '../git/worktree-cleanup.js';
import { executionForNode } from '../feature/client-profile.js';
import {taskAllowance,requireManagedAllowance,activateTaskAdmission,taskCapacity} from '../runtime/task-orchestration.js';
import {findRegistration} from '../runtime/machine-admission.js';
import {withMachineContext} from '../runtime/machine-admission.js';
import {readJson} from './work.js';
import * as filesystem from 'node:fs';
import { taskGovernanceCommand } from './task-governance.js';
import { taskState } from '../cli/task-presentation.js';
import { finishTask } from './task-completion.js';
import { resolveConfiguredProject } from '../cli/project-discovery.js';
import { withTerminalInterruption } from '../cli/interrupt.js';
import { CliError, EXIT_CODES } from '../cli/output.js';
import { loadProjectConfig } from '../config/load.js';
import { createFeatureRunStore } from '../feature/run-store.js';
import { createGitClient } from '../git/client.js';
import { createReservationStore } from '../git/reservations.js';
import { bootstrapWorktreeDependencies } from '../runtime/worktree-bootstrap.js';
import { listExistingFeatureRunPaths, resolveExistingStatePaths } from '../state/paths.js';
import { activateProposal } from './human-run.js';
import { invokeFeature } from './feature.js';
import { confirmIsolatedDependencyInstall } from './dependency-approval.js';

const RUN_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ACTIVE = new Set(['proposed', 'approved', 'running', 'blocked', 'awaiting-final-approval']);

function fail(message, code = 'INVALID_INPUT') { throw new CliError(message, code); }

function visible(value) {
  return String(value).replace(/[\u0000-\u001f\u007f\u009b]/g, character =>
    `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`);
}

function diagnostic(value) {
  return String(value).replace(/[\u0000-\u001f\u007f\u009b]/g, character =>
    character === '\n' || character === '\t'
      ? character : `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`);
}

async function runs(project) {
  try {
    const paths = await listExistingFeatureRunPaths(project);
    const result = [];
    for (const path of paths) {
      const record = await createFeatureRunStore(path).readOnly();
      if (record === null) fail('A private run is incomplete. Inspect its state before selecting another run.', 'REPOSITORY_CONFLICT');
      result.push(record);
    }
    return result;
  } catch (error) {
    if (error instanceof CliError) throw error;
    fail('Private run discovery failed or found unsafe state. Inspect it before continuing.', 'REPOSITORY_CONFLICT');
  }
}

function summary(record) {
  const criterion = record.workRequest.acceptanceCriteria[0] ?? record.workRequest.title;
  return `${record.runId}: ${record.status} (${record.featurePlan.client}) ${visible(criterion.slice(0, 100))}`;
}

async function selectedRun(project, wanted, operation, dependencies) {
  const {output} = dependencies;
  const records = await runs(project);
  if (wanted !== undefined) {
    if (typeof wanted !== 'string' || !RUN_ID.test(wanted)) fail('Run selector is invalid.');
    const exact = records.find(record => record.runId === wanted);
    if (!exact) fail('No task with that run ID exists in this project.', 'REPOSITORY_CONFLICT');
    return exact;
  }
  const eligible = records.filter(record => (operation === 'cleanup' || ACTIVE.has(record.status))
    && (operation !== 'recover' || record.featurePlan.client === 'host' || record.status === 'awaiting-final-approval'));
  if (eligible.length === 0) fail(operation === 'cleanup' ? 'No task exists in this project for cleanup preview.' : operation === 'recover' ? 'No host task or terminal task at final review is available for lock recovery.'
    : 'No active task exists in this project. Start one with rivet run "task".', 'REPOSITORY_CONFLICT');
  if (eligible.length > 1) {
    if (dependencies.terminalIsInteractive?.() === true) {
      const choice = await withTerminalInterruption(async signal => {
        const selected = await dependencies.taskSelectionPrompt({type:'select',signal,message:operation === 'cleanup' ? 'Which task would you like to inspect for cleanup?' : 'Which task would you like to continue?',choices:eligible.map(record=>({value:record.runId,label:`${visible(record.workRequest.acceptanceCriteria[0] ?? record.workRequest.title)} (${taskState(record.status)})`}))});
        signal.throwIfAborted();
        return selected;
      });
      if (choice === null || choice === undefined) return null;
      if (!eligible.some(record=>record.runId===choice)) fail('Select one of the listed tasks.');
      const current = (await runs(project)).find(record=>record.runId===choice);
      if (!current) fail('The selected task is no longer available. Run rivet task status.', 'REPOSITORY_CONFLICT');
      return current;
    }
    output.log(operation === 'cleanup' ? 'Several tasks exist:' : 'Several active tasks exist:');
    for (const record of eligible) output.log(`  ${summary(record)}`);
    fail('Choose one with --run=<id>, or run interactively to choose from a numbered list.');
  }
  return eligible[0];
}

async function dependencyCommand(project, record, dependencies) {
  if (dependencies.terminalIsInteractive?.() !== true || typeof dependencies.confirmDependencyInstall !== 'function') {
    fail('Run rivet task deps in an interactive terminal to approve dependency installation.');
  }
  if (typeof dependencies.work?.status !== 'function'
    || typeof dependencies.resolveCommandExecutable !== 'function') fail('Dependency setup is unavailable.', 'MISSING_CONFIGURATION');
  const status = await invokeFeature(dependencies.work, 'status', { project: project.root, runId: record.runId });
  if(status.candidateCheckouts?.some(candidate=>candidate.status!=='ready'))fail(status.nextAction,'REPOSITORY_CONFLICT');
  let target = null;
  const targets=[...(status.dependencyTargets ?? [])];
  if (record.featurePlan.client === 'host' && record.status === 'running') {
    const statePaths = await resolveExistingStatePaths(project.root, record.runId);
    const workerIds = new Set(record.featurePlan.nodes.filter(node => node.role === 'worker').map(node => node.id));
    const nodes = (status.runtime?.nodes ?? []).filter(node => node.status === 'running' && workerIds.has(node.id));
    if (statePaths && nodes.length === 1) {
      const reservations = await createReservationStore(statePaths).list();
      const matches = reservations.reservations.filter(item => item.status === 'active' && item.nodeId === nodes[0].id);
      if (matches.length === 1) target = {
        path: matches[0].worktreePath,
        commit: matches[0].baseSha,
        branch: matches[0].branch,
        kind: 'worker',
      };
    }
  }
  if (!target && targets.length===0 && status.checkout?.status === 'clean') target = {
    path: status.checkout.path,
    commit: status.checkout.acceptedCommit,
    branch: status.checkout.branch,
    kind: 'integration',
  };
  if(target && targets.length===0)targets.push(target);
  if (!['running', 'blocked'].includes(record.status) || targets.length===0) {
    fail('This task has no eligible isolated checkout yet. Continue the task, then retry dependency setup.', 'REPOSITORY_CONFLICT');
  }
  const config = await loadProjectConfig(project.root);
  if(!config.project.dependencies && !['npm','pnpm','yarn','bun'].includes(config.project.stack.packageManager)) {
    fail('No dependency installation plan is configured. Define inputs, provides, and steps in project.dependencies in .rivet/project.yaml, review and commit the policy, then start a new task. For the current task, prepare its isolated environment using the project’s documented procedure. No installation was attempted.','INVALID_INPUT');
  }
  let gitClient;
  try { gitClient = await createGitClient({ gitExecutable: await dependencies.resolveCommandExecutable('git') }); }
  catch { fail('A supported Git executable is required for dependency setup.', 'PROVIDER_UNAVAILABLE'); }
  return withTerminalInterruption(async signal => {
    for(const target of targets) {
      let result;
      try {
        const install=()=>bootstrapWorktreeDependencies({
          projectRoot: project.root,
          worktreePath: target.path,
          expectedCommit: target.commit,
          expectedBranch: target.branch,
          ...(config.project.dependencies ? {dependencies:config.project.dependencies} : {manager: config.project.stack.packageManager}),
        }, {
          gitClient,
          resolveCommandExecutable: dependencies.resolveCommandExecutable,
          confirm: confirmIsolatedDependencyInstall(dependencies, signal),
          signal,
        });
        result=dependencies.machine?await withMachineContext(dependencies.machine,project.root,record.runId,install,{signal}):await install();
      } catch (error) {
        fail(error?.safeMessage ?? 'Dependency setup failed safely.', 'FAILED_GATE');
      }
      if (result.status === 'declined') {
        dependencies.output.log('Dependency setup was declined.');
        return EXIT_CODES.SUCCESS;
      }
      if (result.status !== 'ready') {
        dependencies.output.error(`Dependency setup failed (${visible(result.result?.status ?? result.status)}).`);
        if (result.result?.stdout) dependencies.output.error(`stdout:\n${diagnostic(result.result.stdout)}`);
        if (result.result?.stderr) dependencies.output.error(`stderr:\n${diagnostic(result.result.stderr)}`);
        return EXIT_CODES.FAILED_GATE;
      }
      dependencies.output.log(record.featurePlan.client === 'host'
        ? target.kind === 'candidate'
          ? 'Dependencies are ready in the candidate checkout. Retry the exact submitted action and result in the owning harness.'
        : target.kind === 'worker'
          ? 'Dependencies are ready in the Worker checkout. Continue in the owning harness.'
          : 'Dependencies are ready in the isolated checkout. Continue in the owning harness and retry work verify.'
        : 'Dependencies are ready in the isolated checkout. Use rivet task resume to retry verification.');
    }
    return EXIT_CODES.SUCCESS;
  });
}

function renderWorkerCheckouts(status, output) {
  for (const worker of status.workerCheckouts ?? []) {
    output.log(`Worker checkout: ${visible(worker.nodeId)} (${visible(worker.status)}; ${visible(worker.reservationStatus)}${worker.leaseExpired ? '; lease expired' : ''})`);
    output.log(`  Path: ${visible(worker.path)}`);
    output.log(`  Branch: ${visible(worker.expectedBranch)}; observed: ${visible(worker.observedBranch ?? 'unknown')}`);
    for (const path of worker.dirtyPaths) output.log(`  Uncommitted: ${visible(path)}`);
    for (const path of worker.branchLocations) output.log(`  Branch location: ${visible(path)}`);
    output.log(`  Next: ${visible(worker.nextAction)}`);
  }
}


export async function humanTaskCommand(parsed, dependencies) {
  if (parsed.command !== 'task' || !['status', 'start', 'approve', 'pause', 'resume', 'deps', 'cleanup', 'recover', 'decisions', 'decide', 'approve-decision', 'review', 'checkpoint', 'handoff'].includes(parsed.subcommand)
    || parsed.operands.length !== 0 || Object.keys(parsed.flags).some(key => !['project', 'run', 'for', 'details', 'preview', 'input', 'input-json', 'phase', 'decision'].includes(key))) {
    fail('Use rivet task status|start|approve|resume|deps|recover [--project=<path>] [--run=<id>].');
  }
  if (parsed.subcommand !== 'cleanup' && parsed.flags.preview !== undefined) fail('--preview requires task cleanup.');
  const allowanceMs=taskAllowance(parsed.flags.for);
  if(allowanceMs!==undefined&&!['start','resume'].includes(parsed.subcommand))fail('--for is available on task start or resume.');
  const project = await resolveConfiguredProject(dependencies.cwd(), parsed.flags.project, { env: dependencies.env });
  const record = await selectedRun(project.root, parsed.flags.run, parsed.subcommand, dependencies);
  if (!record) {dependencies.output.log('Task selection cancelled. No task action was taken.');return EXIT_CODES.SUCCESS;}
  if (!['checkpoint','handoff','decisions','decide','approve-decision','review'].includes(parsed.subcommand)
      && ['input','input-json','phase','decision'].some(key=>parsed.flags[key]!==undefined))
    fail('Evidence options require a decision or review command.');
  if (parsed.subcommand === 'cleanup') {
    const gitClient = await createGitClient({gitExecutable:await dependencies.resolveCommandExecutable('git')});
    const preview = await previewTaskWorktreeCleanup({projectRoot:project.root, runId:record.runId}, {gitClient});
    dependencies.output.log('Cleanup plan. Branches, commits and task evidence will be preserved.');
    for (const item of preview.checkouts) {
      dependencies.output.log(`${item.eligible ? 'Eligible' : 'Retained'}: ${visible(item.path)} (${visible(item.reason)}).`);
      dependencies.output.log(`  Preserve branch: ${visible(item.branch)}; commit: ${visible(item.commit ?? 'unknown')}.`);
    }
    if (!preview.checkouts.length) dependencies.output.log('No owned Worker checkouts are available for cleanup.');
    dependencies.output.log('Integration and candidate checkouts, and checkouts containing ignored artifacts, are retained.');
    if (parsed.flags.preview === true) {
      dependencies.output.log('Preview only. No checkout, branch, commit or evidence was removed.');
    } else if (preview.checkouts.some(item => item.eligible)) {
      if (dependencies.terminalIsInteractive?.() !== true) fail('Cleanup requires an interactive confirmation of these exact paths. Use --preview to inspect them.');
      const approval = await confirmTaskWorktreeCleanup(preview, dependencies.confirmWorktreeCleanup);
      if (!approval) {dependencies.output.log('Cleanup cancelled. No checkout was removed.');return EXIT_CODES.SUCCESS;}
      const result = await applyTaskWorktreeCleanup({projectRoot:project.root,runId:record.runId,preview,approval},{gitClient});
      for (const item of result.checkouts) dependencies.output.log(item.status === 'removed'
        ? `Removed checkout: ${visible(item.path)}. Preserved branch: ${visible(item.branch)}.`
        : `Cleanup incomplete: ${visible(item.path)}. Checkout retained or outcome requires inspection; branch preserved: ${visible(item.branch)}.`);
    }
    return EXIT_CODES.SUCCESS;
  }
  requireManagedAllowance(record,allowanceMs);
  if(parsed.subcommand==='pause') {
    const registration=dependencies.machine&&await findRegistration(dependencies.machine,project.root,record.runId);
    if(!registration)fail('This task has no active managed execution allowance.','REPOSITORY_CONFLICT');
    await dependencies.machine.pause(registration.id);
    dependencies.output.log('Task paused. Running work can settle; new work waits until task resume.');
    return EXIT_CODES.SUCCESS;
  }
  if (['checkpoint','handoff'].includes(parsed.subcommand)) {
    if(record.featurePlan.client!=='host')fail('Owned CLI sessions checkpoint at bounded call boundaries. A running process cannot be reset from this command; inspect task status.','REPOSITORY_CONFLICT');
    const keys=['input','input-json'].filter(key=>parsed.flags[key]!==undefined);
    if(keys.length!==1)fail('Session commands require exactly one --input or --input-json.');
    let input;
    try{input=keys[0]==='input'?readJson(project.root,parsed.flags.input,dependencies.fs??filesystem,'Session input'):JSON.parse(parsed.flags['input-json']);}catch(error){if(error instanceof CliError)throw error;fail('Session input is invalid.');}
    if(!input||typeof input!=='object'||Array.isArray(input)||JSON.stringify(input).length>65536||Object.keys(input).some(key=>!['expectedRuntimeVersion','action','input'].includes(key)))fail('Session input is invalid.');
    const result=await invokeFeature(dependencies.work,parsed.subcommand,{project:project.root,runId:record.runId,...input});
    dependencies.output.log(JSON.stringify(result,null,2));return EXIT_CODES.SUCCESS;
  }
  if (['decisions','decide','approve-decision','review'].includes(parsed.subcommand)) return taskGovernanceCommand(parsed,dependencies,project,record);
  if (['input','input-json','phase','decision'].some(key=>parsed.flags[key]!==undefined)) fail('Evidence options require a decision or review command.');
  if (parsed.subcommand === 'approve') return finishTask(project, record, dependencies);
  if (parsed.subcommand === 'recover') {
    if (record.featurePlan.client !== 'host' && !['awaiting-final-approval','completed'].includes(record.status)) fail('Lock recovery is only available for host tasks or terminal tasks at final review; it never restarts a worker.', 'REPOSITORY_CONFLICT');
    if (typeof dependencies.work?.recover !== 'function') fail('Host recovery is unavailable.', 'MISSING_CONFIGURATION');
    const result = await invokeFeature(dependencies.work, 'recover', { project: project.root, runId: record.runId });
    dependencies.output.log(`Recovery: ${visible(result.status)}.`);
    dependencies.output.log(`Recovered locks: ${result.recoveredLocks.map(visible).join(', ') || 'none'}.`);
    if (result.blockedLock) dependencies.output.error(`Blocked lock: ${visible(result.blockedLock)}.`);
    dependencies.output.log(visible(result.nextAction));
    return result.status === 'recovered' ? EXIT_CODES.SUCCESS : EXIT_CODES.REPOSITORY_CONFLICT;
  }
  if (parsed.subcommand === 'deps') return dependencyCommand(project, record, dependencies);
  if (parsed.subcommand === 'status') {
    if (typeof dependencies.work?.status !== 'function') fail('Task status is unavailable.', 'MISSING_CONFIGURATION');
    const status = await invokeFeature(dependencies.work, 'status', { project: project.root, runId: record.runId });
    const capacity=dependencies.machine&&await taskCapacity(dependencies.machine,project.root,record.runId);
    if(capacity){
      dependencies.output.log(`Execution: ${capacity.paused?'paused':'managed'}; deadline ${new Date(capacity.deadlineMs).toISOString()}.`);
      if(capacity.waiting.length)dependencies.output.log(`Waiting: ${capacity.waiting.join(', ')}.`);
      dependencies.output.log(`Machine capacity: ${Object.entries(capacity.capacity).map(([name,value])=>`${name} ${value.held}/${value.limit}`).join('; ')}.`);
    }
    dependencies.output.log(`Run: ${record.runId}`);
    dependencies.output.log(`Project: ${visible(project.root)} (run the next command from this project)`);
    dependencies.output.log(`Task: ${visible(record.workRequest.acceptanceCriteria[0] ?? record.workRequest.title)}`);
    dependencies.output.log(`State: ${taskState(record.status)}${parsed.flags.details ? ` (${visible(record.status)})` : ''}`);
    if (record.featurePlan.nodes.some(node => node.execution || node.executionSelection)) {
      const coordination = record.featurePlan.nodes.find(node => node.role === 'manager')?.executionSelection;
      const planning = coordination && !coordination.recommendationOnly ? coordination : null;
      dependencies.output.log(`Planning harness: ${planning ? `${planning.harness}; model: ${planning.model}; reasoning: ${planning.effort}` : record.featurePlan.client}`);
      dependencies.output.log(`Worker harnesses: ${[...new Set(record.featurePlan.nodes.filter(node => node.role === 'worker').map(node => executionForNode(record.featurePlan, node).client))].join(', ')}`);
    } else dependencies.output.log(`Harness: ${record.featurePlan.client}`);
    dependencies.output.log(`Next: ${record.status === 'completed' ? 'Task completed. Inspect its recorded evidence and any separate delivery status.' : record.status === 'proposed' && record.featurePlan.client !== 'host' ? `rivet task start --run=${record.runId}` : record.status === 'awaiting-final-approval' && status.deliveryReady ? `rivet task approve --run=${record.runId}` : visible(status.nextAction)}`);
    if (status.governance?.decisions.length) {
      dependencies.output.log(`Decisions: ${status.governance.decisions.length}; use rivet task decisions to read the journal.`);
    }
    for (const blocker of status.governance?.blockers ?? []) dependencies.output.log(`Review: ${visible(blocker.code)}${blocker.reviewerId ? ` (${visible(blocker.reviewerId)})` : ''}`);
    if (status.governance?.review.humanEscalation) dependencies.output.log('Review round limit reached. Ask a human to assess the findings and prepare a corrective task.');
    if (status.verification) {
      dependencies.output.log(`Verification: ${status.verification.status} at ${status.verification.commitSha}`);
      for (const path of status.verification.changedPaths) dependencies.output.log(`Changed: ${visible(path)}`);
      for (const check of status.verification.checks) {
        dependencies.output.log(`Check: ${visible(check.id)} ${check.status} (${visible(check.cwd)})`);
        if (check.status === 'failed') {
          dependencies.output.log(`  Exit: ${check.exitCode ?? 'unknown'}; execution: ${visible(check.executionStatus)}`);
          if (check.output?.stdout) dependencies.output.log(`  stdout:\n${diagnostic(check.output.stdout)}`);
          if (check.output?.stderr) dependencies.output.log(`  stderr:\n${diagnostic(check.output.stderr)}`);
          if (check.output?.truncated?.combined || check.output?.truncated?.stdout || check.output?.truncated?.stderr) {
            dependencies.output.log('  Output was truncated.');
          }
          if (check.output?.redacted) dependencies.output.log('  Output was redacted.');
          if (check.output?.suppressed) dependencies.output.log('  Output was suppressed.');
        }
      }
      if (status.verification.failure) dependencies.output.log(`Failure: ${visible(status.verification.failure)}`);
    }
    for(const session of status.sessions??[])dependencies.output.log(`Session: ${session.id}; generation ${session.generation}; ${session.phase}; stop ${session.stopStatus}; context ${session.telemetry?.contextUsedTokens?.value??'unknown'}${session.turnoverReason?`; turnover ${session.turnoverReason}`:''}`);
    renderWorkerCheckouts(status, dependencies.output);
    if(record.featurePlan.maxParallelWorkers!==undefined)dependencies.output.log(`Parallel Workers: up to ${record.featurePlan.maxParallelWorkers}.`);
    if (status.checkout) dependencies.output.log(`Integration checkout: ${visible(status.checkout.path)} (${status.checkout.status}); accepted commit ${visible(status.checkout.acceptedCommit)}`);
    return EXIT_CODES.SUCCESS;
  }
  if (parsed.subcommand === 'start' || (parsed.subcommand === 'resume' && record.status === 'proposed' && record.featurePlan.client !== 'host')) {
    if (record.status !== 'proposed') fail('This task is already activated. Use rivet task status to see its next step.', 'REPOSITORY_CONFLICT');
    if (record.featurePlan.client === 'host') fail('Continue proposal approval through the coding harness that owns this task.', 'REPOSITORY_CONFLICT');
    if (dependencies.terminalIsInteractive?.() !== true) fail('Run rivet task start in an interactive terminal to review and approve the saved plan.');
    if (typeof dependencies.harnesses?.select !== 'function') fail('Harness discovery is unavailable.', 'MISSING_CONFIGURATION');
    return withTerminalInterruption(async signal => {
      let selected;
      for (const client of new Set(record.featurePlan.nodes.filter(node => node.role === 'worker').map(node => executionForNode(record.featurePlan, node).client))) {
        try {
          const available = await dependencies.harnesses.select(client, project.root, {signal});
          if (!selected || client === record.featurePlan.client) selected = available;
        } catch { fail(`The saved harness ${client} is unavailable or incompatible. Restore it before starting.`, 'PROVIDER_UNAVAILABLE'); }
      }
      return activateProposal(project, record.workRequest.description, selected, record, dependencies, signal, {details:parsed.flags.details,allowanceMs});
    });
  }
  if (record.status === 'awaiting-final-approval') return finishTask(project, record, dependencies);
  if (record.status === 'completed') {dependencies.output.log('This task is completed. Inspect its recorded evidence and any separate delivery status.');return EXIT_CODES.SUCCESS;}
  if (record.featurePlan.client === 'host') {
    if(dependencies.machine)await activateTaskAdmission(dependencies.machine,record,project.root,{allowanceMs,resume:true});
    const status = await invokeFeature(dependencies.work, 'status', { project: project.root, runId: record.runId });
    renderWorkerCheckouts(status, dependencies.output);
    dependencies.output.log(`Run: ${record.runId}`);
    dependencies.output.log(`Host task: ${visible(status.run.status)}. ${visible(status.nextAction)}`);
    dependencies.output.log('Continue in the coding harness that owns this task; Rivet will not launch a second worker.');
    return EXIT_CODES.SUCCESS;
  }
  if (record.status === 'running') {
    if(dependencies.machine){
      const registration=await findRegistration(dependencies.machine,project.root,record.runId);
      if(registration?.paused){await activateTaskAdmission(dependencies.machine,record,project.root,{allowanceMs,resume:true});dependencies.output.log('Task admission resumed. The existing worker remains its owner; no second worker was launched.');return EXIT_CODES.SUCCESS;}
    }
    fail('This spawned run is already marked running. Rivet cannot prove its worker stopped, so it will not launch a duplicate. Inspect its process and state.', 'REPOSITORY_CONFLICT');
  }
  if (!['approved', 'blocked'].includes(record.status)) {
    fail('This task cannot be resumed from its current state.', 'REPOSITORY_CONFLICT');
  }
  if (typeof dependencies.feature?.resume !== 'function') fail('Feature resume is unavailable.', 'MISSING_CONFIGURATION');
  if (typeof dependencies.harnesses?.select !== 'function') fail('Harness discovery is unavailable.', 'MISSING_CONFIGURATION');
  return withTerminalInterruption(async signal => {
    const clients = new Set(record.featurePlan.nodes.filter(node => node.role === 'worker')
      .map(node => executionForNode(record.featurePlan, node).client));
    for (const client of clients) {
      try { await dependencies.harnesses.select(client, project.root, { signal }); }
      catch { fail(`The saved worker harness ${client} is unavailable or incompatible. Restore it before resuming; Rivet will not switch models.`, 'PROVIDER_UNAVAILABLE'); }
    }
    const result = await invokeFeature(dependencies.feature, 'resume', {
      project: project.root, runId: record.runId, expectedVersion: record.version,
    }, { signal, ...(allowanceMs===undefined?{}:{allowanceMs}), confirmDependencyInstall: confirmIsolatedDependencyInstall(dependencies, signal) });
    dependencies.output.log(`Task: ${taskState(result.status)}.`);
    if (result.summary) dependencies.output.log(visible(result.summary));
    if (result.status === 'awaiting-final-approval') return finishTask(project, {...record,status:result.status}, dependencies, {signal});
    return result.status === 'awaiting-final-approval' ? EXIT_CODES.SUCCESS
      : result.status === 'blocked' ? EXIT_CODES.FAILED_GATE : EXIT_CODES.REPOSITORY_CONFLICT;
  });
}
