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

test('managed host checkpoint stopped successor completion preserves dirty work and rejects late results before integration',async t=>{
 const {root,approved,execution,next,worktree,gitClient}=await managedWorker(t);
 assert.equal(next.action.generation,1);
 const base={project:root,runId:approved.runId};
 const checkpoint=await execution.checkpoint({...base,expectedRuntimeVersion:next.runtimeVersion,action:next.action,
   input:{summary:'Agenda implemented; run remaining checks.',usage:{tokens:10,costUsd:0},nativeHandle:'native-one',actorId:'host-one',observedAtMs:Date.parse(NOW)}});
 const fenced=await execution.handoff({...base,expectedRuntimeVersion:checkpoint.runtimeVersion,input:{operation:'fence'}});
 await assert.rejects(()=>execution.submitResult({...base,expectedRuntimeVersion:next.runtimeVersion,action:next.action,result:resultFor(next.action)}));
 const stopped=await execution.handoff({...base,expectedRuntimeVersion:fenced.runtimeVersion,input:{operation:'stop',receipt:{sessionId:next.action.sessionId,generation:1,nativeHandle:'native-one',actorId:'host-one',observedAtMs:Date.parse(NOW),status:'stopped',source:'host-observation',assurance:'host-reported'}}});
 const transferred=await execution.handoff({...base,expectedRuntimeVersion:stopped.runtimeVersion,input:{operation:'transfer'}});
 const successor=await execution.nextAction({...base,expectedRuntimeVersion:transferred.runtimeVersion});
 assert.equal(successor.action.generation,2);assert.equal(successor.action.attempt,1);
 assert.equal(JSON.parse(successor.action.payload).contract.worktree.path,worktree);
 assert.match(JSON.parse(successor.action.payload).contract.session.checkpoint,/Agenda implemented/);
 const result=await execution.submitResult({...base,expectedRuntimeVersion:successor.runtimeVersion,action:successor.action,result:resultFor(successor.action)});
 assert.equal(result.status,'accepted');
 const state=await execution.status(base);assert.equal(state.sessions[0].generation,2);assert.equal(state.runtime.usage.tokens,20);
 assert.equal((await gitClient.inspectRepository(worktree)).dirty,false);
});

test('managed host unknown stop and changed dirty bytes block successor without resetting cumulative budgets',async t=>{
 const {root,approved,execution,next,worktree}=await managedWorker(t);const base={project:root,runId:approved.runId};
 let state=await execution.checkpoint({...base,expectedRuntimeVersion:next.runtimeVersion,action:next.action,input:{summary:'Pending checks.',usage:{tokens:10,costUsd:0},nativeHandle:'native-one',actorId:'host-one',observedAtMs:Date.parse(NOW)}});
 state=await execution.handoff({...base,expectedRuntimeVersion:state.runtimeVersion,input:{operation:'fence'}});
 state=await execution.handoff({...base,expectedRuntimeVersion:state.runtimeVersion,input:{operation:'stop',receipt:{sessionId:next.action.sessionId,generation:1,nativeHandle:'native-one',actorId:'host-one',observedAtMs:Date.parse(NOW),status:'unknown',source:'host-observation',assurance:'host-reported'}}});
 await assert.rejects(()=>execution.handoff({...base,expectedRuntimeVersion:state.runtimeVersion,input:{operation:'transfer'}}));
 state=await execution.handoff({...base,expectedRuntimeVersion:state.runtimeVersion,input:{operation:'stop',receipt:{sessionId:next.action.sessionId,generation:1,nativeHandle:'native-one',actorId:'host-one',observedAtMs:Date.parse(NOW),status:'stopped',source:'host-observation',assurance:'host-reported'}}});
 await writeFile(join(worktree,'app','agenda.js'),'changed after checkpoint');
 await assert.rejects(()=>execution.handoff({...base,expectedRuntimeVersion:state.runtimeVersion,input:{operation:'transfer'}}));
 assert.equal((await execution.status(base)).sessions[0].generation,1);
});

test('host handoff cap retains charged usage and does not erase reported wall time',async t=>{
 const {root,approved,execution,next,clock}=await managedWorker(t,{policy:{maxReplacements:0}});const base={project:root,runId:approved.runId};
 let state=await execution.checkpoint({...base,expectedRuntimeVersion:next.runtimeVersion,action:next.action,input:{summary:'Remaining checks.',usage:{tokens:10,costUsd:0,timeMinutes:0},nativeHandle:'native-one',actorId:'host-one',observedAtMs:Date.parse(NOW)}});
 state=await execution.handoff({...base,expectedRuntimeVersion:state.runtimeVersion,input:{operation:'fence'}});
 clock.now+=120000;
 state=await execution.handoff({...base,expectedRuntimeVersion:state.runtimeVersion,input:{operation:'stop',receipt:{sessionId:next.action.sessionId,generation:1,nativeHandle:'native-one',actorId:'host-one',observedAtMs:clock.now,status:'stopped',source:'host-observation',assurance:'host-reported'}}});
 await assert.rejects(()=>execution.handoff({...base,expectedRuntimeVersion:state.runtimeVersion,input:{operation:'transfer'}}),error=>error.code==='ERR_SESSION_REPLACEMENT_CAP');
 const status=await execution.status(base);assert.equal(status.runtime.usage.tokens,10);assert.equal(status.runtime.usage.timeMinutes,2);assert.equal(status.runtime.usage.retries,0);
});

test('host handoff crash boundaries recover exact recorded phase or block without overlapping generation',async t=>{
 const {root,approved,execution,next,worktree,gitClient}=await managedWorker(t);const base={project:root,runId:approved.runId};
 const input={summary:'Remaining checks.',usage:{tokens:10,costUsd:0},nativeHandle:'native-one',actorId:'host-one',observedAtMs:Date.parse(NOW)};
 await writeFile(join(worktree,'outside-scope'),'preserve');
 await assert.rejects(()=>execution.checkpoint({...base,expectedRuntimeVersion:next.runtimeVersion,action:next.action,input}));
 let current=await execution.status(base);assert.equal(current.sessions[0].phase,'checkpoint-requested');
 await rm(join(worktree,'outside-scope'));
 const fresh=()=>createHostExecution({gitClient,now:()=>NOW});
 let state=await fresh().checkpoint({...base,expectedRuntimeVersion:current.runtime.version,action:next.action,input});
 state=await fresh().handoff({...base,expectedRuntimeVersion:state.runtimeVersion,input:{operation:'fence'}});
 assert.equal((await fresh().status(base)).sessions[0].phase,'stopping');
 state=await fresh().handoff({...base,expectedRuntimeVersion:state.runtimeVersion,input:{operation:'stop',receipt:{sessionId:next.action.sessionId,generation:1,nativeHandle:'native-one',actorId:'host-one',observedAtMs:Date.parse(NOW),status:'stopped',source:'host-observation',assurance:'host-reported'}}});
 assert.equal((await fresh().status(base)).sessions[0].phase,'stopped');
 const predecessorVersion=state.runtimeVersion;
 state=await fresh().handoff({...base,expectedRuntimeVersion:state.runtimeVersion,input:{operation:'transfer'}});
 await assert.rejects(()=>fresh().handoff({...base,expectedRuntimeVersion:predecessorVersion,input:{operation:'transfer'}}));
 const successor=await fresh().nextAction({...base,expectedRuntimeVersion:state.runtimeVersion});assert.equal(successor.action.generation,2);
 assert.equal((await fresh().status(base)).runtime.usage.tokens,10);
});

test('host observation exposes action fallback without promoting host-reported context into native measurement',async t=>{
 const {root,approved,execution,next}=await managedWorker(t,{policy:{maxActions:2}});const base={project:root,runId:approved.runId};
 const {sessionTelemetry}=await import('../../src/clients/session-capabilities.js');
 const telemetry=structuredClone(sessionTelemetry('host'));telemetry.contextUsedTokens={value:99,source:'host-context',assurance:'host-reported'};telemetry.contextWindowTokens={value:100,source:'host-context',assurance:'host-reported'};
 const receipt={sessionId:next.action.sessionId,generation:1,nativeHandle:'native-one',actorId:'host-one',observedAtMs:Date.parse(NOW),source:'host-observation',assurance:'host-reported',actions:1,telemetry};
 let state=await execution.handoff({...base,expectedRuntimeVersion:next.runtimeVersion,input:{operation:'observe',receipt}});
 assert.equal(state.turnoverReason,null);
 const forged=structuredClone(receipt);forged.telemetry.contextUsedTokens.assurance='native-measured';
 await assert.rejects(()=>execution.handoff({...base,expectedRuntimeVersion:state.runtimeVersion,input:{operation:'observe',receipt:forged}}));
 state=await execution.handoff({...base,expectedRuntimeVersion:state.runtimeVersion,input:{operation:'observe',receipt:{...receipt,actions:2}}});
 assert.equal(state.status,'checkpoint-required');assert.equal(state.turnoverReason,'observed-action-boundary');
 const observed=await execution.nextAction({...base,expectedRuntimeVersion:state.runtimeVersion});assert.equal(observed.status,'checkpoint-required');assert.equal(observed.action.generation,1);
});

test('public task checkpoint and handoff reach the managed host service',async t=>{
 const {root,approved,execution,next}=await managedWorker(t);const messages=[];
 const output={log:value=>messages.push(value),error:value=>messages.push(value),json:value=>messages.push(value)};
 const input={expectedRuntimeVersion:next.runtimeVersion,action:next.action,input:{summary:'Pending checks.',usage:{tokens:10,costUsd:0},nativeHandle:'native-one',actorId:'host-one',observedAtMs:Date.parse(NOW)}};
 assert.equal(await main(['task','checkpoint',`--run=${approved.runId}`,`--input-json=${JSON.stringify(input)}`],{cwd:()=>root,work:execution,output}),0,messages.join('\n'));
 const checkpoint=JSON.parse(messages.at(-1));assert.equal(checkpoint.status,'checkpoint-ready');
 assert.equal(await main(['task','handoff',`--run=${approved.runId}`,`--input-json=${JSON.stringify({expectedRuntimeVersion:checkpoint.runtimeVersion,input:{operation:'fence'}})}`],{cwd:()=>root,work:execution,output}),0,messages.join('\n'));
 assert.equal(JSON.parse(messages.at(-1)).status,'stopping');
});

test('host handoff rejects checkpoint and stop observations older than latest activity or fence',async t=>{
 const {root,approved,execution,next,clock}=await managedWorker(t);const base={project:root,runId:approved.runId};
 const {sessionTelemetry}=await import('../../src/clients/session-capabilities.js');
 clock.now+=1000;
 const receipt={sessionId:next.action.sessionId,generation:1,nativeHandle:'native-one',actorId:'host-one',observedAtMs:clock.now,source:'host-observation',assurance:'host-reported',actions:1,telemetry:sessionTelemetry('host')};
 let state=await execution.handoff({...base,expectedRuntimeVersion:next.runtimeVersion,input:{operation:'observe',receipt}});
 const checkpoint={summary:'Remaining checks.',usage:{tokens:10,costUsd:0},nativeHandle:'native-one',actorId:'host-one',observedAtMs:Date.parse(NOW)};
 await assert.rejects(()=>execution.checkpoint({...base,expectedRuntimeVersion:state.runtimeVersion,action:next.action,input:checkpoint}));
 state={runtimeVersion:(await execution.status(base)).runtime.version};
 clock.now+=1000;
 state=await execution.checkpoint({...base,expectedRuntimeVersion:state.runtimeVersion,action:next.action,input:{...checkpoint,observedAtMs:clock.now}});
 const checkpointTime=clock.now;clock.now+=1000;
 state=await execution.handoff({...base,expectedRuntimeVersion:state.runtimeVersion,input:{operation:'fence'}});
 const {actions,telemetry,...proof}=receipt;
 for(const observedAtMs of [receipt.observedAtMs,checkpointTime])await assert.rejects(()=>execution.handoff({...base,expectedRuntimeVersion:state.runtimeVersion,input:{operation:'stop',receipt:{...proof,observedAtMs,status:'stopped'}}}));
 state=await execution.handoff({...base,expectedRuntimeVersion:state.runtimeVersion,input:{operation:'stop',receipt:{...proof,observedAtMs:clock.now,status:'stopped'}}});
 assert.equal(state.status,'stopped');
});

test('enrolled host queues without poisoning state and requires observed stop before normal result',async t=>{
 const {createResourceCoordinator}=await import('../../src/runtime/resource-coordinator.js');
 const {withMachineContext}=await import('../../src/runtime/machine-admission.js');
 const {sessionTelemetry}=await import('../../src/clients/session-capabilities.js');
 const {root,gitClient,approved}=await fixture(t,{managed:{maxMinutes:1}});
 const machine=createResourceCoordinator({root:join(dirname(root),'machine')});
 const registered=await machine.register({projectRoot:root,runId:approved.runId,deadlineMs:Date.now()+120000,machineLimits:{activeTasks:4,agentExecutions:1,heavyVerification:1,dependencyInstalls:1}});
 const blocker=await machine.request({registrationId:registered.id,resource:'agentExecutions',idempotencyKey:'other-writer',generation:1});
 let hostNow=Date.parse(NOW);
 const execution=createHostExecution({gitClient,now:()=>new Date(hostNow).toISOString()});
 const prepared=await execution.prepare({project:root,runId:approved.runId,expectedRunVersion:approved.version});
 const base={project:root,runId:approved.runId};
 const call=(method,input)=>withMachineContext(machine,root,approved.runId,()=>execution[method]({...base,...input}),{nonblocking:true});
 const queued=await call('nextAction',{expectedRuntimeVersion:prepared.runtimeVersion});assert.equal(queued.status,'queued');assert.equal(queued.action,null);
 hostNow+=61000;
 await machine.release({claimId:blocker.id,generation:1,completed:true});
 const next=await call('nextAction',{expectedRuntimeVersion:queued.runtimeVersion});assert.equal(next.status,'action');assert.ok(next.action);
 const worktree=JSON.parse(next.action.payload).contract.worktree.path;await mkdir(join(worktree,'app'),{recursive:true});await writeFile(join(worktree,'app','agenda.js'),'export const agenda=true;\n');
 await assert.rejects(call('submitResult',{expectedRuntimeVersion:next.runtimeVersion,action:next.action,result:resultFor(next.action)}));
 const observation={sessionId:next.action.sessionId,generation:next.action.generation,nativeHandle:'native-one',actorId:'host-one',observedAtMs:hostNow,source:'host-observation',assurance:'host-reported',actions:1,telemetry:sessionTelemetry('host')};
 const observed=await call('handoff',{expectedRuntimeVersion:next.runtimeVersion,input:{operation:'observe',receipt:observation}});
 assert.equal(observed.status,'active');
 const {actions,telemetry,...identity}=observation;
 const released=await call('handoff',{expectedRuntimeVersion:observed.runtimeVersion,input:{operation:'release',receipt:{...identity,status:'stopped'}}});
 const stopped=await call('nextAction',{expectedRuntimeVersion:released.runtimeVersion});assert.equal(stopped.status,'result-required');
 assert.equal((await machine.inspect()).claims.filter(c=>c.resource==='activeTasks'&&c.status==='held').length,1);
 const result=await call('submitResult',{expectedRuntimeVersion:stopped.runtimeVersion,action:stopped.action,result:resultFor(stopped.action)});assert.equal(result.status,'accepted');
 assert.equal((await machine.inspect()).claims.filter(c=>c.resource==='agentExecutions'&&c.status==='held').length,0);
 assert.equal((await execution.status(base)).runtime.usage.timeMinutes,0);
 assert.equal((await machine.inspect()).registrations.find(r=>r.id===registered.id).deadlineMs,registered.deadlineMs);
});

test('enrolled host verification queues without recording failed checks then resumes',async t=>{
 const {createResourceCoordinator}=await import('../../src/runtime/resource-coordinator.js');
 const {withMachineContext}=await import('../../src/runtime/machine-admission.js');
 const {root,execution,verifyInput}=await completedWorker(t,{managed:true});const machine=createResourceCoordinator({root:join(dirname(root),'machine')});
 const r=await machine.register({projectRoot:root,runId:verifyInput.runId,deadlineMs:Date.now()+60000});
 const held=await machine.request({registrationId:r.id,resource:'heavyVerification',idempotencyKey:'occupied',generation:1});
 const verify=()=>withMachineContext(machine,root,r.runId,()=>execution.verify(verifyInput),{nonblocking:true});
 const queued=await verify();assert.equal(queued.status,'queued');
 const status=await execution.status({project:root,runId:r.runId});assert.equal(status.run.status,'running');
 await machine.release({claimId:held.id,generation:1,completed:true});assert.equal((await verify()).status,'awaiting-final-approval');
});

for (const archive of [false,true]) test(`application permits stopped host reconciliation after deadline without new admission${archive?' with archived receipt':''}`,async t=>{
 const {createRivetApplication}=await import('../../src/runtime/application.js');
 const {sessionTelemetry}=await import('../../src/clients/session-capabilities.js');
 const {root,approved}=await fixture(t,{managed:true,now:new Date().toISOString()});
 const app=createRivetApplication({env:{...process.env,RIVET_MACHINE_STATE_ROOT:join(dirname(root),'machine')}});
 const registration=await app.machine.register({projectRoot:root,runId:approved.runId,deadlineMs:Date.now()+60000});const base={project:root,runId:approved.runId};
 const prepared=await app.work.prepare({...base,expectedRunVersion:approved.version});const next=await app.work.nextAction({...base,expectedRuntimeVersion:prepared.runtimeVersion});
 const worktree=JSON.parse(next.action.payload).contract.worktree.path;await mkdir(join(worktree,'app'),{recursive:true});await writeFile(join(worktree,'app','agenda.js'),'export const agenda=true;\n');
 const identity={sessionId:next.action.sessionId,generation:next.action.generation,nativeHandle:'deadline-native',actorId:'host-one',observedAtMs:Date.now(),source:'host-observation',assurance:'host-reported'};
 const observed=await app.work.handoff({...base,expectedRuntimeVersion:next.runtimeVersion,input:{operation:'observe',receipt:{...identity,actions:1,telemetry:sessionTelemetry('host')}}});
 await app.machine.register({projectRoot:root,runId:approved.runId,deadlineMs:Date.now()+30});await new Promise(resolve=>setTimeout(resolve,60));
 const released=await app.work.handoff({...base,expectedRuntimeVersion:observed.runtimeVersion,input:{operation:'release',receipt:{...identity,observedAtMs:Date.now(),status:'stopped'}}});assert.equal(released.status,'resource-released');
 if(archive) {
  for(let i=0;i<256;i++) {
   const old=await app.machine.register({projectRoot:root,runId:`settled-history-${i}`,deadlineMs:Date.now()+60000});
   await app.machine.cancelRegistration(old.id);
  }
  const active=await app.machine.inspectReadOnly();
  assert.equal(active.claims.some(c=>c.idempotencyKey===next.action.sessionId),false);
  const saved=await app.machine.getClaim({registrationId:registration.id,resource:'agentExecutions',idempotencyKey:next.action.sessionId,generation:next.action.generation});
  assert.equal(saved.status,'released');
 }
 const resultAction=await app.work.nextAction({...base,expectedRuntimeVersion:released.runtimeVersion});assert.equal(resultAction.status,'result-required');
 const result=await app.work.submitResult({...base,expectedRuntimeVersion:resultAction.runtimeVersion,action:resultAction.action,result:resultFor(resultAction.action)});assert.equal(result.status,'accepted');
 const after=await app.work.nextAction({...base,expectedRuntimeVersion:result.runtimeVersion});assert.equal(after.status,'deadline');assert.equal(after.action,null);
 const claims=(await app.machine.inspect()).claims.filter(c=>c.registrationId===registration.id);assert.equal(claims.filter(c=>c.status==='held').length,0);
});

test('enrolled host successor starts its execution clock after queued admission',async t=>{
 const {createResourceCoordinator}=await import('../../src/runtime/resource-coordinator.js');
 const {withMachineContext}=await import('../../src/runtime/machine-admission.js');
 const {sessionTelemetry}=await import('../../src/clients/session-capabilities.js');
 const {root,gitClient,approved}=await fixture(t,{managed:{maxMinutes:1}});
 const machine=createResourceCoordinator({root:join(dirname(root),'machine')});
 const registered=await machine.register({projectRoot:root,runId:approved.runId,deadlineMs:Date.now()+120000,machineLimits:{activeTasks:4,agentExecutions:1,heavyVerification:1,dependencyInstalls:1}});
 const blocker=await machine.request({registrationId:registered.id,resource:'agentExecutions',idempotencyKey:'other-writer',generation:1});
 let hostNow=Date.parse(NOW);
 const execution=createHostExecution({gitClient,now:()=>new Date(hostNow).toISOString()});
 const prepared=await execution.prepare({project:root,runId:approved.runId,expectedRunVersion:approved.version});
 const base={project:root,runId:approved.runId};
 const call=(method,input)=>withMachineContext(machine,root,approved.runId,()=>execution[method]({...base,...input}),{nonblocking:true});
 const queued=await call('nextAction',{expectedRuntimeVersion:prepared.runtimeVersion});assert.equal(queued.status,'queued');assert.equal(queued.action,null);
 hostNow+=61000;
 await machine.release({claimId:blocker.id,generation:1,completed:true});
 const next=await call('nextAction',{expectedRuntimeVersion:queued.runtimeVersion});assert.equal(next.status,'action');assert.ok(next.action);

 const worktree=JSON.parse(next.action.payload).contract.worktree.path;
 await mkdir(join(worktree,'app'),{recursive:true});await writeFile(join(worktree,'app','agenda.js'),'export const agenda=true;\n');
 let state=await call('checkpoint',{expectedRuntimeVersion:next.runtimeVersion,action:next.action,input:{summary:'Continue remaining checks.',usage:{tokens:10,costUsd:0},nativeHandle:'native-one',actorId:'host-one',observedAtMs:hostNow}});
 state=await call('handoff',{expectedRuntimeVersion:state.runtimeVersion,input:{operation:'fence'}});
 state=await call('handoff',{expectedRuntimeVersion:state.runtimeVersion,input:{operation:'stop',receipt:{sessionId:next.action.sessionId,generation:1,nativeHandle:'native-one',actorId:'host-one',observedAtMs:hostNow,status:'stopped',source:'host-observation',assurance:'host-reported'}}});
 state=await call('handoff',{expectedRuntimeVersion:state.runtimeVersion,input:{operation:'transfer'}});
 const secondBlocker=await machine.request({registrationId:registered.id,resource:'agentExecutions',idempotencyKey:'second-blocker',generation:1});
 const waiting=await call('nextAction',{expectedRuntimeVersion:state.runtimeVersion});assert.equal(waiting.status,'queued');
 hostNow+=61000;
 await machine.release({claimId:secondBlocker.id,generation:1,completed:true});
 const successor=await call('nextAction',{expectedRuntimeVersion:waiting.runtimeVersion});assert.equal(successor.status,'action');assert.equal(successor.action.generation,2);
 const observation={sessionId:successor.action.sessionId,generation:2,nativeHandle:'native-two',actorId:'host-one',observedAtMs:hostNow,source:'host-observation',assurance:'host-reported',actions:1,telemetry:sessionTelemetry('host')};
 const observed=await call('handoff',{expectedRuntimeVersion:successor.runtimeVersion,input:{operation:'observe',receipt:observation}});assert.equal(observed.status,'active');
 const {actions,telemetry,...identity}=observation;
 const released=await call('handoff',{expectedRuntimeVersion:observed.runtimeVersion,input:{operation:'release',receipt:{...identity,status:'stopped'}}});
 const stopped=await call('nextAction',{expectedRuntimeVersion:released.runtimeVersion});
 assert.equal((await call('submitResult',{expectedRuntimeVersion:stopped.runtimeVersion,action:stopped.action,result:resultFor(stopped.action)})).status,'accepted');
 assert.equal((await execution.status(base)).runtime.usage.timeMinutes,0);
 assert.equal((await machine.inspect()).registrations.find(r=>r.id===registered.id).deadlineMs,registered.deadlineMs);
});

test('enrolled legacy host rejects before changing its approved run or checkout', async t => {
 const {createRivetApplication}=await import('../../src/runtime/application.js');
 const {root,approved,gitClient}=await fixture(t);
 const app=createRivetApplication({env:{...process.env,RIVET_MACHINE_STATE_ROOT:join(dirname(root),'machine')}});
 await app.machine.register({projectRoot:root,runId:approved.runId,deadlineMs:Date.now()+60000});
 const before=await gitClient.listWorktrees(root);
 await assert.rejects(app.work.prepare({project:root,runId:approved.runId,expectedRunVersion:approved.version}));
 assert.equal((await app.feature.status({project:root,runId:approved.runId})).status,'approved');
 assert.deepEqual(await gitClient.listWorktrees(root),before);
 assert.equal((await app.machine.inspect()).claims.length,0);
});

test('host admission cancellation before durable dispatch retains no new writer', async t => {
 const {createResourceCoordinator}=await import('../../src/runtime/resource-coordinator.js');
 const {withMachineContext}=await import('../../src/runtime/machine-admission.js');
 const {root,gitClient,approved}=await fixture(t,{managed:true});
 const execution=createHostExecution({gitClient,now:()=>NOW});
 const prepared=await execution.prepare({project:root,runId:approved.runId,expectedRunVersion:approved.version});
 const c=createResourceCoordinator({root:join(dirname(root),'machine')});
 await c.register({projectRoot:root,runId:approved.runId,deadlineMs:Date.now()+60000});
 const controller=new AbortController();
 const machine={...c,dispatch:async input=>{controller.abort();return c.dispatch(input);}};
 await assert.rejects(withMachineContext(machine,root,approved.runId,()=>execution.nextAction({project:root,runId:approved.runId,expectedRuntimeVersion:prepared.runtimeVersion}),{signal:controller.signal}));
 const claims=(await c.inspect()).claims.filter(x=>x.resource==='agentExecutions');
 assert.equal(claims.length,1);assert.equal(claims[0].status,'released');assert.equal(claims[0].dispatched,undefined);
 const state=await execution.status({project:root,runId:approved.runId});
 assert.equal(state.sessions[0].stopStatus,'unknown');
 const next=await withMachineContext(c,root,approved.runId,()=>execution.nextAction({project:root,runId:approved.runId,expectedRuntimeVersion:state.runtime.version}));
 assert.equal(next.status,'action');
 assert.equal((await c.inspect()).claims.filter(x=>x.resource==='agentExecutions'&&x.status==='held').length,1);
});

test('application forwards host cancellation and preserves previously dispatched owners', async t => {
 const {createRivetApplication}=await import('../../src/runtime/application.js');
 const {root,approved}=await fixture(t,{managed:true,now:new Date().toISOString()});
 const app=createRivetApplication({env:{...process.env,RIVET_MACHINE_STATE_ROOT:join(dirname(root),'machine')}});
 await app.machine.register({projectRoot:root,runId:approved.runId,deadlineMs:Date.now()+60000});
 const base={project:root,runId:approved.runId};
 const prepared=await app.work.prepare({...base,expectedRunVersion:approved.version});
 const controller=new AbortController();controller.abort();
 await assert.rejects(app.work.nextAction({...base,expectedRuntimeVersion:prepared.runtimeVersion},{signal:controller.signal}));
 assert.equal((await app.machine.inspect()).claims.length,0);
 const next=await app.work.nextAction({...base,expectedRuntimeVersion:prepared.runtimeVersion});
 await assert.rejects(app.work.nextAction({...base,expectedRuntimeVersion:next.runtimeVersion},{signal:controller.signal}));
 const claims=(await app.machine.inspect()).claims;
 assert.equal(claims.find(x=>x.resource==='agentExecutions').status,'held');
 assert.equal(claims.find(x=>x.resource==='activeTasks').status,'held');
});

test('application automatically enrolls approved host execution while status and invalid prepare remain inert',async t=>{
 const {createRivetApplication}=await import('../../src/runtime/application.js');
 const {root,approved}=await fixture(t,{managed:true,now:new Date().toISOString()});
 const app=createRivetApplication({env:{...process.env,RIVET_MACHINE_STATE_ROOT:join(dirname(root),'machine')}});
 const base={project:root,runId:approved.runId};
 await app.work.status(base);assert.equal((await app.machine.inspect()).configured,false);
 await assert.rejects(app.work.prepare({...base,expectedRunVersion:approved.version+1}));assert.equal((await app.machine.inspect()).configured,false);
 await assert.rejects(app.work.prepare({...base,expectedRunVersion:approved.version,unexpected:true}));assert.equal((await app.machine.inspect()).configured,false);
 for(const key of ['hidden',Symbol('hidden')]){await assert.rejects(app.work.prepare(Object.defineProperty({...base,expectedRunVersion:approved.version},key,{value:true})));assert.equal((await app.machine.inspect()).configured,false);}
 const before=Date.now();const ready=await app.work.prepare({...base,expectedRunVersion:approved.version});assert.equal(ready.status,'ready');
 const registered=(await app.machine.inspect()).registrations;assert.equal(registered.length,1);assert.equal(registered[0].runId,approved.runId);assert.ok(registered[0].deadlineMs>=before+3600000);
 const next=await app.work.nextAction({...base,expectedRuntimeVersion:ready.runtimeVersion});assert.ok(next.action);
 const again=await app.work.nextAction({...base,expectedRuntimeVersion:next.runtimeVersion});assert.equal(again.status,'waiting-for-result');assert.equal((await app.machine.inspect()).registrations[0].deadlineMs,registered[0].deadlineMs);
});

test('application enrolls a previously prepared managed host at first valid next action',async t=>{
 const {createRivetApplication}=await import('../../src/runtime/application.js');
 const {root,approved,gitClient}=await fixture(t,{managed:true,now:new Date().toISOString()});
 const execution=createHostExecution({gitClient});
 const base={project:root,runId:approved.runId};const prepared=await execution.prepare({...base,expectedRunVersion:approved.version});
 const app=createRivetApplication({env:{...process.env,RIVET_MACHINE_STATE_ROOT:join(dirname(root),'machine')}});
 await assert.rejects(app.work.nextAction({...base,expectedRuntimeVersion:prepared.runtimeVersion+1}));assert.equal((await app.machine.inspect()).configured,false);
 for(const key of ['hidden',Symbol('hidden')]){await assert.rejects(app.work.nextAction(Object.defineProperty({...base,expectedRuntimeVersion:prepared.runtimeVersion},key,{value:true})));assert.equal((await app.machine.inspect()).configured,false);}
 const next=await app.work.nextAction({...base,expectedRuntimeVersion:prepared.runtimeVersion});assert.ok(next.action);assert.equal((await app.machine.inspect()).registrations.length,1);
});

test('host verification consumes exact configured reuse and reports that evidence was reused',async t=>{
  const {root,approved,gate,gitClient,execution,verifyInput}=await completedWorker(t,{verificationReuse:true});
  const {loadProjectConfig}=await import('../../src/config/load.js');
  const {configuredVerificationReuse}=await import('../../src/quality/configuration.js');
  const {runQualityGates}=await import('../../src/quality/runner.js');
  const {configuredFeatureGates,featureQualityAuthority}=await import('../../src/feature/runtime-bridge.js');
  const {createAcceptedIntegrationStore}=await import('../../src/feature/accepted-integration.js');
  const {acceptedIntegrationPaths}=await import('../../src/state/paths.js');
  const paths=await resolveFeatureRunPaths(root,approved.runId);
  const accepted=await createAcceptedIntegrationStore(await acceptedIntegrationPaths(paths)).readOnly();
  const config=await loadProjectConfig(root);
  const counter=join(dirname(root),'gate-count');
  await writeFile(gate,`#!${await realpath("/bin/sh")}\nprintf 'run\\n' >> '${counter}'\nexit 0\n`);
  const quality=await runQualityGates({
    ...configuredVerificationReuse(config),projectRoot:accepted.path,commitSha:accepted.commitSha,
    authority:featureQualityAuthority(config),gates:await configuredFeatureGates(config,async()=>gate,accepted.path),
    environment:{PATH:process.env.PATH},
  },{gitClient,now:()=>Date.parse(NOW)});
  assert.equal(quality.verificationReuse.status,'executed');
  const before=await readFile(counter,'utf8');
  assert.equal((await execution.verify(verifyInput)).status,'awaiting-final-approval');
  const report=await createVerificationReportStore(await verificationReportPaths(paths)).readOnly();
  assert.equal(report.verificationReuse,'reused');
  assert.equal(await readFile(counter,'utf8'),before);
});

test('host and verify command leave long shared verification pending without recording failure',async t=>{
  const {root,approved,gate,gitClient,execution,verifyInput}=await completedWorker(t,{verificationReuse:true});
  const {loadProjectConfig}=await import('../../src/config/load.js');
  const {configuredVerificationReuse}=await import('../../src/quality/configuration.js');
  const {runQualityGates}=await import('../../src/quality/runner.js');
  const {verifyProject}=await import('../../src/commands/verify.js');
  const {configuredFeatureGates,featureQualityAuthority}=await import('../../src/feature/runtime-bridge.js');
  const {createAcceptedIntegrationStore}=await import('../../src/feature/accepted-integration.js');
  const {acceptedIntegrationPaths}=await import('../../src/state/paths.js');
  const paths=await resolveFeatureRunPaths(root,approved.runId);
  const accepted=await createAcceptedIntegrationStore(await acceptedIntegrationPaths(paths)).readOnly();
  const config=await loadProjectConfig(root);
  const marker=join(dirname(root),'long-owner-started');
  await writeFile(gate,`#!${await realpath("/bin/sh")}\nprintf started > '${marker}'\nexec /bin/sleep 120\n`);
  const quality={...configuredVerificationReuse(config),projectRoot:accepted.path,commitSha:accepted.commitSha,
    authority:featureQualityAuthority(config),gates:await configuredFeatureGates(config,async()=>gate,accepted.path),environment:{PATH:process.env.PATH}};
  const controller=new AbortController();
  const owner=runQualityGates(quality,{gitClient,now:()=>Date.parse(NOW),signal:controller.signal}).catch(error=>error);
  try {
    await waitForFile(marker);
    const [host,command]=await Promise.all([
      execution.verify(verifyInput),
      verifyProject({quality,traceability:{subjectId:'review-owner',acceptanceCriteria:[],manualReviews:[]}},{gitClient,now:()=>Date.parse(NOW)}),
    ]);
    assert.equal(host.status,'queued');
    assert.equal(host.reason,'verification-running');
    assert.equal(command.status,'queued');
    assert.equal(command.ok,false);
    assert.equal(await createVerificationReportStore(await verificationReportPaths(paths)).readOnly(),null);
  } finally {controller.abort();await owner;}
});
