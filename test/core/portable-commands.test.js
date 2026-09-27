import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { access, link, mkdir, mkdtemp, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectConfig } from '../../src/config/load.js';
import { validateProjectConfiguration } from '../../src/config/validate.js';
import { compileProjectCommands, compileQualitySteps } from '../../src/config/commands.js';
import { inspectCommandReadiness } from '../../src/config/command-readiness.js';
import { configuredFeatureGates } from '../../src/feature/runtime-bridge.js';
import { createAuthorityEnvelope } from '../../src/policy/authority.js';
import { runCommand, prepareCommand } from '../../src/policy/commands.js';
import { runQualityGates } from '../../src/quality/runner.js';
import { diagnoseDoctor } from '../../src/commands/doctor.js';
import { createRivetApplication } from '../../src/runtime/application.js';
import { createGitClient } from '../../src/git/client.js';

async function config(argv = ['python', '-m', 'pytest']) {
  const value = structuredClone(await loadProjectConfig(new URL('../fixtures/config/valid/', import.meta.url).pathname));
  value.project.schemaVersion = 3;
  value.project.stack = { framework: 'django', language: 'python', packageManager: 'pip' };
  value.project.commands = { test: { steps: [{ cwd: '.', argv }] } };
  value.quality.commandGates = [{ id: 'test', command: 'test', required: true }];
  return value;
}

test('schema3 accepts a real required test/check without invented build across ecosystems', async () => {
  for (const argv of [['python', '-m', 'pytest'], ['python', 'manage.py', 'check'], ['go', 'test', './...'], ['cargo', 'test'], ['make', 'check'], ['custom_tool+', '--filter', '[a-z]*;literal']]) {
    const value = await config(argv);
    assert.equal(validateProjectConfiguration(value), true);
    assert.deepEqual(compileQualitySteps(value)[0], { id: 'test', logicalId: 'test', cwd: '.', argv, execution: 'argv', required: true });
  }
  const value = await config(['python', 'manage.py', 'check']);
  value.project.commands.check = value.project.commands.test;
  delete value.project.commands.test;
  value.quality.commandGates[0].command = 'check';
  assert.equal(validateProjectConfiguration(value), true);
  value.quality.commandGates[0].required = false;
  assert.throws(() => validateProjectConfiguration(value));
});

test('schema3 compiler rejects shell, path, controls, sparse, and excessive argv', async () => {
  for (const argv of [['sh', '-c', 'true'], ['/bin/python'], ['../python'], ['python', 'bad\narg'], ['python', '\0'], ['python', ...Array(257).fill('x')], ['python', , 'test']]) {
    assert.throws(() => compileProjectCommands({ schemaVersion: 3, commands: { test: { steps: [{ cwd: '.', argv }] } } }));
  }
});

test('schema3 readiness checks executable and cwd without package manifest', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rivet-portable-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const value = await config();
  assert.equal(inspectCommandReadiness(root, value, { tools: { python: { runtimeResolved: true } } }).ready, true);
  assert.equal(inspectCommandReadiness(root, value, { tools: {} }).ready, false);
  value.project.commands.test.steps[0].cwd = 'missing';
  assert.equal(inspectCommandReadiness(root, value, { tools: { python: { runtimeResolved: true } } }).ready, false);
});

test('schema3 bridge executes real Python unittest through quality evidence and preserves literal argv', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rivet-python-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const python = execFileSync('python3', ['-c', 'import os,sys; print(os.path.realpath(sys.executable))'], { encoding: 'utf8' }).trim();
  await writeFile(join(root, 'test_portable.py'), 'import unittest\nclass Portable(unittest.TestCase):\n def test_runs(self): self.assertEqual(2+2,4)\n');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture']);
  const gitExecutable = await realpath(execFileSync('which', ['git'], { encoding: 'utf8' }).trim());
  const gitClient = await createGitClient({ gitExecutable });
  const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const authority = createAuthorityEnvelope({ actorId: 'worker', principal: 'agent', actions: ['command.test'], commands: ['test'], ownedPaths: [], providers: [] });
  const value = await config(['python', '-B', '-m', 'unittest', '-v']);
  const gates = await configuredFeatureGates(value, async () => python);
  assert.equal(gates[0].execution, 'argv');
  assert.equal(gates[0].packageScript, undefined);
  const result = await runQualityGates({ projectRoot: root, commitSha: sha, authority, gates }, { gitClient });
  assert.equal(result.status, 'pass');
  const contract = { worktree: root, authority, commands: { test: { executable: python, args: ['-c', 'import sys; print(sys.argv[1])', '[x]*;$(literal)'], execution: 'argv', action: 'command.test' } } };
  const request = { actorId: 'worker', commandId: 'test', cwd: '.' };
  const literal = await runCommand(contract, request);
  assert.equal(literal.status, 'success');
  assert.equal(literal.stdout.trim(), '[x]*;$(literal)');
  await assert.rejects(() => prepareCommand(contract, { ...request, args: ['extra'] }));
  await assert.rejects(() => prepareCommand({ ...contract, commands: { test: { ...contract.commands.test, allowExtraArgs: true } } }, request));
  await assert.rejects(() => prepareCommand({ ...contract, commands: { test: { ...contract.commands.test, executable: '/bin/sh' } } }, request));
  await assert.rejects(() => prepareCommand(contract, { ...request, cwd: '..' }));
  await assert.rejects(() => prepareCommand(contract, { ...request, actorId: 'stranger' }));
  const failure = await runCommand({ ...contract, commands: { test: { ...contract.commands.test, args: ['-c', 'raise SystemExit(7)'] } } }, request);
  assert.equal(failure.code, 7);
  const failedGates = await configuredFeatureGates(await config(['python', '-c', 'raise SystemExit(7)']), async () => python);
  const failedQuality = await runQualityGates({ projectRoot: root, commitSha: sha, authority, gates: failedGates }, { gitClient });
  assert.equal(failedQuality.status, 'fail');
  const controller = new AbortController();
  const waiting = runCommand({ ...contract, commands: { test: { ...contract.commands.test, args: ['-c', 'import time; time.sleep(20)'] } } }, request, { signal: controller.signal });
  setTimeout(() => controller.abort(), 150);
  const cancelled = await waiting;
  assert.notEqual(cancelled.status, 'success');
  assert.equal(cancelled.aborted, true);
  assert.notEqual(failure.status, 'success');
});


test('argv execution accepts regular hardlinks and preserves legacy rejection and cwd safety', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rivet-hardlink-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'custom-tool');
  await writeFile(executable, '#!/bin/sh\nprintf linked', { mode: 0o700 });
  await link(executable, join(root, 'alias'));
  await mkdir(join(root, 'worktree'));
  await symlink(root, join(root, 'worktree', 'external'));
  const authority = createAuthorityEnvelope({ actorId: 'worker', principal: 'agent', actions: ['command.test'], commands: ['test'], ownedPaths: [], providers: [] });
  const contract = { worktree: join(root, 'worktree'), authority, commands: { test: { executable, args: [], action: 'command.test', execution: 'argv' } } };
  const request = { actorId: 'worker', commandId: 'test', cwd: '.' };
  assert.equal((await runCommand(contract, request)).stdout, 'linked');
  await assert.rejects(() => prepareCommand(contract, { ...request, cwd: 'external' }));
  const { execution, ...legacy } = contract.commands.test;
  await assert.rejects(() => prepareCommand({ ...contract, commands: { test: legacy } }, request));
});


test('default symlink virtualenv keeps its own packages through application resolution and quality execution', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rivet-venv-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const venv = join(root, 'venv');
  execFileSync('python3', ['-m', 'venv', '--without-pip', venv]);
  const alias = join(venv, 'bin', 'python3');
  const site = execFileSync(alias, ['-c', 'import sysconfig;print(sysconfig.get_path("purelib"))'], { encoding: 'utf8' }).trim();
  await writeFile(join(site, 'rivet_venv_only.py'), 'VALUE = "venv-only-import-ok"\n');
  const env = { PATH: join(venv, 'bin') + ':' + process.env.PATH, VIRTUAL_ENV: venv };
  const application = createRivetApplication({ env });
  const executable = await application.resolveCommandExecutable('python3', { execution: 'argv' });
  assert.equal(executable, alias);
  assert.equal(await application.resolveCommandExecutable('python3'), await realpath(alias));
  const project = join(root, 'project');
  execFileSync('git', ['init', '-q', project]);
  await writeFile(join(project, 'README'), 'fixture\n');
  execFileSync('git', ['-C', project, 'add', '.']);
  execFileSync('git', ['-C', project, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture']);
  const sha = execFileSync('git', ['-C', project, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const gitExecutable = await realpath(execFileSync('which', ['git'], { encoding: 'utf8' }).trim());
  const gitClient = await createGitClient({ gitExecutable });
  const value = await config(['python3', '-B', '-c', 'import sys,rivet_venv_only; print(sys.prefix); print(rivet_venv_only.VALUE)']);
  const diagnosis = await diagnoseDoctor(project, {
    configLoader: async () => value, env, hostReadiness: true,
    resolveCommandExecutable: application.resolveCommandExecutable,
    toolDiscovery: async () => ({ node: { present: true, supported: true, version: '22' }, git: { present: true, supported: true, version: '2' } }),
  });
  assert.equal(diagnosis.ok, true);
  const gates = await configuredFeatureGates(value, application.resolveCommandExecutable);
  const authority = createAuthorityEnvelope({ actorId: 'worker', principal: 'agent', actions: ['command.test'], commands: ['test'], ownedPaths: [], providers: [] });
  const quality = await runQualityGates({ projectRoot: project, commitSha: sha, gates, authority, environment: env }, { gitClient });
  assert.equal(quality.status, 'pass');
  assert.equal(quality.gates[0].output.stdout.trim(), venv + '\nvenv-only-import-ok');

  const contract = { worktree: project, authority, commands: { test: { executable, execution: 'argv', action: 'command.test', args: ['-c', 'import pathlib,time; pathlib.Path("started").write_text("yes"); time.sleep(20)'] } } };
  const request = { actorId: 'worker', commandId: 'test', cwd: '.' };
  const running = runCommand(contract, request);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { await access(join(project, 'started')); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await access(join(project, 'started'));
  const target = await realpath(alias);
  await rename(alias, alias + '-original');
  await symlink(target, alias);
  const stopped = await running;
  assert.equal(stopped.status, 'bootstrap-error');
  assert.equal(stopped.suppressed, true);
  await unlink(alias);
  await symlink('/bin/sh', alias);
  await assert.rejects(() => prepareCommand(contract, request));
});

test('missing configured direct executable gives an actionable bounded error', async () => {
  const application = createRivetApplication({ env: { PATH: '/no-such-tools', RIVET_CUSTOM_EXECUTABLE: '/missing/custom' } });
  await assert.rejects(() => application.resolveCommandExecutable('custom', { execution: 'argv' }), error =>
    error.details?.reason === 'command-executable-unavailable' && /PATH|executable/.test(error.safeMessage));
});
