import assert from 'node:assert/strict';
import { execFile as callback } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { main } from '../../src/cli/main.js';
import { createOutput, EXIT_CODES } from '../../src/cli/output.js';
import { loadProjectConfig } from '../../src/config/load.js';
import { createHostFeaturePlan } from '../../src/feature/planner.js';
import { createFeatureRunStore } from '../../src/feature/run-store.js';
import { governancePaths, resolveFeatureRunPaths } from '../../src/state/paths.js';
import { readSnapshotWithoutLock } from '../../src/state/snapshot-store.js';
import { createWorkRequest } from '../../src/work-request/contract.js';

const execFile = promisify(callback);
const git = async (root, ...args) => (await execFile('/usr/bin/git', ['-C', root, ...args])).stdout.trim();
const configFixture = new URL('../fixtures/config/valid/.rivet/', import.meta.url);
const decision = (id = 'health-response', tier = 1) => ({ id, tier, title: 'Health response format',
  options: [{ id: 'json', description: 'Return JSON' }, { id: 'text', description: 'Return plain text' }],
  choice: 'json', rationale: 'Keep the response consistent with existing endpoints.' });

async function fixture(t) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'rivet-cli-governance-'))), root = join(parent, 'project');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await mkdir(root); await cp(configFixture, join(root, '.rivet'), { recursive: true });
  await mkdir(join(root, 'src')); await mkdir(join(root, '.rivet-inputs'));
  await writeFile(join(root, '.gitignore'), '.rivet-inputs/\n');
  await writeFile(join(root, 'README.md'), '# CLI fixture\n');
  await execFile('/usr/bin/git', ['init', '-q', '--initial-branch=main', root]);
  await git(root, 'add', '.');
  await git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'fixture');
  const baselineCommit = await git(root, 'rev-parse', 'HEAD');
  const now = new Date().toISOString(), config = await loadProjectConfig(root);
  const workRequest = createWorkRequest({ source: { kind: 'inline', ref: 'inline' }, title: 'Health endpoint', description: 'Add a health endpoint.',
    acceptanceCriteria: ['Add a working health endpoint.'], contextRefs: [], capturedAt: now });
  const featurePlan = createHostFeaturePlan({ config, workRequest, baselineCommit, decomposition: {
    schemaVersion: 1, kind: 'agilno.feature-decomposition', workItems: [{ objective: 'Add a working health endpoint.', ownedPaths: ['src/health.js'], acceptanceCriterionIndexes: [1] }],
  } });
  const paths = await resolveFeatureRunPaths(root, 'health-task'), store = createFeatureRunStore(paths);
  const run = await store.create({ workRequest, featurePlan, createdAt: now });
  const snapshot = async () => readSnapshotWithoutLock(await governancePaths(paths));
  const call = async (args, overrides = {}) => {
    const messages = [];
    const code = await main(['task', ...args], { cwd: () => root, env: {}, reportFailure: false,
      terminalIsInteractive: () => false, resolveCommandExecutable: async () => realpath('/usr/bin/git'),
      output: { log: value => messages.push(value), error: value => messages.push(value), json: value => messages.push(JSON.stringify(value)) }, ...overrides });
    return { code, messages, text: messages.join('\n') };
  };
  const record = async (value = decision()) => {
    const result = await call(['decide', `--input-json=${JSON.stringify(value)}`]);
    assert.equal(result.code, EXIT_CODES.SUCCESS, result.text);
    return result;
  };
  return { parent, root, paths, run, store, call, record, snapshot, baselineCommit };
}

test('task governance autodiscovers the project and sole run from a nested directory', async t => {
  const f = await fixture(t);
  const initial = await f.call(['decisions'], { cwd: () => join(f.root, 'src') });
  assert.equal(initial.code, EXIT_CODES.SUCCESS, initial.text);
  assert.match(initial.text, /No decisions recorded/); assert.equal(await f.snapshot(), null);
  await f.record();
  const listed = await f.call(['decisions'], { cwd: () => join(f.root, 'src') });
  assert.equal(listed.code, EXIT_CODES.SUCCESS, listed.text); assert.match(listed.text, /Health response format/);
  assert.equal((await f.snapshot()).version, 1);
  assert.equal((await f.store.readOnly()).status, 'proposed');
});

test('inline input accepts exactly 64 KiB and rejects excess UTF-8 bytes before journal mutation', async t => {
  const f = await fixture(t), text = JSON.stringify(decision('inline-limit'));
  const valid = text + ' '.repeat(64 * 1024 - Buffer.byteLength(text));
  assert.equal((await f.call(['decide', `--input-json=${valid}`])).code, EXIT_CODES.SUCCESS);
  const before = await f.snapshot();
  const invalid = await f.call(['decide', `--input-json=${valid} `]);
  assert.equal(invalid.code, EXIT_CODES.INVALID_INPUT); assert.match(invalid.text, /64 KiB|bounded JSON/);
  assert.deepEqual(await f.snapshot(), before);
});

test('project file input accepts exactly 128 KiB and rejects excess or outside/symlink inputs', async t => {
  const f = await fixture(t), file = join(f.root, '.rivet-inputs', 'decision.json');
  const text = JSON.stringify(decision('file-limit'));
  await writeFile(file, text + ' '.repeat(128 * 1024 - Buffer.byteLength(text)));
  const result = await f.call(['decide', '--input=.rivet-inputs/decision.json']);
  assert.equal(result.code, EXIT_CODES.SUCCESS, result.text);
  const before = await f.snapshot();
  await writeFile(file, text + ' '.repeat(128 * 1024 - Buffer.byteLength(text) + 1));
  assert.equal((await f.call(['decide', '--input=.rivet-inputs/decision.json'])).code, EXIT_CODES.INVALID_INPUT);
  const outside = join(f.parent, 'outside.json'); await writeFile(outside, JSON.stringify(decision('outside-file')));
  assert.equal((await f.call(['decide', `--input=${outside}`])).code, EXIT_CODES.INVALID_INPUT);
  await symlink(outside, join(f.root, '.rivet-inputs', 'linked.json'));
  assert.notEqual((await f.call(['decide', '--input=.rivet-inputs/linked.json'])).code, EXIT_CODES.SUCCESS);
  assert.deepEqual(await f.snapshot(), before);
});

test('input modes are exclusive and unsupported flags cannot create evidence', async t => {
  const f = await fixture(t), source = JSON.stringify(decision());
  const cases = [
    ['decide'], ['decide', '--input-json={invalid'],
    ['decide', '--input=.rivet-inputs/missing.json', `--input-json=${source}`],
    ['decide', `--input-json=${source}`, '--phase=plan'],
    ['decisions', `--input-json=${source}`], ['decisions', '--details'],
    ['approve-decision'], ['approve-decision', '--decision=health-response', `--input-json=${source}`],
    ['review', '--phase=unexpected'], ['review', '--input=x.json', '--input-json={}'],
    ['decide', `--input-json=${source}`, '--approve'],
  ];
  for (const args of cases) {
    const result = await f.call(args);
    assert.equal(result.code, EXIT_CODES.INVALID_INPUT, `${args.join(' ')}\n${result.text}`);
    assert.equal(await f.snapshot(), null);
  }
});

test('pending decision approval requires an interactive terminal and the explicit approve choice', async t => {
  const f = await fixture(t); await f.record(decision('human-choice', 2));
  const before = await f.snapshot(); let prompts = 0;
  const noninteractive = await f.call(['approve-decision', '--decision=human-choice'], { taskApprovalPrompt: async () => { prompts++; return 'approve'; } });
  assert.equal(noninteractive.code, EXIT_CODES.BLOCKED_AUTHORITY, noninteractive.text); assert.equal(prompts, 0);
  for (const choice of ['leave', null, undefined, true, 'yes']) {
    const result = await f.call(['approve-decision', '--decision=human-choice'], { terminalIsInteractive: () => true,
      taskApprovalPrompt: async preview => { assert.deepEqual(preview.choices.map(item => item.value), ['approve', 'leave']); return choice; } });
    if (choice === 'leave' || choice === null || choice === undefined) assert.equal(result.code, EXIT_CODES.SUCCESS, result.text);
    assert.deepEqual(await f.snapshot(), before);
  }
  const approved = await f.call(['approve-decision', '--decision=human-choice'], { terminalIsInteractive: () => true,
    taskApprovalPrompt: async () => 'approve' });
  assert.equal(approved.code, EXIT_CODES.SUCCESS, approved.text);
  const after = await f.snapshot(); assert.equal(after.version, 2);
  assert.equal(after.data.events[1].data.status, 'approved');
  assert.equal(after.data.events[1].data.approval.actor.kind, 'human');
  assert.equal((await f.store.readOnly()).status, 'proposed');
  const repeated = await f.call(['approve-decision', '--decision=human-choice'], { terminalIsInteractive: () => true, taskApprovalPrompt: async () => 'approve' });
  assert.equal(repeated.code, EXIT_CODES.FAILED_GATE); assert.deepEqual(await f.snapshot(), after);
});

test('review context is available before plan approval and reading it creates no evidence', async t => {
  const f = await fixture(t);
  const result = await f.call(['review']);
  assert.equal(result.code, EXIT_CODES.SUCCESS, result.text);
  const context = JSON.parse(result.messages[0]);
  assert.equal(context.subject.phase, 'plan'); assert.equal(context.subject.runId, f.run.runId);
  assert.equal(context.subject.baseSha, f.baselineCommit); assert.equal(context.subject.headSha, f.baselineCommit);
  assert.equal(context.subject.planDigest, f.run.proposalDigest); assert.equal(context.plan.baselineCommit, f.baselineCommit);
  assert.deepEqual(context.subject.changedPaths, []); assert.ok(context.request.acceptanceCriteria.length);
  assert.equal(await f.snapshot(), null); assert.equal((await f.store.readOnly()).status, 'proposed');
});

test('review submission rejects missing report fields and forged approval fields without a journal write', async t => {
  const f = await fixture(t);
  for (const value of [{}, { status: 'PASS' }, { status: 'PASS', blocking: false, actorId: 'independent-reviewer' }]) {
    const result = await f.call(['review', '--phase=plan', `--input-json=${JSON.stringify(value)}`]);
    assert.equal(result.code, EXIT_CODES.FAILED_GATE, result.text); assert.equal(await f.snapshot(), null);
  }
  const result = await f.call(['decide', `--input-json=${JSON.stringify({ ...decision(), status: 'approved', actor: { kind: 'human', id: 'spoofed' } })}`]);
  assert.equal(result.code, EXIT_CODES.FAILED_GATE, result.text); assert.equal(await f.snapshot(), null);
});

test('sensitive decision input is rejected without exposing it or creating private journal events', async t => {
  const f = await fixture(t), secret = 'ghp_' + 'A'.repeat(36);
  const result = await f.call(['decide', `--input-json=${JSON.stringify({ ...decision(), rationale: secret })}`]);
  assert.equal(result.code, EXIT_CODES.FAILED_GATE); assert.equal(result.text.includes(secret), false); assert.equal(await f.snapshot(), null);
});

test('failed review display cannot approve a pending decision', async t => {
  const f = await fixture(t); await f.record(decision('display-failure', 2)); const before = await f.snapshot();
  const stdout = new EventEmitter(), stderr = new EventEmitter(); stdout.write = () => true; stderr.write = () => true;
  await f.call(['approve-decision', '--decision=display-failure'], { terminalIsInteractive: () => true,
    output: createOutput({ stdout, stderr }), taskApprovalPrompt: async () => { stdout.emit('error', new Error('display failed')); return 'approve'; } });
  assert.deepEqual(await f.snapshot(), before);
});

test('interrupting the decision prompt cannot approve a late answer', async t => {
  const f = await fixture(t); await f.record(decision('interrupted-choice', 3)); const before = await f.snapshot();
  let receivedSignal = false;
  await f.call(['approve-decision', '--decision=interrupted-choice'], { terminalIsInteractive: () => true,
    taskApprovalPrompt: async preview => { receivedSignal = preview.signal instanceof AbortSignal; if (receivedSignal) process.emit('SIGINT'); return 'approve'; } });
  assert.equal(receivedSignal, true, 'Decision approval prompt must receive an interruption signal.');
  assert.deepEqual(await f.snapshot(), before);
});

test('a complete independent review report records through the CLI without approving execution', async t => {
  const f = await fixture(t), observed = await f.call(['review', '--phase=plan']);
  assert.equal(observed.code, EXIT_CODES.SUCCESS, observed.text);
  const context = JSON.parse(observed.messages[0]), subject = context.subject;
  const identity = Object.fromEntries(['phase', 'runId', 'requestDigest', 'planDigest', 'baseSha', 'headSha', 'diffDigest'].map(key => [key, subject[key]]));
  const report = { ...identity, reviewerId: 'general', actorId: 'independent-reviewer', round: 1, status: 'PASS', blocking: false,
    coverage: subject.acceptanceCriteria.map((_, index) => ({ criterionIndex: index + 1,
      planNodeIds: [context.plan.nodes.find(node => node.role === 'worker').id], paths: [],
      evidence: [{ kind: 'manual', reference: 'plan-review', summary: 'Compared the proposed plan with the requested health endpoint behavior.' }] })),
    findings: [], filesReviewed: [], commandsExecuted: [], checkedAt: new Date().toISOString() };
  const result = await f.call(['review', '--phase=plan', `--input-json=${JSON.stringify(report)}`]);
  assert.equal(result.code, EXIT_CODES.SUCCESS, result.text);
  const snapshot = await f.snapshot(); assert.equal(snapshot.version, 1); assert.equal(snapshot.data.events[0].type, 'review.recorded');
  assert.equal((await f.store.readOnly()).status, 'proposed');
  const reread = await f.call(['review', '--phase=plan']);
  assert.equal(reread.code, EXIT_CODES.SUCCESS, reread.text); assert.equal(JSON.parse(reread.messages[0]).review.valid, true);
});
