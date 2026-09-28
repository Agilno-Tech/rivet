import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArgs } from '../../src/cli/parse-args.js';
import { featureCommand } from '../../src/commands/feature.js';
import { workCommand } from '../../src/commands/work.js';

const commands = {
  feature: ['start', 'status', 'resume', 'cancel'],
  work: ['prepare', 'next', 'status', 'submit', 'verify', 'recover'],
};
const output = { log() {}, error() {}, json() {} };
for (const [command, subcommands] of Object.entries(commands)) {
  for (const subcommand of subcommands) {
    test(`${command} ${subcommand} supports both run flag spellings and rejects mixed selectors`, () => {
      for (const selector of [['--run=task-one'], ['--run', 'task-one']]) {
        const parsed = parseArgs([command, subcommand, ...selector, '--project=/repo']);
        assert.equal(parsed.flags.run, 'task-one');
        assert.deepEqual(parsed.operands, []);
      }
      assert.throws(() => parseArgs([command, subcommand, 'task-one', '--run=task-one']), /run ID|run selector/);
      assert.throws(() => parseArgs([command, subcommand, '--run=task-one', '--run', 'task-two']), /Duplicate flag/);
      assert.throws(() => parseArgs([command, subcommand, '--run']), /requires a value/);
    });
    test(`${command} ${subcommand} validates aliases in direct calls and preserves concurrency inputs`, async () => {
      const calls = [];
      const method = { next: 'nextAction', submit: 'submitResult' }[subcommand] ?? subcommand;
      const dependencies = { output, [command]: { async [method](input) { calls.push(input); return { status: 'recovered' }; } } };
      const flags = { project: '/repo', run: 'task-one', json: true };
      if (['start', 'resume', 'cancel', 'prepare', 'verify'].includes(subcommand)) flags['expected-version'] = '2';
      if (['next', 'submit', 'verify'].includes(subcommand)) flags['expected-runtime-version'] = '3';
      if (subcommand === 'start') flags['proposal-digest'] = 'a'.repeat(64);
      if (subcommand === 'submit') Object.assign(flags, { 'action-json': '{"kind":"test"}', 'result-json': '{"status":"done"}' });
      const handler = command === 'feature' ? featureCommand : workCommand;
      const parsed = { command, subcommand, operands: [], flags };
      assert.equal(await handler(parsed, dependencies), 0);
      assert.equal(calls[0].runId, 'task-one');
      if (flags['expected-version']) assert.equal(calls[0][command === 'feature' ? 'expectedVersion' : 'expectedRunVersion'], 2);
      if (flags['expected-runtime-version']) assert.equal(calls[0].expectedRuntimeVersion, 3);
      if (subcommand === 'start') assert.equal(calls[0].proposalDigest, 'a'.repeat(64));
      await assert.rejects(handler({ ...parsed, operands: ['task-one'] }, dependencies), { code: 'INVALID_INPUT' });
      await assert.rejects(handler({ ...parsed, flags: { ...flags, run: '../task' } }, dependencies), { code: 'INVALID_INPUT' });
      if (flags['expected-version']) {
        const missing = { ...flags }; delete missing['expected-version'];
        await assert.rejects(handler({ ...parsed, flags: missing }, dependencies), { code: 'INVALID_INPUT' });
      }
      const noProject = { ...flags }; delete noProject.project;
      await assert.rejects(handler({ ...parsed, flags: noProject }, dependencies), { code: 'INVALID_INPUT' });
      if (flags['expected-runtime-version']) {
        const missing = { ...flags }; delete missing['expected-runtime-version'];
        await assert.rejects(handler({ ...parsed, flags: missing }, dependencies), { code: 'INVALID_INPUT' });
      }
      if (subcommand === 'start') {
        const missing = { ...flags }; delete missing['proposal-digest'];
        await assert.rejects(handler({ ...parsed, flags: missing }, dependencies), { code: 'INVALID_INPUT' });
      }
      assert.equal(calls.length, 1);
    });
  }
}
test('run aliases do not allow choosing IDs when creating proposals', async () => {
  for (const [command, subcommand] of [['feature', 'propose'], ['feature', 'run'], ['work', 'propose']]) {
    assert.throws(() => parseArgs([command, subcommand, '--run=task-one']), /run/);
    const handler = command === 'feature' ? featureCommand : workCommand;
    await assert.rejects(handler({ command, subcommand, operands: [], flags: { project: '/repo', run: 'task-one' } }, {
      output, feature: { propose() { assert.fail('must not create'); }, start() {}, watch() {} }, confirmFeatureActivation() {},
    }), { code: 'INVALID_INPUT' });
  }
});
test('details is a boolean only on human run/task and separated run stays bounded', () => {
  assert.equal(parseArgs(['run', 'Do work', '--details']).flags.details, true);
  assert.equal(parseArgs(['task', 'resume', '--run', 'task-one', '--details']).flags.details, true);
  for (const argv of [['run', 'Do work', '--details=yes'], ['feature', 'status', '--details'], ['work', 'status', '--project', '/repo'], ['task', 'status', '--project', '/repo'], ['task', 'status', '--run']]) {
    assert.throws(() => parseArgs(argv));
  }
});
