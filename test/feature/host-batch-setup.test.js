import { fixtureGit } from '../helpers/git-executable.js';
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

test('batch ready listing validates accepted work without creating queue state and inline approval resumes the frozen candidate',async t=>{
 const f=await completedWorker(t,{verificationBatch:true,lockedDependencies:true});
 const {inspectTaskBatchReadiness}=await import('../../src/quality/verification-batch.js');
 const options={gitClient:f.gitClient,resolveCommandExecutable:async()=>f.gate,environment:{PATH:process.env.PATH}};
 assert.equal((await inspectTaskBatchReadiness({projectRoot:f.root,runId:f.approved.runId},options)).ready,true);
 assert.equal((await inspectTaskBatchReadiness({projectRoot:f.root,runId:'missing-task'},options)).ready,false);
 const {resolveExistingStatePaths}=await import('../../src/state/paths.js');assert.equal(await resolveExistingStatePaths(f.root,'verification-batches'),null);
 await writeFile(f.gate,'#!/bin/sh\nmkdir -p node_modules\nexit 0\n');
 const messages=[];let approvals=0,pending;
 const {batchForRun}=await import('../../src/quality/verification-batch-queue.js');
 assert.equal(await main(['task','verify','--batch',`--run=${f.approved.runId}`],{cwd:()=>f.root,env:options.environment,work:f.execution,
  terminalIsInteractive:()=>true,confirmDependencyInstall:async()=>{approvals++;pending=await batchForRun(f.root,f.approved.runId);return true;},
  resolveCommandExecutable:async runner=>runner==='git'?realpath(fixtureGit):f.gate,
  output:{log:m=>messages.push(m),error:m=>messages.push(m),json(){}},reportFailure:false}),0,messages.join('\n'));
 assert.equal(approvals,1);assert.match(messages.join('\n'),/pass/);
 const report=await batchForRun(f.root,f.approved.runId);assert.equal(report.status,'pass');assert.equal(report.id,pending.id);assert.equal(report.candidate.commitSha,pending.candidate.commitSha);
});

for(const interactive of [false,true])test(`batch dependency approval ${interactive?'decline':'noninteractive'} retains candidate without installation`,async t=>{
 const f=await completedWorker(t,{verificationBatch:true,lockedDependencies:true}),messages=[];let approvals=0;
 const dependencies={cwd:()=>f.root,env:{PATH:process.env.PATH},work:f.execution,terminalIsInteractive:()=>interactive,confirmDependencyInstall:async()=>{approvals++;return false;},
 resolveCommandExecutable:async runner=>runner==='git'?realpath(fixtureGit):f.gate,output:{log:m=>messages.push(m),error:m=>messages.push(m),json(){}},reportFailure:false};
 assert.notEqual(await main(['task','verify','--batch',`--run=${f.approved.runId}`],dependencies),0);
 assert.equal(approvals,interactive?1:0);
 const {batchForRun}=await import('../../src/quality/verification-batch-queue.js');const report=await batchForRun(f.root,f.approved.runId);assert.equal(report.status,'dependencies-needed');
 await assert.rejects(access(join(report.candidate.path,'node_modules')));
 assert.match(messages.join('\n'),/retry.*interactively/);
});

test('batch chooser excludes unfinished tasks and rechecks a selected head before enrollment',async t=>{
 const f=await completedWorker(t,{verificationBatch:true});
 const proposal=await f.workflow.propose({project:f.root,client:'host',source:{kind:'inline',value:'# Pending work\n\n## Acceptance criteria\n\n- Add pending.\n'},decomposition:{schemaVersion:1,kind:'agilno.feature-decomposition',workItems:[{objective:'Add pending.',ownedPaths:['app/pending.js'],acceptanceCriterionIndexes:[1]}]}});
 const approved=await f.workflow.start({project:f.root,runId:proposal.runId,expectedVersion:proposal.version,proposalDigest:proposal.proposalDigest});
 await f.execution.prepare({project:f.root,runId:approved.runId,expectedRunVersion:approved.version});
 const messages=[];let selected=false;
 const code=await main(['task','verify','--batch'],{cwd:()=>f.root,env:{PATH:process.env.PATH},work:f.execution,terminalIsInteractive:()=>true,
 prompt:async question=>{selected=true;assert.deepEqual(question.choices.map(c=>c.value),[f.approved.runId]);await writeFile(join(f.root,'foreign-change'),'changed after selection');return [f.approved.runId];},
 resolveCommandExecutable:async runner=>runner==='git'?realpath(fixtureGit):f.gate,
 output:{log:m=>messages.push(m),error:m=>messages.push(m),json(){}},reportFailure:false});
 assert.equal(selected,true);assert.notEqual(code,0);
 const {batchForRun}=await import('../../src/quality/verification-batch-queue.js');assert.equal(await batchForRun(f.root,f.approved.runId),null);
});

test('batch ready chooser excludes paused expired and cancelled task or project admission without state writes',async t=>{
 const f=await completedWorker(t,{verificationBatch:true});
 const {createResourceCoordinator}=await import('../../src/runtime/resource-coordinator.js');
 const {inspectTaskBatchReadiness}=await import('../../src/quality/verification-batch.js');
 for(const scope of ['task','project'])for(const reason of ['paused','expired','cancelled']) {
  const machineRoot=join(dirname(f.root),`ready-${scope}-${reason}`),coordinator=createResourceCoordinator({root:machineRoot});
  const registration=await coordinator.register({projectRoot:f.root,...(scope==='task'?{runId:f.approved.runId}:{}),deadlineMs:Date.now()+(reason==='expired'?50:120000)});
  if(reason==='paused')await coordinator.pause(registration.id);
  if(reason==='expired')await delay(60);
  if(reason==='cancelled')await coordinator.cancelRegistration(registration.id);
  if(scope==='task'&&reason==='cancelled') {
   for(let i=0;i<256;i++) {
    const old=await coordinator.register({projectRoot:f.root,runId:`batch-history-${i}`,deadlineMs:Date.now()+120000});
    await coordinator.cancelRegistration(old.id);
   }
   assert.equal((await coordinator.inspectReadOnly()).registrations.some(r=>r.id===registration.id),false);
  }
  const snapshot=await readFile(join(machineRoot,'machine.json'),'utf8'),entries=await readdir(machineRoot);
  const options={gitClient:f.gitClient,coordinator,resolveCommandExecutable:async()=>f.gate,environment:{PATH:process.env.PATH}};
  assert.equal((await inspectTaskBatchReadiness({projectRoot:f.root,runId:f.approved.runId},options)).ready,false,`${scope} ${reason}`);
  const messages=[];
  assert.equal(await main(['task','verify','--batch'],{cwd:()=>f.root,env:options.environment,work:f.execution,machine:coordinator,terminalIsInteractive:()=>true,
   prompt:async()=>{throw Error('Unavailable task must not be offered');},resolveCommandExecutable:async runner=>runner==='git'?realpath(fixtureGit):f.gate,
   output:{log:m=>messages.push(m),error:m=>messages.push(m),json(){}},reportFailure:false}),0,messages.join('\n'));
  assert.match(messages.join('\n'),/No tasks are ready/);
  assert.equal(await readFile(join(machineRoot,'machine.json'),'utf8'),snapshot);assert.deepEqual(await readdir(machineRoot),entries);
 }
});
