import { collectSupportBundle, resolveSupportProject } from '../support/bundle.js';
import { saveSupportReport } from '../support/failure-report.js';
import { CliError, EXIT_CODES } from '../cli/output.js';

export async function supportCommand(parsed, dependencies) {
  if (parsed.operands.length || Object.keys(parsed.flags).some(key => !['project','probe-harnesses','save','json'].includes(key))) {
    throw new CliError('Use rivet support [--project=<path>] [--probe-harnesses] [--save] [--json].', 'INVALID_INPUT');
  }
  const root = await resolveSupportProject(dependencies.cwd(), parsed.flags.project);
  const controller = new AbortController(), abort = () => controller.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  let result, savedReport;
  try {
    const options = {
      environment: dependencies.env,
      signal: controller.signal,
      probeHarnesses: parsed.flags['probe-harnesses'] === true,
      ...(dependencies.support?.diagnose ? {diagnose: dependencies.support.diagnose} : {}),
      ...(dependencies.support?.discoverHarnesses ? {discoverHarnesses: dependencies.support.discoverHarnesses} : {}),
    };
    if (parsed.flags.save === true) {
      try {
        const saved = await saveSupportReport(root, options);
        result = saved.report;
        savedReport = {path: saved.path};
      } catch {
        throw new CliError('Support report could not be saved. Try rivet support --json to display the report.', 'INTERNAL_ERROR');
      }
    } else result = await collectSupportBundle(root, options);
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
  if (parsed.flags.json) dependencies.output.json({ok: true, result, ...(savedReport ? {savedReport} : {})});
  else {
    dependencies.output.log(`Support collection: ${result.collection.status}. Configuration: ${result.configuration.status}. Readiness: ${result.readiness.status}.`);
    if (savedReport) {
      dependencies.output.log(`Support report saved: ${savedReport.path}`);
      dependencies.output.log('Review the file before attaching it to an issue at https://github.com/FraneAgilno/rivet/issues/new. Nothing was uploaded.');
    } else dependencies.output.log('Save a shareable report with rivet support --save. Add --probe-harnesses to include local CLI capability checks.');
  }
  return EXIT_CODES.SUCCESS;
}
