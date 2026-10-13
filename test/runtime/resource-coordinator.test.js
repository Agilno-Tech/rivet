import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createResourceCoordinator } from '../../src/runtime/resource-coordinator.js';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rivet-machine-'));
  return {
    root,
    coordinator: createResourceCoordinator({
      root: join(root, 'machine'),
    }),
  };
}
const deadline = () => Date.now() + 60000;
const owned = (id, status) => ({
  version: 1,
  executionId: id,
  processId: process.pid,
  processGroupId: process.pid,
  ownerProcessId: process.pid,
  processBirth: null,
  observedAtMs: Date.now(),
  source: 'owned-process',
  assurance: 'observed',
  status,
});
test('lazy reads and five task FIFO admissions share four slots', async () => {
  const { root, coordinator: c } = await fixture();
  assert.equal((await c.inspect()).configured, false);
  const p = await c.register({
    projectRoot: root,
    deadlineMs: deadline(),
  });
  const claims = [];
  for (let i = 0; i < 5; i++) {
    const r = await c.register({
      projectRoot: root,
      runId: `run-${i}`,
      deadlineMs: deadline(),
    });
    claims.push(
      await c.request({
        registrationId: r.id,
        resource: 'activeTasks',
        idempotencyKey: `task-${i}`,
        generation: 1,
      }),
    );
  }
  assert.deepEqual(
    claims.map((x) => x.status),
    ['held', 'held', 'held', 'held', 'queued'],
  );
  await c.release({
    claimId: claims[0].id,
    generation: 1,
    completed: true,
  });
  assert.equal(
    (await c.inspect()).claims.find((x) => x.id === claims[4].id).status,
    'held',
  );
  assert.equal(p.runId, null);
});
test('unknown execution retains capacity and generation/idempotency are fenced', async () => {
  const { root, coordinator: c } = await fixture();
  const r = await c.register({
    projectRoot: root,
    runId: 'run-one',
    deadlineMs: deadline(),
    machineLimits: {
      activeTasks: 4,
      agentExecutions: 1,
      heavyVerification: 1,
      dependencyInstalls: 1,
    },
  });
  const request = {
    registrationId: r.id,
    resource: 'agentExecutions',
    idempotencyKey: 'agent-one',
    generation: 1,
  };
  const a = await c.request(request);
  assert.equal((await c.request(request)).id, a.id);
  await c.execution({
    claimId: a.id,
    generation: 1,
    receipt: owned('one', 'started'),
  });
  await c.execution({
    claimId: a.id,
    generation: 1,
    receipt: owned('one', 'unknown'),
  });
  assert.equal(
    (
      await c.request({
        ...request,
        idempotencyKey: 'agent-two',
      })
    ).status,
    'queued',
  );
  await assert.rejects(
    c.release({
      claimId: a.id,
      generation: 2,
      completed: true,
    }),
  );
  await assert.rejects(
    c.release({
      claimId: a.id,
      generation: 1,
      completed: true,
    }),
  );
  await c.execution({
    claimId: a.id,
    generation: 1,
    receipt: owned('one', 'stopped'),
  });
  assert.equal(
    (await c.inspect()).claims.find((x) => x.id === a.id).status,
    'released',
  );
});
test('reregistration preserves deadline and cannot raise machine ceilings', async () => {
  const { root, coordinator: c } = await fixture();
  const d = deadline();
  const r = await c.register({
    projectRoot: root,
    deadlineMs: d,
  });
  assert.equal(
    (
      await c.register({
        projectRoot: root,
        deadlineMs: d + 5000,
      })
    ).deadlineMs,
    d,
  );
  await assert.rejects(
    c.register({
      projectRoot: root,
      deadlineMs: d,
      machineLimits: {
        activeTasks: 8,
        agentExecutions: 8,
        heavyVerification: 1,
        dependencyInstalls: 1,
      },
    }),
  );
  await c.pause(r.id);
  assert.equal(
    (
      await c.request({
        registrationId: r.id,
        resource: 'agentExecutions',
        idempotencyKey: 'plan',
        generation: 1,
      })
    ).reason,
    'paused',
  );
});
test('unsafe private root rejected', async () => {
  const { root } = await fixture();
  await mkdir(join(root, 'unsafe'));
  await chmod(join(root, 'unsafe'), 0o755);
  await assert.rejects(
    createResourceCoordinator({
      root: join(root, 'unsafe'),
    }).register({
      projectRoot: root,
      deadlineMs: deadline(),
    }),
  );
  await symlink(root, join(root, 'link'));
  await assert.rejects(
    createResourceCoordinator({
      root: join(root, 'link'),
    }).register({
      projectRoot: root,
      deadlineMs: deadline(),
    }),
  );
});
test('independent processes contend for one agent without overadmission', async () => {
  const { root, coordinator: c } = await fixture();
  const r = await c.register({
    projectRoot: root,
    runId: 'one',
    deadlineMs: deadline(),
    machineLimits: {
      activeTasks: 4,
      agentExecutions: 1,
      heavyVerification: 1,
      dependencyInstalls: 1,
    },
  });
  const otherRoot = join(root, 'other-project');
  await mkdir(otherRoot);
  const other = await c.register({
    projectRoot: otherRoot,
    runId: 'two',
    deadlineMs: deadline(),
  });
  const url = new URL(
    '../../src/runtime/resource-coordinator.js',
    import.meta.url,
  ).href;
  const launch = (id, registrationId) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        '--input-type=module',
        '-e',
        `import {createResourceCoordinator} from ${JSON.stringify(
          url,
        )}; const c=createResourceCoordinator({root:${JSON.stringify(
          join(root, 'machine'),
        )}}); console.log(JSON.stringify(await c.request({registrationId:${JSON.stringify(
          registrationId,
        )},resource:'agentExecutions',idempotencyKey:${JSON.stringify(
          id,
        )},generation:1})));`,
      ]);
      let out = '';
      let err = '';
      child.stdout.on('data', (x) => (out += x));
      child.stderr.on('data', (x) => (err += x));
      child.on('close', (code) =>
        code ? reject(new Error(err)) : resolve(JSON.parse(out)),
      );
    });
  const results = await Promise.all([
    launch('first', r.id),
    launch('second', other.id),
  ]);
  assert.deepEqual(results.map((x) => x.status).sort(), ['held', 'queued']);
});
test('restart with reused parent PID cannot release dispatched unknown descendants', async () => {
  const { root, coordinator: c } = await fixture();
  const r = await c.register({
    projectRoot: root,
    runId: 'reused',
    deadlineMs: deadline(),
  });
  const a = await c.request({
    registrationId: r.id,
    resource: 'agentExecutions',
    idempotencyKey: 'agent',
    generation: 1,
  });
  await c.dispatch({
    claimId: a.id,
    generation: 1,
  });
  const reopened = createResourceCoordinator({
    root: join(root, 'machine'),
    now: () => Date.now() + 100000,
  });
  assert.equal(
    (await reopened.inspect()).claims.find((x) => x.id === a.id).status,
    'held',
  );
  await assert.rejects(
    reopened.release({
      claimId: a.id,
      generation: 1,
      completed: true,
    }),
  );
  await assert.rejects(
    reopened.execution({
      claimId: a.id,
      generation: 1,
      receipt: owned('reused-pid', 'stopped'),
    }),
  );
  assert.equal(
    (await reopened.inspect()).claims.find((x) => x.id === a.id).status,
    'held',
  );
});
test('machine caps cannot change while owners hold leases and per-run worker caps queue', async () => {
  const { root, coordinator: c } = await fixture();
  const r = await c.register({
    projectRoot: root,
    runId: 'capped',
    deadlineMs: deadline(),
    limits: {
      workersPerTask: 1,
    },
  });
  await c.request({
    registrationId: r.id,
    resource: 'agentExecutions',
    idempotencyKey: 'one',
    generation: 1,
  });
  assert.equal(
    (
      await c.request({
        registrationId: r.id,
        resource: 'agentExecutions',
        idempotencyKey: 'two',
        generation: 1,
      })
    ).reason,
    'run-agentExecutions',
  );
  await assert.rejects(
    c.configure({
      activeTasks: 8,
      agentExecutions: 8,
      heavyVerification: 1,
      dependencyInstalls: 1,
    }),
  );
});

test('coordinator pins machine root identity and rejects replacement after enrollment', async () => {
  const { root, coordinator: c } = await fixture();
  await c.register({ projectRoot: root, deadlineMs: deadline() });
  const { rename } = await import('node:fs/promises');
  await rename(join(root, 'machine'), join(root, 'prior'));
  await mkdir(join(root, 'machine'), { mode: 0o700 });
  await assert.rejects(c.inspect(), /Unsafe private machine state/);
});

test('no-execution proof is bound to one dispatched attempt and rejects fabricated evidence', async () => {
  const {withExecutionProof,observeExecutionAttempt}=await import('../../src/clients/execution-proof.js');
  const {root,coordinator:c}=await fixture();
  const registration=await c.register({projectRoot:root,runId:'proof-run',deadlineMs:deadline()});
  const first=await c.request({registrationId:registration.id,resource:'agentExecutions',idempotencyKey:'first',generation:1});
  const second=await c.request({registrationId:registration.id,resource:'agentExecutions',idempotencyKey:'second',generation:1});
  await c.dispatch({claimId:first.id,generation:1,dispatchId:'first-attempt'});
  await c.dispatch({claimId:second.id,generation:1,dispatchId:'second-attempt'});
  let proof;
  await assert.rejects(withExecutionProof('first-attempt',()=>{observeExecutionAttempt();throw new Error('preflight');},value=>{proof=value;}));
  await assert.rejects(c.release({claimId:second.id,generation:1,completed:true,dispatchId:'second-attempt',noExecutionProof:proof}));
  await assert.rejects(c.release({claimId:second.id,generation:1,completed:true,dispatchId:'second-attempt',noExecutionProof:{}}));
  await c.release({claimId:first.id,generation:1,completed:true,dispatchId:'first-attempt',noExecutionProof:proof});
  assert.equal((await c.inspect()).claims.find(x=>x.id===second.id).status,'held');
  let reconciled=false;
  await assert.rejects(withExecutionProof('possible-child',()=>{observeExecutionAttempt()();throw new Error('spawn-failed');},()=>{reconciled=true;}));
  assert.equal(reconciled,false);
});
