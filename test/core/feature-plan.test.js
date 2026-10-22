import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentContractError } from '../../src/clients/contract.js';
import { loadProjectConfig } from '../../src/config/load.js';
import { createFeaturePlan } from '../../src/feature/plan-contract.js';
import {
  FeaturePlanError,
  createFeaturePlanner,
  createHostFeaturePlan,
  featurePlanDigest,
} from '../../src/feature/planner.js';
import { createWorkRequest } from '../../src/work-request/contract.js';

const CONFIG_ROOT = new URL('../fixtures/config/valid/', import.meta.url).pathname;
const BASELINE = '0123456789abcdef0123456789abcdef01234567';
const NOW = '2029-01-01T00:00:00.000Z';

function request() {
  return createWorkRequest({
    source: { kind: 'linear', ref: 'DEMO-123', revision: 'v1' },
    title: 'Smart agenda builder',
    description: 'Recommend a conflict-free conference agenda and export it.',
    acceptanceCriteria: ['Preserve accepted sessions', 'Export the agenda as ICS'],
    contextRefs: ['linear:DEMO-124'],
    capturedAt: NOW,
  });
}

function budget(timeMinutes, tokenLimit, costUsd, taskLimit) {
  return { timeMinutes, tokenLimit, costUsd, taskLimit };
}

function decomposition(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'agilno.feature-decomposition',
    workItems: [
      {
        objective: 'Implement deterministic agenda recommendations.',
        ownedPaths: ['app/agenda'],
        acceptanceCriterionIndexes: [1],
      },
      {
        objective: 'Implement deterministic ICS export.',
        ownedPaths: ['app/export'],
        acceptanceCriterionIndexes: [2],
      },
    ],
    ...overrides,
  };
}

async function configuration() { return loadProjectConfig(CONFIG_ROOT); }

test('compiles a harness-supplied decomposition without invoking another model', async () => {
  const config = await configuration();
  const workRequest = request();
  const plan = createHostFeaturePlan({
    config,
    workRequest,
    baselineCommit: BASELINE,
    decomposition: decomposition(),
  });

  assert.equal(plan.client, 'host');
  assert.equal(Object.hasOwn(plan, 'clientProfile'), false);
  assert.equal(plan.nodes.filter(node => node.role === 'worker').length, 2);
  assert.deepEqual(plan.nodes[2].ownedPaths, ['app/agenda']);
  assert.match(featurePlanDigest(plan), /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(plan), true);
});

test('accepts one strict proposal and gives the planning client only an immutable read-only policy contract', async () => {
  const config = await configuration();
  const workRequest = request();
  let received;
  const planner = createFeaturePlanner({
    planningClient: Object.freeze({
      async propose(contract) {
        received = contract;
        assert.equal(Object.isFrozen(contract), true);
        assert.equal(Object.isFrozen(contract.policy.roles), true);
        assert.equal(JSON.stringify(contract).includes('ATLASSIAN_API_TOKEN'), false);
        assert.equal(contract.workRequest.digest, workRequest.digest);
        return decomposition();
      },
    }),
  });

  const plan = await planner.propose({ config, workRequest, baselineCommit: BASELINE, client: 'codex' });

  assert.equal(received.policy.defaultBranch, 'main');
  assert.equal(plan.nodes.filter(node => node.role === 'worker').length, 2);
  assert.equal(plan.id, 'smart-agenda-builder');
  assert.deepEqual(plan.providerRefs, ['git-ci-main']);
  assert.deepEqual(plan.nodes.map(node => node.id), [
    'activation', 'management', 'implement-deterministic-agenda-recommendations',
    'implement-deterministic-ics-export', 'final-delivery',
  ]);
  assert.deepEqual(plan.nodes[3].dependencies, ['implement-deterministic-agenda-recommendations']);
  assert.deepEqual(plan.nodes[4].dependencies, [
    'implement-deterministic-agenda-recommendations', 'implement-deterministic-ics-export',
  ]);
  assert.deepEqual(plan.nodes[2].acceptanceCriteria, ['Preserve accepted sessions']);
  assert.deepEqual(plan.nodes[3].acceptanceCriteria, ['Export the agenda as ICS']);
  assert.deepEqual(plan.nodes[2].commandIds, ['build', 'test', 'lint']);
  assert.match(featurePlanDigest(plan), /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.nodes[0]), true);
});

test('binds the exact bounded Sonnet profile into Claude proposals and rejects profile drift', async () => {
  const config = await configuration();
  const workRequest = request();
  const planner = createFeaturePlanner({ planningClient: { propose: async () => decomposition() } });
  const plan = await planner.propose({ config, workRequest, baselineCommit: BASELINE, client: 'claude' });

  assert.deepEqual(JSON.parse(JSON.stringify(plan.clientProfile)), {
    schemaVersion: 1,
    id: 'claude-bounded-sonnet-v1',
    provider: 'claude',
    model: 'sonnet',
    planning: { effort: 'low', timeoutMs: 120_000, maxCostUsd: 1 },
    execution: { maxCostUsd: 2 },
    fallbackModel: null,
  });
  assert.ok(Object.isFrozen(plan.clientProfile));
  assert.ok(Object.isFrozen(plan.clientProfile.planning));

  for (const mutate of [
    value => { value.clientProfile.model = 'fable'; },
    value => { value.clientProfile.planning.timeoutMs = 30_000; },
    value => { value.clientProfile.planning.maxCostUsd = 10; },
    value => { value.clientProfile.execution.maxCostUsd = 20; },
    value => { value.clientProfile.fallbackModel = 'haiku'; },
  ]) {
    const changed = structuredClone(plan);
    mutate(changed);
    assert.throws(() => createFeaturePlan({
      proposal: changed, config, workRequest, baselineCommit: BASELINE, client: 'claude',
    }), FeaturePlanError);
  }

  const codexPlan = await planner.propose({ config, workRequest, baselineCommit: BASELINE, client: 'codex' });
  const widenedCodexPlan = structuredClone(codexPlan);
  widenedCodexPlan.clientProfile = structuredClone(plan.clientProfile);
  assert.throws(() => createFeaturePlan({
    proposal: widenedCodexPlan, config, workRequest, baselineCommit: BASELINE, client: 'codex',
  }), FeaturePlanError);
});

test('allows cross-cutting acceptance criteria to support multiple work items', async () => {
  const config = await configuration();
  const workRequest = request();
  const sharedAcceptance = decomposition({
    workItems: [
      {
        objective: 'Implement deterministic agenda recommendations.',
        ownedPaths: ['app/agenda'],
        acceptanceCriterionIndexes: [1],
      },
      {
        objective: 'Add focused agenda recommendation tests.',
        ownedPaths: ['test/agenda'],
        acceptanceCriterionIndexes: [1],
      },
      {
        objective: 'Implement deterministic ICS export.',
        ownedPaths: ['app/export'],
        acceptanceCriterionIndexes: [2],
      },
    ],
  });
  const planner = createFeaturePlanner({ planningClient: { propose: async () => sharedAcceptance } });

  const plan = await planner.propose({ config, workRequest, baselineCommit: BASELINE, client: 'codex' });

  assert.deepEqual(
    plan.nodes.filter(node => node.role === 'worker').map(node => node.acceptanceCriteria),
    [
      ['Preserve accepted sessions'],
      ['Preserve accepted sessions'],
      ['Export the agenda as ICS'],
    ],
  );
});

test('rejects malformed decomposition, policy-field injection, unsafe paths, and invalid acceptance allocation', async t => {
  const config = await configuration();
  const workRequest = request();
  const cases = [
    ['full governed plan', value => Object.assign(value, { id: 'model-owned-plan', nodes: [] })],
    ['authority expansion', value => { value.workItems[0].authorityScopes = ['merge']; }],
    ['budget expansion', value => { value.workItems[0].budget = budget(999, 999, 999, 999); }],
    ['repository mutation', value => { value.workItems[0].ownedPaths = ['.git/config']; }],
    ['sensitive path', value => { value.workItems[0].ownedPaths = ['config/private/key.txt']; }],
    ['empty acceptance trace', value => { value.workItems[1].acceptanceCriterionIndexes = []; }],
    ['missing acceptance coverage', value => { value.workItems[1].acceptanceCriterionIndexes = [1]; }],
    ['out-of-range acceptance trace', value => { value.workItems[1].acceptanceCriterionIndexes = [3]; }],
    ['invalid result kind', value => { value.kind = 'agilno.feature-plan'; }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const value = structuredClone(decomposition());
      const returned = mutate(value) ?? value;
      const planner = createFeaturePlanner({ planningClient: { propose: async () => returned } });
      await assert.rejects(
        () => planner.propose({ config, workRequest, baselineCommit: BASELINE, client: 'codex' }),
        error => error instanceof FeaturePlanError && !JSON.stringify(error).includes('config/private'),
      );
    });
  }
});

test('preserves safe provider-output failures instead of masking them as invalid feature plans', async () => {
  const config = await configuration();
  const workRequest = request();
  const providerError = new AgentContractError('output-invalid');
  const planner = createFeaturePlanner({ planningClient: { propose: async () => { throw providerError; } } });

  await assert.rejects(
    () => planner.propose({ config, workRequest, baselineCommit: BASELINE, client: 'codex' }),
    error => error === providerError && error.code === 'ERR_AGENT_OUTPUT_INVALID',
  );
});

test('rejects unvalidated requests and malformed planning clients before invoking a model', async () => {
  const config = await configuration();
  assert.throws(() => createFeaturePlanner({ planningClient: {} }), FeaturePlanError);
  const planner = createFeaturePlanner({ planningClient: { propose: async () => decomposition() } });
  await assert.rejects(
    () => planner.propose({ config, workRequest: { digest: 'f'.repeat(64) }, baselineCommit: BASELINE, client: 'codex' }),
    FeaturePlanError,
  );
});


test('repairs a rejected owned path once using safe feedback and validates the replacement', async () => {
  const config = await configuration();
  const workRequest = request();
  const contracts = [];
  const planner = createFeaturePlanner({ planningClient: { propose: async contract => {
    contracts.push(contract);
    const value = decomposition();
    if (contracts.length === 1) value.workItems[0].ownedPaths = ['config/private/key.txt'];
    return value;
  } } });
  const plan = await planner.propose({ config, workRequest, baselineCommit: BASELINE, client: 'claude' });
  assert.equal(contracts.length, 2);
  assert.equal(contracts[1].repair.reason, 'owned-path-protected');
  assert.equal(contracts[1].repair.attempt, 2);
  assert.ok(Object.isFrozen(contracts[1].repair));
  assert.deepEqual(contracts[1].policy, contracts[0].policy);
  assert.deepEqual(contracts[1].workRequest, contracts[0].workRequest);
  assert.deepEqual(plan.nodes[2].ownedPaths, ['app/agenda']);
});

test('stops after one repair and reports a safe concrete path failure', async () => {
  const config = await configuration();
  let calls = 0;
  const planner = createFeaturePlanner({ planningClient: { propose: async () => {
    calls += 1;
    const value = decomposition();
    value.workItems[0].ownedPaths = ['config/private/key.txt'];
    return value;
  } } });
  await assert.rejects(() => planner.propose({ config, workRequest: request(), baselineCommit: BASELINE, client: 'claude' }), error => {
    assert.equal(error.details.reason, 'compiled-plan-invalid');
    assert.equal(error.details.violation, 'owned-path-protected');
    assert.match(error.safeMessage, /protected/);
    assert.ok(!JSON.stringify(error).includes('key.txt'));
    return true;
  });
  assert.equal(calls, 2);
});

test('repairs case-insensitive path collisions without silently dropping owned files', async () => {
  const config = await configuration();
  let calls = 0;
  const planner = createFeaturePlanner({ planningClient: { propose: async contract => {
    calls += 1;
    const value = decomposition();
    if (calls === 1) value.workItems[0].ownedPaths = ['app/Page.tsx', 'app/page.tsx'];
    else assert.equal(contract.repair.reason, 'owned-path-duplicate');
    return value;
  } } });
  await planner.propose({ config, workRequest: request(), baselineCommit: BASELINE, client: 'codex' });
  assert.equal(calls, 2);
});


test('never retries a provider failure or accepts a malformed repair', async () => {
  const config = await configuration();
  for (const scenario of ['provider', 'repair']) {
    let calls = 0;
    const planner = createFeaturePlanner({ planningClient: { propose: async () => {
      calls += 1;
      if (scenario === 'provider') throw new AgentContractError('output-invalid');
      const value = decomposition();
      if (calls === 1) value.workItems[0].ownedPaths = ['.git/config'];
      else value.workItems[0].authorityScopes = ['merge'];
      return value;
    } } });
    await assert.rejects(() => planner.propose({ config, workRequest: request(), baselineCommit: BASELINE, client: 'claude' }),
      error => scenario === 'provider' ? error instanceof AgentContractError : error.details.reason === 'decomposition-invalid');
    assert.equal(calls, scenario === 'provider' ? 1 : 2);
  }
});

test('repairs reserved path components', async () => {
  const config = await configuration();
  let calls = 0;
  const planner = createFeaturePlanner({ planningClient: { propose: async contract => {
    calls += 1;
    const value = decomposition();
    if (calls === 1) value.workItems[0].ownedPaths = ['app/con.ts'];
    else assert.equal(contract.repair.reason, 'owned-path-invalid');
    return value;
  } } });
  await planner.propose({ config, workRequest: request(), baselineCommit: BASELINE, client: 'claude' });
  assert.equal(calls, 2);
});

test('explicit worker harness is snapshotted, digest-bound, and rejects role drift or host spawning', async () => {
  const original = await configuration(), workRequest = request();
  for (const [client, harness] of [['codex', 'claude'], ['claude', 'codex']]) {
    const config = structuredClone(original);
    config.orchestration.roles.find(role => role.kind === 'worker').harness = harness;
    const planner = createFeaturePlanner({ planningClient: { propose: async () => decomposition() } });
    const plan = await planner.propose({ config, workRequest, baselineCommit: BASELINE, client });
    const worker = plan.nodes.find(node => node.role === 'worker');
    assert.equal(worker.execution.client, harness);
    assert.equal(worker.execution.clientProfile?.provider, harness === 'claude' ? 'claude' : undefined);
    assert.throws(() => createHostFeaturePlan({ config, workRequest, baselineCommit: BASELINE, decomposition: decomposition() }));
    const validate = proposal => createFeaturePlan({ proposal, config, workRequest, baselineCommit: BASELINE, client });
    for (const change of [node => { delete node.execution; }, node => { node.execution.client = client; }, node => { node.execution.clientProfile = {}; }]) {
      const changed = structuredClone(plan); change(changed.nodes.find(node => node.role === 'worker')); assert.throws(() => validate(changed));
    }
    delete config.orchestration.roles.find(role => role.kind === 'worker').harness;
    assert.throws(() => validate(plan));
  }
});
test('worker harness rejects nonworker overrides and unsupported clients', async () => {
  for (const [kind, harness] of [['boss','codex'],['manager','claude'],['worker','openai']]) {
    const config=structuredClone(await configuration());config.orchestration.roles.find(role=>role.kind===kind).harness=harness;
    const planner=createFeaturePlanner({planningClient:{propose:async()=>decomposition()}});
    await assert.rejects(planner.propose({config,workRequest:request(),baselineCommit:BASELINE,client:'codex'}));
  }
});

test('rejects ownership of the pinned project launcher and descendants with case-insensitive matching', async () => {
  const config = await configuration();
  for (const path of ['.rivet.cjs', '.RIVET.CJS', '.rivet.cjs/child']) {
    const proposal = decomposition();
    proposal.workItems[0].ownedPaths = [path];
    const planner = createFeaturePlanner({ planningClient: { propose: async () => proposal } });
    await assert.rejects(() => planner.propose({
      config, workRequest: request(), baselineCommit: BASELINE, client: 'codex',
    }), error => error.details.violation === 'owned-path-protected');
  }
});

test('both planning paths bind bugfix naming before activation and reject changed naming policy', async () => {
  const config = structuredClone(await configuration());
  config.project.repository.branchPatterns = {bugfix:'bugfix/{ticket}/{slug}'};
  const original = request();
  const {schemaVersion,digest,...input} = original;
  const workRequest = createWorkRequest({...input,workType:'bugfix'});
  const host = createHostFeaturePlan({config,workRequest,baselineCommit:BASELINE,decomposition:decomposition({workType:'feature'})});
  const planner = createFeaturePlanner({planningClient:{async propose(){return decomposition({workType:'feature'});}}});
  const spawned = await planner.propose({config,workRequest,baselineCommit:BASELINE,client:'codex'});
  assert.deepEqual({...host.branchNaming},{workType:'bugfix',pattern:'bugfix/DEMO-123/{slug}'});
  assert.deepEqual(spawned.branchNaming,host.branchNaming);
  const changed = structuredClone(config);
  changed.project.repository.branchPatterns.bugfix='fix/{slug}';
  assert.throws(()=>createFeaturePlan({proposal:host,config:changed,workRequest,baselineCommit:BASELINE,client:'host'}));
});

test('missing ticket placeholder reports an actionable planning error', async()=>{
  const config=structuredClone(await configuration());
  config.project.repository.branchPattern='fix/{ticket}/{slug}';
  const {schemaVersion,digest,...input}=request();
  const workRequest=createWorkRequest({...input,source:{kind:'inline',ref:'inline'}});
  assert.throws(()=>createHostFeaturePlan({config,workRequest,baselineCommit:BASELINE,decomposition:decomposition()}),/branchPattern.*ticket/i);
});

test('managed plans pin routing and reject policy drift at activation/resume', async () => {
  const { managedPolicy } = await import('../fixtures/execution-policy.js');
  const config = structuredClone(await configuration());
  config.orchestration.executionPolicy = managedPolicy();
  const workRequest = request();
  const proposed = decomposition();
  proposed.workItems[0].executionClass = 'bounded-fix';
  const plan = createHostFeaturePlan({ config, workRequest, baselineCommit: BASELINE, decomposition: proposed });
  assert.match(plan.executionPolicy.policyDigest, /^[a-f0-9]{64}$/);
  assert.equal(plan.nodes[2].executionSelection.classification, 'bounded-fix');
  assert.equal(plan.nodes[2].executionSelection.recommendationOnly, true);
  assert.equal(plan.nodes[1].executionSelection.classification, 'coordination');
  assert.equal(plan.nodes[2].execution, undefined);
  for (const mutate of [
    c => { c.orchestration.executionPolicy.profiles.implementation.model = 'other-model'; },
    c => { c.orchestration.executionPolicy.limits.agentExecutions = 8; },
    c => { delete c.orchestration.executionPolicy; },
  ]) {
    const changed = structuredClone(config); mutate(changed);
    assert.throws(() => createFeaturePlan({ proposal: plan, config: changed, workRequest, baselineCommit: BASELINE, client: 'host' }), FeaturePlanError);
  }
  const modified = structuredClone(plan);
  modified.nodes[2].budget.tokenLimit = config.orchestration.roles.find(r => r.kind === 'worker').budget.tokenLimit + 1;
  assert.throws(() => createFeaturePlan({ proposal: modified, config, workRequest, baselineCommit: BASELINE, client: 'host' }), FeaturePlanError);
});

test('spawned managed proposals expose approved model selection while preserving legacy client profile', async () => {
  const { managedPolicy } = await import('../fixtures/execution-policy.js');
  const config = structuredClone(await configuration());
  config.orchestration.executionPolicy = managedPolicy();
  let received;
  const planner = createFeaturePlanner({ planningClient: { async propose(contract) { received = contract; return decomposition(); } } });
  const plan = await planner.propose({ config, workRequest: request(), baselineCommit: BASELINE, client: 'claude' });
  assert.equal(received.policy.executionPolicy.version, 1);
  assert.equal(plan.clientProfile.id, 'claude-bounded-sonnet-v1');
  const worker = plan.nodes.find(node => node.role === 'worker');
  assert.equal(worker.executionSelection.harness, 'codex');
  assert.equal(worker.executionSelection.classification, 'implementation');
  assert.equal(worker.executionSelection.recommendationOnly, false);
  const proposal = structuredClone(plan);
  delete proposal.nodes.find(node => node.role === 'worker').executionSelection;
  assert.throws(() => createFeaturePlan({ proposal, config, workRequest: request(), baselineCommit: BASELINE, client: 'claude' }), FeaturePlanError);
});

test('published legacy client profile schema rejects managed execution selection fields', async () => {
  const { readFile } = await import('node:fs/promises');
  const { default: Ajv } = await import('ajv');
  const { CLAUDE_FEATURE_PROFILE } = await import('../../src/feature/client-profile.js');
  const schema = JSON.parse(await readFile(new URL('../../schemas/feature-plan.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv({ strict: true }).compile(schema.$defs.clientProfile);
  const { resolveExecutionSelection } = await import('../../src/models/execution-policy.js');
  const { managedPolicy } = await import('../fixtures/execution-policy.js');
  assert.equal(validate(CLAUDE_FEATURE_PROFILE), true);
  assert.equal(validate({ ...CLAUDE_FEATURE_PROFILE, executionSelection: resolveExecutionSelection(managedPolicy(), 'implementation') }), false);
});

test('configured Claude spending caps are sealed in planning and Worker profiles and reject policy drift', async () => {
  const original = await configuration(), workRequest = request();
  for (const caps of [{planningMaxCostUsd: 3.5}, {workerMaxCostUsd: 4.25}, {planningMaxCostUsd: 3.5, workerMaxCostUsd: 4.25}]) {
    for (const [client, harness] of [['claude', undefined], ['codex', 'claude'], ['claude', 'codex']]) {
      const config = structuredClone(original);
      config.project.claude = caps;
      if (harness) config.orchestration.roles.find(role => role.kind === 'worker').harness = harness;
      let contract;
      const planner = createFeaturePlanner({planningClient: {propose: async input => { contract = input; return decomposition(); }}});
      const plan = await planner.propose({config, workRequest, baselineCommit: BASELINE, client});
      const expectedPlanning = caps.planningMaxCostUsd ?? 1, expectedWorker = caps.workerMaxCostUsd ?? 2;
      if (client === 'claude') {
        assert.equal(contract.clientProfile.planning.maxCostUsd, expectedPlanning);
        assert.equal(plan.clientProfile.planning.maxCostUsd, expectedPlanning);
        assert.equal(plan.clientProfile.execution.maxCostUsd, expectedWorker);
      } else assert.equal(plan.clientProfile, undefined);
      const worker = plan.nodes.find(node => node.role === 'worker');
      if (harness === 'claude') assert.equal(worker.execution.clientProfile.execution.maxCostUsd, expectedWorker);
      if (harness === 'codex') assert.equal(worker.execution.clientProfile, undefined);
      const changed = structuredClone(config);
      changed.project.claude.workerMaxCostUsd = 8;
      assert.throws(() => createFeaturePlan({proposal: plan, config: changed, workRequest, baselineCommit: BASELINE, client}), FeaturePlanError);
      assert.ok(Object.isFrozen(plan));
    }
  }
});

test('managed Claude routes retain configured spending caps across planner harnesses', async () => {
  const {managedPolicy} = await import('../fixtures/execution-policy.js');
  const {executionForNode} = await import('../../src/feature/client-profile.js');
  for (const client of ['claude', 'codex']) for (const cap of [0.25, 4.5]) {
    const config = structuredClone(await configuration());
    config.project.claude = {planningMaxCostUsd: cap, workerMaxCostUsd: cap};
    config.orchestration.executionPolicy = managedPolicy();
    config.orchestration.executionPolicy.profiles.implementation.harness = 'claude';
    let contract;
    const planner = createFeaturePlanner({planningClient: {propose: async input => {contract = input; return decomposition();}}});
    const workRequest = request();
    const plan = await planner.propose({config, workRequest, baselineCommit: BASELINE, client});
    assert.equal(contract.clientProfile.planning.maxCostUsd, cap);
    const worker = plan.nodes.find(node => node.role === 'worker');
    assert.equal(executionForNode(plan, worker).clientProfile.execution.maxCostUsd, cap);
    for (const mutate of [p => {delete p.managedClaudeProfile;}, p => {p.managedClaudeProfile.execution.maxCostUsd = 9;}]) {
      const proposal = structuredClone(plan); mutate(proposal);
      assert.throws(() => createFeaturePlan({proposal, config, workRequest, baselineCommit: BASELINE, client}), FeaturePlanError);
    }
    const changed = structuredClone(config); changed.project.claude.workerMaxCostUsd = 8;
    assert.throws(() => createFeaturePlan({proposal: plan, config: changed, workRequest, baselineCommit: BASELINE, client}), FeaturePlanError);
  }
});

function graphDecomposition() {
  const value = decomposition();
  value.workItems.forEach((item, index) => Object.assign(item, { id: `work-${index}`, dependencies: [] }));
  return value;
}

test('explicit dependency graphs retain stable IDs and allow independent siblings', async () => {
  const config = await configuration();
  const input = { config, workRequest: request(), baselineCommit: BASELINE, decomposition: graphDecomposition() };
  const plan = createHostFeaturePlan(input);
  assert.deepEqual(plan.nodes.filter(n => n.role === 'worker').map(n => [n.id, n.dependencies]), [
    ['work-0', ['management']], ['work-1', ['management']],
  ]);
  input.decomposition.workItems[0].dependencies = ['work-1'];
  const dependent = createHostFeaturePlan(input);
  assert.deepEqual(dependent.nodes.filter(n => n.role === 'worker').map(n => [n.id, n.dependencies]), [
    ['work-1', ['management']], ['work-0', ['work-1']],
  ]);
  assert.notEqual(featurePlanDigest(plan), featurePlanDigest(dependent));
});

test('explicit graphs serialize overlapping paths and named shared resources deterministically', async () => {
  const config = await configuration();
  for (const conflict of ['path', 'resource']) {
    const value = graphDecomposition();
    if (conflict === 'path') value.workItems[1].ownedPaths = ['APP/agenda/child.js'];
    else value.workItems.forEach(item => { item.sharedResources = ['test-database']; });
    const input = { config, workRequest: request(), baselineCommit: BASELINE, decomposition: value };
    const plan = createHostFeaturePlan(input);
    assert.deepEqual(plan.nodes[3].dependencies, ['work-0']);
    if (conflict === 'resource') {
      assert.deepEqual(plan.nodes[2].sharedResources, ['test-database']);
      const proposal = structuredClone(plan);
      proposal.nodes[3].dependencies = ['management'];
      assert.throws(() => createFeaturePlan({ proposal, config, workRequest: input.workRequest, baselineCommit: BASELINE, client: 'host' }));
    }
    value.workItems[0].dependencies = ['work-1'];
    const reversed = createHostFeaturePlan(input);
    assert.deepEqual(reversed.nodes[3].dependencies, ['work-1']);
  }
});

test('rejects incomplete, duplicate, reserved, unknown, self and cyclic dependency metadata', async () => {
  const config = await configuration();
  const edits = [
    value => { delete value.workItems[0].id; },
    value => { delete value.workItems[0].dependencies; },
    value => { delete value.workItems[0].id; delete value.workItems[0].dependencies; },
    value => { value.workItems[1].id = 'work-0'; },
    value => { value.workItems[0].id = 'management'; },
    value => { value.workItems[0].dependencies = ['missing']; },
    value => { value.workItems[0].dependencies = ['work-0']; },
    value => { value.workItems[0].dependencies = ['work-1']; value.workItems[1].dependencies = ['work-0']; },
    value => { value.workItems[0].dependencies = ['work-1', 'work-1']; },
    value => { value.workItems[0].sharedResources = ['Database']; },
  ];
  for (const edit of edits) {
    const value = graphDecomposition(); edit(value);
    assert.throws(() => createHostFeaturePlan({ config, workRequest: request(), baselineCommit: BASELINE, decomposition: value }), error => error.details.reason === 'decomposition-invalid');
  }
});

test('pins explicit graph parallelism to policy and leaves legacy plans unchanged', async () => {
  const { managedPolicy } = await import('../fixtures/execution-policy.js');
  const base = await configuration();
  for (const managed of [false, true]) {
    const config = structuredClone(base);
    if (managed) config.orchestration.executionPolicy = managedPolicy();
    const input = { config, workRequest: request(), baselineCommit: BASELINE, decomposition: graphDecomposition() };
    const plan = createHostFeaturePlan(input);
    assert.equal(plan.maxParallelWorkers, managed ? 2 : 1);
    const proposal = structuredClone(plan);
    proposal.maxParallelWorkers += 1;
    assert.throws(() => createFeaturePlan({ proposal, config, workRequest: input.workRequest, baselineCommit: BASELINE, client: 'host' }));
    const legacy = createHostFeaturePlan({ ...input, decomposition: decomposition() });
    assert.equal(Object.hasOwn(legacy, 'maxParallelWorkers'), false);
  }
});

test('retains fan-in dependencies and deterministic compilation through the planning client', async () => {
  const config = await configuration();
  const value = graphDecomposition();
  value.workItems.push({ id: 'join', dependencies: ['work-0', 'work-1'], objective: 'Integrate exports', ownedPaths: ['app/integration'], acceptanceCriterionIndexes: [1, 2] });
  const planner = createFeaturePlanner({ planningClient: { propose: async () => value } });
  const input = { config, workRequest: request(), baselineCommit: BASELINE, client: 'codex' };
  const plan = await planner.propose(input);
  assert.deepEqual(plan.nodes.find(node => node.id === 'join').dependencies, ['work-0', 'work-1']);
  assert.deepEqual(plan.nodes.at(-1).dependencies, ['work-0', 'work-1', 'join']);
  assert.equal(featurePlanDigest(plan), featurePlanDigest(await planner.propose(input)));
});
