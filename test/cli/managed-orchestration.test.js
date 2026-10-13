import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { createManagedOrchestration } from '../../src/runtime/managed-orchestration.js';
const execFile = promisify(callback);
const cli = new URL('../../bin/cli.js', import.meta.url).pathname;
async function fixture(t) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), 'rivet-managed-cli-')),
  );
  t.after(() =>
    rm(parent, {
      recursive: true,
      force: true,
    }),
  );
  const root = join(parent, 'project');
  await mkdir(root);
  await cp(
    new URL('../fixtures/config/valid/.rivet/', import.meta.url),
    join(root, '.rivet'),
    {
      recursive: true,
    },
  );
  await execFile('/usr/bin/git', ['init', '-q', '--initial-branch=main', root]);
  await execFile('/usr/bin/git', ['-C', root, 'add', '.']);
  await execFile('/usr/bin/git', [
    '-C',
    root,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
  const machine = join(parent, 'machine');
  const call = async (...args) =>
    JSON.parse(
      (
        await execFile(
          process.execPath,
          [cli, 'orchestrate', ...args, '--json'],
          {
            cwd: root,
            env: {
              ...process.env,
              RIVET_MACHINE_STATE_ROOT: machine,
            },
          },
        )
      ).stdout,
    ).result;
  return {
    root,
    machine,
    call,
  };
}
test('normal CLI persists explicit registration pause resume limits and planning renewal', async (t) => {
  const { root, call } = await fixture(t);
  assert.equal((await call('status')).configured, false);
  const deadline = Date.now() + 60000;
  const registered = await call(
    'register',
    `--project=${root}`,
    `--deadline-ms=${deadline}`,
  );
  assert.equal(
    (await call('status', registered.id)).registration.projectRoot,
    root,
  );
  assert.equal((await call('pause', registered.id)).paused, true);
  assert.equal((await call('resume', registered.id)).paused, false);
  assert.equal(
    (
      await call(
        'register',
        `--project=${root}`,
        `--deadline-ms=${deadline + 5000}`,
      )
    ).deadlineMs,
    deadline,
  );
  assert.equal(
    (await call('renew', registered.id, `--deadline-ms=${deadline + 10000}`))
      .deadlineMs,
    deadline + 10000,
  );
  assert.equal(
    (
      await call(
        'limits',
        '--limits-json={"activeTasks":2,"agentExecutions":2,"heavyVerification":1,"dependencyInstalls":1}',
      )
    ).activeTasks,
    2,
  );
});
test('managed watch preserves run deadline across restarted services and stops at decisions', async (t) => {
  const { root, machine } = await fixture(t);
  let clock = Date.now();
  let executions = 0;
  const workflow = {
    status: async () => ({
      status: 'proposed',
      version: 1,
    }),
    resume: async () => {
      executions++;
      return {
        status: 'complete',
      };
    },
  };
  const make = () =>
    createManagedOrchestration({
      root: machine,
      gitClient: async () => ({
        inspectRepository: async () => ({
          root,
        }),
      }),
      workflow,
      now: () => clock,
    });
  let service = make();
  const r = await service.register({
    projectRoot: root,
    runId: 'run-one',
    deadlineMs: clock + 1000,
  });
  assert.equal(
    (
      await service.watch(r.id, {
        deadlineMs: clock + 5000,
      })
    ).terminal,
    'decision-required',
  );
  clock += 1001;
  service = make();
  assert.equal(
    (
      await service.watch(r.id, {
        deadlineMs: clock + 100000,
      })
    ).terminal,
    'deadline',
  );
  assert.equal(executions, 0);
});

test('managed host watch stops after preparation crosses its own cutoff', async t => {
 const {root,machine}=await fixture(t);
 let clock=Date.now();let nextCalls=0;let received;
 const service=createManagedOrchestration({root:machine,gitClient:async()=>null,now:()=>clock,
  workflow:{status:async()=>({status:'approved',version:1,featurePlan:{client:'host'}})},
  work:{status:async()=>({runtime:{version:1}}),prepare:async(_request,options)=>{received=options;clock+=1001;return {runtimeVersion:1};},nextAction:async()=>{nextCalls++;return {status:'action'};}}});
 const r=await service.coordinator.register({projectRoot:root,runId:'host-cutoff',deadlineMs:clock+60000});
 const result=await service.watch(r.id,{deadlineMs:clock+500});
 assert.equal(result.terminal,'deadline');assert.equal(nextCalls,0);assert.ok(received.signal instanceof AbortSignal);
});

test('managed host watch honors explicit cancellation during slow preparation', async t => {
 const {root,machine}=await fixture(t);
 const controller=new AbortController();let nextCalls=0;let received;
 const service=createManagedOrchestration({root:machine,gitClient:async()=>null,
  workflow:{status:async()=>({status:'approved',version:1,featurePlan:{client:'host'}})},
  work:{status:async()=>({runtime:{version:1}}),prepare:async(_request,options)=>{received=options;await new Promise(resolve=>setTimeout(resolve,20));controller.abort();return {runtimeVersion:1};},nextAction:async()=>{nextCalls++;return {status:'action'};}}});
 const r=await service.coordinator.register({projectRoot:root,runId:'host-cancel',deadlineMs:Date.now()+60000});
 const result=await service.watch(r.id,{deadlineMs:Date.now()+30000,signal:controller.signal});
 assert.equal(result.terminal,'cancelled');assert.equal(nextCalls,0);assert.equal(received.signal.aborted,true);
});
