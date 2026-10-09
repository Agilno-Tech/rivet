import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseArgs } from '../../src/cli/parse-args.js';
import { main } from '../../src/cli/main.js';
import { CliError, createOutput } from '../../src/cli/output.js';

test('version reports executing package without project or network discovery', async () => {
  let stdout = '';
  const forbidden = () => { throw new Error('Unexpected discovery'); };
  const code = await main(['--version'], {
    cwd: forbidden, fetch: forbidden, reportFailure: false,
    output: createOutput({ stdout: { write: value => { stdout += value; } }, stderr: { write: forbidden } }),
  });
  assert.equal(code, 0);
  assert.equal(stdout.trim(), JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).version);
});

test('update accepts only boolean scopes and rejects ambiguous requests', () => {
  assert.deepEqual(parseArgs(['update', '--project', '--check']).flags, { project: true, check: true });
  for (const args of [
    ['--version', '--json'], ['--version', 'run'], ['update', '--global', '--project'],
    ['update', '--project=.'], ['update', '.'], ['update', '--check=false'],
  ]) assert.throws(() => parseArgs(args), undefined, args.join(' '));
});

test('update routes without treating project as a path', async () => {
  let called = false;
  const code = await main(['update', '--project', '--check'], {
    reportFailure: false,
    commands: { update: async (parsed) => {
      called = true;
      assert.deepEqual(parsed.flags, { project: true, check: true });
      return 0;
    } },
  });
  assert.equal(code, 0);
  assert.equal(called, true);
});


test('failed update check never persists an automatic failure report', async () => {
  let reports = 0;
  const code = await main(['update', '--check'], {
    output: createOutput({ stdout: { write() {} }, stderr: { write() {} } }),
    reportFailure: async () => { reports += 1; },
    commands: { update: async () => { throw new CliError('Registry unavailable', 'PROVIDER_UNAVAILABLE'); } },
  });
  assert.notEqual(code, 0);
  assert.equal(reports, 0);
});
