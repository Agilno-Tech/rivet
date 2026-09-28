import { applyVerifiedTask } from '../feature/local-approval.js';
import { createGitClient } from '../git/client.js';
import { withTerminalInterruption } from '../cli/interrupt.js';
import { CliError, EXIT_CODES, observeOutputErrors } from '../cli/output.js';
import { deliveryCommand } from './delivery.js';
import { invokeFeature } from './feature.js';

function fail(message, code = 'INVALID_INPUT') { throw new CliError(message, code); }
function visible(value) { return String(value).replace(/[\u0000-\u001f\u007f\u009b]/g, character => `\\u${character.codePointAt(0).toString(16).padStart(4,'0')}`); }
function displayPatch(value) { return String(value).split('\n').map(visible).join('\n'); }
const completionChoices = [
  {value:'review',label:'Review changes'},
  {value:'pull-request',label:'Pull-request delivery (recommended for team review)'},
  {value:'local',label:'Apply locally (update the current default branch; no push)'},
  {value:'leave',label:'Leave for later'},
];

export async function finishTask(project, record, dependencies, options = {}) {
  let failed = false;
  const unobserve = observeOutputErrors(dependencies.output,()=>{failed=true;});
  const assertDisplay = () => { if(failed) fail('Final review output failed. Nothing further was approved. Retry in a working terminal.', 'REPOSITORY_CONFLICT'); };
  try { return await finishTaskAction(project,record,dependencies,{...options,assertDisplay}); }
  finally { unobserve?.(); }
}

async function finishTaskAction(project, record, dependencies, options) {
  if (!['awaiting-final-approval', 'completed'].includes(record.status)) fail('This task has no verified result ready for final review. Use rivet task status.', 'REPOSITORY_CONFLICT');
  if (dependencies.terminalIsInteractive?.() !== true) fail('Run rivet task approve in an interactive terminal for final review.');
  let reviewedStatus;
  if (record.status !== 'completed') {
    const status = await invokeFeature(dependencies.work, 'status', {project: project.root, runId: record.runId});
    reviewedStatus = status;
    if (status.deliveryReady !== true) fail('Final review requires current passing checks and a clean verified checkout. Use rivet task status.', 'REPOSITORY_CONFLICT');
    dependencies.output.log('Changes passed checks and are ready for your review.');
    dependencies.output.log(`Verified commit: ${visible(status.checkout.acceptedCommit)}`);
    dependencies.output.log(`Integration checkout: ${visible(status.checkout.path)}`);
    for (const path of status.verification.changedPaths) dependencies.output.log(`Changed: ${visible(path)}`);
    for (const check of status.verification.checks) dependencies.output.log(`Check: ${visible(check.id)} ${visible(check.status)}`);
  }
  options.assertDisplay();
  const finish = async signal => {
    let choice = record.status === 'completed' ? 'local' : await dependencies.taskApprovalPrompt({
      type: 'select', signal, message: 'How would you like to finish this task?',
      choices: completionChoices,
    });
    options.assertDisplay();
    while (choice === 'review') {
      signal.throwIfAborted();
      const baseline = reviewedStatus?.run?.featurePlan?.baselineCommit ?? record.featurePlan?.baselineCommit;
      const tip = reviewedStatus?.checkout?.acceptedCommit;
      const gitClient = await createGitClient({gitExecutable: await dependencies.resolveCommandExecutable('git')});
      try {
        const diff = await gitClient.reviewDiff(project.root,{fromSha:baseline,toSha:tip});
        dependencies.output.log(diff.patch ? displayPatch(diff.patch) : 'No file changes.');
        if(diff.truncated) dependencies.output.log('Diff preview was truncated. Inspect the integration checkout before approval.');
      } catch {
        fail('Could not display the complete diff. Inspect the integration checkout shown above, then retry rivet task approve. No changes were applied.', 'REPOSITORY_CONFLICT');
      }
      options.assertDisplay();
      choice = await dependencies.taskApprovalPrompt({type:'select',signal,message:'How would you like to finish this task?',choices:completionChoices});
      options.assertDisplay();
    }
    if (choice === 'leave' || choice === null || choice === undefined) { dependencies.output.log('Final review cancelled. Work is saved for later. Continue with rivet task resume.'); return EXIT_CODES.SUCCESS; }
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
        options.assertDisplay();
        return approved === true && !outputFailed && !signal.aborted;
      }});
      dependencies.output.log(`Local application: ${visible(result.status)}.`);
      if (result.nextAction) dependencies.output.log(visible(result.nextAction));
      return EXIT_CODES.SUCCESS;
    } catch (error) {
      if (error instanceof CliError) throw error;
      fail(error?.safeMessage ?? 'Local application could not complete safely. Inspect task status and preserve the checkouts.', 'REPOSITORY_CONFLICT');
    } finally {unobserve?.();}
  };
  return options.signal ? finish(options.signal) : withTerminalInterruption(finish);
}

