import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmIsolatedDependencyInstall } from '../../src/commands/dependency-approval.js';

for (const plan of [
  {worktreePath: '/tmp/worker', executable: '/opt/yarn', args: ['install', '--immutable']},
  {kind: 'portable', worktreePath: '/tmp/worker', expectedBranch: 'feature/test', expectedCommit: 'a'.repeat(40), inputs: [], steps: [{cwd: '.', argv: ['yarn', 'install', '--immutable']}]},
]) {
  test(`dependency approval presents context and asks once (${plan.kind ?? 'legacy'})`, async () => {
    const messages = [];
    let calls = 0;
    const confirm = confirmIsolatedDependencyInstall({
      output: {log: value => messages.push(value)},
      confirmDependencyInstall: async received => {
        assert.equal(received, plan);
        calls++;
        messages.push('Install these dependencies in the isolated checkout? [y/N] ');
        return true;
      },
    });
    assert.equal(await confirm(plan), true);
    assert.equal(calls, 1);
    assert.equal(messages.filter(message => message.includes('?')).length, 1);
    assert.match(messages.join('\n'), /\/tmp\/worker/);
    assert.match(messages.join('\n'), /--immutable/);
  });
}
