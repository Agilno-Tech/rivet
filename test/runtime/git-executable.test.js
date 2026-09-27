import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { chmod, copyFile, link, lstat, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createGitClient } from '../../src/git/client.js';
import { createRivetApplication } from '../../src/runtime/application.js';
import { main } from '../../src/cli/main.js';
import { EXIT_CODES } from '../../src/cli/output.js';

const execFile = promisify(execFileCallback);
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rivet-git-executable-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'git');
  const installedGit = process.platform === 'darwin'
    ? (await execFile('/usr/bin/xcrun', ['--find', 'git'])).stdout.trim() : '/usr/bin/git';
  await copyFile(await realpath(installedGit), executable);
  await chmod(executable, 0o700);
  const repository = join(root, 'repository');
  await execFile('git', ['init', '-q', '-b', 'main', repository]);
  await writeFile(join(repository, 'README.md'), 'fixture\n');
  await execFile('git', ['-C', repository, 'add', '.']);
  await execFile('git', ['-C', repository, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
  return { root, executable, repository };
}

test('accepts a hardlinked native Git executable and inspects a repository', async t => {
  const f = await fixture(t);
  await link(f.executable, join(f.root, 'git-alias'));
  assert.equal((await lstat(f.executable)).nlink, 2);
  const client = await createGitClient({ gitExecutable: f.executable });
  assert.equal((await client.inspectRepository(f.repository)).branch, 'main');
});

for (const change of ['replacement', 'symlink', 'permissions']) {
  test(`rechecks Git executable identity and permissions after ${change}`, async t => {
    const f = await fixture(t);
    const client = await createGitClient({ gitExecutable: f.executable });
    if (change === 'permissions') await chmod(f.executable, 0o600);
    else {
      const original = join(f.root, 'original');
      await rename(f.executable, original);
      if (change === 'symlink') await symlink(original, f.executable);
      else await copyFile(original, f.executable);
    }
    await assert.rejects(client.inspectRepository(f.repository), { code: 'ERR_GIT_UNSAFE_EXECUTABLE' });
  });
}

for (const [setting, reason, message] of [
  ['private-relative-value', 'git-executable-invalid', /RIVET_GIT_EXECUTABLE.*absolute.*canonical/],
  ['/definitely/missing/private-git-value', 'git-executable-unusable', /RIVET_GIT_EXECUTABLE.*regular.*executable/],
]) {
  test(`lazy runtime reports sanitized ${reason} through the CLI boundary`, async () => {
    const app = createRivetApplication({ env: { RIVET_GIT_EXECUTABLE: setting } });
    const request = { project: '/unused', source: { kind: 'inline', value: '# Task\n\n## Acceptance Criteria\n- Works.' }, client: 'codex' };
    await assert.rejects(app.feature.propose(request), error => {
      assert.equal(error.code, 'ERR_APPLICATION_CONFIGURATION');
      assert.equal(error.details.reason, reason);
      assert.match(error.safeMessage, message);
      assert.ok(!error.safeMessage.includes(setting));
      return true;
    });
    const output = [];
    const code = await main(['feature', 'propose', '--project=/unused', '--request-text=# Task\n\n## Acceptance Criteria\n- Works.', '--client=codex', '--json'], {
      ...app,
      output: { log() {}, error() {}, json: value => output.push(value) },
    });
    assert.equal(code, EXIT_CODES.MISSING_CONFIGURATION);
    assert.match(output[0].error.message, message);
    assert.ok(!JSON.stringify(output).includes(setting));
  });
}

test('Git discovery exhaustion explains how to configure Git without leaking lookup errors', async () => {
  const { stdout } = await execFile(process.execPath, ['--input-type=module', '-e', `
    import { register } from 'node:module';
    function resolve(specifier, context, next) {
      if (specifier === 'node:fs/promises' && context.parentURL?.endsWith('/src/runtime/application.js')) {
        return { shortCircuit: true, url: 'data:text/javascript,export async function realpath() { throw new Error("private-lookup-value"); } export async function lstat() { throw new Error("private-lookup-value"); }' };
      }
      return next(specifier, context);
    }
    register('data:text/javascript,' + encodeURIComponent('export ' + resolve.toString()));
    const { createRivetApplication } = await import('./src/runtime/application.js');
    try { await createRivetApplication({ env: {} }).feature.propose({}); }
    catch (error) { console.log(JSON.stringify({ code: error.code, details: error.details, message: error.safeMessage })); }
  `], { cwd: new URL('../../', import.meta.url) });
  const error = JSON.parse(stdout);
  assert.equal(error.code, 'ERR_APPLICATION_CONFIGURATION');
  assert.equal(error.details?.reason, 'git-unavailable');
  assert.match(error.message, /Git.*PATH.*RIVET_GIT_EXECUTABLE/);
  assert.ok(!stdout.includes('private-lookup-value'));
});
