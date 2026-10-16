import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { createGitClient } from '../../src/git/client.js';
import { bootstrapWorktreeDependencies, inspectWorktreeDependencies, WorktreeBootstrapError } from '../../src/runtime/worktree-bootstrap.js';

const execFile = promisify(execFileCallback);

async function fixture(t, files = {}) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'rivet-bootstrap-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const projectRoot = join(parent, 'project');
  const worktreePath = join(parent, 'integration');
  await mkdir(projectRoot);
  await writeFile(join(projectRoot, '.gitignore'), 'node_modules/\n');
  await writeFile(join(projectRoot, 'package.json'), '{"private":true}\n');
  for (const [name, contents] of Object.entries(files)) await writeFile(join(projectRoot, name), contents);
  await execFile('git', ['init', '--quiet', '--initial-branch=main', projectRoot]);
  await execFile('git', ['-C', projectRoot, 'add', '.']);
  await execFile('git', ['-C', projectRoot, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  let gitExecutable;
  for (const candidate of ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git']) {
    try {
      gitExecutable = await realpath(candidate);
      await createGitClient({ gitExecutable });
      break;
    } catch { gitExecutable = undefined; }
  }
  if (!gitExecutable) throw new Error('Git fixture executable is unavailable');
  const gitClient = await createGitClient({ gitExecutable });
  const expectedCommit = (await gitClient.inspectRepository(projectRoot)).headSha;
  await execFile('git', ['-C', projectRoot, 'worktree', 'add', '--quiet', '-b', 'feature/bootstrap', worktreePath, expectedCommit]);
  const input = { projectRoot, worktreePath, expectedCommit, expectedBranch: 'feature/bootstrap', manager: 'npm' };
  const installer = join(parent, 'fake-npm');
  await writeFile(installer, '#!/bin/sh\nmkdir -p node_modules\nprintf "ready" > node_modules/installed\n', { mode: 0o700 });
  await chmod(installer, 0o700);
  return { parent, input, gitClient, installer };
}

test('chooses the frozen install command from the configured manager and committed lockfile', async t => {
  const value = await fixture(t, { 'package-lock.json': '{"lockfileVersion":3}\n' });
  const plan = await inspectWorktreeDependencies(value.input, { gitClient: value.gitClient });
  assert.equal(plan.lockfile, 'package-lock.json');
  assert.deepEqual(plan.args, ['ci']);
});

test('requires a matching, unambiguous lockfile and clean accepted checkout', async t => {
  const value = await fixture(t, { 'yarn.lock': '# lock\n' });
  await assert.rejects(() => inspectWorktreeDependencies(value.input, { gitClient: value.gitClient }),
    error => error instanceof WorktreeBootstrapError && error.details.reason === 'manager-mismatch');
  await writeFile(join(value.input.worktreePath, 'untracked.txt'), 'dirty\n');
  await assert.rejects(() => inspectWorktreeDependencies(value.input, { gitClient: value.gitClient }),
    error => error instanceof WorktreeBootstrapError && error.details.reason === 'unsafe-checkout');
  await assert.rejects(() => inspectWorktreeDependencies({
    ...value.input, worktreePath: value.input.projectRoot, expectedBranch: 'main',
  }, { gitClient: value.gitClient }),
  error => error instanceof WorktreeBootstrapError && error.details.reason === 'invalid-input');
});

test('decline does not execute and approval installs only in the isolated checkout', async t => {
  const value = await fixture(t, { 'package-lock.json': '{"lockfileVersion":3}\n' });
  const options = {
    gitClient: value.gitClient,
    resolveCommandExecutable: async () => value.installer,
  };
  assert.deepEqual(await bootstrapWorktreeDependencies(value.input, { ...options, confirm: async () => false }),
    { status: 'declined' });
  await assert.rejects(() => readFile(join(value.input.worktreePath, 'node_modules/installed')));
  const result = await bootstrapWorktreeDependencies(value.input, { ...options, confirm: async () => true });
  assert.equal(result.status, 'ready');
  assert.equal(await readFile(join(value.input.worktreePath, 'node_modules/installed'), 'utf8'), 'ready');
  await assert.rejects(() => readFile(join(value.input.projectRoot, 'node_modules/installed')));
  assert.equal((await value.gitClient.inspectRepository(value.input.worktreePath)).dirty, false);
});

test('package-manager scripts using env node can run with a bounded PATH', async t => {
  const value = await fixture(t, { 'package-lock.json': '{"lockfileVersion":3}\n' });
  await writeFile(value.installer, '#!/usr/bin/env node\nrequire("node:fs").mkdirSync("node_modules", { recursive: true });\nrequire("node:fs").writeFileSync("node_modules/installed", "ready");\n', { mode: 0o700 });
  const result = await bootstrapWorktreeDependencies(value.input, {
    gitClient: value.gitClient,
    resolveCommandExecutable: async () => value.installer,
    confirm: async () => true,
  });
  assert.equal(result.status, 'ready', result.result.stderr);
});

test('refuses a checkout changed after the prompt and rejects installer source edits', async t => {
  const value = await fixture(t, { 'package-lock.json': '{"lockfileVersion":3}\n' });
  let resolved = false;
  await assert.rejects(() => bootstrapWorktreeDependencies(value.input, {
    gitClient: value.gitClient,
    resolveCommandExecutable: async () => value.installer,
    confirm: async () => {
      await writeFile(join(value.input.worktreePath, 'package-lock.json'), '{"changed":true}\n');
      resolved = true;
      return true;
    },
  }), error => error instanceof WorktreeBootstrapError && error.details.reason === 'unsafe-checkout');
  assert.equal(resolved, true);
  await writeFile(join(value.input.worktreePath, 'package-lock.json'), '{"lockfileVersion":3}\n');
  await writeFile(value.installer, '#!/bin/sh\nprintf "changed\\n" > package-lock.json\n', { mode: 0o700 });
  await assert.rejects(() => bootstrapWorktreeDependencies(value.input, {
    gitClient: value.gitClient,
    resolveCommandExecutable: async () => value.installer,
    confirm: async () => true,
  }), error => error instanceof WorktreeBootstrapError && error.details.reason === 'checkout-changed');
});

test('enrolled dependency setup queues without an agent lease and resumes the actual installer',async t=>{
 const {createResourceCoordinator}=await import('../../src/runtime/resource-coordinator.js');
 const {withMachineContext}=await import('../../src/runtime/machine-admission.js');
 const value=await fixture(t,{'package-lock.json':'{"lockfileVersion":3}\n'});
 const coordinator=createResourceCoordinator({root:join(value.parent,'machine')});const r=await coordinator.register({projectRoot:value.input.projectRoot,runId:'install-run',deadlineMs:Date.now()+30000});
 const held=await coordinator.request({registrationId:r.id,resource:'dependencyInstalls',idempotencyKey:'another-installer',generation:1});
 let done=false;const pending=withMachineContext(coordinator,value.input.projectRoot,r.runId,()=>bootstrapWorktreeDependencies(value.input,{gitClient:value.gitClient,resolveCommandExecutable:async()=>value.installer,confirm:async()=>true})).then(result=>{done=true;return result;});
 for(let i=0;i<100;i++){if((await coordinator.inspect()).claims.some(c=>c.status==='queued'))break;await new Promise(resolve=>setTimeout(resolve,10));}
 assert.equal(done,false);const waiting=await coordinator.inspect();assert.equal(waiting.claims.filter(c=>c.resource==='agentExecutions'&&c.status==='held').length,0);assert.equal(waiting.claims.filter(c=>c.status==='queued').length,1);
 await coordinator.release({claimId:held.id,generation:1,completed:true});assert.equal((await pending).status,'ready');assert.equal(await readFile(join(value.input.worktreePath,'node_modules','installed'),'utf8'),'ready');
});

test('install errors expose only recognized bootstrap failure reasons', () => {
  const error = new WorktreeBootstrapError('install-failed', {
    status: 'bootstrap-error', code: null, bootstrapFailure: 'target-spawn-failed',
  });
  assert.match(error.safeMessage, /Bootstrap failure: target-spawn-failed/);
  const untrusted = new WorktreeBootstrapError('install-failed', {
    status: 'bootstrap-error', code: null, bootstrapFailure: 'secret-untrusted-path',
  });
  assert.doesNotMatch(untrusted.safeMessage, /secret-untrusted-path/);
});

test('legacy dependency installs also finish after exceeding the output capture limit', async t => {
  const value = await fixture(t, { 'package-lock.json': '{"lockfileVersion":3}\n' });
  await writeFile(value.installer, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeSync(1, 'x'.repeat(800000));
fs.mkdirSync('node_modules', {recursive: true});
fs.writeFileSync('node_modules/installed', 'ready');
`, {mode: 0o700});
  const result = await bootstrapWorktreeDependencies(value.input, {
    gitClient: value.gitClient, resolveCommandExecutable: async () => value.installer, confirm: async () => true,
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.result.code, 0);
  assert.equal(result.result.suppressed, true);
  assert.equal(result.result.truncated.combined, true);
  assert.equal(await readFile(join(value.input.worktreePath, 'node_modules/installed'), 'utf8'), 'ready');
});
