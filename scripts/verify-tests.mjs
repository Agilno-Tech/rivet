import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryRoot, parseShard, selectedTests } from './test-shards.cjs';
import { fixtureEnvironment, loadManifest, runBounded, summarizeScenario } from './run-evals.mjs';

// CI executes the entire selected suite once in the same credential-free environment
// as fixture evaluations, then checks the catalog against those observed events.
export function summarizeVerification(files, scenarios, observation) {
  let records = [], reason = observation.reason ?? null;
  const countsValid = counts => counts && ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo', 'suites'].every(k => Number.isSafeInteger(counts[k]) && counts[k] >= 0);
  try {
    records = (observation.stdout ?? '').split('\n').filter(Boolean).map(JSON.parse);
    for (const record of records) {
      if (!record || !['test', 'summary'].includes(record.type)) throw Error();
      if (record.file !== null) {
        if (typeof record.file !== 'string') throw Error();
        record.file = relative(repositoryRoot, resolve(repositoryRoot, record.file));
        if (!files.includes(record.file)) throw Error();
      }
      if (record.type === 'test' && (record.file === null || typeof record.name !== 'string' || !['passed', 'failed', 'skipped', 'todo'].includes(record.status))) throw Error();
      if (record.type === 'summary' && (typeof record.success !== 'boolean' || !countsValid(record.counts))) throw Error();
    }
  } catch { reason ??= 'invalid-test-report'; records = []; }
  const summaries = records.filter(r => r.type === 'summary');
  if ([null, ...files].some(file => summaries.filter(r => r.file === file).length !== 1)) reason ??= 'incomplete-test-report';
  if (summaries.some(s => !s.success || s.counts.failed || s.counts.cancelled) || records.some(r => r.type === 'test' && r.status === 'failed')) reason ??= 'test-failure';
  const totals = summaries.find(s => s.file === null)?.counts ?? null;
  const tests = records.filter(r => r.type === 'test');
  const evaluated = scenarios.map(scenario => summarizeScenario(scenario, { ...observation, reason, durationMs: null,
    records: tests.filter(r => r.file === scenario.file && scenario.criteria.some(c => c.test === r.name)) }));
  const passed = observation.exitCode === 0 && !reason && evaluated.every(s => s.outcome === 'passed');
  return { outcome: passed ? 'passed' : 'failed', reason, totals, scenarios: evaluated,
    durationMs: observation.durationMs ?? null, fileTimings: summaries.filter(s => s.file !== null).map(({ file, durationMs }) => ({ file, durationMs })), failedTests: tests.filter(t => t.status === 'failed').map(({ file, name }) => ({ file, name })) };
}

export async function verifyTests(shard, { execute = runBounded, signal } = {}) {
  const files = selectedTests(shard);
  if (!files.length) throw Error('Empty test shard.');
  const manifest = await loadManifest();
  const scenarios = manifest.scenarios.filter(s => files.includes(s.file));
  const scratch = await mkdtemp(join(tmpdir(), 'rivet-verify-'));
  try {
    const env = fixtureEnvironment(scratch);
    const observation = await execute(process.execPath, ['--test', '--test-concurrency=2',
      `--test-reporter=${join(repositoryRoot, 'scripts/verify-tests-reporter.mjs')}`, ...files],
    { cwd: repositoryRoot, env, timeoutMs: 25 * 60_000, signal });
    const report = summarizeVerification(files, scenarios, signal?.aborted ? { ...observation, reason: 'cancelled' } : observation);
    return { exitCode: report.outcome === 'passed' ? 0 : 1, report: { schemaVersion: 1, mode: 'fixture',
      liveModelQualityEvaluated: false, pilotEvaluated: false, coverage: 'full test suite and named mechanics assertions',
      ...(shard ? { shard } : {}), files, ...report } };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

async function main() {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const { exitCode, report } = await verifyTests(parseShard(process.argv.slice(2)), { signal: controller.signal });
    console.log(`Tests: ${report.outcome}. ${JSON.stringify(report.totals)}`);
    for (const timing of report.fileTimings) console.log(`TIMING ${JSON.stringify(timing)}`);
    for (const test of report.failedTests) console.log(`FAILED ${test.file}: ${test.name}`);
    if (report.reason) console.log(`Reason: ${report.reason}`);
    for (const s of report.scenarios) console.log(`${s.id}: ${s.outcome} (${s.testCounts.passed}/${s.testCounts.expected} named tests).`);
    console.log('Live model quality and independent pilot readiness were not evaluated.');
    process.exitCode = exitCode;
  } catch (error) { console.error('Verification could not complete:', error.message); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
