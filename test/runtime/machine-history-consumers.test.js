import test from 'node:test';
import assert from 'node:assert/strict';
import {findRegistration,withMachineContext} from '../../src/runtime/machine-admission.js';
import {inspectBatchReadinessAdmission,withBatchAdmission} from '../../src/quality/batch-admission.js';

function archivedCoordinator(overrides={}) {
 const registration={id:'saved',projectRoot:'/project',runId:'task',deadlineMs:Date.now()+60000,paused:false,...overrides};
 return {registration,coordinator:{
  inspect:async()=>({registrations:[],claims:[]}),
  inspectReadOnly:async()=>({registrations:[],claims:[]}),
  getRegistration:async({projectRoot,runId})=>projectRoot==='/project'&&runId==='task'?registration:undefined,
 }};
}
test('normal admission finds archived registration and preserves expired deadline',async()=>{
 const {coordinator,registration}=archivedCoordinator({deadlineMs:Date.now()-1});
 assert.deepEqual(await findRegistration(coordinator,'/project','task'),registration);
 await assert.rejects(withMachineContext(coordinator,'/project','task',()=>assert.fail('must not execute as unmanaged')),/deadline/);
});
for(const constraint of [{paused:true},{cancelled:true},{deadlineMs:Date.now()-1}]) {
 test(`readonly batch readiness preserves archived constraint ${Object.keys(constraint)[0]}`,async()=>{
  const {coordinator}=archivedCoordinator(constraint);
  coordinator.inspect=async()=>assert.fail('listing must not mutate admission');
  await assert.rejects(inspectBatchReadinessAdmission('/project','task',{coordinator}),/paused, cancelled or expired/);
 });
 test(`batch dispatch preserves archived constraint ${Object.keys(constraint)[0]}`,async()=>{
  const {coordinator}=archivedCoordinator(constraint);
  await assert.rejects(withBatchAdmission('/project',[{runId:'task'}],{coordinator},()=>assert.fail('must not run')),/paused, cancelled or expired/);
 });
}
