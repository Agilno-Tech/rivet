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

test('batch verification flushes an elapsed ready singleton without advancing task delivery state',async t=>{
 const f=await completedWorker(t,{verificationBatch:true});
 const {verifyTaskBatch}=await import('../../src/quality/verification-batch.js');
 const before=await f.execution.status({project:f.root,runId:f.approved.runId});
 const result=await verifyTaskBatch({projectRoot:f.root,runIds:[f.approved.runId]},
  {gitClient:f.gitClient,resolveCommandExecutable:async()=>f.gate,environment:{PATH:process.env.PATH}});
 assert.equal(result[0].status,'pass');assert.equal(result[0].scope,'combined-candidate');
 const after=await f.execution.status({project:f.root,runId:f.approved.runId});
 assert.equal(after.run.version,before.run.version);assert.equal(after.run.status,'running');assert.equal(after.verification,null);
 await writeFile(f.gate,`#!/bin/sh\necho drift > '${join(f.root,'foreign')}'\nexit 0\n`);
 const [drift]=await verifyTaskBatch({projectRoot:f.root,runIds:[f.approved.runId]},
  {gitClient:f.gitClient,resolveCommandExecutable:async()=>f.gate,environment:{PATH:process.env.PATH}});
 assert.equal(drift.status,'blocked');
 await rm(join(f.root,'foreign'));
 const qualityPath=join(f.root,'.rivet','quality.yaml');
 await writeFile(f.gate,`#!/bin/sh\necho '# changed during checks' >> '${qualityPath}'\nexit 0\n`);
 const [configDrift]=await verifyTaskBatch({projectRoot:f.root,runIds:[f.approved.runId]},
  {gitClient:f.gitClient,resolveCommandExecutable:async()=>f.gate,environment:{PATH:process.env.PATH}});
 assert.equal(configDrift.status,'blocked');


});

test('batch verifies three ready task heads once and preserves each accepted integration',async t=>{
 const f=await completedWorker(t,{verificationBatch:true});
 const ids=[f.approved.runId];
 for(const name of ['second','third']) {
  const proposal=await f.workflow.propose({project:f.root,client:'host',source:{kind:'inline',value:`# Add ${name}\n\n## Acceptance criteria\n\n- Add ${name}.\n`},decomposition:{schemaVersion:1,kind:'agilno.feature-decomposition',workItems:[{objective:`Add ${name}.`,ownedPaths:[`app/${name}.js`],acceptanceCriterionIndexes:[1]}]}});
  const approved=await f.workflow.start({project:f.root,runId:proposal.runId,expectedVersion:proposal.version,proposalDigest:proposal.proposalDigest});
  const prepared=await f.execution.prepare({project:f.root,runId:approved.runId,expectedRunVersion:approved.version});
  const next=await f.execution.nextAction({project:f.root,runId:approved.runId,expectedRuntimeVersion:prepared.runtimeVersion});
  const path=JSON.parse(next.action.payload).contract.worktree.path;
  await mkdir(join(path,'app'),{recursive:true});await writeFile(join(path,'app',`${name}.js`),`export const ${name}=true;\n`);
  await f.execution.submitResult({project:f.root,runId:approved.runId,expectedRuntimeVersion:next.runtimeVersion,action:next.action,result:resultFor(next.action)});ids.push(approved.runId);
 }
 const counter=join(dirname(f.root),'batch-counter');await writeFile(f.gate,`#!/bin/sh\necho checked >> '${counter}'\nexit 0\n`);
 const {verifyTaskBatch}=await import('../../src/quality/verification-batch.js');
 const results=await verifyTaskBatch({projectRoot:f.root,runIds:ids},{gitClient:f.gitClient,resolveCommandExecutable:async()=>f.gate,environment:{PATH:process.env.PATH}});
 assert.ok(results.every(r=>r.status==='pass'));assert.equal(new Set(results.map(r=>r.id)).size,1);
 assert.equal((await readFile(counter,'utf8')).trim().split('\n').length,results[0].checks.length);
 assert.equal(results[0].members.length,3);
 for(const id of ids)assert.equal((await f.execution.status({project:f.root,runId:id})).verification,null);
 await writeFile(f.gate,"#!/bin/sh\nif test -f app/agenda.js && test -f app/second.js; then exit 1; fi\nexit 0\n");
 const [failed]=await verifyTaskBatch({projectRoot:f.root,runIds:ids},{gitClient:f.gitClient,resolveCommandExecutable:async()=>f.gate,environment:{PATH:process.env.PATH}});
 assert.equal(failed.status,'fail');assert.deepEqual(failed.diagnostics.map(d=>d.status),['pass','pass','untested']);assert.equal(failed.interactionFailure,false);

});

test('batch cancellation stops an executing gate and cannot publish passing evidence',async t=>{
 const f=await completedWorker(t,{verificationBatch:true});
 const marker=join(dirname(f.root),'batch-gate-started');
 await writeFile(f.gate,`#!/bin/sh\necho started > '${marker}'\nsleep 20\nexit 0\n`);
 const {createResourceCoordinator}=await import('../../src/runtime/resource-coordinator.js');
 const coordinator=createResourceCoordinator({root:join(dirname(f.root),'batch-cancel-machine')});
 await coordinator.register({projectRoot:f.root,runId:f.approved.runId,deadlineMs:Date.now()+300000});
 const controller=new AbortController();
 t.after(()=>controller.abort());
 const {verifyTaskBatch}=await import('../../src/quality/verification-batch.js');
 const pending=verifyTaskBatch({projectRoot:f.root,runIds:[f.approved.runId]},
  {gitClient:f.gitClient,coordinator,resolveCommandExecutable:async()=>f.gate,environment:{PATH:process.env.PATH},signal:controller.signal});
 // Candidate assembly is real Git work; observe the command boundary before cancelling.
 for(let attempt=0;attempt<2400;attempt++) {try {await access(marker);break;}catch {await delay(25);}}
 await access(marker);controller.abort();
 const [result]=await pending;assert.equal(result.status,'blocked');
 assert.equal((await f.execution.status({project:f.root,runId:f.approved.runId})).verification,null);
 const claims=(await coordinator.inspect()).claims.filter(claim=>claim.resource==='heavyVerification');
 assert.equal(claims.length,1);
 for(const claim of claims.filter(claim=>claim.status==='held'))assert.equal(claim.execution?.status,'unknown');
});
