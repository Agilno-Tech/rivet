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
import { acceptedIntegrationPaths, resolveFeatureRunPaths, resolveStatePaths } from '../../src/state/paths.js';
import { acquireLock } from '../../src/state/lock.js';
import { verificationReportPaths } from '../../src/state/paths.js';
import { createVerificationReportStore } from '../../src/feature/verification-report.js';
import { execFile, CONFIG, NOW, PROTOCOL_BODY, PROTOCOL_METADATA, PROTOCOL_REF, git, npmExecutable, fixture, resultFor, completedWorker, waitForFile, directoryBytes, abandonedHostLock, managedWorker, readyBatchGroup } from './host-execution-fixture.js';

test('host-observed tracker context survives activation, isolated work and verification', async t => {
  const { root, execution, verifyInput } = await completedWorker(t, {hostContext:true});
  const result = await execution.verify(verifyInput);
  const status = await execution.status({project:root,runId:verifyInput.runId});
  assert.equal(status.run.status,'awaiting-final-approval');
  assert.equal(status.run.workRequest.source.kind,'host-observation');
  assert.equal(status.run.workRequest.context.sources[0].assurance,'harness-observed');
  assert.ok(status.run.workRequest.contextRefs.includes(PROTOCOL_REF));
  assert.equal(await git(root,'status','--porcelain'),'');
});

test('status advises review rather than restarting a completed Worker', async t => {
  const { root, execution, verifyInput } = await completedWorker(t);
  const status = await execution.status({ project: root, runId: verifyInput.runId });
  assert.equal(status.workerCheckouts[0].nodeStatus, 'completed');
  assert.match(status.workerCheckouts[0].nextAction, /do not restart/i);
  await git(root, 'worktree', 'remove', status.workerCheckouts[0].path);
  const absent = await execution.status({ project: root, runId: verifyInput.runId });
  assert.equal(absent.workerCheckouts[0].status, 'missing');
  assert.match(absent.workerCheckouts[0].nextAction, /cleanup history/i);
  assert.match(absent.workerCheckouts[0].nextAction, /do not restart/i);
  const paths = await acceptedIntegrationPaths(await resolveFeatureRunPaths(root, verifyInput.runId));
  await rm(paths.snapshotPath);
  const missing = await execution.status({project: root, runId: verifyInput.runId});
  assert.match(missing.nextAction, /Accepted integration identity is missing/);
  assert.equal(missing.deliveryReady, false);
});

test('status exposes active Worker edits without changing private state or taking its lock', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient, now: () => NOW });
  const prepared = await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  const next = await execution.nextAction({ project: root, runId: approved.runId, expectedRuntimeVersion: prepared.runtimeVersion });
  const path = JSON.parse(next.action.payload).contract.worktree.path;
  const statePaths = await resolveStatePaths(root, approved.runId);
  const reservationFile = join(statePaths.instanceDir, 'worktree-reservations.json');
  const before = await readFile(reservationFile);
  const lock = await acquireLock(statePaths.lockPath);
  const privateBefore = await directoryBytes(statePaths.instanceDir);
  const workerIndex = await git(path, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
  const indexBefore = await readFile(workerIndex);
  try {
    const clean = await execution.status({ project: root, runId: approved.runId });
    assert.equal(clean.checkout, null);
    assert.match(clean.nextAction, /work next/);
    assert.doesNotMatch(clean.nextAction, /integration identity is missing/);
    assert.equal(clean.workerCheckouts[0].status, 'clean');
    assert.equal(clean.workerCheckouts[0].path, path);
    await mkdir(join(path, 'app'), { recursive: true });
    await writeFile(join(path, 'app/agenda.js'), 'preserve this interrupted work\n');
    const dirty = await execution.status({ project: root, runId: approved.runId });
    assert.equal(dirty.workerCheckouts[0].status, 'dirty');
    assert.deepEqual(dirty.workerCheckouts[0].dirtyPaths, ['app/agenda.js']);
    assert.match(dirty.workerCheckouts[0].nextAction, /inspect/i);
    assert.equal(await readFile(join(path, 'app/agenda.js'), 'utf8'), 'preserve this interrupted work\n');
    assert.deepEqual(await readFile(reservationFile), before);
    assert.equal(dirty.deliveryReady, false);
    assert.deepEqual(await directoryBytes(statePaths.instanceDir), privateBefore);
    assert.deepEqual(await readFile(workerIndex), indexBefore);
  } finally { await lock.release(); }
});

test('status reports interrupted reserved, expired, moved, wrong-branch and missing Workers without recovery', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient, now: () => NOW });
  await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  const statePaths = await resolveStatePaths(root, approved.runId);
  const current = await execution.status({ project: root, runId: approved.runId });
  const node = current.runtime.nodes.find(item => item.owner.role === 'worker');
  const repository = await gitClient.inspectRepository(root);
  const integration = (await gitClient.listWorktrees(root)).find(item => item.branch.includes(approved.runId));
  const path = join(dirname(integration.path), 'workers', node.id);
  const branch = `worker/${approved.runId}/${node.id}`;
  const expiresAt = new Date(Date.parse(NOW) + 1000).toISOString();
  await createReservationStore(statePaths).reserve({ nodeId: node.id, ownerId: node.owner.id,
    repositoryId: repository.repositoryId, branch, worktreePath: path, baseSha: repository.headSha,
    responsibilities: ['app/agenda.js'], intendedPaths: ['app/agenda.js'], expiresAt,
  }, { expectedVersion: 0, nowMs: Date.parse(NOW) });
  const read = async () => (await execution.status({ project: root, runId: approved.runId })).workerCheckouts[0];
  assert.equal((await read()).status, 'missing');
  await mkdir(dirname(path), { recursive: true });
  await git(root, 'worktree', 'add', '-q', '-b', branch, path);
  assert.equal((await read()).status, 'clean');
  assert.equal((await read()).reservationStatus, 'reserved');
  assert.match((await read()).nextAction, /interrupted/);
  const expired = createHostExecution({ gitClient, now: () => expiresAt });
  assert.equal((await expired.status({ project: root, runId: approved.runId })).workerCheckouts[0].leaseExpired, true);
  await git(path, 'checkout', '-q', '-b', 'other-worker-branch');
  assert.equal((await read()).status, 'mismatched');
  assert.equal((await read()).observedBranch, 'other-worker-branch');
  const other = join(dirname(path), 'other-location');
  await git(root, 'worktree', 'add', '-q', other, branch);
  assert.deepEqual((await read()).branchLocations, [other]);
  await rm(path, { recursive: true, force: true });
  assert.equal((await read()).status, 'missing');
});

test('Worker status fails closed on unsafe reservation associations and symlinked state', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient, now: () => NOW });
  const prepared = await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  await execution.nextAction({ project: root, runId: approved.runId, expectedRuntimeVersion: prepared.runtimeVersion });
  const paths = await resolveStatePaths(root, approved.runId);
  const file = join(paths.instanceDir, 'worktree-reservations.json');
  const original = await readFile(file, 'utf8');
  for (const patch of [{ worktreePath: root }, { ownerId: 'another-worker' }, { repositoryId: 'different-repository' }, { nodeId: 'unknown-node' }]) {
    const state = JSON.parse(original);
    Object.assign(state.reservations[0], patch);
    await writeFile(file, `${JSON.stringify(state)}\n`);
    await assert.rejects(execution.status({ project: root, runId: approved.runId }), { code: 'ERR_HOST_EXECUTION_STATE_CONFLICT' });
  }
  await writeFile(file, '{broken\n');
  await assert.rejects(execution.status({ project: root, runId: approved.runId }));
  await rm(file);
  const target = join(dirname(root), 'reservation-target');
  await writeFile(target, original, { mode: 0o600 });
  await symlink(target, file);
  await assert.rejects(execution.status({ project: root, runId: approved.runId }));
  assert.equal(await readFile(target, 'utf8'), original);
});

test('Worker status refuses checkout paths with symlinked ancestors', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient, now: () => NOW });
  const prepared = await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  const next = await execution.nextAction({ project: root, runId: approved.runId, expectedRuntimeVersion: prepared.runtimeVersion });
  const path = JSON.parse(next.action.payload).contract.worktree.path;
  const parent = dirname(path);
  await rename(parent, `${parent}-relocated`);
  await symlink(`${parent}-relocated`, parent);
  const status = await execution.status({ project: root, runId: approved.runId });
  assert.equal(status.workerCheckouts[0].status, 'unavailable');
  assert.equal(status.workerCheckouts[0].headCommit, null);
  assert.deepEqual(status.workerCheckouts[0].dirtyPaths, []);
});

test('Worker status rejects excessive dirty-path output instead of returning an unbounded report', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient, now: () => NOW });
  const prepared = await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  const next = await execution.nextAction({ project: root, runId: approved.runId, expectedRuntimeVersion: prepared.runtimeVersion });
  const path = JSON.parse(next.action.payload).contract.worktree.path;
  await Promise.all(Array.from({ length: 257 }, (_, i) => writeFile(join(path, `untracked-${i}`), 'preserved')));
  await assert.rejects(execution.status({ project: root, runId: approved.runId }), { code: 'ERR_HOST_EXECUTION_STATE_CONFLICT' });
  assert.equal(await readFile(join(path, 'untracked-256'), 'utf8'), 'preserved');
});

test('explicit host recovery removes all four abandoned locks without changing saved state or files', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient, now: () => NOW });
  await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  const paths = await resolveFeatureRunPaths(root, approved.runId);
  const runtime = await resolveStatePaths(root, approved.runId);
  const before = await Promise.all([readFile(paths.snapshotPath), readFile(runtime.snapshotPath)]);
  const worktrees = await git(root, 'worktree', 'list', '--porcelain');
  await writeFile(join(root, 'uncommitted.txt'), 'preserve me');
  for (const path of [join(paths.runDir, 'host-operation.lock'), paths.lockPath, runtime.runtimeLockPath, runtime.lockPath]) await abandonedHostLock(path);
  const recovered = await execution.recover({ project: root, runId: approved.runId });
  assert.equal(recovered.status, 'recovered');
  assert.deepEqual(recovered.recoveredLocks, ['host-operation', 'run', 'runtime', 'state']);
  assert.deepEqual(await Promise.all([readFile(paths.snapshotPath), readFile(runtime.snapshotPath)]), before);
  assert.equal(await readFile(join(root, 'uncommitted.txt'), 'utf8'), 'preserve me');
  assert.equal(await git(root, 'worktree', 'list', '--porcelain'), worktrees);
  assert.deepEqual((await execution.recover({ project: root, runId: approved.runId })).recoveredLocks, []);
});

test('host recovery reports partial progress and preserves a live inner owner', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient });
  const paths = await resolveFeatureRunPaths(root, approved.runId);
  await abandonedHostLock(join(paths.runDir, 'host-operation.lock'));
  await abandonedHostLock(paths.lockPath, { pid: process.pid });
  const before = await readFile(paths.lockPath);
  const result = await execution.recover({ project: root, runId: approved.runId });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.recoveredLocks, ['host-operation']);
  assert.equal(result.blockedLock, 'run');
  assert.deepEqual(await readFile(paths.lockPath), before);
});

test('host recovery validates corrupt snapshots before removing an abandoned outer lock', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const paths = await resolveFeatureRunPaths(root, approved.runId);
  const outer = join(paths.runDir, 'host-operation.lock');
  await abandonedHostLock(outer);
  const before = await readFile(outer);
  await writeFile(paths.snapshotPath, '{}', { mode: 0o600 });
  await assert.rejects(createHostExecution({ gitClient }).recover({ project: root, runId: approved.runId }));
  assert.deepEqual(await readFile(outer), before);
});

test('task recover selects a sole active host run and work recover reports blocked progress as failure', async t => {
  const { root, approved } = await fixture(t);
  const calls = [];
  const messages = [];
  const output = { log: x => messages.push(x), error: x => messages.push(x), json: x => messages.push(x) };
  const work = { recover: async value => { calls.push(value); return { status: 'recovered', recoveredLocks: ['run'], nextAction: 'Read task status.' }; } };
  assert.equal(await main(['task', 'recover'], { cwd: () => root, work, output }), EXIT_CODES.SUCCESS);
  assert.deepEqual(calls[0], { project: root, runId: approved.runId });
  assert.match(messages.join('\n'), /run/);
  const blocked = { recover: async () => ({ status: 'blocked', recoveredLocks: ['host-operation'], blockedLock: 'run', nextAction: 'Inspect remaining owner.' }) };
  messages.length = 0;
  assert.equal(await main(['work', 'recover', approved.runId, `--project=${root}`, '--json'], { work: blocked, output }), EXIT_CODES.REPOSITORY_CONFLICT);
  assert.equal(messages[0].ok, false);
  assert.deepEqual(messages[0].result.recoveredLocks, ['host-operation']);
  assert.equal(await main(['task', 'recover', '--force'], { cwd: () => root, work, output }), EXIT_CODES.INVALID_INPUT);
});

test('host recovery permits interrupted initialization without inventing a runtime snapshot', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const runtime = await resolveStatePaths(root, approved.runId);
  await abandonedHostLock(runtime.runtimeLockPath);
  await abandonedHostLock(runtime.lockPath);
  const result = await createHostExecution({ gitClient }).recover({ project: root, runId: approved.runId });
  assert.equal(result.status, 'recovered');
  assert.equal(result.runtimeVersion, null);
  assert.deepEqual(result.recoveredLocks, ['runtime', 'state']);
  await assert.rejects(access(runtime.snapshotPath), { code: 'ENOENT' });
});

test('host recovery rejects substituted runtime objectives before removing locks', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient, now: () => NOW });
  await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  const paths = await resolveFeatureRunPaths(root, approved.runId);
  const runtime = await resolveStatePaths(root, approved.runId);
  const saved = JSON.parse(await readFile(runtime.snapshotPath, 'utf8'));
  saved.data.graph.nodes.find(node => node.owner.role === 'worker').objective = 'Implement an unrelated task with different ownership.';
  await writeFile(runtime.snapshotPath, `${JSON.stringify(saved)}\n`);
  const lock = join(paths.runDir, 'host-operation.lock');
  await abandonedHostLock(lock);
  const before = await readFile(lock);
  await assert.rejects(execution.recover({ project: root, runId: approved.runId }));
  assert.deepEqual(await readFile(lock), before);
});

test('host recovery fails closed for young live foreign corrupt and previously claimed owners', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const paths = await resolveFeatureRunPaths(root, approved.runId);
  const outer = join(paths.runDir, 'host-operation.lock');
  const execution = createHostExecution({ gitClient });
  for (const [name, overrides] of [
    ['young', { timestamp: new Date().toISOString() }],
    ['live', { pid: process.pid }],
    ['foreign', { host: 'another-host.invalid' }],
    ['corrupt', {}],
    ['claimed', {}],
  ]) {
    await abandonedHostLock(outer, overrides);
    if (name === 'corrupt') await writeFile(outer, '{}');
    if (name === 'claimed') {
      const owner = JSON.parse(await readFile(outer, 'utf8'));
      await writeFile(`${outer}.recovered-${owner.ownerId}`, 'prior recovery claim', { mode: 0o600 });
    }
    const before = await readFile(outer);
    const result = await execution.recover({ project: root, runId: approved.runId });
    assert.equal(result.status, 'blocked', name);
    assert.equal(result.blockedLock, 'host-operation', name);
    assert.deepEqual(result.recoveredLocks, [], name);
    assert.deepEqual(await readFile(outer), before, name);
  }
});

test('host prepare respects recovery outer lock and never initializes state while another owner holds it', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const paths = await resolveFeatureRunPaths(root, approved.runId);
  const outer = await acquireLock(join(paths.runDir, 'host-operation.lock'));
  const before = await readFile(paths.snapshotPath);
  try {
    await assert.rejects(createHostExecution({ gitClient }).prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version }), { code: 'ERR_HOST_RUN_BUSY' });
    assert.deepEqual(await readFile(paths.snapshotPath), before);
  } finally { await outer.release(); }
});

test('concurrent host recoverers preserve snapshots and do not remove an active acquired lock', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient });
  const paths = await resolveFeatureRunPaths(root, approved.runId);
  const before = await readFile(paths.snapshotPath);
  await abandonedHostLock(join(paths.runDir, 'host-operation.lock'));
  const results = await Promise.all([
    execution.recover({ project: root, runId: approved.runId }),
    execution.recover({ project: root, runId: approved.runId }),
  ]);
  assert.ok(results.some(result => result.status === 'recovered'));
  assert.equal(results.filter(result => result.recoveredLocks.includes('host-operation')).length, 1);
  assert.deepEqual(await readFile(paths.snapshotPath), before);
});

test('host recovery refuses a running run with a missing runtime snapshot', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient, now: () => NOW });
  await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  const paths = await resolveFeatureRunPaths(root, approved.runId);
  const runtime = await resolveStatePaths(root, approved.runId);
  await rm(runtime.snapshotPath);
  const lock = join(paths.runDir, 'host-operation.lock');
  await abandonedHostLock(lock);
  const before = await readFile(lock);
  await assert.rejects(execution.recover({ project: root, runId: approved.runId }));
  assert.deepEqual(await readFile(lock), before);
});

test('task recover requires a selector for multiple host runs and refuses explicit spawned runs', async t => {
  const { root, gitClient, approved, workflow } = await fixture(t);
  const second = await workflow.propose({ project: root, client: 'host',
    source: { kind: 'inline', value: '# Another task\n\n## Acceptance criteria\n\n- Add another agenda item.\n' },
    decomposition: { schemaVersion: 1, kind: 'agilno.feature-decomposition', workItems: [{ objective: 'Add another agenda item.', ownedPaths: ['app/second.js'], acceptanceCriterionIndexes: [1] }] },
  });
  const calls = [];
  const messages = [];
  const output = { log: value => messages.push(value), error: value => messages.push(value), json: value => messages.push(value) };
  const work = { recover: async value => { calls.push(value); return { status: 'recovered', recoveredLocks: [], nextAction: 'Read task status.' }; } };
  assert.equal(await main(['task', 'recover'], { cwd: () => root, work, output }), EXIT_CODES.INVALID_INPUT);
  assert.equal(calls.length, 0);
  assert.equal(await main(['task', 'recover', `--run=${second.runId}`], { cwd: () => root, work, output }), EXIT_CODES.SUCCESS);
  assert.equal(calls[0].runId, second.runId);
  const paths = await resolveFeatureRunPaths(root, approved.runId);
  const saved = JSON.parse(await readFile(paths.snapshotPath, 'utf8'));
  saved.data.featurePlan.client = 'codex';
  const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
    : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
      : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  const { createHash } = await import('node:crypto');
  saved.data.proposalDigest = createHash('sha256').update(canonical(saved.data.featurePlan)).digest('hex');
  saved.data.activation.proposalDigest = saved.data.proposalDigest;
  await writeFile(paths.snapshotPath, `${JSON.stringify(saved)}\n`);
  assert.equal(await main(['task', 'recover', `--run=${approved.runId}`], { cwd: () => root, work, output }), EXIT_CODES.REPOSITORY_CONFLICT);
  assert.equal(calls.length, 1);
  await assert.rejects(createHostExecution({ gitClient }).recover({ project: root, runId: approved.runId }), { code: 'ERR_HOST_RUN_RECOVERY_STATE' });
  assert.equal(await main(['task', 'recover'], { cwd: () => root, work, output }), EXIT_CODES.SUCCESS);
  assert.equal(calls.at(-1).runId, second.runId);
});

test('host recovery rejects missing runtime directories for started runs even without their expected runtime reference', async t => {
  const { root, gitClient, approved } = await fixture(t);
  const execution = createHostExecution({ gitClient, now: () => NOW });
  await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  const paths = await resolveFeatureRunPaths(root, approved.runId);
  const runtime = await resolveStatePaths(root, approved.runId);
  await rm(runtime.instanceDir, { recursive: true });
  const saved = JSON.parse(await readFile(paths.snapshotPath, 'utf8'));
  const lock = join(paths.runDir, 'host-operation.lock');
  await abandonedHostLock(lock);
  const before = await readFile(lock);
  for (const status of ['running', 'blocked', 'completed']) {
    for (const refs of [[], ['runtime:unrelated-run']]) {
      saved.data.status = status;
      saved.data.runtimeRefs = refs;
      await writeFile(paths.snapshotPath, `${JSON.stringify(saved)}\n`);
      await assert.rejects(execution.recover({ project: root, runId: approved.runId }), { code: 'ERR_HOST_RUN_RECOVERY_STATE' });
      assert.deepEqual(await readFile(lock), before);
    }
  }
});

test('host execution creates the approved bugfix branch directly', async t => {
  const {root,gitClient,approved} = await fixture(t,{workType:'bugfix'});
  assert.equal(approved.featurePlan.branchNaming.workType,'bugfix');
  const execution = createHostExecution({gitClient,now:()=>NOW});
  await execution.prepare({project:root,runId:approved.runId,expectedRunVersion:approved.version});
  const worktrees = await gitClient.listWorktrees(root);
  assert.ok(worktrees.some(item=>item.branch===`fix/${approved.featurePlan.id}-${approved.runId}`));
  assert.ok(!worktrees.some(item=>item.branch===`feature/${approved.featurePlan.id}-${approved.runId}`));
});
