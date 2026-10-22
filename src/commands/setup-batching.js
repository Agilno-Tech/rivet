import {CliError, observeOutputErrors} from '../cli/output.js';
import {defaultIntegrationSetupPrompt} from '../cli/integration-setup-prompt.js';
import {prepareVerificationBatchUpdate} from './init.js';

// Setup owns this optional question; task execution never changes project policy.
export async function configureSetupBatching(root, dependencies) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const external = dependencies.setup?.signal;
  if (external?.aborted) abort();
  external?.addEventListener('abort', abort, {once:true});
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  let saved = false, outputFailed = false;
  const unobserve = observeOutputErrors(dependencies.output, () => { outputFailed = true; abort(); });
  const check = () => {
    if (outputFailed || controller.signal.aborted) throw new CliError(saved
      ? 'Batch policy was saved before interruption. Inspect .rivet/quality.yaml.'
      : 'Batch setup was interrupted or could not display its proposal. No batch policy was saved.', 'INVALID_INPUT');
  };
  const show = message => {
    check();
    try { dependencies.output.log(message); } catch { outputFailed = true; }
    check();
  };
  try {
    check();
    const update = await prepareVerificationBatchUpdate(root, {fs:dependencies.fs, beforeCommit:check});
    const previous = update.config.quality.verificationBatch;
    if (previous?.enabled) {
      show('Optional batch verification is already enabled; existing settings are preserved.');
      return;
    }
    const policy = {maxTasks:3, waitMs:2000, maxIsolationTasks:2, ...previous, enabled:true};
    const proposal = update.propose(policy);
    show('Optional batch verification checks selected ready tasks together in an isolated candidate. Results are advisory; each task still needs its own checks and approval.');
    show(`Proposed batch settings: ${policy.maxTasks} tasks, ${policy.waitMs} ms wait, up to ${policy.maxIsolationTasks} diagnostic checks after failure.`);
    let answer;
    try {
      answer = await (dependencies.setupBatchPrompt ?? defaultIntegrationSetupPrompt)({
        id:'enable-batching', type:'confirm', message:'Enable optional batch verification for this project?',
        proposal:structuredClone(policy), signal:controller.signal,
      });
    } catch { throw new CliError('Batch setup cancelled. No batch policy was saved.', 'INVALID_INPUT'); }
    check();
    if (answer === null || answer === undefined) throw new CliError('Batch setup cancelled. No batch policy was saved.', 'INVALID_INPUT');
    if (answer !== true) { show('Batch settings unchanged. Rerun rivet setup --write to enable batching later.'); return; }
    await proposal.commit();
    saved = true;
    show('Batch verification enabled. Review and commit the setup files before creating tasks, then use rivet task verify --batch.');
  } finally {
    unobserve?.();
    external?.removeEventListener('abort', abort);
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}
