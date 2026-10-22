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

test('explicit host graph offers siblings and accepts issued actions in reverse order',async t=>{
  const workItems=[{id:'one',dependencies:[],objective:'Add first file',ownedPaths:['app/one.js'],acceptanceCriterionIndexes:[1]},
    {id:'two',dependencies:[],objective:'Add second file',ownedPaths:['app/two.js'],acceptanceCriterionIndexes:[1]}];
  const {root,gitClient,approved,gate}=await fixture(t,{managed:true,workItems});
  const execution=createHostExecution({gitClient,now:()=>NOW,resolveCommandExecutable:async()=>gate});
  const prepared=await execution.prepare({project:root,runId:approved.runId,expectedRunVersion:approved.version});
  const next=await execution.nextAction({project:root,runId:approved.runId,expectedRuntimeVersion:prepared.runtimeVersion});
  assert.equal(next.status,'actions');assert.equal(next.actions.length,2);
  assert.ok(next.actions.every(offer=>offer.status==='action'));
  const repeated=await execution.nextAction({project:root,runId:approved.runId,expectedRuntimeVersion:next.runtimeVersion});
  assert.ok(repeated.actions.every(offer=>offer.status==='waiting-for-result'));
  const issued=next.actions.map(offer=>offer.action);
  for(const action of issued) {
    const contract=JSON.parse(action.payload).contract;
    await mkdir(join(contract.worktree.path,'app'),{recursive:true});
    await writeFile(join(contract.worktree.path,contract.ownedPaths[0]),`export const ${action.nodeId.replaceAll('-','_')} = true;\n`);
  }
  for(const action of issued.toReversed()) {
    const result=await execution.submitResult({project:root,runId:approved.runId,expectedRuntimeVersion:action.runtimeVersion,action,result:resultFor(action)});
    assert.equal(result.status,'accepted');
  }
  await assert.rejects(execution.submitResult({project:root,runId:approved.runId,expectedRuntimeVersion:issued[0].runtimeVersion,action:issued[0],result:resultFor(issued[0])}));
  const status=await execution.status({project:root,runId:approved.runId});
  for(const name of ['one','two'])assert.match(await readFile(join(status.checkout.path,`app/${name}.js`),'utf8'),/export const/);
});

test('parallel host admission preserves runnable offers and selects each stopped writer by receipt',async t=>{
  const {createResourceCoordinator}=await import('../../src/runtime/resource-coordinator.js');
  const {withMachineContext}=await import('../../src/runtime/machine-admission.js');
  const {sessionTelemetry}=await import('../../src/clients/session-capabilities.js');
  const workItems=['one','two'].map(id=>({id,dependencies:[],objective:`Add ${id}`,ownedPaths:[`app/${id}.js`],acceptanceCriterionIndexes:[1]}));
  const {root,gitClient,approved,gate}=await fixture(t,{managed:true,workItems});
  const machine=createResourceCoordinator({root:join(dirname(root),'machine')});
  await machine.register({projectRoot:root,runId:approved.runId,deadlineMs:Date.now()+120000,machineLimits:{activeTasks:4,agentExecutions:1,heavyVerification:1,dependencyInstalls:1}});
  const execution=createHostExecution({gitClient,now:()=>NOW,resolveCommandExecutable:async()=>gate});
  const prepared=await execution.prepare({project:root,runId:approved.runId,expectedRunVersion:approved.version});
  const base={project:root,runId:approved.runId};
  const call=(method,input)=>withMachineContext(machine,root,approved.runId,()=>execution[method]({...base,...input}),{nonblocking:true});
  const next=await call('nextAction',{expectedRuntimeVersion:prepared.runtimeVersion});
  assert.equal(next.status,'actions');assert.equal(next.actions.filter(x=>x.status==='action').length,1);assert.equal(next.actions.filter(x=>x.status==='queued').length,1);
  const action=next.actions.find(x=>x.status==='action').action;
  const observation={sessionId:action.sessionId,generation:action.generation,nativeHandle:'native-first',actorId:'host-one',observedAtMs:Date.parse(NOW),source:'host-observation',assurance:'host-reported',actions:1,telemetry:sessionTelemetry('host')};
  const observed=await call('handoff',{expectedRuntimeVersion:next.runtimeVersion,input:{operation:'observe',receipt:observation}});
  const contract=JSON.parse(action.payload).contract;
  await mkdir(join(contract.worktree.path,'app'),{recursive:true});
  await writeFile(join(contract.worktree.path,contract.ownedPaths[0]),'export const done = true;\n');
  await git(contract.worktree.path,'add',contract.ownedPaths[0]);
  await git(contract.worktree.path,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','finish worker');
  const {actions,telemetry,...identity}=observation;
  const released=await call('handoff',{expectedRuntimeVersion:observed.runtimeVersion,input:{operation:'release',receipt:{...identity,status:'stopped'}}});
  const resumed=await call('nextAction',{expectedRuntimeVersion:released.runtimeVersion});
  assert.equal(resumed.actions.filter(x=>x.status==='result-required').length,1);
  assert.equal(resumed.actions.filter(x=>x.status==='action').length,1);
  assert.notEqual(resumed.actions.find(x=>x.status==='action').action.sessionId,action.sessionId);
  const completion=resumed.actions.find(x=>x.status==='result-required').action;
  const submitted=await call('submitResult',{expectedRuntimeVersion:completion.runtimeVersion,action:completion,result:resultFor(completion)});
  assert.equal(submitted.status,'accepted');

});

for (const interrupted of [false, true]) test(`host release exact retry repairs persistence boundary (${interrupted ? 'machine saved' : 'both saved'})`, async t => {
  const {createResourceCoordinator}=await import('../../src/runtime/resource-coordinator.js');
  const {withMachineContext}=await import('../../src/runtime/machine-admission.js');
  const {sessionTelemetry}=await import('../../src/clients/session-capabilities.js');
  const {root,gitClient,approved}=await fixture(t,{managed:true});
  const machine=createResourceCoordinator({root:join(dirname(root),'machine')});
  const registration=await machine.register({projectRoot:root,runId:approved.runId,deadlineMs:Date.now()+120000});
  let interrupt=interrupted;
  const coordinator={...machine,async hostStop(input) {
    await machine.hostStop(input);
    if(interrupt){interrupt=false;throw new Error('interrupted after machine persistence');}
  }};
  let execution=createHostExecution({gitClient,now:()=>NOW});
  const base={project:root,runId:approved.runId};
  const call=(method,input)=>withMachineContext(coordinator,root,approved.runId,()=>execution[method]({...base,...input}),{nonblocking:true});
  const prepared=await execution.prepare({...base,expectedRunVersion:approved.version});
  const next=await call('nextAction',{expectedRuntimeVersion:prepared.runtimeVersion});
  const action=next.action;
  const identity={sessionId:action.sessionId,generation:action.generation,nativeHandle:'release-writer',actorId:'host-one',observedAtMs:Date.parse(NOW),source:'host-observation',assurance:'host-reported'};
  const observation={...identity,actions:1,telemetry:sessionTelemetry('host')};
  const observed=await call('handoff',{expectedRuntimeVersion:next.runtimeVersion,input:{operation:'observe',receipt:observation}});
  const receipt={...identity,status:'stopped'};
  const release=(version,proof=receipt)=>call('handoff',{expectedRuntimeVersion:version,input:{operation:'release',receipt:proof}});
  for(const patch of [{status:'unknown'},{generation:2},{actorId:'foreign'},{nativeHandle:'foreign'},{observedAtMs:Date.parse(NOW)-1}]) {
    await assert.rejects(release(observed.runtimeVersion,{...receipt,...patch}));
  }
  assert.equal((await machine.getClaim({registrationId:registration.id,resource:'agentExecutions',idempotencyKey:action.sessionId,generation:action.generation})).status,'held');
  let version=observed.runtimeVersion;
  if(interrupted) await assert.rejects(release(version),/interrupted after machine persistence/);
  else version=(await release(version)).runtimeVersion;
  execution=createHostExecution({gitClient,now:()=>NOW});
  await assert.rejects(call('handoff',{expectedRuntimeVersion:version,input:{operation:'observe',receipt:observation}}));
  await assert.rejects(call('checkpoint',{expectedRuntimeVersion:version,action,input:{summary:'Late checkpoint',usage:{tokens:1,costUsd:0},nativeHandle:identity.nativeHandle,actorId:identity.actorId,observedAtMs:identity.observedAtMs}}));
  await assert.rejects(release(version,{...receipt,observedAtMs:receipt.observedAtMs+1}));
  const repaired=await release(version);
  assert.equal(repaired.runtimeVersion,observed.runtimeVersion+1);
  assert.deepEqual(await release(repaired.runtimeVersion),repaired);
  await assert.rejects(release(observed.runtimeVersion));
  const status=await execution.status(base);
  assert.equal(status.sessions[0].stopStatus,'stopped');
  assert.equal(status.sessions[0].phase,'active');
  assert.equal(status.runtime.usage.tokens,0);
  const resumed=await call('nextAction',{expectedRuntimeVersion:repaired.runtimeVersion});
  assert.equal(resumed.status,'result-required');
  assert.equal(resumed.action.sessionId,action.sessionId);
});

test('explicit host retries failed candidate verification with only the frozen result and source', async t => {
  const workItems=[{id:'one',dependencies:[],objective:'Add first file',ownedPaths:['app/one.js'],acceptanceCriterionIndexes:[1]}];
  const {root,gitClient,approved,gate}=await fixture(t,{managed:true,workItems});
  let execution=createHostExecution({gitClient,now:()=>NOW,resolveCommandExecutable:async()=>gate});
  const prepared=await execution.prepare({project:root,runId:approved.runId,expectedRunVersion:approved.version});
  const next=await execution.nextAction({project:root,runId:approved.runId,expectedRuntimeVersion:prepared.runtimeVersion});
  const action=next.actions[0].action;
  const contract=JSON.parse(action.payload).contract;
  await mkdir(join(contract.worktree.path,'app'),{recursive:true});
  await writeFile(join(contract.worktree.path,'app/one.js'),'export const one = true;\n');
  const input={project:root,runId:approved.runId,expectedRuntimeVersion:action.runtimeVersion,action,result:resultFor(action)};
  await writeFile(gate,'#!/bin/sh\nexit 1\n');
  await assert.rejects(execution.submitResult(input));
  execution=createHostExecution({gitClient,now:()=>NOW,resolveCommandExecutable:async()=>gate});
  await writeFile(gate,'#!/bin/sh\nexit 0\n');
  await assert.rejects(execution.submitResult({...input,result:{...input.result,output:{...input.result.output,summary:'changed'}}}));
  await assert.rejects(execution.submitResult({...input,action:{...action,generation:action.generation+1}}));
  const source=await git(contract.worktree.path,'rev-parse','HEAD');
  await writeFile(join(contract.worktree.path,'app/one.js'),'export const one = false;\n');
  await git(contract.worktree.path,'add','app/one.js');await git(contract.worktree.path,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','changed source');
  await assert.rejects(execution.submitResult(input));
  await git(contract.worktree.path,'reset','--hard',source);
  const accepted=await execution.submitResult(input);
  assert.equal(accepted.status,'accepted');
});

test('task deps prepares both parallel Workers and the frozen candidate before exact submission retry', async t=>{
  const workItems=['one','two'].map(id=>({id,dependencies:[],objective:`Add ${id}`,ownedPaths:[`app/${id}.js`],acceptanceCriterionIndexes:[1]}));
  const {root,gitClient,approved}=await fixture(t,{managed:true,workItems,portableDependencies:true});
  const execution=createHostExecution({gitClient,now:()=>NOW,resolveCommandExecutable:async()=>process.execPath});
  const prepared=await execution.prepare({project:root,runId:approved.runId,expectedRunVersion:approved.version});
  const next=await execution.nextAction({project:root,runId:approved.runId,expectedRuntimeVersion:prepared.runtimeVersion});
  const before=await execution.status({project:root,runId:approved.runId});
  assert.equal(before.dependencyTargets.length,2);
  const messages=[],approvals=[];
  const {stdout:gitPath}=await execFile('which',['git']);
  const deps=()=>main(['task','deps'],{cwd:()=>root,terminalIsInteractive:()=>true,
    output:{log:value=>messages.push(value),error:value=>messages.push(value),json(){}},work:execution,
    resolveCommandExecutable:async name=>name==='git'?realpath(gitPath.trim()):process.execPath,
    confirmDependencyInstall:async plan=>{approvals.push(plan.worktreePath);return true;}});
  assert.equal(await deps(),EXIT_CODES.SUCCESS,messages.join('\n'));
  for(const target of before.dependencyTargets)assert.equal(await readFile(join(target.path,'.rivet-deps/ready'),'utf8'),'ready');
  const action=next.actions[0].action;const contract=JSON.parse(action.payload).contract;
  await mkdir(join(contract.worktree.path,'app'),{recursive:true});
  await writeFile(join(contract.worktree.path,'app/one.js'),'export const one = true;\n');
  const input={project:root,runId:approved.runId,expectedRuntimeVersion:action.runtimeVersion,action,result:resultFor(action)};
  await assert.rejects(execution.submitResult(input));
  const pending=await execution.status({project:root,runId:approved.runId});
  assert.equal((await execution.nextAction({project:root,runId:approved.runId,expectedRuntimeVersion:pending.runtime.version})).status,'reconciliation-pending');
  const candidate=pending.dependencyTargets.find(item=>item.kind==='candidate');
  assert.ok(candidate);assert.match(pending.nextAction,/task deps/);
  assert.equal(await deps(),EXIT_CODES.SUCCESS,messages.join('\n'));
  assert.ok(approvals.includes(candidate.path));
  assert.equal((await execution.submitResult(input)).status,'accepted');
});

test('task deps prepares parallel npm Workers and the npm candidate before exact retry', async t=>{
  const workItems=['one','two'].map(id=>({id,dependencies:[],objective:`Add ${id}`,ownedPaths:[`app/${id}.js`],acceptanceCriterionIndexes:[1]}));
  const {root,gitClient,approved,gate}=await fixture(t,{managed:true,workItems,lockedDependencies:true});
  await writeFile(gate,'#!/bin/sh\ntest -f node_modules/installed\n');
  const execution=createHostExecution({gitClient,now:()=>NOW,resolveCommandExecutable:async()=>gate});
  const prepared=await execution.prepare({project:root,runId:approved.runId,expectedRunVersion:approved.version});
  const next=await execution.nextAction({project:root,runId:approved.runId,expectedRuntimeVersion:prepared.runtimeVersion});
  const installer=join(dirname(root),'installer');
  await writeFile(installer,'#!/bin/sh\nmkdir -p node_modules\nprintf ready > node_modules/installed\n',{mode:0o700});
  const approvals=[],messages=[];const {stdout:gitPath}=await execFile('which',['git']);
  const deps=()=>main(['task','deps'],{cwd:()=>root,terminalIsInteractive:()=>true,work:execution,
    output:{log:v=>messages.push(v),error:v=>messages.push(v),json(){}},
    resolveCommandExecutable:async name=>name==='git'?realpath(gitPath.trim()):installer,
    confirmDependencyInstall:async plan=>{approvals.push(plan.worktreePath);return true;}});
  assert.equal(await deps(),EXIT_CODES.SUCCESS,messages.join('\n'));assert.equal(approvals.length,2);
  const action=next.actions[0].action,contract=JSON.parse(action.payload).contract;
  await mkdir(join(contract.worktree.path,'app'),{recursive:true});
  await writeFile(join(contract.worktree.path,'app/one.js'),'export const one = true;\n');
  const input={project:root,runId:approved.runId,expectedRuntimeVersion:action.runtimeVersion,action,result:resultFor(action)};
  await assert.rejects(execution.submitResult(input));
  const pending=await execution.status({project:root,runId:approved.runId});
  const candidate=pending.dependencyTargets.find(item=>item.kind==='candidate');assert.ok(candidate);
  assert.equal(await deps(),EXIT_CODES.SUCCESS,messages.join('\n'));assert.ok(approvals.includes(candidate.path));
  assert.equal((await execution.submitResult(input)).status,'accepted');
});

test('missing pending candidate remains visible in task status and blocks dependency installation safely',async t=>{
  const workItems=[{id:'one',dependencies:[],objective:'Add first file',ownedPaths:['app/one.js'],acceptanceCriterionIndexes:[1]}];
  const {root,gitClient,approved,gate}=await fixture(t,{managed:true,workItems,lockedDependencies:true});
  const execution=createHostExecution({gitClient,now:()=>NOW,resolveCommandExecutable:async()=>gate});
  const prepared=await execution.prepare({project:root,runId:approved.runId,expectedRunVersion:approved.version});
  const next=await execution.nextAction({project:root,runId:approved.runId,expectedRuntimeVersion:prepared.runtimeVersion});
  const action=next.actions[0].action,contract=JSON.parse(action.payload).contract;
  await mkdir(join(contract.worktree.path,'app'),{recursive:true});
  await writeFile(join(contract.worktree.path,'app/one.js'),'export const one = true;\n');
  await writeFile(gate,'#!/bin/sh\nexit 1\n');
  await assert.rejects(execution.submitResult({project:root,runId:approved.runId,expectedRuntimeVersion:action.runtimeVersion,action,result:resultFor(action)}));
  const before=await execution.status({project:root,runId:approved.runId});
  const candidate=before.dependencyTargets.find(item=>item.kind==='candidate');assert.ok(candidate);
  await rename(candidate.path,`${candidate.path}-moved`);
  const observed=await execution.status({project:root,runId:approved.runId});
  assert.deepEqual(observed.runtime,before.runtime);
  assert.deepEqual(observed.workerCheckouts,before.workerCheckouts);
  assert.equal(observed.dependencyTargets.length,0);
  assert.equal(observed.candidateCheckouts[0].status,'unavailable');
  assert.match(observed.nextAction,/candidate.*unavailable|unavailable.*candidate/i);
  let approvedInstall=false;const messages=[];
  const code=await main(['task','deps'],{cwd:()=>root,terminalIsInteractive:()=>true,work:execution,
    output:{log:v=>messages.push(v),error:v=>messages.push(v),json(){}},
    resolveCommandExecutable:async()=>process.execPath,confirmDependencyInstall:async()=>{approvedInstall=true;return true;}});
  assert.equal(code,EXIT_CODES.REPOSITORY_CONFLICT);assert.equal(approvedInstall,false);
  assert.match(messages.join('\n'),/candidate.*unavailable|unavailable.*candidate/i);
});

test('expired parallel host admission still exposes the stopped second sibling without mutating admission',async t=>{
  const {createRivetApplication}=await import('../../src/runtime/application.js');
  const {sessionTelemetry}=await import('../../src/clients/session-capabilities.js');
  const workItems=['one','two','three'].map(id=>({id,dependencies:[],objective:`Add ${id}`,ownedPaths:[`app/${id}.js`],acceptanceCriterionIndexes:[1]}));
  const {root,approved,gitClient}=await fixture(t,{managed:true,workItems,now:new Date().toISOString()});
  const app=createRivetApplication({env:{...process.env,RIVET_MACHINE_STATE_ROOT:join(dirname(root),'machine')}});
  await app.machine.register({projectRoot:root,runId:approved.runId,deadlineMs:Date.now()+60000,
    machineLimits:{activeTasks:4,agentExecutions:2,heavyVerification:1,dependencyInstalls:1}});
  const base={project:root,runId:approved.runId};
  const prepared=await app.work.prepare({...base,expectedRunVersion:approved.version});
  const next=await app.work.nextAction({...base,expectedRuntimeVersion:prepared.runtimeVersion});
  const issued=next.actions.filter(offer=>offer.status==='action');assert.equal(issued.length,2);
  const second=issued[1].action;
  const identity={sessionId:second.sessionId,generation:second.generation,nativeHandle:'second-before-deadline',actorId:'host-two',observedAtMs:Date.now(),source:'host-observation',assurance:'host-reported'};
  const observed=await app.work.handoff({...base,expectedRuntimeVersion:next.runtimeVersion,input:{operation:'observe',receipt:{...identity,actions:1,telemetry:sessionTelemetry('host')}}});
  await app.machine.register({projectRoot:root,runId:approved.runId,deadlineMs:Date.now()+30});await delay(60);
  const released=await app.work.handoff({...base,expectedRuntimeVersion:observed.runtimeVersion,input:{operation:'release',receipt:{...identity,observedAtMs:Date.now(),status:'stopped'}}});
  const before=await app.work.status(base),claimsBefore=await app.machine.inspect(),treesBefore=await gitClient.listWorktrees(root);
  const recovered=await app.work.nextAction({...base,expectedRuntimeVersion:released.runtimeVersion});
  assert.equal(recovered.status,'actions');
  assert.equal(recovered.actions.find(offer=>offer.action?.nodeId===second.nodeId)?.status,'result-required');
  assert.equal(recovered.actions.find(offer=>offer.action?.nodeId===issued[0].action.nodeId)?.status,'waiting-for-result');
  assert.equal(recovered.actions.some(offer=>offer.status==='action'),false);
  assert.deepEqual((await app.work.status(base)).runtime,before.runtime);
  assert.deepEqual((await app.machine.inspect()).claims,claimsBefore.claims);
  assert.deepEqual(await gitClient.listWorktrees(root),treesBefore);
});
