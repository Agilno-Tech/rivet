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
