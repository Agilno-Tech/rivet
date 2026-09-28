import { applyVerifiedTask } from '../feature/local-approval.js';
import { deliveryCommand } from './delivery.js';
import { resolveConfiguredProject } from '../cli/project-discovery.js';
import { withTerminalInterruption } from '../cli/interrupt.js';
import { CliError, EXIT_CODES, observeOutputErrors } from '../cli/output.js';
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

async function selectedRun(project, wanted, operation, output) {
  const records = await runs(project);
  if (wanted !== undefined) {
    if (typeof wanted !== 'string' || !RUN_ID.test(wanted)) fail('Run selector is invalid.');
    const exact = records.find(record => record.runId === wanted);
    if (!exact) fail('No task with that run ID exists in this project.', 'REPOSITORY_CONFLICT');
    return exact;
  }
  const eligible = records.filter(record => ACTIVE.has(record.status)
    && (operation !== 'recover' || record.featurePlan.client === 'host' || record.status === 'awaiting-final-approval'));
  if (eligible.length === 0) fail(operation === 'recover' ? 'No host task or terminal task at final review is available for lock recovery.'
    : 'No active task exists in this project. Start one with rivet run "task".', 'REPOSITORY_CONFLICT');
  if (eligible.length > 1) {
    output.log('Several active tasks exist:');
    for (const record of eligible) output.log(`  ${summary(record)}`);
    fail('Choose one with --run=<id>. Rivet will not guess which task you mean.');
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
  let target = null;
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
  if (!target && status.checkout?.status === 'clean') target = {
    path: status.checkout.path,
    commit: status.checkout.acceptedCommit,
    branch: status.checkout.branch,
    kind: 'integration',
  };
  if (!['running', 'blocked'].includes(record.status) || !target) {
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
    let result;
    try {
      result = await bootstrapWorktreeDependencies({
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
    } catch (error) {
      fail(error?.safeMessage ?? 'Dependency setup failed safely.', 'FAILED_GATE');
    }
    if (result.status === 'declined') {
      dependencies.output.log('Dependency setup was declined.');
      return EXIT_CODES.SUCCESS;
    }
    if (result.status !== 'ready') {
      dependencies.output.error(`Dependency setup failed (${visible(result.result.status)}).`);
      if (result.result.stdout) dependencies.output.error(`stdout:\n${diagnostic(result.result.stdout)}`);
      if (result.result.stderr) dependencies.output.error(`stderr:\n${diagnostic(result.result.stderr)}`);
      return EXIT_CODES.FAILED_GATE;
    }
    dependencies.output.log(record.featurePlan.client === 'host'
      ? target.kind === 'worker'
        ? 'Dependencies are ready in the Worker checkout. Continue in the owning harness.'
        : 'Dependencies are ready in the isolated checkout. Continue in the owning harness and retry work verify.'
      : 'Dependencies are ready in the isolated checkout. Use rivet task resume to retry verification.');
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

async function approveTask(project, record, dependencies) {
  if (!['awaiting-final-approval', 'completed'].includes(record.status)) fail('This task has no verified result ready for final review. Use rivet task status.', 'REPOSITORY_CONFLICT');
  if (dependencies.terminalIsInteractive?.() !== true) fail('Run rivet task approve in an interactive terminal for final review.');
  if (record.status !== 'completed') {
    const status = await invokeFeature(dependencies.work, 'status', {project: project.root, runId: record.runId});
    if (status.deliveryReady !== true) fail('Final review requires current passing checks and a clean verified checkout. Use rivet task status.', 'REPOSITORY_CONFLICT');
    dependencies.output.log(`Verified commit: ${visible(status.checkout.acceptedCommit)}`);
    dependencies.output.log(`Integration checkout: ${visible(status.checkout.path)}`);
    for (const path of status.verification.changedPaths) dependencies.output.log(`Changed: ${visible(path)}`);
    for (const check of status.verification.checks) dependencies.output.log(`Check: ${visible(check.id)} ${visible(check.status)}`);
  }
  return withTerminalInterruption(async signal => {
    const choice = record.status === 'completed' ? 'local' : await dependencies.taskApprovalPrompt({
      type: 'select', signal, message: 'How would you like to finish this task?',
      choices: [{value:'pull-request',label:'Pull-request delivery (recommended for team review)'}, {value:'local',label:'Apply locally (update the current default branch; no push)'}],
    });
    if (choice === null || choice === undefined) { dependencies.output.log('Final review cancelled. No completion action was taken.'); return EXIT_CODES.SUCCESS; }
    if (choice === 'pull-request') {
      signal.throwIfAborted();
      const result = await deliveryCommand({command:'delivery',subcommand:'prepare',operands:[],flags:{project:project.root,run:record.runId}}, dependencies);
      if (result === EXIT_CODES.SUCCESS) {
        dependencies.output.log(`Delivery prepared locally. From project ${visible(project.root)}, publish and create the review with separate approvals:`);
        dependencies.output.log(`rivet delivery publish --run=${record.runId}`);
        dependencies.output.log(`rivet delivery review --run=${record.runId}`);
        dependencies.output.log('No remote write or merge has been approved by this selection.');
      }
      return result;
    }
    if (choice !== 'local') fail('Select local application or pull-request delivery.');
    const gitClient = await createGitClient({gitExecutable: await dependencies.resolveCommandExecutable('git')});
    let outputFailed = false;
    const unobserve = observeOutputErrors(dependencies.output, () => { outputFailed = true; });
    try {
      const result = await applyVerifiedTask({project:project.root,runId:record.runId,gitClient,signal,confirm:async preview => {
        try {
          dependencies.output.log(`Apply to local branch: ${visible(preview.targetBranch)}`);
          dependencies.output.log(`From: ${visible(preview.baselineCommit)}`);
          dependencies.output.log(`To: ${visible(preview.commitSha)}`);
          for (const path of preview.changedPaths) dependencies.output.log(`Changed: ${visible(path)}`);
          for (const check of preview.checks) dependencies.output.log(`Check: ${visible(check.id)} ${visible(check.status)}`);
          dependencies.output.log('This updates the original checkout using a fast-forward only. It does not push or deploy.');
        } catch { fail('Could not display the local application preview. Nothing was approved.', 'REPOSITORY_CONFLICT'); }
        if (outputFailed || signal.aborted) return false;
        const approved = await dependencies.confirmTaskApplication(preview,{signal});
        return approved === true && !outputFailed && !signal.aborted;
      }});
      dependencies.output.log(`Local application: ${visible(result.status)}.`);
      if (result.nextAction) dependencies.output.log(visible(result.nextAction));
      return EXIT_CODES.SUCCESS;
    } catch (error) {
      if (error instanceof CliError) throw error;
      fail(error?.safeMessage ?? 'Local application could not complete safely. Inspect task status and preserve the checkouts.', 'REPOSITORY_CONFLICT');
    } finally {unobserve?.();}
  });
}

export async function humanTaskCommand(parsed, dependencies) {
  if (parsed.command !== 'task' || !['status', 'start', 'approve', 'resume', 'deps', 'recover'].includes(parsed.subcommand)
    || parsed.operands.length !== 0 || Object.keys(parsed.flags).some(key => !['project', 'run'].includes(key))) {
    fail('Use rivet task status|start|approve|resume|deps|recover [--project=<path>] [--run=<id>].');
  }
  const project = await resolveConfiguredProject(dependencies.cwd(), parsed.flags.project, { env: dependencies.env });
  const record = await selectedRun(project.root, parsed.flags.run, parsed.subcommand, dependencies.output);
  if (parsed.subcommand === 'approve') return approveTask(project, record, dependencies);
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
    dependencies.output.log(`Run: ${record.runId}`);
    dependencies.output.log(`Project: ${visible(project.root)} (run the next command from this project)`);
    dependencies.output.log(`Task: ${visible(record.workRequest.acceptanceCriteria[0] ?? record.workRequest.title)}`);
    dependencies.output.log(`State: ${visible(record.status)}`);
    if (record.featurePlan.nodes.some(node => node.execution)) {
      dependencies.output.log(`Planning harness: ${record.featurePlan.client}`);
      dependencies.output.log(`Worker harnesses: ${[...new Set(record.featurePlan.nodes.filter(node => node.role === 'worker').map(node => node.execution?.client ?? record.featurePlan.client))].join(', ')}`);
    } else dependencies.output.log(`Harness: ${record.featurePlan.client}`);
    dependencies.output.log(`Next: ${record.status === 'completed' ? 'Task completed. Inspect its recorded evidence and any separate delivery status.' : record.status === 'proposed' && record.featurePlan.client !== 'host' ? `rivet task start --run=${record.runId}` : record.status === 'awaiting-final-approval' && status.deliveryReady ? `rivet task approve --run=${record.runId}` : visible(status.nextAction)}`);
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
    renderWorkerCheckouts(status, dependencies.output);
    if (status.checkout) dependencies.output.log(`Integration checkout: ${visible(status.checkout.path)} (${status.checkout.status})`);
    return EXIT_CODES.SUCCESS;
  }
  if (parsed.subcommand === 'start' || (parsed.subcommand === 'resume' && record.status === 'proposed' && record.featurePlan.client !== 'host')) {
    if (record.status !== 'proposed') fail('This task is already activated. Use rivet task status to see its next step.', 'REPOSITORY_CONFLICT');
    if (record.featurePlan.client === 'host') fail('Continue proposal approval through the coding harness that owns this task.', 'REPOSITORY_CONFLICT');
    if (dependencies.terminalIsInteractive?.() !== true) fail('Run rivet task start in an interactive terminal to review and approve the saved plan.');
    if (typeof dependencies.harnesses?.select !== 'function') fail('Harness discovery is unavailable.', 'MISSING_CONFIGURATION');
    return withTerminalInterruption(async signal => {
      let selected;
      for (const client of new Set([record.featurePlan.client, ...record.featurePlan.nodes.filter(node => node.role === 'worker').map(node => node.execution?.client ?? record.featurePlan.client)])) {
        try {
          const available = await dependencies.harnesses.select(client, project.root, {signal});
          if (client === record.featurePlan.client) selected = available;
        } catch { fail(`The saved harness ${client} is unavailable or incompatible. Restore it before starting.`, 'PROVIDER_UNAVAILABLE'); }
      }
      return activateProposal(project, record.workRequest.description, selected, record, dependencies, signal);
    });
  }
  if (record.featurePlan.client === 'host') {
    const status = await invokeFeature(dependencies.work, 'status', { project: project.root, runId: record.runId });
    renderWorkerCheckouts(status, dependencies.output);
    dependencies.output.log(`Run: ${record.runId}`);
    dependencies.output.log(`Host task: ${visible(status.run.status)}. ${visible(status.nextAction)}`);
    dependencies.output.log('Continue in the coding harness that owns this task; Rivet will not launch a second worker.');
    return EXIT_CODES.SUCCESS;
  }
  if (record.status === 'awaiting-final-approval' || record.status === 'completed') {
    dependencies.output.log(`Task: ${record.status}.`);
    dependencies.output.log(`Review and finish this task: rivet task approve --run=${record.runId}`);
    return EXIT_CODES.SUCCESS;
  }
  if (record.status === 'running') {
    fail('This spawned run is already marked running. Rivet cannot prove its worker stopped, so it will not launch a duplicate. Inspect its process and state.', 'REPOSITORY_CONFLICT');
  }
  if (!['approved', 'blocked'].includes(record.status)) {
    fail('This task cannot be resumed from its current state.', 'REPOSITORY_CONFLICT');
  }
  if (typeof dependencies.feature?.resume !== 'function') fail('Feature resume is unavailable.', 'MISSING_CONFIGURATION');
  if (typeof dependencies.harnesses?.select !== 'function') fail('Harness discovery is unavailable.', 'MISSING_CONFIGURATION');
  return withTerminalInterruption(async signal => {
    const clients = new Set(record.featurePlan.nodes.filter(node => node.role === 'worker')
      .map(node => node.execution?.client ?? record.featurePlan.client));
    for (const client of clients) {
      try { await dependencies.harnesses.select(client, project.root, { signal }); }
      catch { fail(`The saved worker harness ${client} is unavailable or incompatible. Restore it before resuming; Rivet will not switch models.`, 'PROVIDER_UNAVAILABLE'); }
    }
    const result = await invokeFeature(dependencies.feature, 'resume', {
      project: project.root, runId: record.runId, expectedVersion: record.version,
    }, { signal, confirmDependencyInstall: confirmIsolatedDependencyInstall(dependencies, signal) });
    dependencies.output.log(`Task: ${visible(result.status)}.`);
    if (result.summary) dependencies.output.log(visible(result.summary));
    if (result.status === 'awaiting-final-approval') dependencies.output.log(`Review and finish this task: rivet task approve --run=${record.runId}`);
    return result.status === 'awaiting-final-approval' ? EXIT_CODES.SUCCESS
      : result.status === 'blocked' ? EXIT_CODES.FAILED_GATE : EXIT_CODES.REPOSITORY_CONFLICT;
  });
}
