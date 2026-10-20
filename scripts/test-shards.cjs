const { readdirSync } = require('node:fs');
const { join, relative } = require('node:path');
const weights = require('./test-durations.json');
const repositoryRoot = join(__dirname, '..');

function discoverTests(directory = join(repositoryRoot, 'test')) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return discoverTests(path);
    return entry.isFile() && entry.name.endsWith('.test.js') ? [relative(repositoryRoot, path)] : [];
  }).sort();
}
function parseShard(args) {
  if (!args.length) return null;
  const match = args.length === 1 && /^--shard=([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(args[0]);
  if (!match || Number(match[1]) > Number(match[2]) || Number(match[2]) > 32) {
    throw new Error('Use --shard=<index>/<count> with 1 <= index <= count <= 32.');
  }
  return { index: Number(match[1]), count: Number(match[2]) };
}
// Longest-first packing balances observed work without depending on discovery order.
// Hints affect scheduling only: every new or unmeasured suite is still included.
function assignShards(files, count, durations = weights) {
  if (!Number.isInteger(count) || count < 1 || count > 32 || new Set(files).size !== files.length) throw new Error('Invalid shard inventory.');
  const cost = file => Number.isFinite(durations[file]) && durations[file] > 0 ? durations[file] : 5;
  const shards = Array.from({ length: count }, () => ({ files: [], seconds: 0 }));
  for (const file of [...files].sort((a,b) => cost(b)-cost(a) || (a < b ? -1 : a > b ? 1 : 0))) {
    const target = shards.reduce((best, shard) => shard.seconds < best.seconds ? shard : best);
    target.files.push(file); target.seconds += cost(file);
  }
  return shards.map(shard => shard.files.sort());
}
function selectedTests(shard, files = discoverTests()) {
  if (!shard) return files;
  // Programmatic callers receive the same validation as the CLI.
  parseShard([`--shard=${shard.index}/${shard.count}`]);
  return assignShards(files, shard.count)[shard.index - 1];
}
module.exports = { repositoryRoot, discoverTests, parseShard, assignShards, selectedTests };
