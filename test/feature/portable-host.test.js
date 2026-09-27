import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile as execute } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { createFeatureWorkflow } from '../../src/feature/workflow.js';
import { createHostExecution } from '../../src/feature/host-execution.js';
import { createGitClient } from '../../src/git/client.js';
import { createRivetApplication } from '../../src/runtime/application.js';

const execFile = promisify(execute);
const NOW = '2029-01-01T00:00:00.000Z';
const CONFIG = new URL('../fixtures/config/valid/.rivet', import.meta.url);

async function tools(t) {
  let gitPath;
  try {
    gitPath = (await execFile('which', ['git'])).stdout.trim();
    await execFile('python3', ['--version']);
  } catch (error) {
    if (error.code === 'ENOENT' || (!gitPath && error.code === 1)) {
      t.skip('Git and Python 3 are required for this real local workflow test.');
      return null;
    }
    throw error;
  }
  return { git: await realpath(gitPath) };
}

async function pythonHost(t) {
  const available = await tools(t);
  if (!available) return null;
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'rivet-python-host-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'python project');
  await mkdir(join(root, 'tests'), { recursive: true });
  await cp(CONFIG, join(root, '.rivet'), { recursive: true });
  const projectFile = join(root, '.rivet/project.yaml');
  const project = YAML.parse(await readFile(projectFile, 'utf8'));
  project.schemaVersion = 3;
  project.stack = { framework: 'other', language: 'python', packageManager: 'pip' };
  project.commands = { test: { steps: [{ cwd: '.', argv: ['python3', '-B', '-m', 'unittest', 'discover', '-s', 'tests', '-v'] }] } };
  await writeFile(projectFile, YAML.stringify(project));
  const qualityFile = join(root, '.rivet/quality.yaml');
  const quality = YAML.parse(await readFile(qualityFile, 'utf8'));
  quality.commandGates = [{ id: 'python-tests', command: 'test', required: true }];
  await writeFile(qualityFile, YAML.stringify(quality));
  await writeFile(join(root, 'calculator.py'), 'def add(left, right):\n    return 0\n');
  await writeFile(join(root, 'tests/test_calculator.py'), [
    'import unittest',
    'from calculator import add',
    'class Calculator(unittest.TestCase):',
    '    def test_add(self):',
    '        self.assertEqual(add(2, 3), 5)',
    '',
  ].join('\n'));
  const git = async (...args) => (await execFile(available.git, ['-C', root, ...args])).stdout.trim();
  await execFile(available.git, ['init', '--quiet', '--initial-branch=main', root]);
  await git('add', '.');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'Python fixture');
  const gitClient = await createGitClient({ gitExecutable: available.git });
  const workflow = createFeatureWorkflow({
    gitClient, now: () => NOW,
    planningClientFor: async () => { throw new Error('Host workflow must not invoke a planning model.'); },
    executeFeature: async () => { throw new Error('Host workflow must not spawn a model.'); },
  });
  const proposed = await workflow.propose({
    project: root, client: 'host',
    source: { kind: 'inline', value: '# Fix addition\n\n## Acceptance criteria\n- add returns the sum of its arguments.\n' },
    decomposition: { schemaVersion: 1, kind: 'agilno.feature-decomposition', workItems: [{
      objective: 'Fix Python addition.', ownedPaths: ['calculator.py'], acceptanceCriterionIndexes: [1],
    }] },
  });
  const approved = await workflow.start({ project: root, runId: proposed.runId, expectedVersion: proposed.version, proposalDigest: proposed.proposalDigest });
  // Poison Node package-manager discovery so accidental bootstrap cannot pass silently.
  const poison = join(parent, 'forbidden-tools');
  const marker = join(parent, 'node-bootstrap-called');
  await mkdir(poison);
  for (const command of ['npm', 'pnpm', 'yarn', 'bun']) {
    await writeFile(join(poison, command), '#!/bin/sh\nprintf forbidden > "$RIVET_BOOTSTRAP_MARKER"\nexit 91\n', { mode: 0o700 });
  }
  const environment = { PATH: `${poison}:${process.env.PATH}`, RIVET_BOOTSTRAP_MARKER: marker };
  const application = createRivetApplication({ env: environment });
  const resolved = [];
  const execution = createHostExecution({ gitClient, now: () => NOW, environment,
    resolveCommandExecutable: async (command, options) => {
      resolved.push(command);
      assert.equal(command, 'python3', 'Python-only verification must not resolve a Node package manager.');
      return application.resolveCommandExecutable(command, options);
    },
  });
  const prepared = await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  const next = await execution.nextAction({ project: root, runId: approved.runId, expectedRuntimeVersion: prepared.runtimeVersion });
  const payload = JSON.parse(next.action.payload).contract;
  return { root, marker, resolved, approved, prepared, next, payload, execution, gitClient };
}

async function noNodeInstallation(root) {
  for (const name of ['package.json', 'package-lock.json', 'node_modules']) {
    await assert.rejects(access(join(root, name)), error => error.code === 'ENOENT');
  }
}

for (const correct of [true, false]) {
  test(`Python-only host work ${correct ? 'verifies the accepted commit and awaits human approval' : 'records failed Python evidence and prevents final approval'}`, async t => {
    const f = await pythonHost(t);
    if (!f) return;
    await noNodeInstallation(f.root);
    await noNodeInstallation(f.payload.worktree.path);
    await writeFile(join(f.payload.worktree.path, 'calculator.py'), `def add(left, right):\n    return ${correct ? 'left + right' : 'left - right'}\n`);
    const submitted = await f.execution.submitResult({
      project: f.root, runId: f.approved.runId, expectedRuntimeVersion: f.next.runtimeVersion, action: f.next.action,
      result: { version: 1, status: 'success', output: { summary: 'Updated Python implementation.', evidence: f.payload.evidence }, usage: { tokens: 0, costUsd: 0 } },
    });
    assert.equal(submitted.status, 'accepted');
    const verify = () => f.execution.verify({ project: f.root, runId: f.approved.runId,
      expectedRunVersion: f.prepared.run.version, expectedRuntimeVersion: submitted.runtimeVersion });
    if (correct) {
      const result = await verify();
      assert.equal(result.status, 'awaiting-final-approval');
      assert.ok(result.evidenceRefs.includes('test:python-tests'));
    } else {
      await assert.rejects(verify(), error => error.code === 'ERR_HOST_EXECUTION_VERIFICATION_FAILED');
    }
    const status = await f.execution.status({ project: f.root, runId: f.approved.runId });
    assert.equal(status.verification.status, correct ? 'pass' : 'fail');
    assert.equal(status.verification.checks.length, 1);
    const check = status.verification.checks[0];
    assert.equal(check.id, 'python-tests');
    assert.equal(check.exitCode, correct ? 0 : 1);
    assert.match(check.output.stderr, /Ran 1 test/);
    assert.match(check.output.stderr, correct ? /OK/ : /FAILED \(failures=1\)/);
    assert.deepEqual(status.verification.changedPaths, ['calculator.py']);
    assert.equal(status.run.status, correct ? 'awaiting-final-approval' : 'running');
    assert.equal(status.deliveryReady, correct);
    assert.notEqual(status.runtime.nodes.find(node => node.id === 'final-delivery').status, 'completed');
    assert.equal(status.verification.commitSha, status.checkout.acceptedCommit);
    assert.notEqual(status.checkout.acceptedCommit, f.approved.featurePlan.baselineCommit);
    assert.equal((await f.gitClient.inspectRepository(status.checkout.path)).dirty, false);
    assert.deepEqual(f.resolved, ['python3']);
    assert.equal(await readFile(join(f.root, 'calculator.py'), 'utf8'), 'def add(left, right):\n    return 0\n');
    await noNodeInstallation(status.checkout.path);
    await assert.rejects(access(f.marker), error => error.code === 'ENOENT');
  });
}
