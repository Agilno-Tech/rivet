import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as commands from '../../src/config/commands.js';
import { loadProjectConfig } from '../../src/config/load.js';
import { validateProjectConfiguration } from '../../src/config/validate.js';
import { createRivetApplication } from '../../src/runtime/application.js';
import { configuredFeatureGates } from '../../src/feature/runtime-bridge.js';
import { diagnoseDoctor } from '../../src/commands/doctor.js';

async function config() {
  const value = structuredClone(await loadProjectConfig(new URL('../fixtures/config/valid/', import.meta.url).pathname));
  value.project.schemaVersion = 3;
  value.project.stack = { framework: 'django', language: 'python', packageManager: 'pip' };
  value.project.dependencies = {
    inputs: ['requirements.txt'], provides: ['./.rivet/dependencies/python/bin/python'],
    steps: [
      { cwd: '.', argv: ['python3', '-m', 'venv', '.rivet/dependencies/python'] },
      { cwd: '.', argv: ['./.rivet/dependencies/python/bin/python', '-m', 'pip', 'install', '-r', 'requirements.txt'] },
    ],
  };
  value.project.commands = { test: { steps: [{ cwd: '.', argv: ['./.rivet/dependencies/python/bin/python', 'manage.py', 'test'] }] } };
  value.quality.commandGates = [{ id: 'test', command: 'test', required: true }];
  return value;
}
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rivet-dependencies-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'requirements.txt'), '# fixture\n');
  return root;
}

test('schema3 dependency steps compile immutably with local tools and preserve legacy grammar', async () => {
  const value = await config();
  assert.equal(validateProjectConfiguration(value), true);
  const dependency = commands.compileProjectDependencies(value.project);
  assert.deepEqual(dependency.inputs, ['requirements.txt']);
  assert.equal(dependency.steps[1].execution, 'argv');
  assert.equal(dependency.steps[0].id, 'install-1');
  assert.ok(Object.isFrozen(dependency.steps[0].argv));
  delete value.project.dependencies;
  assert.equal(commands.compileProjectDependencies(value.project), undefined);
  value.project.schemaVersion = 2;
  assert.throws(() => commands.compileProjectCommands(value.project));
});

test('dependency config rejects unknown fields, accessors, sparse arrays, unsafe paths and excessive entries', async () => {
  for (const mutate of [
    d => { d.unknown = true; }, d => { d.inputs = ['../requirements.txt']; },
    d => { d.provides = ['/usr/bin/python']; }, d => { d.provides = ['./.git/tool']; },
    d => { d.steps = Array(17).fill(d.steps[0]); }, d => { d.inputs = Array(17).fill('requirements.txt'); },
    d => { d.steps[0].argv = ['./../tool']; }, d => { d.steps[0].argv = ['./.venv/bin/sh']; },
    d => { d.provides = ['./tool', './tool']; }, d => { d.inputs = ['requirements.txt', , 'other']; },
    d => { Object.defineProperty(d, 'steps', { enumerable: true, get() { throw Error('must not invoke'); } }); },
  ]) {
    const value = await config(); mutate(value.project.dependencies);
    assert.throws(() => commands.compileProjectDependencies(value.project));
  }
});

test('local executable resolution binds cwd and checkout and rejects escaping or symlinked ancestors', async t => {
  const root = await fixture(t);
  const app = createRivetApplication();
  await mkdir(join(root, 'backend', 'env', 'bin'), { recursive: true });
  const python = execFileSync('python3', ['-c', 'import os,sys;print(os.path.realpath(sys.executable))'], { encoding: 'utf8' }).trim();
  await symlink(python, join(root, 'backend', 'env', 'bin', 'python'));
  const actual = await app.resolveCommandExecutable('./env/bin/python', { execution: 'argv', worktree: root, cwd: 'backend' });
  assert.equal(actual, join(root, 'backend', 'env', 'bin', 'python'));
  await assert.rejects(() => app.resolveCommandExecutable('./env/bin/python', { execution: 'argv' }));
  await assert.rejects(() => app.resolveCommandExecutable('./../python', { execution: 'argv', worktree: root, cwd: '.' }));
  await symlink(join(root, 'backend'), join(root, 'alias'));
  await assert.rejects(() => app.resolveCommandExecutable('./env/bin/python', { execution: 'argv', worktree: root, cwd: 'alias' }));
  const value = await config();
  value.project.commands.test.steps[0] = { cwd: 'backend', argv: ['./env/bin/python', '-m', 'unittest'] };
  assert.equal((await configuredFeatureGates(value, app.resolveCommandExecutable, root))[0].executable, actual);
});

test('doctor defers only declared outputs when actual dependency tools and inputs are available', async t => {
  const root = await fixture(t);
  const value = await config();
  const app = createRivetApplication();
  const diagnose = () => diagnoseDoctor(root, {
    configLoader: async () => value, hostReadiness: true,
    resolveCommandExecutable: app.resolveCommandExecutable,
    toolDiscovery: async () => ({ node: { present: true, supported: true, version: '22' }, git: { present: true, supported: true, version: '2' } }),
  });
  const pending = await diagnose();
  assert.equal(pending.status, 'preparation-required');
  assert.equal(pending.ok, true);
  assert.equal(pending.preparationReady, true);
  assert.equal(pending.checks.commands.ready, false);
  assert.equal(pending.checks.commands.steps[0].available, false);
  assert.equal(pending.checks.commands.steps[0].status, 'preparation-required');
  value.project.dependencies.steps[0].argv[0] = 'rivet-nonexistent-base-tool';
  assert.equal((await diagnose()).ok, false);
  value.project.dependencies.steps[0].argv[0] = 'python3';
  value.project.dependencies.inputs = ['missing.txt'];
  assert.equal((await diagnose()).ok, false);
  value.project.dependencies.inputs = ['requirements.txt'];
  value.project.commands.test.steps[0].argv[0] = './undeclared/tool';
  assert.equal((await diagnose()).ok, false);
});
