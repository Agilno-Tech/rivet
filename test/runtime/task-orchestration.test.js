import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import YAML from 'yaml';
import {managedPolicy} from '../fixtures/execution-policy.js';
import {executionPolicyIdentity} from '../../src/models/execution-policy.js';
import {createResourceCoordinator} from '../../src/runtime/resource-coordinator.js';
import {activateTaskAdmission,taskAllowance,taskCapacity} from '../../src/runtime/task-orchestration.js';
import {createRivetApplication} from '../../src/runtime/application.js';
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'rivet-task-simple-')));t.after(()=>rm(root,{recursive:true,force:true}));
 await cp(new URL('../fixtures/config/valid/.rivet',import.meta.url),join(root,'.rivet'),{recursive:true});
 const path=join(root,'.rivet/orchestration.yaml');
 const config=YAML.parse(await readFile(path,'utf8'));const policy=managedPolicy();config.executionPolicy=policy;await writeFile(path,YAML.stringify(config));
 const machine=join(root,'machine');const coordinator=createResourceCoordinator({root:machine});
 const record={runId:'test-task',version:2,status:'approved',featurePlan:{client:'codex',executionPolicy:executionPolicyIdentity(policy)}};
 return {root,machine,coordinator,record,config,path};
}
test('duration parsing rejects malformed or excessive allowances',()=>{
 assert.equal(taskAllowance('1h'),3600000);assert.equal(taskAllowance('30m'),1800000);assert.equal(taskAllowance('5s'),5000);
 for(const value of ['0h','1.5h','1h30m','-1h',' 1h','999999999h',true])assert.throws(()=>taskAllowance(value));
});
test('task enrollment is approved only and legacy cannot acquire an allowance',async t=>{
 const {root,coordinator,record}=await fixture(t);
 await activateTaskAdmission(coordinator,{...record,status:'proposed'},root);
 assert.equal((await coordinator.inspect()).configured,false);
 await activateTaskAdmission(coordinator,{...record,featurePlan:{}},root);
 await assert.rejects(activateTaskAdmission(coordinator,{...record,featurePlan:{}},root,{allowanceMs:1000}));
 assert.equal((await coordinator.inspect()).configured,false);
});
test('task allowance survives restart and resume, can shorten, and keeps capacity IDs internal',async t=>{
 const {root,machine,coordinator,record}=await fixture(t);const before=Date.now();
 const first=await activateTaskAdmission(coordinator,record,root);
 assert.ok(first.deadlineMs>=before+3600000);assert.ok(first.deadlineMs<=Date.now()+3600000);
 await coordinator.pause(first.id);
 const restarted=createResourceCoordinator({root:machine});
 const resumed=await activateTaskAdmission(restarted,record,root,{allowanceMs:7200000,resume:true});
 assert.equal(resumed.deadlineMs,first.deadlineMs);assert.equal(resumed.paused,false);
 const shorter=await activateTaskAdmission(restarted,record,root,{allowanceMs:30000});assert.ok(shorter.deadlineMs<first.deadlineMs);
 const summary=await taskCapacity(restarted,root,record.runId);assert.equal(JSON.stringify(summary).includes('registration-'),false);
});
test('changed policy cannot silently enroll an existing approval',async t=>{
 const {root,coordinator,record,path,config}=await fixture(t);config.executionPolicy.limits.agentExecutions=1;await writeFile(path,YAML.stringify(config));
 await assert.rejects(activateTaskAdmission(coordinator,record,root),/changed since approval/);assert.equal((await coordinator.inspect()).configured,false);
});
test('application enrolls approved execution before dispatch and leaves stale requests unenrolled',async t=>{
 const {root,machine,record}=await fixture(t);let dispatched=0;
 const workflow=Object.fromEntries(['propose','start','watch','status','resume','cancel'].map(method=>[method,async()=>{if(method==='resume')dispatched++;return record;}]));
 const app=createRivetApplication({env:{RIVET_MACHINE_STATE_ROOT:machine},featureWorkflow:workflow});
 await app.feature.status({project:root,runId:record.runId});assert.equal((await app.machine.inspect()).configured,false);
 await assert.rejects(app.feature.resume({project:root,runId:record.runId,expectedVersion:1}));assert.equal((await app.machine.inspect()).configured,false);
 await app.feature.resume({project:root,runId:record.runId,expectedVersion:2},{allowanceMs:30000});assert.equal(dispatched,1);assert.equal((await app.machine.inspect()).registrations.length,1);
});

test('machine limits can be configured before tasks while invalid and busy changes are refused',async t=>{
 const {root,coordinator,record}=await fixture(t);
 await assert.rejects(coordinator.configure({activeTasks:0}));assert.equal((await coordinator.inspect()).configured,false);
 const limits={activeTasks:2,agentExecutions:2,heavyVerification:1,dependencyInstalls:1};await coordinator.configure(limits);assert.deepEqual((await coordinator.inspect()).limits,limits);
 const r=await activateTaskAdmission(coordinator,record,root);await coordinator.request({registrationId:r.id,resource:'activeTasks',idempotencyKey:'busy',generation:1});
 await assert.rejects(coordinator.configure({...limits,activeTasks:3}),/active-claims/);assert.deepEqual((await coordinator.inspect()).limits,limits);
});

test('owned execution entry points reject managed host requests before enrolling',async t=>{
 const {root,machine,record}=await fixture(t);record.featurePlan.client='host';let attempts=0;
 const featureWorkflow=Object.fromEntries(['propose','start','watch','status','resume','cancel'].map(method=>[method,async()=>{if(['resume','watch'].includes(method)){attempts++;throw Object.assign(new Error('Host uses work.'),{code:'ERR_FEATURE_WORKFLOW_HOST_USE_WORK'});}return record;}]));
 const app=createRivetApplication({env:{RIVET_MACHINE_STATE_ROOT:machine},featureWorkflow});
 for(const method of ['resume','watch'])await assert.rejects(app.feature[method]({project:root,runId:record.runId,expectedVersion:record.version}),error=>error.code==='ERR_FEATURE_WORKFLOW_HOST_USE_WORK');
 assert.equal((await app.machine.inspect()).configured,false);assert.equal(attempts,0);
});

test('hidden request and option keys cannot enroll a managed execution',async t=>{
 const {root,machine,record}=await fixture(t);
 const featureWorkflow=Object.fromEntries(['propose','start','watch','status','resume','cancel'].map(method=>[method,async()=>record]));
 const app=createRivetApplication({env:{RIVET_MACHINE_STATE_ROOT:machine},featureWorkflow});
 const input={project:root,runId:record.runId,expectedVersion:record.version};
 for(const key of ['hidden',Symbol('hidden')]){
  const request=Object.defineProperty({...input},key,{value:true});
  await assert.rejects(app.feature.resume(request));assert.equal((await app.machine.inspect()).configured,false);
  const options=Object.defineProperty({},key,{value:true});
  await assert.rejects(app.feature.resume(input,options));assert.equal((await app.machine.inspect()).configured,false);
 }
});

test('automatic enrollment enforces aggregate project resources without a parent registration', async t => {
 const f=await fixture(t); const other=await fixture(t);
 for(const resource of ['activeTasks','agentExecutions','heavyVerification','dependencyInstalls']) f.config.executionPolicy.limits[resource]=1;
 await writeFile(f.path,YAML.stringify(f.config));
 const record={...f.record,featurePlan:{...f.record.featurePlan,executionPolicy:executionPolicyIdentity(f.config.executionPolicy)}};
 await f.coordinator.configure({activeTasks:4,agentExecutions:4,heavyVerification:4,dependencyInstalls:4});
 const first=await activateTaskAdmission(f.coordinator,record,f.root);
 const second=await activateTaskAdmission(f.coordinator,{...record,runId:'second'},f.root);
 const separate=await activateTaskAdmission(f.coordinator,other.record,other.root);
 const firstClaims=[]; const waiting=[];
 for(const resource of ['activeTasks','agentExecutions','heavyVerification','dependencyInstalls']) {
  const request={resource,idempotencyKey:resource,generation:1};
  firstClaims.push(await f.coordinator.request({...request,registrationId:first.id}));
  waiting.push(await f.coordinator.request({...request,registrationId:second.id}));
  assert.equal(firstClaims.at(-1).status,'held');
  assert.equal(waiting.at(-1).status,'queued');
  assert.equal(waiting.at(-1).reason,`project-${resource}`);
  assert.equal((await f.coordinator.request({...request,registrationId:separate.id})).status,'held');
 }
 assert.equal((await f.coordinator.inspect()).registrations.some(r=>r.runId===null),false);
 for(const claim of firstClaims.slice(1)) await f.coordinator.release({claimId:claim.id,generation:1,completed:true});
 await f.coordinator.release({claimId:firstClaims[0].id,generation:1,completed:true});
 assert.ok((await f.coordinator.inspect()).claims.filter(c=>waiting.some(w=>w.id===c.id)).every(c=>c.status==='held'));
});

import {withOperationAdmission} from '../../src/runtime/task-orchestration.js';
import {admitted} from '../../src/runtime/machine-admission.js';
import {observeExecutionAttempt} from '../../src/clients/execution-proof.js';
async function waitClaim(coordinator,predicate) {
 for(let n=0;n<100;n++) {
  const claim=(await coordinator.inspect()).claims.find(predicate);if(claim)return claim;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 throw new Error('Claim did not reach expected state');
}
test('bounded model operations obey the machine ceiling across projects',async t=>{
 const f=await fixture(t),other=await fixture(t);
 await f.coordinator.configure({activeTasks:4,agentExecutions:1,heavyVerification:1,dependencyInstalls:1});
 const r=await activateTaskAdmission(f.coordinator,other.record,other.root);
 const occupied=await f.coordinator.request({registrationId:r.id,resource:'agentExecutions',idempotencyKey:'occupied',generation:1});
 let calls=0;const controller=new AbortController();
 const pending=withOperationAdmission(f.coordinator,f.root,signal=>admitted('agentExecutions','model',{signal},async()=>{calls++;}),{signal:controller.signal});
 const rejected=assert.rejects(pending);
 assert.equal((await waitClaim(f.coordinator,c=>c.status==='queued')).reason,'machine-agentExecutions');
 controller.abort();await rejected;assert.equal(calls,0);
 assert.equal((await f.coordinator.inspect()).claims.filter(c=>c.status==='held').length,1);
 assert.equal((await f.coordinator.inspect()).claims.find(c=>c.id===occupied.id).status,'held');
});
test('bounded operations inherit parent pause and deadline without dispatch',async t=>{
 const f=await fixture(t);const parent=await f.coordinator.register({projectRoot:f.root,deadlineMs:Date.now()+1000,limits:f.config.executionPolicy.limits});
 await f.coordinator.pause(parent.id);let calls=0;
 const pending=withOperationAdmission(f.coordinator,f.root,signal=>admitted('agentExecutions','model',{signal},async()=>{calls++;}));
 const rejected=assert.rejects(pending);
 assert.equal((await waitClaim(f.coordinator,c=>c.status==='queued')).reason,'paused');
 await rejected;assert.equal(calls,0);
 const state=await f.coordinator.inspect();assert.ok(state.registrations.every(r=>r.deadlineMs<=parent.deadlineMs));assert.equal(state.claims.some(c=>['held','queued'].includes(c.status)),false);
});
test('cancelled project enrollment cannot be bypassed by a fresh operation ID',async t=>{
 const f=await fixture(t);const parent=await f.coordinator.register({projectRoot:f.root,deadlineMs:Date.now()+30000});await f.coordinator.cancelRegistration(parent.id);
 let calls=0;await assert.rejects(withOperationAdmission(f.coordinator,f.root,async()=>{calls++;}),/cancelled/);
 assert.equal(calls,0);assert.equal((await f.coordinator.inspect()).registrations.length,1);
});
test('unknown model execution remains held and blocks the next bounded operation',async t=>{
 const f=await fixture(t);f.config.executionPolicy.limits.agentExecutions=1;await writeFile(f.path,YAML.stringify(f.config));
 await assert.rejects(withOperationAdmission(f.coordinator,f.root,signal=>admitted('agentExecutions','unknown',{signal},async()=>{throw new Error('Unknown child outcome');})),/Unknown child/);
 assert.equal((await f.coordinator.inspect()).claims.find(c=>c.dispatched)?.status,'held');
 const controller=new AbortController();let calls=0;
 const next=withOperationAdmission(f.coordinator,f.root,signal=>admitted('agentExecutions','next',{signal},async()=>{calls++;observeExecutionAttempt();}),{signal:controller.signal});const rejected=assert.rejects(next);
 assert.equal((await waitClaim(f.coordinator,c=>c.status==='queued')).reason,'project-agentExecutions');controller.abort();await rejected;assert.equal(calls,0);
});
test('bounded model operation deadline expires even without project enrollment',async t=>{
 const f=await fixture(t);let calls=0;
 await assert.rejects(withOperationAdmission(f.coordinator,f.root,()=>{calls++;},{deadlineMs:Date.now()-1}),/deadline/);assert.equal(calls,0);assert.equal((await f.coordinator.inspect()).configured,false);
});
test('settled bounded operations retire their private admission records across repeated calls',async t=>{
 const f=await fixture(t);
 const task=await activateTaskAdmission(f.coordinator,f.record,f.root);
 for(let i=0;i<12;i++) {
  await withOperationAdmission(f.coordinator,f.root,signal=>admitted('agentExecutions','completed',{signal},async()=>{observeExecutionAttempt();}));
  const state=await f.coordinator.inspect();
  assert.deepEqual(state.registrations.map(r=>r.id),[task.id]);
  assert.equal(state.claims.length,0);
 }
});
test('retirement preserves unknown execution ownership while removing later settled operations',async t=>{
 const f=await fixture(t);
 await assert.rejects(withOperationAdmission(f.coordinator,f.root,signal=>admitted('agentExecutions','unknown',{signal},async()=>{throw new Error('unknown');})),/unknown/);
 const prior=await f.coordinator.inspect();
 for(let i=0;i<3;i++)await withOperationAdmission(f.coordinator,f.root,signal=>admitted('agentExecutions','completed',{signal},async()=>{observeExecutionAttempt();}));
 const state=await f.coordinator.inspect();
 assert.deepEqual(state.registrations,prior.registrations);assert.deepEqual(state.claims,prior.claims);
});
