import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { main } from '../../src/cli/main.js';
import { EXIT_CODES } from '../../src/cli/output.js';
import { loadProjectConfig } from '../../src/config/load.js';
import { featurePlanDigest } from '../../src/feature/plan-contract.js';
import { createFeaturePlanner, createHostFeaturePlan } from '../../src/feature/planner.js';
import { createFeatureRunStore } from '../../src/feature/run-store.js';
import { resolveFeatureRunPaths } from '../../src/state/paths.js';
import { createWorkRequest } from '../../src/work-request/contract.js';

const execFile = promisify(execFileCallback);
const CONFIG = new URL('../fixtures/config/valid/.rivet/', import.meta.url);
const NOW = '2029-01-01T00:00:00.000Z';
const BASELINE = 'a'.repeat(40);

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rivet-human-task-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFile('/usr/bin/git', ['-C', root, 'init', '-q']);
  await cp(CONFIG, join(root, '.rivet'), { recursive: true });
  return root;
}

async function createRun(root, runId, client = 'codex') {
  const config = await loadProjectConfig(root);
  const workRequest = createWorkRequest({
    source: { kind: 'inline', ref: 'inline' }, title: `Task ${runId}`,
    description: `Implement task ${runId}.`, acceptanceCriteria: [`Complete ${runId}`],
    contextRefs: [], capturedAt: NOW,
  });
  const decomposition = {
    schemaVersion: 1, kind: 'agilno.feature-decomposition',
    workItems: [{ objective: `Complete ${runId}`, ownedPaths: ['app/agenda.js'], acceptanceCriterionIndexes: [1] }],
  };
  const featurePlan = client === 'host'
    ? createHostFeaturePlan({ config, workRequest, baselineCommit: BASELINE, decomposition })
    : await createFeaturePlanner({ planningClient: { async propose() { return decomposition; } } })
      .propose({ config, workRequest, baselineCommit: BASELINE, client });
  const store = createFeatureRunStore(await resolveFeatureRunPaths(root, runId));
  const record = await store.create({ workRequest, featurePlan, createdAt: NOW });
  assert.equal(record.proposalDigest, featurePlanDigest(featurePlan));
  return { store, record };
}

function overrides(root, messages, services = {}) {
  return {
    cwd: () => root,
    output: { log: value => messages.push(value), error: value => messages.push(value), json() {} },
    work: { async status() { return { run: { status: 'proposed' }, nextAction: 'Review the proposal.', verification: null, checkout: null }; } },
    ...services,
  };
}

test('task status selects the sole project-local run without an ID or project flag', async t => {
  const root = await fixture(t);
  await createRun(root, 'first-task');
  const messages = [];
  assert.equal(await main(['task', 'status'], overrides(root, messages)), EXIT_CODES.SUCCESS);
  assert.match(messages.join('\n'), /^Run: first-task$/m);
  assert.match(messages.join('\n'), /Task: Complete first-task/);
  assert.match(messages.join('\n'), /Next: rivet task start --run=first-task/);
});

test('task deps selects the run but refuses installation before an accepted checkout exists', async t => {
  const root = await fixture(t);
  await createRun(root, 'first-task');
  const messages = [];
  let confirmations = 0;
  const result = await main(['task', 'deps'], overrides(root, messages, {
    terminalIsInteractive: () => true,
    confirmDependencyInstall: async () => { confirmations += 1; return true; },
    resolveCommandExecutable: async () => '/usr/bin/git',
  }));
  assert.equal(result, EXIT_CODES.REPOSITORY_CONFLICT, messages.join('\n'));
  assert.equal(confirmations, 0);
  assert.match(messages.join('\n'), /no eligible isolated checkout/);
});

test('multiple or corrupt private runs cannot be silently inferred', async t => {
  const root = await fixture(t);
  await createRun(root, 'first-task');
  await createRun(root, 'second-task');
  const messages = [];
  assert.equal(await main(['task', 'status'], overrides(root, messages)), EXIT_CODES.INVALID_INPUT);
  assert.match(messages.join('\n'), /first-task.*second-task/s);
  const paths = await resolveFeatureRunPaths(root, 'second-task');
  await writeFile(paths.snapshotPath, '{broken\n', { mode: 0o600 });
  const after = [];
  assert.equal(await main(['task', 'status'], overrides(root, after)), EXIT_CODES.REPOSITORY_CONFLICT);
  assert.match(after.join('\n'), /unsafe state|discovery failed/i);
});

test('host resume gives guidance without launching a spawned worker', async t => {
  const root = await fixture(t);
  await createRun(root, 'host-task', 'host');
  const messages = [];
  const services = overrides(root, messages, {
    feature: { async resume() { throw new Error('must not spawn'); } },
  });
  assert.equal(await main(['task', 'resume'], services), EXIT_CODES.SUCCESS);
  assert.match(messages.join('\n'), /^Run: host-task$/m);
  assert.match(messages.join('\n'), /Continue in the coding harness/);
});

test('task status presents the stored check evidence and source paths', async t => {
  const root = await fixture(t);
  await createRun(root, 'checked-task');
  const messages = [];
  const services = overrides(root, messages, {
    work: { async status() { return {
      run: { status: 'blocked' }, nextAction: 'Repair the environment.',
      verification: {
        status: 'fail', commitSha: BASELINE,
        changedPaths: ['app/agenda.js'],
        checks: [{ id: 'test', status: 'failed', cwd: 'backend' }],
        failure: 'Required test failed.',
      },
      checkout: { path: join(root, 'integration'), status: 'clean' },
    }; } },
  });
  assert.equal(await main(['task', 'status'], services), EXIT_CODES.SUCCESS);
  const shown = messages.join('\n');
  assert.match(shown, /Changed: app\/agenda\.js/);
  assert.match(shown, /Check: test failed \(backend\)/);
  assert.match(shown, /Failure: Required test failed/);
});


test('task status distinguishes the planner from the configured worker harness', async t => {
  const root=await fixture(t),path=join(root,'.rivet','orchestration.yaml');
  await writeFile(path,(await readFile(path,'utf8')).replace('    kind: worker','    kind: worker\n    harness: claude'));
  await createRun(root,'cross-harness-task');const messages=[];
  assert.equal(await main(['task','status'],overrides(root,messages)),EXIT_CODES.SUCCESS);
  assert.match(messages.join('\n'),/Planning harness: codex/);
  assert.match(messages.join('\n'),/Worker harnesses: claude/);
});

test('task status and host resume render Worker checkout guidance with visible escaping', async t => {
  const root = await fixture(t);
  await createRun(root, 'worker-guidance', 'host');
  for (const command of ['status', 'resume']) {
    const messages = [];
    const services = overrides(root, messages, { work: { async status() { return {
      run: { status: 'running' }, nextAction: 'Continue.',
      workerCheckouts: [{ nodeId: 'worker-one', path: '/tmp/worker\u001b[31m', status: 'dirty',
        expectedBranch: 'worker/task/one', observedBranch: 'other', reservationStatus: 'active', leaseExpired: true,
        dirtyPaths: ['app/evil\nname.js'], branchLocations: ['/tmp/other'], nextAction: 'Inspect edits.' }],
    }; } } });
    assert.equal(await main(['task', command], services), EXIT_CODES.SUCCESS);
    const output = messages.join('\n');
    assert.match(output, /Worker checkout: worker-one/);
    assert.match(output, /lease expired/);
    assert.match(output, /Inspect edits/);
    assert.ok(!output.includes('\u001b'));
    assert.ok(!output.includes('app/evil\nname.js'));
  }
});

test('ambiguous automatic status and resume expose choices without choosing a continuation run', async t => {
  const root=await fixture(t);await createRun(root,'host-one','host');await createRun(root,'host-two','host');
  for(const command of ['status','resume']) {
    const messages=[];let selected=0;
    const code=await main(['task',command],overrides(root,messages,{work:{async status(){selected++;throw new Error('must not select');}}}));
    assert.equal(code,EXIT_CODES.INVALID_INPUT);assert.equal(selected,0);
    assert.match(messages.join('\n'),/host-one.*host-two/s);
    assert.doesNotMatch(messages.join('\n'),/^Run:/m);
  }
});

for (const command of ['start', 'resume']) {
  test(`task ${command} reviews a saved proposal before exact activation and execution`, async t => {
    const root = await fixture(t); const {record} = await createRun(root, 'saved-task');
    const messages = [], calls = [];
    const code = await main(['task', command, '--run=saved-task'], overrides(root, messages, {
      terminalIsInteractive: () => true,
      taskApprovalPrompt: async () => 'leave',
      work: {async status(){return {deliveryReady:true,checkout:{acceptedCommit:BASELINE,path:'/tmp/integration'},verification:{changedPaths:[],checks:[]}};}},
      harnesses: {async select(kind) { calls.push(`select:${kind}`); return {kind, version:'test', executable:'/bin/codex'}; }},
      confirmFeatureActivation: async value => {
        assert.equal(value.proposalDigest, record.proposalDigest);
        assert.match(messages.join('\n'), /app\/agenda.js/);
        assert.match(messages.join('\n'), /Required checks:/);
        calls.push('approve'); return true;
      },
      feature: {
        async start(value) {assert.deepEqual(value,{project:root,runId:record.runId,expectedVersion:record.version,proposalDigest:record.proposalDigest});calls.push('start');return {version:2};},
        async watch(value) {assert.equal(value.expectedVersion,2);calls.push('watch');return {status:'awaiting-final-approval'};},
      },
    }));
    assert.equal(code, EXIT_CODES.SUCCESS, messages.join('\n'));
    assert.deepEqual(calls.slice(-3), ['approve','start','watch']);
  });
}

test('declining saved proposal review preserves the proposal without dispatch', async t => {
  const root=await fixture(t);const {store}=await createRun(root,'declined-task');const messages=[];
  const code=await main(['task','start'],overrides(root,messages,{
    terminalIsInteractive:()=>true,
    harnesses:{async select(kind){return {kind,version:'test',executable:'/bin/codex'};}},
    confirmFeatureActivation:async()=>false,
    feature:{async start(){assert.fail('must not activate');},async watch(){assert.fail('must not execute');}},
  }));
  assert.equal(code,EXIT_CODES.SUCCESS,messages.join('\n'));assert.equal((await store.readOnly()).status,'proposed');
  assert.match(messages.join('\n'),/rivet task start --run=declined-task/);
});

test('task approve requires a verified result and never treats a proposal as final approval', async t => {
  const root=await fixture(t);await createRun(root,'not-ready');const messages=[];
  const code=await main(['task','approve'],overrides(root,messages,{terminalIsInteractive:()=>true}));
  assert.equal(code,EXIT_CODES.REPOSITORY_CONFLICT,messages.join('\n'));
  assert.match(messages.join('\n'),/verified result|final review/);
});

test('saved proposal cannot start after project policy changes during review',async t=>{
  const root=await fixture(t);await createRun(root,'changed-policy');const messages=[];let started=false;
  const code=await main(['task','start'],overrides(root,messages,{
    terminalIsInteractive:()=>true,
    harnesses:{async select(kind){return {kind,version:'test',executable:'/bin/codex'};}},
    confirmFeatureActivation:async()=>{
      const path=join(root,'.rivet','project.yaml');
      await writeFile(path,(await readFile(path,'utf8')).replaceAll('npm','yarn'));
      return true;
    },
    feature:{async start(){started=true;return {version:2};},async watch(){return {status:'awaiting-final-approval'};}},
  }));
  assert.equal(code,EXIT_CODES.REPOSITORY_CONFLICT,messages.join('\n'));assert.equal(started,false);
});

async function finalReviewRun(root, runId) {
  const {store,record}=await createRun(root,runId);
  let next=await store.update({status:'approved',updatedAt:NOW,runtimeRefs:[],evidenceRefs:[],activation:{approverId:'user',approvedAt:NOW,requestDigest:record.workRequest.digest,proposalDigest:record.proposalDigest}},{expectedVersion:1});
  next=await store.update({status:'running',updatedAt:NOW,runtimeRefs:[],evidenceRefs:[]},{expectedVersion:next.version});
  await store.update({status:'awaiting-final-approval',updatedAt:NOW,runtimeRefs:[],evidenceRefs:[]},{expectedVersion:next.version});
  return store;
}

for(const choice of [null,undefined]) test(`cancelling final choice (${choice}) preserves verified work without Git actions`,async t=>{
  const root=await fixture(t),store=await finalReviewRun(root,'final-task'),messages=[];
  const code=await main(['task','approve'],overrides(root,messages,{
    terminalIsInteractive:()=>true,
    work:{async status(){return {deliveryReady:true,checkout:{acceptedCommit:BASELINE,path:'/tmp/integration'},verification:{changedPaths:['app/agenda.js'],checks:[{id:'test',status:'passed'}]}};}},
    taskApprovalPrompt:async question=>{assert.deepEqual(question.choices.map(item=>item.value),['review','pull-request','local','leave']);return choice;},
    resolveCommandExecutable:async()=>assert.fail('no Git mutation after cancellation'),
    confirmTaskApplication:async()=>assert.fail('no confirmation after cancellation'),
  }));
  assert.equal(code,EXIT_CODES.SUCCESS,messages.join('\n'));
  assert.equal((await store.readOnly()).status,'awaiting-final-approval');
  assert.match(messages.join('\n'),/Final review cancelled/);
});

test('final approval refuses noninteractive input before showing a completion choice',async t=>{
  const root=await fixture(t);await finalReviewRun(root,'final-task');const messages=[];
  const code=await main(['task','approve'],overrides(root,messages,{
    terminalIsInteractive:()=>false,taskApprovalPrompt:async()=>assert.fail('must not prompt'),
  }));
  assert.equal(code,EXIT_CODES.INVALID_INPUT);assert.match(messages.join('\n'),/interactive terminal/);
});

test('final approval refuses stale verification before offering local application',async t=>{
  const root=await fixture(t);await finalReviewRun(root,'final-task');const messages=[];
  const code=await main(['task','approve'],overrides(root,messages,{
    terminalIsInteractive:()=>true,work:{async status(){return {deliveryReady:false};}},
    taskApprovalPrompt:async()=>assert.fail('must not prompt'),
  }));
  assert.equal(code,EXIT_CODES.REPOSITORY_CONFLICT);assert.match(messages.join('\n'),/current passing checks/);
});

test('task recover selects a finished terminal task without resuming its worker',async t=>{
  const root=await fixture(t);await finalReviewRun(root,'finished-task');const messages=[];let recovered=false;
  const code=await main(['task','recover'],overrides(root,messages,{
    work:{async recover(input){assert.deepEqual(input,{project:root,runId:'finished-task'});recovered=true;return {status:'recovered',recoveredLocks:['host-operation'],nextAction:'Read task status and retry final approval.'};}},
    feature:{async resume(){assert.fail('lock recovery must not resume a worker');}},
  }));
  assert.equal(code,EXIT_CODES.SUCCESS,messages.join('\n'));assert.equal(recovered,true);
});

test('task recover rejects unfinished terminal task even with explicit run selector',async t=>{
  const root=await fixture(t);await createRun(root,'unfinished-task');const messages=[];
  const code=await main(['task','recover','--run=unfinished-task'],overrides(root,messages,{
    work:{async recover(){assert.fail('unfinished terminal tasks are excluded');}},
  }));
  assert.equal(code,EXIT_CODES.REPOSITORY_CONFLICT,messages.join('\n'));assert.match(messages.join('\n'),/never restarts a worker/);
});

test('interactive task choice selects by description and binds only that run',async t=>{
  const root=await fixture(t);await createRun(root,'one');await createRun(root,'two');const messages=[];let selected;
  const code=await main(['task','status'],overrides(root,messages,{
    terminalIsInteractive:()=>true,
    taskSelectionPrompt:async question=>{assert.match(question.choices[1].label,/Complete two/);return 'two';},
    work:{async status(input){selected=input.runId;return {nextAction:'Review.',workerCheckouts:[]};}},
  }));
  assert.equal(code,0,messages.join('\n'));assert.equal(selected,'two');
});

test('leaving task selection does not perform any task action',async t=>{
  const root=await fixture(t);await createRun(root,'one');await createRun(root,'two');const messages=[];
  assert.equal(await main(['task','resume'],overrides(root,messages,{
    terminalIsInteractive:()=>true,taskSelectionPrompt:async()=>null,
    work:{async status(){assert.fail('cancelled selection must not act');}},
    feature:{async start(){assert.fail('cancelled selection must not activate');}},
  })),0);
});

test('resume offers final approval for a verified task instead of only printing a command',async t=>{
  const root=await fixture(t);await finalReviewRun(root,'done');const messages=[];let offered=false;
  assert.equal(await main(['task','resume'],overrides(root,messages,{
    terminalIsInteractive:()=>true,
    work:{async status(){return {deliveryReady:true,checkout:{acceptedCommit:BASELINE,path:'/tmp/integration'},verification:{changedPaths:[],checks:[]}};}},
    taskApprovalPrompt:async()=>{offered=true;return 'leave';},
  })),0);assert.equal(offered,true);
});

test('final review output failure cannot proceed to local application',async t=>{
  const {EventEmitter}=await import('node:events');const {createOutput}=await import('../../src/cli/output.js');
  const root=await fixture(t);await finalReviewRun(root,'done');const stdout=new EventEmitter(),stderr=new EventEmitter();stdout.write=()=>true;stderr.write=()=>true;
  const code=await main(['task','approve'],overrides(root,[],{
    output:createOutput({stdout,stderr}),terminalIsInteractive:()=>true,reportFailure:false,
    work:{async status(){return {deliveryReady:true,checkout:{acceptedCommit:BASELINE,path:'/tmp/integration'},verification:{changedPaths:[],checks:[]}};}},
    taskApprovalPrompt:async()=>{stdout.emit('error',new Error('display failed'));return 'local';},
    resolveCommandExecutable:async()=>assert.fail('no Git after failed review output'),
  }));assert.equal(code,EXIT_CODES.REPOSITORY_CONFLICT);
});
