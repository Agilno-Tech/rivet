import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

// Apple's /usr/bin/git dispatches through xcrun on every launch. Resolve the
// same installed Git once per test process; production discovery stays covered
// separately in runtime/git-executable.test.js.
export const fixtureGit = realpathSync(process.platform === 'darwin'
  ? execFileSync('/usr/bin/xcrun', ['--find', 'git'], { encoding: 'utf8' }).trim()
  : '/usr/bin/git');
