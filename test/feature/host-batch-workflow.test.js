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

test('batch dependencies remain pending until an explicitly approved install and retry the frozen candidate',async t=>{
 const f=await completedWorker(t,{verificationBatch:true,lockedDependencies:true});
 const {verifyTaskBatch,bootstrapTaskBatchDependencies}=await import('../../src/quality/verification-batch.js');
 const options={gitClient:f.gitClient,resolveCommandExecutable:async()=>f.gate,environment:{PATH:process.env.PATH}};
 const [pending]=await verifyTaskBatch({projectRoot:f.root,runIds:[f.approved.runId]},options);
 assert.equal(pending.status,'dependencies-needed');
 const declined=await bootstrapTaskBatchDependencies({projectRoot:f.root,runId:f.approved.runId},{...options,confirm:async()=>false});assert.equal(declined.status,'declined');
 await writeFile(f.gate,'#!/bin/sh\nmkdir -p node_modules\nexit 0\n');
 const messages=[];
 assert.equal(await main(['task','deps',`--run=${f.approved.runId}`],{cwd:()=>f.root,env:options.environment,work:f.execution,
  terminalIsInteractive:()=>true,confirmDependencyInstall:async()=>true,
  resolveCommandExecutable:async runner=>runner==='git'?realpath(fixtureGit):f.gate,
  output:{log:m=>messages.push(m),error:m=>messages.push(m),json(){}},reportFailure:false}),0,messages.join('\n'));
 assert.match(messages.join('\n'),/frozen batch candidate/);
 await writeFile(f.gate,'#!/bin/sh\nexit 0\n');
 const [result]=await verifyTaskBatch({projectRoot:f.root,runIds:[f.approved.runId]},options);
 assert.equal(result.status,'pass');assert.equal(result.id,pending.id);assert.equal(result.candidate.commitSha,pending.candidate.commitSha);
});

test('ordinary verification rejects combined-candidate evidence even for an identical singleton head',async t=>{
 const f=await completedWorker(t);await f.execution.verify(f.verifyInput);
 const paths=await verificationReportPaths(await resolveFeatureRunPaths(f.root,f.approved.runId));
 const {createSnapshotStore}=await import('../../src/state/snapshot-store.js');
 const snapshots=createSnapshotStore(paths);const saved=await snapshots.read();
 await snapshots.write({...saved.data,scope:'combined-candidate'},{expectedVersion:saved.version});
 await assert.rejects(createVerificationReportStore(paths).readOnly(),/invalid/);
});

test('public batch task selection and status execute with heavy capacity one and require no delivery transition',async t=>{
 const f=await completedWorker(t,{verificationBatch:true});
 const {createResourceCoordinator}=await import('../../src/runtime/resource-coordinator.js');
 const machine=createResourceCoordinator({root:join(dirname(f.root),'batch-machine')});
 await machine.register({projectRoot:f.root,runId:f.approved.runId,deadlineMs:Date.now()+120000,limits:{heavyVerification:1}});
 const messages=[];
 const dependencies={cwd:()=>f.root,env:{PATH:process.env.PATH},work:f.execution,machine,
  terminalIsInteractive:()=>true,prompt:async question=>{assert.ok(question.choices.some(c=>c.value===f.approved.runId));return [f.approved.runId];},
  resolveCommandExecutable:async runner=>runner==='git'?realpath(fixtureGit):f.gate,
  output:{log:m=>messages.push(m),error:m=>messages.push(m),json(){}},reportFailure:false};
 assert.equal(await main(['task','verify','--batch'],dependencies),0,messages.join('\n'));
 assert.match(messages.join('\n'),/advisory/);
 assert.equal(await main(['task','status',`--run=${f.approved.runId}`],dependencies),0,messages.join('\n'));
 assert.match(messages.join('\n'),/Report:/);
 assert.equal((await f.execution.status({project:f.root,runId:f.approved.runId})).verification,null);
 assert.equal((await machine.inspect()).claims.filter(c=>c.resource==='heavyVerification'&&c.status==='held').length,0);
});

test('identical tracked project executables batch across distinct task checkout paths',async t=>{
 const f=await completedWorker(t,{verificationBatch:true,argvScripts:true});const ids=[f.approved.runId];
 for(const name of ['second']) {
  const proposal=await f.workflow.propose({project:f.root,client:'host',source:{kind:'inline',value:`# Add ${name}\n\n## Acceptance criteria\n\n- Add ${name}.\n`},decomposition:{schemaVersion:1,kind:'agilno.feature-decomposition',workItems:[{objective:`Add ${name}.`,ownedPaths:[`app/${name}.js`],acceptanceCriterionIndexes:[1]}]}});
  const approved=await f.workflow.start({project:f.root,runId:proposal.runId,expectedVersion:proposal.version,proposalDigest:proposal.proposalDigest});
  const prepared=await f.execution.prepare({project:f.root,runId:approved.runId,expectedRunVersion:approved.version});
  const next=await f.execution.nextAction({project:f.root,runId:approved.runId,expectedRuntimeVersion:prepared.runtimeVersion});
  const path=JSON.parse(next.action.payload).contract.worktree.path;
  await mkdir(join(path,'app'),{recursive:true});await writeFile(join(path,'app',`${name}.js`),`export const ${name}=true;\n`);
  await f.execution.submitResult({project:f.root,runId:approved.runId,expectedRuntimeVersion:next.runtimeVersion,action:next.action,result:resultFor(next.action)});ids.push(approved.runId);
 }
 const {verifyTaskBatch}=await import('../../src/quality/verification-batch.js');
 const results=await verifyTaskBatch({projectRoot:f.root,runIds:ids},{gitClient:f.gitClient,
  resolveCommandExecutable:async(runner,options)=>runner.startsWith('./')?realpath(join(options.worktree,options.cwd,runner)):f.gate,
  environment:{PATH:process.env.PATH}});
 assert.ok(results.every(r=>r.status==='pass'));assert.equal(new Set(results.map(r=>r.id)).size,1);assert.equal(results[0].members.length,2);
});
