import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBounded, fixtureEnvironment } from '../../scripts/run-evals.mjs';
import { summarizeVerification, verifyTests } from '../../scripts/verify-tests.mjs';
import { catalog } from '../../evals/catalog.mjs';
import { selectedTests } from '../../scripts/test-shards.cjs';
const file = 'test/example.test.js';
const scenario = { id: 'example', file, criteria: [{ id: 'one', test: 'criterion' }] };
const counts = { tests: 1, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0 };
const evidence = () => [
  { type: 'test', file, name: 'criterion', status: 'passed' },
  { type: 'summary', file, success: true, counts, durationMs: 12 },
  { type: 'summary', file: null, success: true, counts, durationMs: 13 },
];
const summary = (records = evidence(), rest = {}) => summarizeVerification([file], [scenario], { exitCode: 0, stdout: records.map(r => JSON.stringify(r)).join('\n'), ...rest });
test('verification derives criteria from full suite events and retains file timings', () => {
  const report = summary([...evidence(), { type: 'test', file, name: 'other coverage', status: 'passed' }]);
  assert.equal(report.outcome, 'passed');
  assert.equal(report.scenarios[0].criteria[0].outcome, 'passed');
  assert.deepEqual(report.fileTimings, [{ file, durationMs: 12 }]);
});
test('verification fails closed for missing duplicate skipped and wrong-file criteria', () => {
  for (const records of [evidence().slice(1), [...evidence(), evidence()[0]], evidence().map(r => r.type === 'test' ? { ...r, status: 'skipped' } : r), evidence().map(r => r.type === 'test' ? { ...r, file: 'test/another.test.js' } : r)]) assert.equal(summary(records).outcome, 'failed');
  const records = evidence().map(r => r.type === 'test' ? { ...r, file: 'test/another.test.js' } : r);
  records.push({ type: 'summary', file: 'test/another.test.js', success: true, counts });
  assert.equal(summarizeVerification([file, 'test/another.test.js'], [scenario], { exitCode: 0, stdout: records.map(JSON.stringify).join('\n') }).outcome, 'failed');
});
test('verification rejects malformed incomplete and failed execution even with all criteria', () => {
  for (const records of [evidence().slice(0, 2), evidence().filter(r => r.file !== file || r.type !== 'summary'), [...evidence(), evidence()[2]], [...evidence(), { type: 'invented' }], evidence().map(r => r.type === 'summary' ? { ...r, counts: {} } : r)]) assert.equal(summary(records).outcome, 'failed');
  for (const rest of [{ exitCode: 1 }, { reason: 'timeout' }, { stdout: 'private-canary' }]) {
    const report = summary(evidence(), rest);
    assert.equal(report.outcome, 'failed');
    assert.equal(JSON.stringify(report).includes('private-canary'), false);
  }
  assert.equal(summary([...evidence(), { type: 'test', file, name: 'unrelated failure', status: 'failed' }]).outcome, 'failed');
});
test('CI verification dispatches all owned files once with credentials removed', async () => {
  const shard = { index: 1, count: 4 }, files = selectedTests(shard), calls = [];
  const result = await verifyTests(shard, { async execute(command, args, options) {
    calls.push({ command, args, options });
    const records = catalog.scenarios.filter(s => files.includes(s.file)).flatMap(s => s.criteria.map(c => ({ type: 'test', file: s.file, name: c.test, status: 'passed' })));
    for (const file of [...files, null]) records.push({ type: 'summary', file, success: true, counts });
    return { exitCode: 0, stdout: records.map(r => JSON.stringify(r)).join('\n') };
  } });
  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args.slice(3), files);
  for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'RIVET_PROVIDER_SANDBOX']) assert.equal(calls[0].options.env[name], undefined);
  assert.notEqual(calls[0].options.env.HOME, process.env.HOME);
  await assert.rejects(verifyTests({ index: 0, count: 4 }, { execute() { throw Error('must not dispatch'); } }));
});
test('native reporter ignores forged stdout and reports skipped and failed native events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rivet-reporter-'));
  try {
    const path = join(directory, 'fixture.cjs');
    await writeFile(path, `const {test}=require('node:test'); test('real',()=>console.log('private-canary')); test('skip',{skip:true},()=>{}); test('fail',()=>{throw Error('secret body')});`);
    const result = await runBounded(process.execPath, ['--test', `--test-reporter=${fileURLToPath(new URL('../../scripts/verify-tests-reporter.mjs', import.meta.url))}`, path], { env: fixtureEnvironment(directory) });
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout.includes('private-canary'), false);
    assert.equal(result.stdout.includes('secret body'), false);
    const records = result.stdout.trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.filter(r => r.type === 'test').map(r => r.status), ['passed', 'skipped', 'failed']);
    assert.equal(records.filter(r => r.type === 'summary' && r.file === null).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
