const { spawnSync } = require('node:child_process');
const { repositoryRoot, parseShard, selectedTests } = require('../scripts/test-shards.cjs');

const testFiles = selectedTests(parseShard(process.argv.slice(2)));
if (!testFiles.length) throw new Error('The selected shard contains no tests.');
// Bound process-heavy test files so their deadline/lock assertions remain meaningful
// on shared developer machines and small CI runners. In-file race tests still run.
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=2', ...testFiles], {
  cwd: repositoryRoot,
  shell: false,
  stdio: 'inherit',
});

if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
