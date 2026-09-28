import assert from 'node:assert/strict';
import { execFile as callback } from 'node:child_process';
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createGitClient } from '../../src/git/client.js';
const execFile = promisify(callback);
async function fixture(t, content = 'new value\n') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rivet-review-diff-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args) => (await execFile('git', ['-C', root, ...args])).stdout.trim();
  await git('init', '-q', '-b', 'main');
  async function commit(text) {
    await writeFile(join(root, 'file.txt'), text);
    await git('add', '.');
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  }
  const fromSha = await commit('old value\n');
  const toSha = await commit(content);
  let executable;
  for (const path of ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git']) {
    try { executable = await realpath(path); break; } catch {}
  }
  const client = await createGitClient({ gitExecutable: executable });
  return { root, git, fromSha, toSha, client };
}
test('review diff shows the exact commit patch without altering index, HEAD or local edits', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'file.txt'), 'uncommitted value\n');
  await f.git('config', 'color.ui', 'always');
  const before = await f.git('status', '--porcelain');
  const result = await f.client.reviewDiff(f.root, { fromSha: f.fromSha, toSha: f.toSha });
  assert.match(result.patch, /-old value\n\+new value/);
  assert.doesNotMatch(result.patch, /uncommitted|\x1b/);
  assert.equal(result.truncated, false);
  assert.equal(await f.git('status', '--porcelain'), before);
  assert.equal(await f.git('rev-parse', 'HEAD'), f.toSha);
});
test('review diff rejects hostile selectors before invoking Git', async t => {
  const f = await fixture(t);
  for (const fromSha of ['HEAD', '--output=/tmp/unsafe', `${f.fromSha}~1`, 'a'.repeat(39)]) {
    await assert.rejects(f.client.reviewDiff(f.root, { fromSha, toSha: f.toSha }), { code: 'ERR_GIT_INVALID_INPUT' });
  }
});
test('review diff refuses executable diff configuration without running it', async t => {
  const f = await fixture(t);
  const marker = join(f.root, 'executed');
  await f.git('config', 'diff.external', `touch ${marker}`);
  await assert.rejects(f.client.reviewDiff(f.root, { fromSha: f.fromSha, toSha: f.toSha }), { code: 'ERR_GIT_EXECUTABLE_CONFIG' });
  await assert.rejects(access(marker), { code: 'ENOENT' });
});
test('review diff refuses excessive patches with checkout review guidance', async t => {
  const f = await fixture(t, 'large line\n'.repeat(10000));
  await assert.rejects(f.client.reviewDiff(f.root, { fromSha: f.fromSha, toSha: f.toSha }), error => {
    assert.equal(error.code, 'ERR_GIT_REVIEW_DIFF_UNAVAILABLE');
    assert.match(error.safeMessage, /checkout/);
    return true;
  });
});
