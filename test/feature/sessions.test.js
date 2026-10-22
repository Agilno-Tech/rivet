import assert from 'node:assert/strict';
import test from 'node:test';
import {newSession,validateSessions,turnoverReason,validateSessionTelemetry,observeHostSession,stopReceipt} from '../../src/feature/sessions.js';
import {sessionTelemetry} from '../../src/clients/session-capabilities.js';
const policy={maxReplacements:2,maxActions:3,maxMinutes:2,contextThresholdPercent:75};
test('host stop proof cannot predate the latest observed writer activity',()=>{
 const {session}=fixture();
 const receipt={sessionId:session.id,generation:1,nativeHandle:'native-one',actorId:'host-one',observedAtMs:2000,actions:1,telemetry:sessionTelemetry('host'),source:'host-observation',assurance:'host-reported'};
 observeHostSession(session,receipt);observeHostSession(session,{...receipt,observedAtMs:5000,actions:2});
 const {actions,telemetry,...proof}=receipt;
 assert.throws(()=>stopReceipt({...proof,status:'stopped'},session));
 assert.doesNotThrow(()=>stopReceipt({...proof,observedAtMs:5000,status:'stopped'},session));
});
function fixture(){const intent={id:'launch-worker-1',nodeId:'worker'};const session=newSession('run-one',intent,policy,1000);intent.session={id:session.id,generation:1,maxActions:policy.maxActions,maxMinutes:policy.maxMinutes,checkpoint:null};return {session,state:{sessionPolicy:policy,sessions:{worker:session},launchIntents:{worker:intent},graph:{nodes:[{id:'worker'}]}}};}
test('session threshold uses measured context and deterministic observed-action/time fallback, never total tokens',()=>{
 const {session}=fixture();session.telemetry=sessionTelemetry('claude',{tokens:100000,costUsd:1});
 assert.equal(turnoverReason(session,2000),null);
 session.telemetry=structuredClone(session.telemetry);session.telemetry.contextUsedTokens={value:75,source:'native-context',assurance:'native-measured'};session.telemetry.contextWindowTokens={value:100,source:'native-context',assurance:'native-measured'};
 assert.equal(turnoverReason(session,2000),'measured-context-threshold');
 session.telemetry.contextUsedTokens.assurance='model-reported';assert.equal(turnoverReason(session,2000),null);
 session.actions=3;assert.equal(turnoverReason(session,2000),'observed-action-boundary');session.actions=0;
 assert.equal(turnoverReason(session,121000),'elapsed-time-boundary');
});
test('saved sessions reject forged generation policy fields histories and telemetry',()=>{
 const {state}=fixture();assert.doesNotThrow(()=>validateSessions(state,'run-one'));
 for(const mutate of [s=>s.sessions.worker.generation++,s=>s.sessions.worker.extra=true,s=>s.sessions.worker.writer={source:'owned-process'},s=>s.sessions.worker.history.push({}),s=>s.sessions.worker.policy={...policy,maxReplacements:32}]){
  const changed=structuredClone(state);mutate(changed);assert.throws(()=>validateSessions(changed,'run-one'));
 }
 const telemetry=structuredClone(sessionTelemetry('host'));telemetry.contextUsedTokens.value=0;assert.throws(()=>validateSessionTelemetry(telemetry));
});
test('saved session authority is bidirectional and replacement history cannot reset the cap',()=>{
 const {state,session}=fixture();
 for(const mutate of [s=>s.sessions={},s=>{delete s.sessions;delete s.sessionPolicy;},s=>s.sessionReplacementCounts=[],s=>s.sessionReplacementCounts=0,s=>{s.launchIntents.worker.status='started';delete s.launchIntents.worker.session;s.sessions={};},s=>{s.launchIntents.worker.status='complete';s.launchIntents.worker.startedAtMs=1000;delete s.launchIntents.worker.session;s.sessions={};}]){
  const changed=structuredClone(state);mutate(changed);assert.throws(()=>validateSessions(changed,'run-one'));
 }
 const intent=state.launchIntents.worker;
 const second=newSession('run-one',intent,policy,2000,{...session,checkpoint:{digest:'a'.repeat(64),summary:'Continue',usage:{tokens:1,costUsd:0}}});
 state.sessions.worker=second;intent.session={id:second.id,generation:2,maxActions:policy.maxActions,maxMinutes:policy.maxMinutes,checkpoint:'Continue'};
 state.sessionReplacementCounts={worker:1};assert.doesNotThrow(()=>validateSessions(state,'run-one'));
 for(const mutate of [s=>delete s.sessionReplacementCounts,s=>s.sessionReplacementCounts.worker=0,s=>s.sessions.worker.history[0].id='session-unrelated',s=>s.sessions.worker.history[0].generation=9,s=>s.sessions.worker.predecessor='session-different',s=>delete s.launchIntents.worker]){
  const changed=structuredClone(state);mutate(changed);assert.throws(()=>validateSessions(changed,'run-one'));
 }
 state.sessionReplacementCounts.worker=2;assert.doesNotThrow(()=>validateSessions(state,'run-one'));
});
