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

test('batch admission includes paused and expired members even when they joined the queue earlier',async t=>{
 const f=await readyBatchGroup(t);
 const {createResourceCoordinator}=await import('../../src/runtime/resource-coordinator.js');
 const c=createResourceCoordinator({root:join(dirname(f.root),'batch-members')});
 const registrations=[];
 for(const runId of f.ids)registrations.push(await c.register({projectRoot:f.root,runId,deadlineMs:Date.now()+120000}));
 const {verifyTaskBatch}=await import('../../src/quality/verification-batch.js');
 const options={gitClient:f.gitClient,coordinator:c,resolveCommandExecutable:async()=>f.gate,environment:{PATH:process.env.PATH}};
 await c.pause(registrations[1].id,true);
 const paused=await verifyTaskBatch({projectRoot:f.root,runIds:f.ids},options);
 assert.ok(paused.every(r=>r.status==='blocked'));
 await c.pause(registrations[1].id,false);
 // Capture a legitimate frozen participant, then explicitly enqueue it before
 // the other two callers. It must still participate in admission validation.
 const {openBatchQueue}=await import('../../src/quality/verification-batch-queue.js');
 const q=await openBatchQueue(f.root);await q.enqueue([paused[0].members[2]]);
 await c.register({projectRoot:f.root,runId:f.ids[2],deadlineMs:Date.now()+200});await delay(250);
 const expired=await verifyTaskBatch({projectRoot:f.root,runIds:f.ids.slice(0,2)},options);
 assert.ok(expired.every(r=>r.status==='blocked'));assert.equal(expired[0].members.length,3);
 assert.equal((await c.inspect()).claims.some(claim=>claim.resource==='heavyVerification'),false);
});

test('batch uses the earliest member deadline even when the first selected task has no registration',async t=>{
 const f=await readyBatchGroup(t);
 const {createResourceCoordinator}=await import('../../src/runtime/resource-coordinator.js');
 const {withBatchAdmission}=await import('../../src/quality/batch-admission.js');
 const {currentMachineContext}=await import('../../src/runtime/machine-admission.js');
 const c=createResourceCoordinator({root:join(dirname(f.root),'batch-deadline')});
 const now=Date.now(),deadline=now+12000;
 await c.register({projectRoot:f.root,runId:f.ids[1],deadlineMs:now+60000});
 await c.register({projectRoot:f.root,runId:f.ids[2],deadlineMs:deadline});
 // Exercise deadline selection independently of checkout preparation speed.
 t.mock.timers.enable({apis:['Date','setTimeout'],now});
 let entered=false;
 await withBatchAdmission(f.root,f.ids.map(runId=>({runId})),{coordinator:c},async scoped=>{
  entered=true;
  assert.equal(currentMachineContext().registration.runId,f.ids[1]);
  assert.equal(currentMachineContext().deadlineMs,deadline);
  t.mock.timers.tick(11999);
  assert.equal(scoped.signal.aborted,false);
  t.mock.timers.tick(1);
  assert.equal(scoped.signal.aborted,true);
  await assert.rejects(scoped.validateAdmission());
 });
 assert.equal(entered,true);
});

test('batch dependency approval cannot install while another frozen member is paused',async t=>{
 const f=await readyBatchGroup(t,{lockedDependencies:true});
 const {verifyTaskBatch,bootstrapTaskBatchDependencies}=await import('../../src/quality/verification-batch.js');
 const options={gitClient:f.gitClient,resolveCommandExecutable:async()=>f.gate,environment:{PATH:process.env.PATH}};
 const pending=await verifyTaskBatch({projectRoot:f.root,runIds:f.ids},options);assert.equal(pending[0].status,'dependencies-needed');
 const {createResourceCoordinator}=await import('../../src/runtime/resource-coordinator.js');
 const c=createResourceCoordinator({root:join(dirname(f.root),'batch-deps-admission')});
 const second=await c.register({projectRoot:f.root,runId:f.ids[1],deadlineMs:Date.now()+60000});await c.pause(second.id,true);
 let confirmed=false;
 await assert.rejects(bootstrapTaskBatchDependencies({projectRoot:f.root,runId:f.ids[0]},
  {...options,coordinator:c,confirm:async()=>{confirmed=true;return true;}}),/admission/);
 assert.equal(confirmed,false);assert.equal((await c.inspect()).claims.length,0);
});
