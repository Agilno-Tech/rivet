import {managedPolicy} from '../fixtures/execution-policy.js';
import {bodyDigest} from '../../src/protocols/project.js';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import YAML from 'yaml';
import { createWorkAction, validateWorkAction } from '../../src/feature/actions.js';
import { main } from '../../src/cli/main.js';
import { EXIT_CODES } from '../../src/cli/output.js';
import { createHostExecution } from '../../src/feature/host-execution.js';
import { createFeatureWorkflow } from '../../src/feature/workflow.js';
import { createGitClient } from '../../src/git/client.js';
import { createReservationStore } from '../../src/git/reservations.js';
import { createReservedWorktree } from '../../src/git/worktrees.js';
import { resolveFeatureRunPaths, resolveStatePaths } from '../../src/state/paths.js';
import { acquireLock } from '../../src/state/lock.js';
import { verificationReportPaths } from '../../src/state/paths.js';
import { createVerificationReportStore } from '../../src/feature/verification-report.js';
import { execFile, CONFIG, NOW, PROTOCOL_BODY, PROTOCOL_METADATA, PROTOCOL_REF, git, npmExecutable, fixture, resultFor, completedWorker, waitForFile, directoryBytes, abandonedHostLock, managedWorker, readyBatchGroup } from './host-execution-fixture.js';

test('prepare and nextAction durably hand one Worker to the host without a model client', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient, now: () => NOW });

  const prepared = await execution.prepare({
    project: root,
    runId: approved.runId,
    expectedRunVersion: approved.version,
  });
  assert.equal(prepared.status, 'ready');
  assert.equal(prepared.run.status, 'running');
  assert.equal(prepared.runtimeVersion, 1);

  const next = await execution.nextAction({
    project: root,
    runId: approved.runId,
    expectedRuntimeVersion: prepared.runtimeVersion,
  });
  assert.equal(next.status, 'action');
  assert.equal(next.action.runId, approved.runId);
  assert.equal(next.action.runtimeVersion, next.runtimeVersion);
  assert.equal(next.action.nodeId, 'add-the-agenda-implementation');
  const payload = JSON.parse(next.action.payload);
  assert.equal(payload.kind, 'agilno.agent-launch');
  assert.equal(payload.contract.nodeId, next.action.nodeId);
  assert.equal(payload.contract.worktree.reservationId, next.action.reservationId);
  assert.deepEqual(payload.contract.contextRefs.filter(ref => ref.startsWith('protocol:')), [PROTOCOL_REF]);
  assert.deepEqual(validateWorkAction(next.action), next.action);
  assert.throws(() => createWorkAction({ ...next.action, unexpected: true }));

  const observed = await execution.status({ project: root, runId: approved.runId });
  assert.equal(observed.runtime.version, next.runtimeVersion);
  assert.equal(observed.runtime.nodes.find(node => node.id === next.action.nodeId).status, 'running');

  const restarted = createHostExecution({ gitClient, now: () => NOW });
  const afterRestart = await restarted.nextAction({
    project: root,
    runId: approved.runId,
    expectedRuntimeVersion: next.runtimeVersion,
  });
  assert.equal(afterRestart.status, 'waiting-for-result');
  assert.equal(afterRestart.action.intentId, next.action.intentId);
  assert.equal(afterRestart.action.payload, next.action.payload);
});

test('task deps installs in the active host Worker before handoff', async t => {
  const { root, gitClient, approved } = await fixture(t, { lockedDependencies: true });
  const execution = createHostExecution({ gitClient, now: () => NOW });
  const prepared = await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  const next = await execution.nextAction({
    project: root, runId: approved.runId, expectedRuntimeVersion: prepared.runtimeVersion,
  });
  const worktree = JSON.parse(next.action.payload).contract.worktree.path;
  const installer = join(dirname(root), 'install-fixture');
  await writeFile(installer, '#!/bin/sh\nmkdir -p node_modules\nprintf ready > node_modules/installed\n', { mode: 0o700 });
  const messages = [];
  const { stdout: gitPath } = await execFile('which', ['git']);
  const code = await main(['task', 'deps'], {
    cwd: () => root, terminalIsInteractive: () => true,
    output: { log: value => messages.push(value), error: value => messages.push(value), json() {} },
    work: execution,
    resolveCommandExecutable: async name => name === 'git' ? await realpath(gitPath.trim()) : installer,
    confirmDependencyInstall: async plan => plan.worktreePath === worktree,
  });
  assert.equal(code, EXIT_CODES.SUCCESS, messages.join('\n'));
  assert.equal(await readFile(join(worktree, 'node_modules/installed'), 'utf8'), 'ready');
  assert.match(messages.join('\n'), /Continue in the owning harness/);
});

test('submitResult integrates an exact restarted host action and verify stops at final human approval', async t => {
  const now = new Date().toISOString();
  const { root, gitClient, approved, gate } = await fixture(t, { now, repositoryRemote: {name:'origin',url:'https://github.com/team/demo'} });
  const execution = createHostExecution({
    gitClient,
    now: () => now,
    resolveCommandExecutable: async () => gate,
    environment: {},
  });
  const prepared = await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  const next = await execution.nextAction({
    project: root, runId: approved.runId, expectedRuntimeVersion: prepared.runtimeVersion,
  });
  const contract = JSON.parse(next.action.payload).contract;
  await mkdir(join(contract.worktree.path, 'app'), { recursive: true });
  await writeFile(join(contract.worktree.path, 'app', 'agenda.js'), 'export const agenda = true;\n');

  const restarted = createHostExecution({
    gitClient,
    now: () => now,
    resolveCommandExecutable: async () => gate,
    environment: {},
  });
  const submitted = await restarted.submitResult({
    project: root,
    runId: approved.runId,
    expectedRuntimeVersion: next.runtimeVersion,
    action: next.action,
    result: resultFor(next.action),
  });
  assert.equal(submitted.status, 'accepted');
  assert.equal(submitted.nodeStatus, 'completed');

  const verified = await restarted.verify({
    project: root,
    runId: approved.runId,
    expectedRunVersion: prepared.run.version,
    expectedRuntimeVersion: submitted.runtimeVersion,
  });
  assert.equal(verified.status, 'awaiting-final-approval');
  assert.ok(verified.evidenceRefs.some(ref => /^commit:[a-f0-9]{40}$/.test(ref)));
  assert.deepEqual(verified.evidenceRefs.filter(ref => ref.startsWith('test:')).sort(), ['test:build', 'test:lint', 'test:test']);
  const observed = await restarted.status({ project: root, runId: approved.runId });
  assert.equal(observed.run.status, 'awaiting-final-approval');
  assert.equal(observed.runtime.nodes.find(node => node.id === 'final-delivery').status, 'ready');
  assert.equal(observed.deliveryReady, true);
  const delivery = await import('../../src/delivery/prepare.js');
  await git(root, 'remote', 'add', 'origin', 'https://github.com/team/demo.git');
  await git(root, 'remote', 'add', 'alternate', 'https://github.com/team/alternate.git');
  const candidate = await delivery.loadDeliveryCandidate({ project: root, runId: approved.runId, gitClient });
  assert.equal(candidate.localVerification.headSha, observed.checkout.acceptedCommit);
  assert.equal(candidate.repository.fullName, 'team/demo');
  const override = await delivery.loadDeliveryCandidate({ project: root, runId: approved.runId, gitClient, remoteName:'alternate' });
  assert.equal(override.repository.fullName, 'team/alternate');
  await git(root, 'remote', 'set-url', 'origin', 'https://github.com/team/substituted.git');
  await assert.rejects(delivery.loadDeliveryCandidate({ project: root, runId: approved.runId, gitClient }));
  await git(root, 'remote', 'set-url', 'origin', 'https://github.com/team/demo.git');
  assert.match(candidate.localVerification.evidenceDigest, /^[a-f0-9]{64}$/);
  assert.equal(candidate.targetBranch, 'main');
  let deliveryOutput;
  const deliveryDeps = {
    cwd: () => root,
    env: {},
    output: { json: value => { deliveryOutput = value; }, error() {}, log() {} },
  };
  assert.equal(await main(['delivery', 'prepare', `--run=${approved.runId}`, '--json'], deliveryDeps), 0);
  assert.equal(deliveryOutput.result.stage, 'locally-verified');
  assert.equal(await main(['delivery', 'status', '--json'], deliveryDeps), 0);
  assert.equal(deliveryOutput.result.candidate.localVerification.headSha, candidate.localVerification.headSha);
  const deliveryVersion = deliveryOutput.result.version;
  assert.equal(await main(['delivery', 'prepare', '--json'], { ...deliveryDeps, cwd: () => join(root, '.rivet') }), 0);
  assert.equal(deliveryOutput.result.version, deliveryVersion);
  assert.equal(await main(['delivery', 'recover', '--json'], deliveryDeps), 0);
  assert.deepEqual(deliveryOutput.recovery.recoveredLocks, []);
  assert.equal(await main(['delivery', 'status', '--json'], deliveryDeps), 0);
  assert.equal(deliveryOutput.result.version, deliveryVersion);
  const originalReadme = await readFile(join(root, 'README.md'), 'utf8');
  await writeFile(join(root, 'README.md'), 'source drift');
  await assert.rejects(() => delivery.loadDeliveryCandidate({ project: root, runId: approved.runId, gitClient }), /verified|verification/i);
  await writeFile(join(root, 'README.md'), originalReadme);
  await writeFile(join(observed.checkout.path, 'unverified.txt'), 'unverified');
  await assert.rejects(() => delivery.loadDeliveryCandidate({ project: root, runId: approved.runId, gitClient }), /verified|verification/i);
});

test('schema-v2 host verification runs each exact child package and still stops at final approval', async t => {
  const { root, gitClient, approved } = await fixture(t, { schemaV2: true });
  const npm = await npmExecutable();
  const execution = createHostExecution({
    gitClient,
    now: () => NOW,
    resolveCommandExecutable: async runner => {
      assert.equal(runner, 'npm');
      return npm;
    },
    environment: { PATH: process.env.PATH },
  });
  const prepared = await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  const next = await execution.nextAction({
    project: root, runId: approved.runId, expectedRuntimeVersion: prepared.runtimeVersion,
  });
  const contract = JSON.parse(next.action.payload).contract;
  await mkdir(join(contract.worktree.path, 'app'), { recursive: true });
  await writeFile(join(contract.worktree.path, 'app', 'agenda.js'), 'export const agenda = true;\n');
  const submitted = await execution.submitResult({
    project: root,
    runId: approved.runId,
    expectedRuntimeVersion: next.runtimeVersion,
    action: next.action,
    result: resultFor(next.action),
  });

  const verified = await execution.verify({
    project: root,
    runId: approved.runId,
    expectedRunVersion: prepared.run.version,
    expectedRuntimeVersion: submitted.runtimeVersion,
  });

  assert.equal(verified.status, 'awaiting-final-approval');
  assert.deepEqual(verified.evidenceRefs.filter(ref => ref.startsWith('test:')).sort(), [
    'test:build-1', 'test:build-2', 'test:test',
  ]);
  const observed = await execution.status({ project: root, runId: approved.runId });
  assert.equal(observed.runtime.nodes.find(node => node.id === 'final-delivery').status, 'ready');
});

test('host verification rejects deleted and symlinked child manifests before execution', async t => {
  for (const replacement of ['deleted', 'symlink']) {
    await t.test(replacement, async t2 => {
      const { root, gitClient, approved } = await fixture(t2, {
        schemaV2: true,
        ownedPaths: ['backend/package.json'],
      });
      const npm = await npmExecutable();
      const execution = createHostExecution({
        gitClient,
        now: () => NOW,
        resolveCommandExecutable: async () => npm,
        environment: { PATH: process.env.PATH },
      });
      const prepared = await execution.prepare({
        project: root, runId: approved.runId, expectedRunVersion: approved.version,
      });
      const next = await execution.nextAction({
        project: root, runId: approved.runId, expectedRuntimeVersion: prepared.runtimeVersion,
      });
      const worktree = JSON.parse(next.action.payload).contract.worktree.path;
      await rm(join(worktree, 'backend', 'package.json'));
      if (replacement === 'symlink') {
        await symlink('../frontend/package.json', join(worktree, 'backend', 'package.json'));
      }
      const submitted = await execution.submitResult({
        project: root,
        runId: approved.runId,
        expectedRuntimeVersion: next.runtimeVersion,
        action: next.action,
        result: resultFor(next.action),
      });

      await assert.rejects(() => execution.verify({
        project: root,
        runId: approved.runId,
        expectedRunVersion: prepared.run.version,
        expectedRuntimeVersion: submitted.runtimeVersion,
      }), error => error.code === 'ERR_HOST_EXECUTION_VERIFICATION_FAILED');
      const observed = await execution.status({ project: root, runId: approved.runId });
      assert.equal(observed.run.status, 'running');
      assert.equal(observed.verification.status, 'fail');
      assert.match(observed.verification.failure, /quality gate/i);
      assert.deepEqual(observed.verification.checks, []);
      const integration = (await gitClient.listWorktrees(root))
        .find(item => item.branch.includes(approved.runId));
      await assert.rejects(() => access(join(integration.path, 'fallback-ran')));
    });
  }
});

test('submitResult rejects stale actions and blocks mismatched evidence before integration', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient, now: () => NOW });
  const prepared = await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  await assert.rejects(() => execution.verify({
    project: root,
    runId: approved.runId,
    expectedRunVersion: prepared.run.version,
    expectedRuntimeVersion: prepared.runtimeVersion,
  }), error => error.code === 'ERR_HOST_EXECUTION_STATE_CONFLICT');
  const next = await execution.nextAction({
    project: root, runId: approved.runId, expectedRuntimeVersion: prepared.runtimeVersion,
  });
  const contract = JSON.parse(next.action.payload).contract;
  await mkdir(join(contract.worktree.path, 'app'), { recursive: true });
  await writeFile(join(contract.worktree.path, 'app', 'agenda.js'), 'export const agenda = true;\n');
  await assert.rejects(() => execution.submitResult({
    project: root,
    runId: approved.runId,
    expectedRuntimeVersion: next.runtimeVersion - 1,
    action: next.action,
    result: resultFor(next.action),
  }), error => error.code === 'ERR_HOST_EXECUTION_STATE_CONFLICT');

  const alteredPayload = JSON.parse(next.action.payload);
  alteredPayload.contract.objective = 'Widened host objective that was never persisted.';
  const alteredAction = { ...next.action, payload: JSON.stringify(alteredPayload) };
  await assert.rejects(() => execution.submitResult({
    project: root,
    runId: approved.runId,
    expectedRuntimeVersion: next.runtimeVersion,
    action: alteredAction,
    result: resultFor(next.action),
  }), error => error.code === 'ERR_HOST_EXECUTION_STATE_CONFLICT');

  const integrationBefore = (await gitClient.listWorktrees(root))
    .find(item => item.branch.includes(approved.runId)).head;
  const blocked = await execution.submitResult({
    project: root,
    runId: approved.runId,
    expectedRuntimeVersion: next.runtimeVersion,
    action: next.action,
    result: resultFor(next.action, {
      output: { summary: 'Claimed success with wrong evidence.', evidence: ['wrong-evidence'] },
    }),
  });
  assert.equal(blocked.status, 'blocked');
  const observed = await execution.status({ project: root, runId: approved.runId });
  assert.equal(observed.run.status, 'blocked');
  assert.equal(observed.runtime.graphStatus, 'blocked');
  assert.ok(observed.blockedNodes.includes(next.action.nodeId));
  assert.match(observed.nextAction, /new reviewed proposal/);
  const integrationAfter = (await gitClient.listWorktrees(root))
    .find(item => item.branch.includes(approved.runId)).head;
  assert.equal(integrationAfter, integrationBefore);
  await assert.rejects(() => execution.submitResult({
    project: root,
    runId: approved.runId,
    expectedRuntimeVersion: blocked.runtimeVersion,
    action: next.action,
    result: resultFor(next.action),
  }));
});

test('submitResult blocks out-of-scope host edits without moving the integration branch', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient, now: () => NOW });
  const prepared = await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  const next = await execution.nextAction({
    project: root, runId: approved.runId, expectedRuntimeVersion: prepared.runtimeVersion,
  });
  const contract = JSON.parse(next.action.payload).contract;
  await mkdir(join(contract.worktree.path, 'app'), { recursive: true });
  await writeFile(join(contract.worktree.path, 'app', 'agenda.js'), 'export const agenda = true;\n');
  await writeFile(join(contract.worktree.path, 'README.md'), '# Unauthorized host edit\n');
  const integrationBefore = (await gitClient.listWorktrees(root))
    .find(item => item.branch.includes(approved.runId)).head;

  const blocked = await execution.submitResult({
    project: root,
    runId: approved.runId,
    expectedRuntimeVersion: next.runtimeVersion,
    action: next.action,
    result: resultFor(next.action),
  });

  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reconciliation.reason, 'worker-uncommitted-changes');
  const integrationAfter = (await gitClient.listWorktrees(root))
    .find(item => item.branch.includes(approved.runId)).head;
  assert.equal(integrationAfter, integrationBefore);
});

test('prepare leaves an approved run retryable after a temporary repository conflict', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient, now: () => NOW });
  await writeFile(join(root, 'temporary.txt'), 'temporary\n');
  await assert.rejects(() => execution.prepare({
    project: root, runId: approved.runId, expectedRunVersion: approved.version,
  }), error => error.code === 'ERR_HOST_EXECUTION_REPOSITORY');
  const unchanged = await execution.status({ project: root, runId: approved.runId });
  assert.equal(unchanged.run.status, 'approved');
  assert.equal(unchanged.run.version, approved.version);
  await rm(join(root, 'temporary.txt'));
  const prepared = await execution.prepare({
    project: root, runId: approved.runId, expectedRunVersion: approved.version,
  });
  const resumed = await execution.prepare({
    project: root, runId: approved.runId, expectedRunVersion: prepared.run.version,
  });
  assert.equal(resumed.status, 'ready');
  assert.equal(resumed.runtimeVersion, prepared.runtimeVersion);
});

test('nextAction reuses an active worker checkout left by an interrupted preparation', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient, now: () => NOW });
  const prepared = await execution.prepare({
    project: root, runId: approved.runId, expectedRunVersion: approved.version,
  });
  const integration = (await gitClient.listWorktrees(root))
    .find(item => item.branch.includes(approved.runId));
  assert.ok(integration);
  const nodeId = 'add-the-agenda-implementation';
  const observed = await execution.status({ project: root, runId: approved.runId });
  const node = observed.runtime.nodes.find(item => item.id === nodeId);
  const statePaths = await resolveStatePaths(root, approved.runId);
  await createReservedWorktree({
    projectRoot: integration.path,
    statePaths,
    nodeId,
    branch: `worker/${approved.runId}/${nodeId}`,
    worktreePath: join(dirname(integration.path), 'workers', nodeId),
    ownerId: node.owner.id,
    baseSha: integration.head,
    responsibilities: ['app/agenda.js'],
    intendedPaths: ['app/agenda.js'],
    expiresAt: new Date(Date.parse(NOW) + 24 * 60 * 60 * 1000).toISOString(),
  }, { gitClient, nowMs: Date.parse(NOW) });

  const next = await execution.nextAction({
    project: root, runId: approved.runId, expectedRuntimeVersion: prepared.runtimeVersion,
  });
  assert.equal(next.status, 'action');
  assert.equal(JSON.parse(next.action.payload).contract.worktree.path, join(dirname(integration.path), 'workers', nodeId));
});

test('verification rejects committed and dirty source drift beyond the reconciled worker commit', async t => {
  const { root, approved, gate, execution, verifyInput } = await completedWorker(t);
  await writeFile(gate, '#!/bin/sh\nexit 1\n');
  await assert.rejects(() => execution.verify(verifyInput),
    error => error.code === 'ERR_HOST_EXECUTION_VERIFICATION_FAILED');
  const failed = await execution.status({ project: root, runId: approved.runId });
  assert.equal(failed.verification.status, 'fail');
  assert.equal(failed.checkout.status, 'clean');
  const acceptedCommit = failed.checkout.acceptedCommit;
  const integration = failed.checkout.path;
  await writeFile(join(integration, 'UNAPPROVED.txt'), 'outside the reviewed scope\n');
  await git(integration, 'add', 'UNAPPROVED.txt');
  await git(integration, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--quiet', '-m', 'unapproved');
  await writeFile(gate, '#!/bin/sh\nexit 0\n');
  await assert.rejects(() => execution.verify(verifyInput),
    error => error.code === 'ERR_HOST_EXECUTION_REPOSITORY');
  const stale = await execution.status({ project: root, runId: approved.runId });
  assert.equal(stale.checkout.status, 'stale');
  assert.equal(stale.checkout.acceptedCommit, acceptedCommit);
  assert.notEqual(stale.checkout.observedCommit, acceptedCommit);
  assert.equal(stale.run.status, 'running');
  assert.equal(stale.verification.commitSha, acceptedCommit);
  assert.match(stale.nextAction, /Do not deliver/);
  await writeFile(join(integration, 'UNAPPROVED.txt'), 'dirty after commit\n');
  const dirty = await execution.status({ project: root, runId: approved.runId });
  assert.equal(dirty.checkout.status, 'stale');
  assert.equal(dirty.checkout.dirty, true);
  assert.match(dirty.nextAction, /Do not deliver/);
});

test('verification rejects source changes made while configured gates run', async t => {
  const { root, approved, gate, execution, verifyInput } = await completedWorker(t);
  const before = await execution.status({ project: root, runId: approved.runId });
  const integration = before.checkout.path;
  const marker = join(dirname(root), 'gate-started');
  const release = `${marker}-release`;
  await writeFile(gate, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    `const marker = ${JSON.stringify(marker)};`,
    `const release = ${JSON.stringify(release)};`,
    "if (!fs.existsSync(marker)) { fs.writeFileSync(marker, 'started'); setInterval(() => { if (fs.existsSync(release)) process.exit(0); }, 20); setTimeout(() => process.exit(1), 30000); }",
    'else process.exit(0);',
    '',
  ].join('\n'));
  const verification = execution.verify(verifyInput);
  const rejected = assert.rejects(verification, error => error.code === 'ERR_HOST_EXECUTION_REPOSITORY');
  rejected.catch(() => {});
  try {
    await waitForFile(marker);
    await writeFile(join(integration, 'UNAPPROVED.txt'), 'changed during checks\n');
    await git(integration, 'add', 'UNAPPROVED.txt');
    await git(integration, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--quiet', '-m', 'mid-gate drift');
  } finally { await writeFile(release, 'release'); await rejected; }
  const observed = await execution.status({ project: root, runId: approved.runId });
  assert.equal(observed.run.status, 'running');
  assert.equal(observed.verification, null);
  assert.equal(observed.checkout.status, 'stale');
  assert.match(observed.nextAction, /Do not deliver/);
});

test('status rejects corrupt and symlinked private reports without preparing a checkout', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient, now: () => NOW });
  const paths = await resolveFeatureRunPaths(root, approved.runId);
  const reportPath = join(paths.runDir, 'verification.json');
  const unprepared = await execution.status({ project: root, runId: approved.runId });
  assert.equal(unprepared.runtime, null);
  assert.equal(unprepared.verification, null);
  await assert.rejects(() => access(join(dirname(root), '.rivet-worktrees')));
  await writeFile(reportPath, '{corrupt\n', { mode: 0o600 });
  await assert.rejects(() => execution.status({ project: root, runId: approved.runId }),
    /Invalid state snapshot/);
  await rm(reportPath);
  const outside = join(dirname(root), 'outside-report');
  await writeFile(outside, 'private outside content\n');
  await symlink(outside, reportPath);
  await assert.rejects(() => execution.status({ project: root, runId: approved.runId }),
    /Unsafe state snapshot/);
  await assert.rejects(() => access(join(dirname(root), '.rivet-worktrees')));
});

test('missing accepted commit identity fails closed after a completed worker', async t => {
  const { root, approved, execution, verifyInput } = await completedWorker(t);
  const paths = await resolveFeatureRunPaths(root, approved.runId);
  await rm(join(paths.runDir, 'accepted-integration.json'));
  await assert.rejects(() => execution.verify(verifyInput),
    error => error.code === 'ERR_HOST_EXECUTION_REPOSITORY');
  const observed = await execution.status({ project: root, runId: approved.runId });
  assert.equal(observed.run.status, 'running');
  assert.equal(observed.checkout, null);
  assert.match(observed.nextAction, /identity is missing/);
});

test('an idle work next after submission preserves the accepted commit for verification', async t => {
  const { root, approved, execution, verifyInput } = await completedWorker(t);
  const next = await execution.nextAction({
    project: root,
    runId: approved.runId,
    expectedRuntimeVersion: verifyInput.expectedRuntimeVersion,
  });
  assert.equal(next.status, 'idle');
  assert.ok(next.runtimeVersion >= verifyInput.expectedRuntimeVersion);
  const verified = await execution.verify({
    ...verifyInput,
    expectedRuntimeVersion: next.runtimeVersion,
  });
  assert.equal(verified.status, 'awaiting-final-approval');
});

test('final approval status requires its private report and accepted commit identity', async t => {
  const { root, approved, execution, verifyInput } = await completedWorker(t);
  await execution.verify(verifyInput);
  const paths = await resolveFeatureRunPaths(root, approved.runId);
  const acceptedPath = join(paths.runDir, 'accepted-integration.json');
  const reportPath = join(paths.runDir, 'verification.json');
  const acceptedBytes = await readFile(acceptedPath);
  const reportBytes = await readFile(reportPath);
  for (const missing of [[reportPath], [acceptedPath], [reportPath, acceptedPath]]) {
    for (const path of missing) await rm(path);
    const observed = await execution.status({ project: root, runId: approved.runId });
    assert.equal(observed.run.status, 'awaiting-final-approval');
    assert.match(observed.nextAction, /Do not deliver/);
    await writeFile(acceptedPath, acceptedBytes, { mode: 0o600 });
    await writeFile(reportPath, reportBytes, { mode: 0o600 });
  }
  const reports = createVerificationReportStore(await verificationReportPaths(paths));
  const current = await reports.readOnly();
  await reports.write({ ...current, commitSha: 'a'.repeat(40) });
  const mismatched = await execution.status({ project: root, runId: approved.runId });
  assert.match(mismatched.nextAction, /Do not deliver/);
});

test('verification holds the host lock through final run publication', async t => {
  const { root, approved, gate, execution, verifyInput } = await completedWorker(t);
  const marker = join(dirname(root), 'publication-gate-started');
  const release = `${marker}-release`;
  await writeFile(gate, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    `const marker = ${JSON.stringify(marker)};`,
    `const release = ${JSON.stringify(release)};`,
    "if (!fs.existsSync(marker)) { fs.writeFileSync(marker, 'started'); setInterval(() => { if (fs.existsSync(release)) process.exit(0); }, 20); setTimeout(() => process.exit(1), 30000); }",
    'else process.exit(0);',
    '',
  ].join('\n'));
  let settled = false;
  const verifying = execution.verify(verifyInput).finally(() => { settled = true; });
  verifying.catch(() => {});
  let stateLock;
  try {
    await waitForFile(marker);
    const paths = await resolveFeatureRunPaths(root, approved.runId);
    stateLock = await acquireLock(paths.lockPath);
    await writeFile(release, 'release');
    await waitForFile(join(paths.runDir, 'verification.json'));
    assert.equal(settled, false);
    const observed = await execution.status({ project: root, runId: approved.runId });
    assert.equal(observed.run.status, 'running');
    await assert.rejects(() => acquireLock(join(paths.runDir, 'host-operation.lock')),
      error => error.code === 'ERR_STATE_LOCKED');
  } finally { await writeFile(release, 'release'); await stateLock?.release(); await verifying; }
  const verified = await verifying;
  assert.equal(verified.status, 'awaiting-final-approval');
});

test('concurrent failed verify and host cancellation cannot overwrite a passing final report', async t => {
  const { root, approved, gate, gitClient, workflow, execution, verifyInput } = await completedWorker(t);
  const marker = join(dirname(root), 'slow-gate-started');
  await writeFile(gate, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    `const marker = ${JSON.stringify(marker)};`,
    "if (!fs.existsSync(marker)) { fs.writeFileSync(marker, 'started'); setTimeout(() => process.exit(0), 4000); }",
    'else process.exit(0);',
    '',
  ].join('\n'));
  const failingGate = join(dirname(root), 'failing-gate');
  await writeFile(failingGate, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  await chmod(failingGate, 0o700);
  const failing = createHostExecution({
    gitClient, now: () => NOW,
    resolveCommandExecutable: async () => failingGate,
    environment: { PATH: process.env.PATH },
  });
  const passingAttempt = execution.verify(verifyInput);
  await waitForFile(marker);
  const outcomes = await Promise.allSettled([
    failing.verify(verifyInput),
    workflow.cancel({ project: root, runId: approved.runId, expectedVersion: verifyInput.expectedRunVersion }),
    execution.nextAction({
      project: root, runId: approved.runId, expectedRuntimeVersion: verifyInput.expectedRuntimeVersion,
    }),
  ]);
  assert.deepEqual(outcomes.map(item => item.status), ['rejected', 'rejected', 'rejected']);
  assert.ok(outcomes.every(item => item.reason.code === 'ERR_HOST_RUN_BUSY'));
  const passed = await passingAttempt;
  assert.equal(passed.status, 'awaiting-final-approval');
  const observed = await execution.status({ project: root, runId: approved.runId });
  assert.equal(observed.run.status, 'awaiting-final-approval');
  assert.equal(observed.verification.status, 'pass');
  assert.equal(observed.checkout.status, 'clean');
  assert.match(observed.nextAction, /final delivery decision/);
});
