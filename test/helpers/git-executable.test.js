import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import test from 'node:test';
import { fixtureGit } from './git-executable.js';

test('fixture Git is canonical and preserves the system Git version', () => {
  assert.equal(realpathSync(fixtureGit), fixtureGit);
  assert.equal(execFileSync(fixtureGit, ['--version'], { encoding: 'utf8' }),
    execFileSync('/usr/bin/git', ['--version'], { encoding: 'utf8' }));
  if (process.platform === 'darwin') assert.notEqual(fixtureGit, '/usr/bin/git');
});
