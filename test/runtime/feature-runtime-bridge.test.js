import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { access, chmod, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { failAgent } from '../../src/clients/contract.js';
import { createFakeClient } from '../../src/clients/fake.js';
import { loadProjectConfig } from '../../src/config/load.js';
import { featurePlanDigest } from '../../src/feature/plan-contract.js';
import { createAcceptedIntegrationStore } from '../../src/feature/accepted-integration.js';
import { createVerificationReportStore } from '../../src/feature/verification-report.js';
import { createFeaturePlanner } from '../../src/feature/planner.js';
import { createFeatureRunStore } from '../../src/feature/run-store.js';
import {
  configuredFeatureGates,
  createFeatureExecutor,
  createFeatureLaunchInput,
  createFeatureRuntimeControls,
  createFeatureRuntimeState,
  featureQualityAuthority,
} from '../../src/feature/runtime-bridge.js';
import { createGitClient } from '../../src/git/client.js';
import { createReservationStore } from '../../src/git/reservations.js';
import { createRuntimeInstance } from '../../src/runtime/instance-store.js';
import { createOrchestrator } from '../../src/runtime/orchestrator.js';
import { acceptedIntegrationPaths, resolveFeatureRunPaths, resolveStatePaths, verificationReportPaths } from '../../src/state/paths.js';
import { createWorkRequest } from '../../src/work-request/contract.js';

const CONFIG_ROOT = new URL('../fixtures/config/valid/', import.meta.url).pathname;
const BASELINE = '0123456789abcdef0123456789abcdef01234567';
const NOW = '2029-01-01T00:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const execFile = promisify(execFileCallback);

test('compiles schema-v2 logical gates and quality authority from the same ordered step list', async () => {
  const config = {
    project: {
      schemaVersion: 2,
      commands: {
        build: { steps: [
          { cwd: 'backend', argv: ['npm', 'run', 'build'] },
          { cwd: 'frontend', argv: ['npm', 'run', 'build'] },
        ] },
        test: { steps: [{ cwd: 'backend', argv: ['npm', 'run', 'test'] }] },
      },
    },
    quality: { commandGates: [
      { id: 'build', command: 'build', required: true },
      { id: 'test', command: 'test', required: true },
    ] },
  };
  const resolved = [];

  const gates = await configuredFeatureGates(config, async runner => {
    resolved.push(runner);
    return `/safe/${runner}`;
  });
  const authority = featureQualityAuthority(config);

  assert.deepEqual(gates.map(gate => ({ id: gate.id, cwd: gate.cwd, args: gate.args })), [
    { id: 'build-1', cwd: 'backend', args: ['run', 'build'] },
    { id: 'build-2', cwd: 'frontend', args: ['run', 'build'] },
    { id: 'test', cwd: 'backend', args: ['run', 'test'] },
  ]);
  assert.deepEqual(resolved, ['npm', 'npm', 'npm']);
  assert.deepEqual(authority.commands, ['build-1', 'build-2', 'test']);
  assert.deepEqual(authority.actions, ['command.build-1', 'command.build-2', 'command.test']);
});

async function gitExecutable() {
  for (const candidate of ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git']) {
    try { return await realpath(candidate); } catch {}
  }
  throw new Error('Git fixture executable is unavailable');
}

function workRequest() {
  return createWorkRequest({
    source: { kind: 'inline', ref: 'inline' },
    title: 'Smart agenda builder',
    description: 'Recommend and export a conflict-free agenda.',
    acceptanceCriteria: ['Preserve accepted sessions', 'Export the agenda as ICS'],
    contextRefs: [],
    capturedAt: NOW,
  });
}

function proposal() {
  return {
    schemaVersion: 1,
    kind: 'agilno.feature-decomposition',
    workItems: [
      {
        objective: 'Implement agenda recommendations.',
        ownedPaths: ['app/agenda'],
        acceptanceCriterionIndexes: [1],
      },
      {
        objective: 'Implement ICS export.',
        ownedPaths: ['app/export'],
        acceptanceCriterionIndexes: [2],
      },
    ],
  };
}

async function persistedRunningRun(root, runId, request, featurePlan) {
  const store = createFeatureRunStore(await resolveFeatureRunPaths(root, runId));
  const proposed = await store.create({ workRequest: request, featurePlan, createdAt: NOW });
  const approved = await store.update({
    status: 'approved', updatedAt: NOW,
    activation: {
      approverId: 'human-cli-operator', approvedAt: NOW,
      requestDigest: request.digest, proposalDigest: proposed.proposalDigest,
    },
    runtimeRefs: [], evidenceRefs: ['approval:activation'],
  }, { expectedVersion: proposed.version });
  return store.update({
    status: 'running', updatedAt: NOW,
    runtimeRefs: approved.runtimeRefs, evidenceRefs: approved.evidenceRefs,
  }, { expectedVersion: approved.version });
}

async function runtimeFixture(decomposition = proposal()) {
  const config = await loadProjectConfig(CONFIG_ROOT);
  const request = workRequest();
  const planner = createFeaturePlanner({ planningClient: { propose: async () => decomposition } });
  const featurePlan = await planner.propose({ config, workRequest: request, baselineCommit: BASELINE, client: 'codex' });
  const digest = featurePlanDigest(featurePlan);
  const run = {
    runId: 'smart-agenda-run',
    workRequest: request,
    featurePlan,
    proposalDigest: digest,
    activation: {
      approverId: 'human-cli-operator',
      approvedAt: NOW,
      requestDigest: request.digest,
      proposalDigest: digest,
    },
  };
  return { config, request, run };
}

test('maps the exact approved plan into a bounded canonical runtime graph without widening authority', async () => {
  const { config, run } = await runtimeFixture();
  const state = createFeatureRuntimeState({ config, run });

  assert.equal(state.version, 0);
  assert.equal(state.activated, false);
  assert.equal(state.graph.status, 'approved');
  assert.equal(state.graph.nodes.find(node => node.id === 'activation').status, 'completed');
  assert.equal(state.graph.nodes.find(node => node.id === 'management').status, 'completed');
  assert.equal(state.graph.nodes.find(node => node.id === 'implement-agenda-recommendations').status, 'ready');
  assert.equal(state.graph.nodes.find(node => node.id === 'final-delivery').approvalGate, 'final-delivery');
  assert.deepEqual(state.graph.nodes.find(node => node.id === 'implement-agenda-recommendations').authorityScopes, ['implement', 'verify']);
  assert.deepEqual(state.graph.nodes.find(node => node.id === 'implement-agenda-recommendations').evidenceRefs, [
    'implement-agenda-recommendations-commit-1',
    'implement-agenda-recommendations-test-2',
  ]);
  assert.equal(JSON.stringify(state).includes('ATLASSIAN_API_TOKEN'), false);
  assert.equal(Object.isFrozen(state), true);
});

test('derives bounded unique evidence references for maximum-length Worker identifiers', async () => {
  const sharedPrefix = 'Implement accessible conference session discovery controls with deterministic behavior and';
  const { config, run } = await runtimeFixture({
    schemaVersion: 1,
    kind: 'agilno.feature-decomposition',
    workItems: [
      {
        objective: `${sharedPrefix} domain coverage.`,
        ownedPaths: ['app/agenda'],
        acceptanceCriterionIndexes: [1],
      },
      {
        objective: `${sharedPrefix} browser coverage.`,
        ownedPaths: ['app/export'],
        acceptanceCriterionIndexes: [2],
      },
    ],
  });

  const state = createFeatureRuntimeState({ config, run });
  const workerEvidenceRefs = state.graph.nodes
    .filter(node => node.owner.role === 'worker')
    .flatMap(node => node.evidenceRefs);

  assert.equal(workerEvidenceRefs.length, 4);
  assert.equal(new Set(workerEvidenceRefs).size, workerEvidenceRefs.length);
  assert.ok(workerEvidenceRefs.every(reference => reference.length <= 64));
  assert.ok(workerEvidenceRefs.every(reference => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(reference)));
  assert.deepEqual(
    workerEvidenceRefs,
    createFeatureRuntimeState({ config, run }).graph.nodes
      .filter(node => node.owner.role === 'worker')
      .flatMap(node => node.evidenceRefs),
  );
});

test('derives one exact activation control set accepted by the existing orchestrator', async () => {
  const { config, run } = await runtimeFixture();
  let state = structuredClone(createFeatureRuntimeState({ config, run }));
  let locked = false;
  const instance = {
    id: run.runId,
    async acquire() {
      assert.equal(locked, false);
      locked = true;
      return { release: async () => { locked = false; } };
    },
    async read() { assert.equal(locked, true); return structuredClone(state); },
    async commit(expectedVersion, next) {
      assert.equal(expectedVersion, state.version);
      state = structuredClone(next);
      return structuredClone(state);
    },
  };
  const runtime = createOrchestrator({
    client: createFakeClient({ scripts: [{
      version: 1,
      kind: 'success',
      output: { summary: 'unused', evidence: ['unused-commit', 'unused-test'] },
      usage: { tokens: 1, costUsd: 0 },
    }] }),
    now: () => NOW_MS,
    launchFor() { throw new Error('activation must not launch a Worker'); },
  });
  const activated = await runtime.activate(instance, {
    expectedVersion: 0,
    ...createFeatureRuntimeControls({ run, nowMs: NOW_MS }),
  });
  assert.equal(activated.activated, true);
  assert.equal(activated.version, 1);
  assert.equal(activated.graph.status, 'running');
});

test('rejects client, digest, role, or authority drift before runtime state exists', async () => {
  const { config, run } = await runtimeFixture();
  for (const mutate of [
    value => { value.featurePlan.client = 'claude'; },
    value => { value.featurePlan.workRequestDigest = 'f'.repeat(64); },
    value => { value.featurePlan.nodes[2].roleId = 'portfolio-boss'; },
    value => { value.featurePlan.nodes[2].authorityScopes.push('merge'); },
  ]) {
    const changed = structuredClone(run);
    mutate(changed);
    assert.throws(() => createFeatureRuntimeState({ config, run: changed }));
  }
});

test('rehydrates the exact persisted approved plan without weakening validation', async () => {
  const { config, run } = await runtimeFixture();
  const persisted = structuredClone(run);
  const state = createFeatureRuntimeState({ config, run: persisted });
  assert.equal(state.graph.id, run.featurePlan.id);
  persisted.featurePlan.nodes[2].authorityScopes.push('merge');
  assert.throws(() => createFeatureRuntimeState({ config, run: persisted }));
});

for (const managed of [false,true]) test(`executes all Workers sequentially with ${managed?'distinct managed profiles':'legacy profiles'} and stops before final approval`, async t => {
  const parentRoot = await realpath(await mkdtemp(join(tmpdir(), 'rivet-feature-executor-')));
  const root = join(parentRoot, 'project');
  await mkdir(root);
  t.after(() => rm(parentRoot, { recursive: true, force: true }));
  await cp(new URL('../fixtures/config/valid/.rivet/', import.meta.url), join(root, '.rivet'), { recursive: true });
  if(managed){
    const {parse,stringify}=await import('yaml');
    const {managedPolicy}=await import('../fixtures/execution-policy.js');
    const path=join(root,'.rivet','orchestration.yaml');
    const orchestration=parse(await readFile(path,'utf8'));
    const policy=managedPolicy();
    policy.profiles.implementation={harness:'claude',model:'opus',effort:'high',capabilities:['read','edit','commands']};
    policy.profiles.fix={harness:'claude',model:'sonnet',effort:'low',capabilities:['read','edit','commands']};
    policy.routing['bounded-fix']='fix';
    orchestration.executionPolicy=policy;
    await writeFile(path,stringify(orchestration));
  }
  await writeFile(join(root, 'README.md'), '# Runtime fixture\n');
  if(managed) {
    const {parse,stringify}=await import('yaml');
    const path=join(root,'.rivet','quality.yaml');
    const quality=parse(await readFile(path,'utf8'));
    quality.verificationReuse={enabled:true,reproducible:true,dependencyRoots:['inputs'],toolchainRoots:['tools']};
    await writeFile(path,stringify(quality));
    for(const directory of ['inputs','tools']) {
      await mkdir(join(root,directory));
      await writeFile(join(root,directory,'.keep'),'fixture\n');
    }
  }
  await writeFile(join(root, '.gitignore'), 'node_modules/\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({
    scripts: { build: 'x', test: 'x', lint: 'x', typecheck: 'x', dev: 'x' },
  }));
  await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  await execFile('git', ['init', '--quiet', '--initial-branch=main', root]);
  await execFile('git', ['-C', root, 'add', '.']);
  await execFile('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  const baselineCommit = (await execFile('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  const gitClient = await createGitClient({ gitExecutable: await gitExecutable() });
  const config = await loadProjectConfig(root);
  const request = workRequest();
  const planner = createFeaturePlanner({ planningClient: { propose: async () => { const value=proposal(request); if(managed)value.workItems[0].executionClass='bounded-fix'; return value; } } });
  const featurePlan = await planner.propose({ config, workRequest: request, baselineCommit, client: 'claude' });
  const run = await persistedRunningRun(root, 'smart-agenda-live-run', request, featurePlan);
  const gateLog = join(dirname(root), 'gate-invocations.log');
  const gateExecutable = join(dirname(root), 'bounded-gate');
  await writeFile(gateExecutable, '#!' + await realpath('/bin/sh') + '\nif [ -n "$RIVET_GATE_LOG" ]; then printf "%s\\n" "$*" >> "$RIVET_GATE_LOG"; fi\nif [ "$1" = ci ]; then mkdir -p node_modules; printf ready > node_modules/installed; exit 0; fi\n[ "$RIVET_GATE_ENV" = present ]\n', { mode: 0o700 });
  await chmod(gateExecutable, 0o700);
  const launches = [];
  let activeLaunches = 0;
  let maxActiveLaunches = 0;
  let installsApproved = 0;
  const executor = createFeatureExecutor({
    gitClient,
    environment: { RIVET_GATE_ENV: 'present', RIVET_GATE_LOG: gateLog, PATH: '/bin' },
    now: () => NOW,
    resolveCommandExecutable: async runner => {
      assert.equal(runner, 'npm');
      return gateExecutable;
    },
    clientFor(kind, clientProfile, options) {
      assert.equal(kind, 'claude');
      assert.equal(JSON.stringify(clientProfile), JSON.stringify(featurePlan.clientProfile));
      return Object.freeze({
        provider: kind,
        async launch(contract,launchOptions) {
          activeLaunches += 1;
          maxActiveLaunches = Math.max(maxActiveLaunches, activeLaunches);
          assert.equal(await readFile(join(contract.worktree.path, 'node_modules/installed'), 'utf8'), 'ready');
          launches.push({
            nodeId: contract.nodeId,
            selection: options.executionSelection,
            branchBase: (await gitClient.inspectRepository(contract.worktree.path)).headSha,
            maxCostUsd: contract.budget.maxCostUsd,
          });
          for (const path of contract.ownedPaths) {
            const target = join(contract.worktree.path, path);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, `${contract.nodeId}\n`);
          }
          if(managed){const receipt={version:1,executionId:`execution-${contract.nodeId}`,processId:111,processGroupId:111,ownerProcessId:process.pid,processBirth:null,observedAtMs:Date.parse(NOW),source:'owned-process',assurance:'observed',status:'started'};await launchOptions.onExecution(receipt);await launchOptions.onExecution({...receipt,status:'stopped'});}
          activeLaunches -= 1;
          return {
            version: 1, status: 'success',
            output: { summary: `Completed ${contract.nodeId}.`, evidence: [...contract.evidence] },
            usage: { tokens: 10, costUsd: 0 },
          };
        },
      });
    },
  });

  const deferred = await executor({ project: root, run }, { confirmDependencyInstall: async () => false });
  assert.equal(deferred.status, 'blocked');
  assert.equal(launches.length, 0);

  await writeFile(gateExecutable, '#!' + await realpath('/bin/sh') + '\nexit 23\n', { mode: 0o700 });
  const failedInstall = await executor({ project: root, run }, { confirmDependencyInstall: async () => true });
  assert.equal(failedInstall.status, 'blocked');
  assert.match(failedInstall.summary, /Dependency command status: nonzero; exit code: 23/);
  assert.equal(launches.length, 0);
  await writeFile(gateExecutable, '#!' + await realpath('/bin/sh') + '\nif [ -n "$RIVET_GATE_LOG" ]; then printf "%s\\n" "$*" >> "$RIVET_GATE_LOG"; fi\nif [ "$1" = ci ]; then mkdir -p node_modules; printf ready > node_modules/installed; exit 0; fi\n[ "$RIVET_GATE_ENV" = present ]\n', { mode: 0o700 });

  const result = await executor({ project: root, run }, {
    confirmDependencyInstall: async plan => {
      assert.deepEqual(plan.args, ['ci']);
      assert.match(plan.worktreePath, /workers\//);
      installsApproved += 1;
      return true;
    },
  });
  assert.equal(result.status, 'awaiting-final-approval', JSON.stringify({ result, launches }));
  assert.equal(installsApproved, launches.length);
  const featurePaths = await resolveFeatureRunPaths(root, run.runId);
  const accepted = await createAcceptedIntegrationStore(await acceptedIntegrationPaths(featurePaths)).readOnly();
  const verification = await createVerificationReportStore(await verificationReportPaths(featurePaths)).readOnly();
  assert.equal(verification.status, 'pass');
  assert.equal(verification.commitSha, accepted.commitSha);
  assert.ok(verification.checks.some(check => check.status === 'passed'));
  assert.equal(launches.length, 2);
  const observedCommands = (await readFile(gateLog, 'utf8')).trim().split('\n');
  assert.deepEqual(observedCommands, ['run build', 'run test', 'run lint']);
  if(managed) {
    assert.equal(verification.verificationReuse,'executed');
    const repeated=await executor({project:root,run});
    assert.equal(repeated.status,'awaiting-final-approval',repeated.summary);
    const reused=await createVerificationReportStore(await verificationReportPaths(featurePaths)).readOnly();
    assert.equal(reused.verificationReuse,'reused');
    assert.deepEqual((await readFile(gateLog,'utf8')).trim().split('\n'),observedCommands);
  }
  assert.equal(maxActiveLaunches, 1);
  t.diagnostic(JSON.stringify({ fixture: managed ? 'managed-profiles' : 'serial', workerCalls: launches.length,
    maxConcurrentWorkers: maxActiveLaunches, dependencyInstalls: installsApproved, verificationCommands: observedCommands.length,
    nativeUsageMeasured: false }));
  if(managed)assert.deepEqual(launches.map(item=>[item.selection.model,item.selection.effort]),[['sonnet','low'],['opus','high']]);
  assert.deepEqual(launches.map(launch => launch.maxCostUsd), [2, 2]);
  const integrationEntry = (await gitClient.listWorktrees(root)).find(item => item.branch === 'feature/smart-agenda-builder-smart-agenda-live-run');
  assert.ok(integrationEntry);
  assert.notEqual(launches[0].branchBase, (await gitClient.inspectRepository(integrationEntry.path)).headSha);
  const integrationLog = (await execFile('git', [
    '-C', integrationEntry.path, 'log', '-2', '--format=%s',
  ])).stdout;
  assert.match(integrationLog, /rivet: complete implement-ics-export/);
  assert.equal((await gitClient.inspectRepository(root)).branch, 'main');
  assert.equal((await gitClient.inspectRepository(root)).headSha, baselineCommit);
  assert.match(result.runtimeRefs[0], /^runtime:/);
  assert.ok(result.evidenceRefs.some(ref => ref.startsWith('commit:')));
});

test('managed one-shot checkpoint successor preserves dirty checkout and cumulative budgets', async t => {
  const managed=true;
  const parentRoot = await realpath(await mkdtemp(join(tmpdir(), 'rivet-feature-executor-')));
  const root = join(parentRoot, 'project');
  await mkdir(root);
  t.after(() => rm(parentRoot, { recursive: true, force: true }));
  await cp(new URL('../fixtures/config/valid/.rivet/', import.meta.url), join(root, '.rivet'), { recursive: true });
  if(managed){
    const {parse,stringify}=await import('yaml');
    const {managedPolicy}=await import('../fixtures/execution-policy.js');
    const path=join(root,'.rivet','orchestration.yaml');
    const orchestration=parse(await readFile(path,'utf8'));
    const policy=managedPolicy();
    policy.profiles.implementation={harness:'claude',model:'opus',effort:'high',capabilities:['read','edit','commands']};
    policy.profiles.fix={harness:'claude',model:'sonnet',effort:'low',capabilities:['read','edit','commands']};
    policy.routing['bounded-fix']='fix';
    orchestration.executionPolicy=policy;
    await writeFile(path,stringify(orchestration));
  }
  await writeFile(join(root, 'README.md'), '# Runtime fixture\n');
  await writeFile(join(root, '.gitignore'), 'node_modules/\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({
    scripts: { build: 'x', test: 'x', lint: 'x', typecheck: 'x', dev: 'x' },
  }));
  await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  await execFile('git', ['init', '--quiet', '--initial-branch=main', root]);
  await execFile('git', ['-C', root, 'add', '.']);
  await execFile('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  const baselineCommit = (await execFile('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  const gitClient = await createGitClient({ gitExecutable: await gitExecutable() });
  const config = await loadProjectConfig(root);
  const request = workRequest();
  const planner = createFeaturePlanner({ planningClient: { propose: async () => { const value=proposal(request); if(managed)value.workItems[0].executionClass='bounded-fix'; return value; } } });
  const featurePlan = await planner.propose({ config, workRequest: request, baselineCommit, client: 'claude' });
  const run = await persistedRunningRun(root, 'smart-agenda-live-run', request, featurePlan);
  const gateLog = join(dirname(root), 'gate-invocations.log');
  const gateExecutable = join(dirname(root), 'bounded-gate');
  await writeFile(gateExecutable, '#!/bin/sh\nif [ -n "$RIVET_GATE_LOG" ]; then printf "%s\\n" "$*" >> "$RIVET_GATE_LOG"; fi\nif [ "$1" = ci ]; then mkdir -p node_modules; printf ready > node_modules/installed; exit 0; fi\n[ "$RIVET_GATE_ENV" = present ]\n', { mode: 0o700 });
  await chmod(gateExecutable, 0o700);
  const launches = [];
  let activeLaunches = 0;
  let maxActiveLaunches = 0;
  let installsApproved = 0;
  const executor = createFeatureExecutor({
    gitClient,
    environment: { RIVET_GATE_ENV: 'present', RIVET_GATE_LOG: gateLog, PATH: '/bin' },
    now: () => NOW,
    resolveCommandExecutable: async runner => {
      assert.equal(runner, 'npm');
      return gateExecutable;
    },
    clientFor(kind, clientProfile, options) {
      assert.equal(kind, 'claude');
      assert.equal(JSON.stringify(clientProfile), JSON.stringify(featurePlan.clientProfile));
      return Object.freeze({
        provider: kind,
        async launch(contract, launchOptions) {
          activeLaunches += 1;
          maxActiveLaunches = Math.max(maxActiveLaunches, activeLaunches);
          assert.equal(await readFile(join(contract.worktree.path, 'node_modules/installed'), 'utf8'), 'ready');
          const generation=contract.session.generation;
          const receipt={version:1,executionId:`execution-${contract.nodeId}-${generation}`,processId:111,processGroupId:111,ownerProcessId:process.pid,processBirth:null,observedAtMs:Date.parse(NOW),source:'owned-process',assurance:'observed',status:'started'};
          await launchOptions.onExecution(receipt);
          launches.push({
            generation,
            nodeId: contract.nodeId,
            selection: options.executionSelection,
            branchBase: (await gitClient.inspectRepository(contract.worktree.path)).headSha,
            maxCostUsd: contract.budget.maxCostUsd,
          });
          for (const path of contract.ownedPaths) {
            const target = join(contract.worktree.path, path);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, `${contract.nodeId}\n`);
          }
          await launchOptions.onExecution({...receipt,status:'stopped'});
          activeLaunches -= 1;
          return {
            version: 1, status: generation===1?'checkpoint':'success',
            output: { summary: `Completed ${contract.nodeId}.`, evidence: [...contract.evidence] },
            usage: { tokens: 10, costUsd: 0 },
          };
        },
      });
    },
  });

  const deferred = await executor({ project: root, run }, { confirmDependencyInstall: async () => false });
  assert.equal(deferred.status, 'blocked');
  assert.equal(launches.length, 0);

  const result = await executor({ project: root, run }, {
    confirmDependencyInstall: async plan => {
      assert.deepEqual(plan.args, ['ci']);
      assert.match(plan.worktreePath, /workers\//);
      installsApproved += 1;
      return true;
    },
  });
  assert.equal(result.status, 'awaiting-final-approval', JSON.stringify({ result, launches }));
  assert.equal(installsApproved, 2);
  const featurePaths = await resolveFeatureRunPaths(root, run.runId);
  const accepted = await createAcceptedIntegrationStore(await acceptedIntegrationPaths(featurePaths)).readOnly();
  const verification = await createVerificationReportStore(await verificationReportPaths(featurePaths)).readOnly();
  assert.equal(verification.status, 'pass');
  assert.equal(verification.commitSha, accepted.commitSha);
  assert.ok(verification.checks.some(check => check.status === 'passed'));
  assert.equal(launches.length, 4);
  const observedCommands = (await readFile(gateLog, 'utf8')).trim().split('\n');
  assert.deepEqual(observedCommands, ['run build', 'run test', 'run lint']);
  assert.equal(maxActiveLaunches, 1);
  t.diagnostic(JSON.stringify({ fixture: 'checkpoint-successors', workerCalls: launches.length,
    maxConcurrentWorkers: maxActiveLaunches, dependencyInstalls: installsApproved, verificationCommands: observedCommands.length,
    nativeUsageMeasured: false }));
  assert.deepEqual(launches.map(x=>x.generation),[1,2,1,2]);
  if(managed)assert.deepEqual(launches.map(item=>[item.selection.model,item.selection.effort]),[['sonnet','low'],['sonnet','low'],['opus','high'],['opus','high']]);
  assert.deepEqual(launches.map(launch => launch.maxCostUsd), [2, 2, 2, 2]);
  const integrationEntry = (await gitClient.listWorktrees(root)).find(item => item.branch === 'feature/smart-agenda-builder-smart-agenda-live-run');
  assert.ok(integrationEntry);
  assert.notEqual(launches[0].branchBase, (await gitClient.inspectRepository(integrationEntry.path)).headSha);
  const integrationLog = (await execFile('git', [
    '-C', integrationEntry.path, 'log', '-2', '--format=%s',
  ])).stdout;
  assert.match(integrationLog, /rivet: complete implement-ics-export/);
  assert.equal((await gitClient.inspectRepository(root)).branch, 'main');
  assert.equal((await gitClient.inspectRepository(root)).headSha, baselineCommit);
  assert.match(result.runtimeRefs[0], /^runtime:/);
  assert.ok(result.evidenceRefs.some(ref => ref.startsWith('commit:')));
});

test('autonomous verification blocks a committed child-manifest deletion before any gate launches', async t => {
  const parentRoot = await realpath(await mkdtemp(join(tmpdir(), 'rivet-feature-manifest-')));
  const root = join(parentRoot, 'project');
  const marker = join(parentRoot, 'quality-gate-ran');
  await mkdir(root);
  t.after(() => rm(parentRoot, { recursive: true, force: true }));
  await cp(new URL('../fixtures/config/valid/.rivet/', import.meta.url), join(root, '.rivet'), { recursive: true });
  await mkdir(join(root, 'backend'));
  await writeFile(join(root, 'README.md'), '# Runtime manifest fixture\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'runtime-root', scripts: { build: 'node -e "process.exit(71)"', test: 'node -e "process.exit(72)"' },
  }));
  await writeFile(join(root, 'backend', 'package.json'), JSON.stringify({
    name: 'runtime-backend', scripts: { build: 'x', test: 'x' },
  }));
  await writeFile(join(root, '.rivet', 'project.yaml'), [
    'schemaVersion: 2',
    'id: runtime-manifest-project',
    'name: Runtime Manifest Project',
    'stack: {framework: other, language: javascript, packageManager: npm}',
    'repository:',
    '  defaultBranch: main',
    '  branchPattern: feature/{slug}',
    '  sensitivePaths: [.env]',
    'commands:',
    '  build:',
    '    steps:',
    '      - {cwd: backend, argv: [npm, run, build]}',
    '  test:',
    '    steps:',
    '      - {cwd: backend, argv: [npm, run, test]}',
    '',
  ].join('\n'));
  await writeFile(join(root, '.rivet', 'quality.yaml'), [
    'schemaVersion: 1',
    'providerRefs: [figma-main, git-ci-main]',
    'completionProfileRefs: [engineering, delivery]',
    'commandGates:',
    '  - {id: build, command: build, required: true}',
    '  - {id: test, command: test, required: true}',
    'expectations: {storybook: optional, playwright: optional, accessibility: wcag-aa, security: required, visual: none}',
    'evidence:',
    '  requiredTypes: [commit, test, review, human-approval]',
    '  requireHumanBaseline: false',
    '  requireHumanFinal: true',
    '',
  ].join('\n'));
  await execFile('git', ['init', '--quiet', '--initial-branch=main', root]);
  await execFile('git', ['-C', root, 'add', '.']);
  await execFile('git', [
    '-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--quiet', '-m', 'fixture',
  ]);
  const baselineCommit = (await execFile('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  const gitClient = await createGitClient({ gitExecutable: await gitExecutable() });
  const config = await loadProjectConfig(root);
  const request = workRequest();
  const planner = createFeaturePlanner({ planningClient: { propose: async () => ({
    schemaVersion: 1,
    kind: 'agilno.feature-decomposition',
    workItems: [{
      objective: 'Replace the backend package manifest.',
      ownedPaths: ['backend/package.json'],
      acceptanceCriterionIndexes: [1, 2],
    }],
  }) } });
  const featurePlan = await planner.propose({ config, workRequest: request, baselineCommit, client: 'claude' });
  const run = await persistedRunningRun(root, 'runtime-manifest-run', request, featurePlan);
  const gateExecutable = join(parentRoot, 'bounded-gate');
  await writeFile(gateExecutable, `#!/bin/sh\nprintf ran > '${marker}'\n`, { mode: 0o700 });
  await chmod(gateExecutable, 0o700);
  const executor = createFeatureExecutor({
    gitClient,
    now: () => NOW,
    resolveCommandExecutable: async () => gateExecutable,
    clientFor() {
      return Object.freeze({
        provider: 'claude',
        async launch(contract) {
          await rm(join(contract.worktree.path, 'backend', 'package.json'));
          return {
            version: 1,
            status: 'success',
            output: { summary: 'Removed the package manifest.', evidence: [...contract.evidence] },
            usage: { tokens: 10, costUsd: 0 },
          };
        },
      });
    },
  });

  const result = await executor({ project: root, run });

  assert.equal(result.status, 'blocked');
  assert.match(result.summary, /quality gates could not complete safely/i);
  const featurePaths = await resolveFeatureRunPaths(root, run.runId);
  const accepted = await createAcceptedIntegrationStore(await acceptedIntegrationPaths(featurePaths)).readOnly();
  const verification = await createVerificationReportStore(await verificationReportPaths(featurePaths)).readOnly();
  assert.equal(verification.status, 'fail');
  assert.equal(verification.commitSha, accepted.commitSha);
  assert.match(verification.failure, /quality gate execution failed safely|could not complete safely/i);
  await assert.rejects(() => access(marker));
});

test('rejects mismatched Worker evidence before integrating its committed changes', async t => {
  const parentRoot = await realpath(await mkdtemp(join(tmpdir(), 'rivet-feature-evidence-')));
  const root = join(parentRoot, 'project');
  await mkdir(root);
  t.after(() => rm(parentRoot, { recursive: true, force: true }));
  await cp(new URL('../fixtures/config/valid/.rivet/', import.meta.url), join(root, '.rivet'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Evidence fixture\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({
    scripts: { build: 'x', test: 'x', lint: 'x', typecheck: 'x', dev: 'x' },
  }));
  await execFile('git', ['init', '--quiet', '--initial-branch=main', root]);
  await execFile('git', ['-C', root, 'add', '.']);
  await execFile('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  const baselineCommit = (await execFile('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  const gitClient = await createGitClient({ gitExecutable: await gitExecutable() });
  const config = await loadProjectConfig(root);
  const request = workRequest();
  const planner = createFeaturePlanner({ planningClient: { propose: async () => proposal(request) } });
  const featurePlan = await planner.propose({ config, workRequest: request, baselineCommit, client: 'claude' });
  const run = await persistedRunningRun(root, 'smart-agenda-evidence-run', request, featurePlan);
  let launches = 0;
  const executor = createFeatureExecutor({
    gitClient,
    now: () => NOW,
    resolveCommandExecutable: async () => { throw new Error('quality gates must not run'); },
    clientFor() {
      return Object.freeze({
        provider: 'claude',
        async launch(contract) {
          launches += 1;
          const target = join(contract.worktree.path, contract.ownedPaths[0]);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, 'committed despite invalid evidence\n');
          return {
            version: 1,
            status: 'success',
            output: { summary: 'invalid evidence', evidence: ['wrong-evidence'] },
            usage: { tokens: 1, costUsd: 0 },
          };
        },
      });
    },
  });

  const result = await executor({ project: root, run });
  assert.equal(result.status, 'blocked');
  assert.equal(launches, 1);
  const integration = (await gitClient.listWorktrees(root)).find(item => item.branch === 'feature/smart-agenda-builder-smart-agenda-evidence-run');
  assert.ok(integration);
  assert.equal((await gitClient.inspectRepository(integration.path)).headSha, baselineCommit);
});

test('resumes one blocked Worker in its exact preserved checkout and records a bounded retry', async t => {
  const parentRoot = await realpath(await mkdtemp(join(tmpdir(), 'rivet-feature-recovery-')));
  const root = join(parentRoot, 'project');
  await mkdir(root);
  t.after(() => rm(parentRoot, { recursive: true, force: true }));
  await cp(new URL('../fixtures/config/valid/.rivet/', import.meta.url), join(root, '.rivet'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Recovery fixture\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({
    scripts: { build: 'x', test: 'x', lint: 'x', typecheck: 'x', dev: 'x' },
  }));
  await execFile('git', ['init', '--quiet', '--initial-branch=main', root]);
  await execFile('git', ['-C', root, 'add', '.']);
  await execFile('git', [
    '-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--quiet', '-m', 'fixture',
  ]);
  const baselineCommit = (await execFile('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  const gitClient = await createGitClient({ gitExecutable: await gitExecutable() });
  const config = await loadProjectConfig(root);
  const request = workRequest();
  const planner = createFeaturePlanner({ planningClient: { propose: async () => proposal(request) } });
  const featurePlan = await planner.propose({ config, workRequest: request, baselineCommit, client: 'claude' });
  const run = await persistedRunningRun(root, 'smart-agenda-recovery-run', request, featurePlan);
  const gateExecutable = join(parentRoot, 'bounded-gate');
  await writeFile(gateExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await chmod(gateExecutable, 0o700);
  const launches = [];
  let firstAttempt = true;
  const executor = createFeatureExecutor({
    gitClient,
    now: () => NOW,
    resolveCommandExecutable: async () => gateExecutable,
    clientFor() {
      return Object.freeze({
        provider: 'claude',
        async launch(contract) {
          launches.push({ nodeId: contract.nodeId, path: contract.worktree.path });
          const [ownedPath] = contract.ownedPaths;
          const target = join(contract.worktree.path, ownedPath);
          await mkdir(dirname(target), { recursive: true });
          if (firstAttempt) {
            firstAttempt = false;
            await writeFile(target, 'preserved first-attempt work\n');
            failAgent('output-invalid');
          }
          if (contract.nodeId === 'implement-agenda-recommendations') {
            assert.equal(await readFile(target, 'utf8'), 'preserved first-attempt work\n');
          } else {
            await writeFile(target, `${contract.nodeId}\n`);
          }
          await execFile('git', ['-C', contract.worktree.path, 'add', '--', ...contract.ownedPaths]);
          await execFile('git', [
            '-C', contract.worktree.path, '-c', 'user.name=Worker', '-c', 'user.email=worker@example.invalid',
            'commit', '--quiet', '-m', `implement ${contract.nodeId}`,
          ]);
          return {
            version: 1,
            status: 'success',
            output: { summary: `Completed ${contract.nodeId}.`, evidence: [...contract.evidence] },
            usage: { tokens: 10, costUsd: 0 },
          };
        },
      });
    },
  });

  const blocked = await executor({ project: root, run });
  assert.equal(blocked.status, 'blocked');
  assert.equal(launches.length, 1);
  const preservedPath = launches[0].path;
  const statePaths = await resolveStatePaths(root, run.runId);
  const reservations = await createReservationStore(statePaths).list();
  assert.equal(reservations.reservations.length, 1);
  assert.equal(reservations.reservations[0].status, 'active');
  assert.equal(reservations.reservations[0].worktreePath, preservedPath);

  await writeFile(join(preservedPath, 'README.md'), '# Out-of-scope retry drift\n');
  const unsafeResume = await executor({ project: root, run });
  assert.equal(unsafeResume.status, 'blocked');
  assert.equal(launches.length, 1);
  await writeFile(join(preservedPath, 'README.md'), '# Recovery fixture\n');

  const resumed = await executor({ project: root, run });

  assert.equal(resumed.status, 'awaiting-final-approval', JSON.stringify({ resumed, launches }));
  assert.equal(launches.length, 3);
  assert.equal(launches[1].nodeId, 'implement-agenda-recommendations');
  assert.equal(launches[1].path, preservedPath);
  const instance = createRuntimeInstance({
    id: run.runId,
    paths: statePaths,
    initialState: createFeatureRuntimeState({ config, run }),
  });
  const lock = await instance.acquire();
  let runtimeState;
  try { runtimeState = await instance.read(); } finally { await lock.release(); }
  assert.equal(runtimeState.attempts['implement-agenda-recommendations'], 2);
  assert.equal(runtimeState.usage.retries, 1);
  assert.ok(runtimeState.events.some(event => (
    event.type === 'retry'
    && event.nodeId === 'implement-agenda-recommendations'
    && event.actor.role === 'manager'
  )));
});


for (const preparationDrift of [null, 'input', 'directory', 'large-input', 'nested-input']) test(`automatic provider retry preserves prepared dependencies (${preparationDrift ?? 'unchanged'})`, async t => {
  const parentRoot = await realpath(await mkdtemp(join(tmpdir(), 'rivet-provider-retry-')));
  const root = join(parentRoot, 'project');
  await mkdir(root);
  t.after(() => rm(parentRoot, {recursive: true, force: true}));
  await cp(new URL('../fixtures/config/valid/.rivet/', import.meta.url), join(root, '.rivet'), {recursive: true});
  await writeFile(join(root, '.gitignore'), 'node_modules/\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({scripts: {build: 'x', test: 'x', lint: 'x', typecheck: 'x'}}));
  await writeFile(join(root, 'package-lock.json'), preparationDrift === 'large-input' ? ' '.repeat(8 * 1024 * 1024 + 1) : '{"lockfileVersion":3}\n');
  await mkdir(join(root, 'packages/shared'), {recursive: true});
  await writeFile(join(root, 'packages/shared/package.json'), '{}\n');
  await execFile('git', ['init', '--quiet', '--initial-branch=main', root]);
  await execFile('git', ['-C', root, 'add', '.']);
  await execFile('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  const gitClient = await createGitClient({gitExecutable: await gitExecutable()});
  const baselineCommit = (await gitClient.inspectRepository(root)).headSha;
  const config = await loadProjectConfig(root);
  const request = workRequest();
  const planner = createFeaturePlanner({planningClient: {propose: async () => ({...proposal(), workItems: [{...proposal().workItems[0], ownedPaths: ['app/agenda', ...(preparationDrift === 'input' ? ['package-lock.json'] : preparationDrift === 'nested-input' ? ['packages/shared/package.json'] : [])], acceptanceCriterionIndexes: [1, 2]}]})}});
  const featurePlan = await planner.propose({config, workRequest: request, baselineCommit, client: 'claude'});
  const run = await persistedRunningRun(root, 'provider-retry', request, featurePlan);
  const gateExecutable = join(parentRoot, 'gate');
  await writeFile(gateExecutable, '#!/bin/sh\nif [ "$1" = ci ]; then mkdir -p node_modules; printf ready > node_modules/installed; fi\nexit 0\n', {mode: 0o700});
  const launches = [];
  const preparedPaths = [];
  const executor = createFeatureExecutor({
    gitClient, now: () => NOW, resolveCommandExecutable: async () => gateExecutable,
    clientFor: () => ({provider: 'claude', async launch(contract) {
      launches.push(contract.worktree.path);
      assert.equal(await readFile(join(contract.worktree.path, 'node_modules/installed'), 'utf8'), 'ready');
      const target = join(contract.worktree.path, contract.ownedPaths[0]);
      if (launches.length === 1) {
        await mkdir(dirname(target), {recursive: true});
        await writeFile(target, 'preserved provider attempt\n');
        if (preparationDrift === 'input') await writeFile(join(contract.worktree.path, 'package-lock.json'), '{"lockfileVersion":2}\n');
        if (preparationDrift === 'nested-input') await writeFile(join(contract.worktree.path, 'packages/shared/package.json'), '{"name":"changed"}\n');
        if (preparationDrift === 'directory') {
          await rename(join(contract.worktree.path, 'node_modules'), join(parentRoot, 'original-dependencies'));
          await mkdir(join(contract.worktree.path, 'node_modules'));
        }
        failAgent('provider-unavailable');
      }
      assert.equal(await readFile(target, 'utf8'), 'preserved provider attempt\n');
      return {version: 1, status: 'success', output: {summary: 'Implementation complete', evidence: [...contract.evidence]}, usage: {tokens: 10, costUsd: 0}};
    }}),
  });
  const result = await executor({project: root, run}, {confirmDependencyInstall: async plan => {
    preparedPaths.push(plan.worktreePath);
    return true;
  }});
  if (preparationDrift) {
    assert.equal(result.status, 'blocked', result.summary);
    assert.equal(launches.length, 1, 'dependency drift must block relaunch');
    return;
  }
  assert.equal(result.status, 'awaiting-final-approval', result.summary);
  assert.equal(launches.length, 2);
  assert.equal(launches[0], launches[1]);
  assert.equal(preparedPaths.filter(path => path === launches[0]).length, 1, 'the exact prepared worker is not installed twice');
  assert.equal((await gitClient.inspectRepository(root)).headSha, baselineCommit);
});

test('worker-specific profile caps its sealed launch budget independently of the planning profile', async () => {
  const {clientProfileFor}=await import('../../src/feature/client-profile.js');
  const planNode={objective:'Implement',ownedPaths:['src/file.js'],authorityScopes:['implement'],commandIds:[]};
  const node={id:'worker',evidenceRefs:[]},intent={allocation:{costUsd:'20',tokenLimit:100,timeMinutes:1},worktree:{}};
  for(const [planner,worker,expected] of [['claude','codex',20],['codex','claude',2]]) {
    const selected={...planNode,execution:{client:worker,...(clientProfileFor(worker)?{clientProfile:clientProfileFor(worker)}:{})}};
    const run={featurePlan:{client:planner,clientProfile:clientProfileFor(planner),providerRefs:[]},workRequest:{digest:'a'.repeat(64),contextRefs:[]}};
    assert.equal(createFeatureLaunchInput(node,intent,selected,run).budget.maxCostUsd,expected);
  }
});

test('custom Worker ceiling respects lower approved allocations and the saved profile', async () => {
  const {clientProfileFor} = await import('../../src/feature/client-profile.js');
  const caps = {planningMaxCostUsd: 3, workerMaxCostUsd: 4.25};
  const profile = clientProfileFor('claude', caps);
  caps.workerMaxCostUsd = 99;
  const planNode = {objective: 'Implement', ownedPaths: ['src/file.js'], authorityScopes: ['implement'], commandIds: []};
  const node = {id: 'worker', evidenceRefs: []};
  const run = {featurePlan: {client: 'claude', clientProfile: profile, providerRefs: []}, workRequest: {digest: 'a'.repeat(64), contextRefs: []}};
  for (const [allocated, expected] of [['20', 4.25], ['0.75', 0.75]]) {
    const intent = {allocation: {costUsd: allocated, tokenLimit: 100, timeMinutes: 1}, worktree: {}};
    assert.equal(createFeatureLaunchInput(node, intent, planNode, run).budget.maxCostUsd, expected);
  }
});

async function parallelFixture(t, {failure = false, workerChecksPending = false, beforeResult, dependent = false, stoppedProof = true, outerFailure = false, preparationRace = false, slowPreparation = false, cancelPreparation = false} = {}) {
  const parentRoot = await realpath(await mkdtemp(join(tmpdir(), 'rivet-adapter-parallel-')));
  t.after(() => rm(parentRoot, {recursive:true, force:true}));
  const root = join(parentRoot, 'project');
  await mkdir(root);
  await cp(new URL('../fixtures/config/valid/.rivet/', import.meta.url), join(root, '.rivet'), {recursive:true});
  const {parse,stringify} = await import('yaml');
  const {managedPolicy} = await import('../fixtures/execution-policy.js');
  const orchestrationPath = join(root,'.rivet','orchestration.yaml');
  const orchestration = parse(await readFile(orchestrationPath,'utf8'));
  orchestration.executionPolicy = managedPolicy();
  orchestration.roles.find(role => role.kind === 'worker').capacity = 2;
  await writeFile(orchestrationPath,stringify(orchestration));
  await writeFile(join(root,'README.md'),'parallel fixture\n');
  await writeFile(join(root,'package.json'),JSON.stringify({scripts:{build:'x',test:'x',lint:'x',typecheck:'x'}}));
  await execFile('git',['init','--quiet','--initial-branch=main',root]);
  await execFile('git',['-C',root,'add','.']);
  await execFile('git',['-C',root,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--quiet','-m','fixture']);
  const preparingMarker=join(parentRoot,'preparing-dependent');
  const releasePreparation=join(parentRoot,'release-dependent');
  let executableGit=await gitExecutable();
  if(preparationRace || slowPreparation) {
    const wrapper=join(parentRoot,'git-wrapper');
    await writeFile(wrapper,`#!/bin/sh
case "$*" in
  ${slowPreparation ? `*'refs/heads/worker/parallel-run/fast^{commit}'*) if [ ! -f '${preparingMarker}' ]; then printf waiting > '${preparingMarker}'; sleep 3; fi ;;` : ''}
  *'refs/heads/worker/parallel-run/dependent^{commit}'*)
    if [ ! -f '${preparingMarker}' ]; then
      printf waiting > '${preparingMarker}'
      count=0
      while [ ! -f '${releasePreparation}' ] && [ "$count" -lt 600 ]; do sleep 0.05; count=$((count + 1)); done
    fi
    ;;
esac
exec '${executableGit}' "$@"
`,{mode:0o700});
    executableGit=wrapper;
  }
  const gitClient = await createGitClient({gitExecutable:executableGit});
  const baselineCommit = (await gitClient.inspectRepository(root)).headSha;
  const config = await loadProjectConfig(root);
  const request = workRequest();
  const workItems = ['fast','slow',...(dependent?['dependent']:[])].map((id,index) => ({
    id, dependencies:id==='dependent'?['fast']:[],objective:`Implement ${id} output.`,
    ownedPaths:[`app/${id}.txt`],acceptanceCriterionIndexes:[index===1?2:1],
  }));
  const planner = createFeaturePlanner({planningClient:{propose:async()=>({schemaVersion:1,kind:'agilno.feature-decomposition',workItems})}});
  const featurePlan = await planner.propose({config,workRequest:request,baselineCommit,client:'codex'});
  const run = await persistedRunningRun(root,'parallel-run',request,featurePlan);
  const executable = join(parentRoot,'gate');
  const gateLog=join(parentRoot,'candidate-gates');
  const slowMarker=join(parentRoot,'slow-verification');
  const releaseMarker=join(parentRoot,'release-verification');
  let releaseTimer;
  t.after(()=>clearTimeout(releaseTimer));
  const slowGate=outerFailure ? `if [ -f app/slow.txt ] && [ ! -f app/fast.txt ]; then printf waiting > '${slowMarker}'; while [ ! -f '${releaseMarker}' ]; do sleep 0.05; done; fi\n` : '';
  await writeFile(executable,`#!/bin/sh\nprintf '%s\\n' \"$PWD\" >> '${gateLog}'\n${slowGate}exit ${failure?1:0}\n`,{mode:0o700});
  let active = 0; let maximum = 0; const bases = []; const events = []; const launches = [];
  let startedSlow; const slowStarted = new Promise(resolve=>{startedSlow=resolve;});
  let startedDependent; const dependentStarted = new Promise(resolve=>{startedDependent=resolve;});
  async function waitFor(promise,signal) {
    let timer; let abort;
    try {
      await Promise.race([promise,new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(new Error('parallel worker did not start')),45000);
        abort=()=>reject(new Error('aborted'));
        signal.addEventListener('abort',abort,{once:true});
        if(signal.aborted)abort();
      })]);
    } finally {clearTimeout(timer);signal.removeEventListener('abort',abort);}
  }
  const executor = createFeatureExecutor({gitClient,now:()=>NOW,resolveCommandExecutable:async()=>executable,
    clientFor:()=>({provider:'codex',async launch(contract,options){
      active++; maximum=Math.max(maximum,active); events.push(`start:${contract.nodeId}`);
      launches.push(contract);
      bases.push((await gitClient.inspectRepository(contract.worktree.path)).headSha);
      const receipt={version:1,executionId:`execution-${contract.nodeId}`,processId:111,processGroupId:111,ownerProcessId:process.pid,processBirth:null,observedAtMs:NOW_MS,source:'owned-process',assurance:'observed',status:'started'};
      await options.onExecution(receipt);
      if(contract.nodeId==='fast') await waitFor(slowStarted,options.signal);
      if(contract.nodeId==='slow') {
        startedSlow();
        if(dependent && !preparationRace) await waitFor(dependentStarted,options.signal);
      }
      if(contract.nodeId==='dependent') startedDependent();
      for(const path of contract.ownedPaths){await mkdir(dirname(join(contract.worktree.path,path)),{recursive:true});await writeFile(join(contract.worktree.path,path),contract.nodeId+'\n');}
      if(preparationRace && contract.nodeId==='slow') {
        const deadline=Date.now()+30000;
        while(true) {
          options.signal.throwIfAborted();
          if(Date.now()>deadline)throw new Error('dependent preparation did not start');
          try{await access(preparingMarker);break;}catch{await new Promise(resolve=>setTimeout(resolve,25));}
        }
        const {acquireLock}=await import('../../src/state/lock.js');
        let peerLock; let contention;
        try{peerLock=await acquireLock(join((await resolveStatePaths(root,run.runId)).instanceDir,'integration.lock'));}
        catch(error){contention=error;}
        finally{await peerLock?.release();await writeFile(releasePreparation,'release');}
        assert.equal(contention?.code,'ERR_STATE_LOCKED','peer acceptance must wait until dependent checkout is reserved');
      }
      if(outerFailure && contract.nodeId==='fast') {
        const deadline=Date.now()+30000;
        while(true) {
          options.signal.throwIfAborted();
          if(Date.now()>deadline)throw new Error('slow verification did not start');
          try{await access(slowMarker);break;}catch{await new Promise(resolve=>setTimeout(resolve,25));}
        }
        const {taskGovernance}=await import('../../src/feature/governance.js');
        await taskGovernance({project:root,runId:run.runId,gitClient,operation:'decide',input:{
          id:'needs-human',tier:2,title:'Choose output format',
          options:[{id:'json',description:'Use JSON'},{id:'text',description:'Use text'}],
          choice:'json',rationale:'Requires human approval.',
        }});
        // A missing cancellation path eventually releases and incorrectly accepts
        // the slow candidate, so the regression fails instead of hanging forever.
        releaseTimer=setTimeout(()=>writeFile(releaseMarker,'release').catch(()=>{}),15000);
      }
      if(beforeResult) await beforeResult({root,run,contract,gitClient});
      if(stoppedProof) await options.onExecution({...receipt,status:'stopped'});
      active--;events.push(`finish:${contract.nodeId}`);
      return {version:1,status:'success',output:{summary:workerChecksPending ? 'Implementation complete. Worker checks were denied; verification is pending the trusted host.' : 'Complete',evidence:[...contract.evidence]},usage:{tokens:10,costUsd:0}};
    }})});
  const cancellationController=new AbortController();
  let cancellationError;
  const cancellation=cancelPreparation ? (async()=>{
    const deadline=Date.now()+30000;
    while(true){
      if(Date.now()>deadline)throw new Error('slow preparation did not start');
      try{await access(preparingMarker);break;}catch{await new Promise(resolve=>setTimeout(resolve,25));}
    }
    cancellationController.abort();
  })().catch(error=>{cancellationError=error;}) : Promise.resolve();
  const result=await executor({project:root,run},{signal:cancellationController.signal});
  await cancellation;
  if(cancellationError)throw cancellationError;
  const accepted=await createAcceptedIntegrationStore(await acceptedIntegrationPaths(await resolveFeatureRunPaths(root,run.runId))).readOnly();
  return {result,accepted,root,run,gitClient,maximum,bases,events,launches,baselineCommit,gateLog};
}

test('explicit adapter workers overlap and both same-base siblings are verified and accepted',async t=>{
  const fixture=await parallelFixture(t);
  assert.equal(fixture.result.status,'awaiting-final-approval',fixture.result.summary);
  assert.equal(fixture.maximum,2);
  assert.equal(fixture.bases[0],fixture.bases[1]);
  for(const id of ['fast','slow'])assert.equal(await readFile(join(fixture.accepted.path,`app/${id}.txt`),'utf8'),id+'\n');
});

test('worker check permission denials defer verification to passing trusted host gates', async t => {
  const fixture = await parallelFixture(t, {workerChecksPending: true});
  for (const launch of fixture.launches) {
    assert.match(launch.objective, /denied|unavailable/i);
    assert.match(launch.objective, /do not retry|do not repeatedly retry/i);
    assert.match(launch.objective, /bypass/i);
    assert.match(launch.objective, /pending/i);
    assert.match(launch.objective, /fail(?:ed|ing|ure)/i);
  }
  assert.equal(fixture.result.status, 'awaiting-final-approval', fixture.result.summary);
  assert.ok(fixture.accepted, 'pending worker checks still require a verified accepted candidate');
  assert.match(await readFile(fixture.gateLog, 'utf8'), /candidate-worker-/);
  const verification = await createVerificationReportStore(
    await verificationReportPaths(await resolveFeatureRunPaths(fixture.root, fixture.run.runId)),
  ).readOnly();
  assert.equal(verification.status, 'pass');
  assert.equal(verification.commitSha, fixture.accepted.commitSha);
});

test('worker pending verification cannot bypass failing trusted host gates', async t => {
  const fixture = await parallelFixture(t, {workerChecksPending: true, failure: true});
  assert.match(await readFile(fixture.gateLog, 'utf8'), /candidate-worker-/);
  assert.equal(fixture.result.status, 'blocked');
  assert.equal(fixture.accepted, null, 'a successful implementation response does not approve failed checks');
  assert.equal((await fixture.gitClient.inspectRepository(fixture.root)).headSha, fixture.baselineCommit);
});

test('explicit adapter starts accepted fast dependency before slow sibling finishes',async t=>{
  const fixture=await parallelFixture(t,{dependent:true});
  assert.equal(fixture.result.status,'awaiting-final-approval',fixture.result.summary);
  assert.ok(fixture.events.indexOf('start:dependent')<fixture.events.indexOf('finish:slow'));
});

test('explicit adapter refuses failed candidate quality without accepting a worker',async t=>{
  const fixture=await parallelFixture(t,{failure:true});
  assert.match(await readFile(fixture.gateLog,'utf8'),/candidate-worker-/);
  assert.equal(fixture.result.status,'blocked');
  assert.equal(fixture.accepted,null);
});

test('explicit adapter rejects live run cancellation before candidate acceptance',async t=>{
  let cancelled = false;
  const fixture=await parallelFixture(t,{beforeResult:async({root,run,contract})=>{
    if(cancelled || contract.nodeId!=='fast')return;
    cancelled=true;
    const store=createFeatureRunStore(await resolveFeatureRunPaths(root,run.runId));
    const current=await store.readOnly();
    await store.update({status:'cancelled',updatedAt:NOW,runtimeRefs:current.runtimeRefs,evidenceRefs:current.evidenceRefs},{expectedVersion:current.version});
  }});
  assert.equal(fixture.result.status,'blocked');
  assert.equal(fixture.accepted,null);
});

test('explicit adapter retains workers without stopped session proof and never verifies them',async t=>{
  const fixture=await parallelFixture(t,{stoppedProof:false});
  assert.equal(fixture.result.status,'blocked');
  assert.equal(fixture.accepted,null);
  await assert.rejects(()=>access(fixture.gateLog));
});

test('explicit adapter outer governance failure aborts in-flight candidate verification before acceptance',async t=>{
  const fixture=await parallelFixture(t,{outerFailure:true});
  assert.equal(fixture.result.status,'blocked');
  assert.match(fixture.result.summary,/ERR_TASK_GOVERNANCE/);
  assert.ok(fixture.accepted,'fast worker was accepted before the next governance check');
  assert.equal(await readFile(join(fixture.accepted.path,'app/fast.txt'),'utf8'),'fast\n');
  await assert.rejects(()=>access(join(fixture.accepted.path,'app/slow.txt')));
});

test('explicit adapter holds acceptance lock while a dependent checkout is reserved, then accepts its peer',async t=>{
  const fixture=await parallelFixture(t,{dependent:true,preparationRace:true});
  assert.equal(fixture.result.status,'awaiting-final-approval',fixture.result.summary);
  for(const id of ['fast','slow','dependent'])assert.equal(await readFile(join(fixture.accepted.path,`app/${id}.txt`),'utf8'),id+'\n');
});


test('explicit adapter waits through a slow cooperating checkout instead of blocking its sibling',async t=>{
  const fixture=await parallelFixture(t,{slowPreparation:true});
  assert.equal(fixture.result.status,'awaiting-final-approval',fixture.result.summary);
  for(const id of ['fast','slow'])assert.equal(await readFile(join(fixture.accepted.path,`app/${id}.txt`),'utf8'),id+'\n');
});

test('explicit adapter cancellation stops the waiter during slow checkout without launching either worker',async t=>{
  const fixture=await parallelFixture(t,{slowPreparation:true,cancelPreparation:true});
  assert.equal(fixture.result.status,'blocked');
  assert.equal(fixture.accepted,null);
  assert.equal(fixture.maximum,0);
  assert.equal(await fixture.gitClient.branchTip(fixture.root,'worker/parallel-run/slow'),null);
});
