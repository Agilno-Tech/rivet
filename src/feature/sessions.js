import {createHash} from 'node:crypto';
import {immutableJson,containsSecretMaterial} from '../clients/contract.js';
export function sessionFailure(reason='state-conflict') {
 const error=new Error(`Session continuity requires reconciliation (${reason}).`);
 error.code=`ERR_SESSION_${reason.replaceAll('-','_').toUpperCase()}`;error.safeMessage=error.message;throw error;
}
export function sessionId(intentId,generation) {return `session-${createHash('sha256').update(`${intentId}:${generation}`).digest('hex').slice(0,32)}`;}
export function newSession(runId,intent,policy,nowMs,previous=null) {
 const generation=(previous?.generation??0)+1;
 return {version:1,runId,nodeId:intent.nodeId,intentId:intent.id,id:sessionId(intent.id,generation),generation,
   phase:'active',usageSettled:false,settledUsage:null,observedAtMs:nowMs,startedAtMs:nowMs,actions:0,policy:structuredClone(policy),checkpoint:null,writer:null,stopReceipt:null,telemetry:null,
   predecessor:previous?.id??null,history:previous ? [...previous.history,{id:previous.id,generation:previous.generation,checkpointDigest:previous.checkpoint.digest,usage:previous.settledUsage??previous.checkpoint.usage}] : [],
   continuation:previous?.checkpoint.summary??null};
}
const ID=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const HASH=/^[a-f0-9]{64}$/;
function exact(value,keys,required=keys) {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k))||required.some(k=>!Object.hasOwn(value,k)))sessionFailure('invalid-record');
}
function integer(value,min=0,max=Number.MAX_SAFE_INTEGER){if(!Number.isSafeInteger(value)||value<min||value>max)sessionFailure('invalid-record');}
function text(value,max=8000){if(typeof value!=='string'||!value.length||value.length>max||containsSecretMaterial(value))sessionFailure('invalid-record');}
function usage(value){exact(value,['tokens','costUsd','timeMinutes','tasks'],['tokens','costUsd']);integer(value.tokens,0,10000000);if(!Number.isFinite(value.costUsd)||value.costUsd<0||value.costUsd>100000)sessionFailure('invalid-record');if(value.timeMinutes!==undefined)integer(value.timeMinutes);if(value.tasks!==undefined)integer(value.tasks);}
export function validateSessionTelemetry(value) {
 exact(value,['version','provider','tokens','costUsd','contextUsedTokens','contextWindowTokens']);
 if(value.version!==1||!['host','claude','codex'].includes(value.provider))sessionFailure('invalid-telemetry');
 for(const key of ['tokens','costUsd','contextUsedTokens','contextWindowTokens']) {
  const field=value[key];exact(field,['value','source','assurance']);text(field.source,200);
  if(!['unknown','native-measured','native-estimate','model-reported','host-reported'].includes(field.assurance)
   || (field.assurance==='unknown' ? field.value!==null : !Number.isFinite(field.value)||field.value<0)
   || key!=='costUsd'&&field.value!==null&&!Number.isSafeInteger(field.value))sessionFailure('invalid-telemetry');
 }
 return immutableJson(value);
}
function validateCheckpoint(value,session) {
 exact(value,['version','runId','nodeId','intentId','sessionId','generation','proposalDigest','policyDigest','selectionDigest','baseSha','reservation','worktree','manifest','summary','usage','nativeHandle','criteria','decisionsRef','evidenceRefs','digest']);
 const {digest,...body}=value;
 if(!HASH.test(digest)||createHash('sha256').update(JSON.stringify(body)).digest('hex')!==digest||value.version!==1
  ||value.sessionId!==session.id||value.generation!==session.generation||value.runId!==session.runId||value.nodeId!==session.nodeId||value.intentId!==session.intentId)sessionFailure('invalid-checkpoint');
 for(const key of ['proposalDigest','policyDigest','selectionDigest'])if(!HASH.test(value[key]))sessionFailure('invalid-checkpoint');
 if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.baseSha))sessionFailure('invalid-checkpoint');
 exact(value.reservation,['leaseId','ownerId','baseSha','expiresAt']);text(value.reservation.leaseId,64);text(value.reservation.ownerId,64);if(!Number.isFinite(Date.parse(value.reservation.expiresAt)))sessionFailure();
 text(value.summary);usage(value.usage);if(value.nativeHandle!==null)text(value.nativeHandle,200);
 exact(value.manifest,['repositoryId','root','rootIdentity','branch','headSha','ancestors','indexDigest','entries','digest']);
 if(!HASH.test(value.manifest.digest)||!HASH.test(value.manifest.indexDigest)||!Array.isArray(value.manifest.entries)||value.manifest.entries.length>256||!Array.isArray(value.manifest.ancestors)||value.manifest.ancestors.length>256)sessionFailure('invalid-checkpoint');
 for(const entry of value.manifest.entries){
  if(entry.deleted===true)exact(entry,['path','deleted']);else{exact(entry,['path','dev','ino','mode','digest']);if(!HASH.test(entry.digest))sessionFailure('invalid-checkpoint');integer(entry.mode,0,511);}
  text(entry.path,500);if(entry.path.startsWith('/')||entry.path.split('/').some(p=>!p||p==='.'||p==='..'))sessionFailure('invalid-checkpoint');
 }
 for(const ancestor of value.manifest.ancestors){exact(ancestor,['path','dev','ino']);text(ancestor.path,4096);}
}
export function validateSessions(state,runId) {
 if(state.sessions===undefined) {if(state.sessionPolicy!==undefined||state.sessionReplacementCounts!==undefined||Object.values(state.launchIntents??{}).some(intent=>intent.session!==undefined))sessionFailure();return;}
 exact(state.sessionPolicy,['maxReplacements','maxActions','maxMinutes','contextThresholdPercent']);
 integer(state.sessionPolicy.maxReplacements,0,32);integer(state.sessionPolicy.maxActions,1,10000);integer(state.sessionPolicy.maxMinutes,1,1440);integer(state.sessionPolicy.contextThresholdPercent,1,99);
 if(state.sessionReplacementCounts!==undefined&&(!state.sessionReplacementCounts||typeof state.sessionReplacementCounts!=='object'||Array.isArray(state.sessionReplacementCounts)))sessionFailure();
 for(const [nodeId,count] of Object.entries(state.sessionReplacementCounts??{})){if(!state.graph.nodes.some(n=>n.id===nodeId))sessionFailure();integer(count,0,state.sessionPolicy.maxReplacements);}
 if(!state.sessions || Array.isArray(state.sessions)||typeof state.sessions!=='object'||Object.keys(state.sessions).length>256) sessionFailure();
 for(const [nodeId,intent] of Object.entries(state.launchIntents??{})){
  if((intent.status==='started'||intent.startedAtMs!==undefined)&&intent.session===undefined)sessionFailure();
  if(intent.session!==undefined&&!Object.hasOwn(state.sessions,nodeId))sessionFailure();
 }
 for(const [nodeId,s] of Object.entries(state.sessions)) {
  const intent=state.launchIntents[nodeId];
  if(!intent?.session)sessionFailure();
  exact(s,['version','runId','nodeId','intentId','id','generation','phase','usageSettled','settledUsage','observedAtMs','startedAtMs','actions','policy','checkpoint','writer','stopReceipt','telemetry','predecessor','history','continuation']);
  integer(s.observedAtMs);
  if(typeof s.usageSettled!=='boolean'||s.usageSettled!==(s.settledUsage!==null))sessionFailure();if(s.settledUsage!==null)usage(s.settledUsage);
  exact(intent.session,['id','generation','maxActions','maxMinutes','checkpoint']);
  if(intent.session.maxActions!==s.policy.maxActions||intent.session.maxMinutes!==s.policy.maxMinutes||intent.session.checkpoint!==s.continuation)sessionFailure();
  if(JSON.stringify(s.policy)!==JSON.stringify(state.sessionPolicy))sessionFailure('policy-changed');
  if(s.continuation!==null)text(s.continuation);if(s.predecessor!==null&&!ID.test(s.predecessor))sessionFailure();
  if(!Array.isArray(s.history)||s.history.length!==s.generation-1||s.history.length>state.sessionPolicy.maxReplacements||(state.sessionReplacementCounts?.[nodeId]??0)<s.history.length)sessionFailure();
  for(const [index,previous] of s.history.entries()){exact(previous,['id','generation','checkpointDigest','usage']);if(previous.id!==sessionId(intent.id,index+1)||previous.generation!==index+1||!HASH.test(previous.checkpointDigest))sessionFailure();integer(previous.generation,1,32);usage(previous.usage);}
  if(s.predecessor!==(s.history.at(-1)?.id??null))sessionFailure();
  if(s.checkpoint!==null)validateCheckpoint(s.checkpoint,s);
  if(s.telemetry!==null)validateSessionTelemetry(s.telemetry);
  if(s.writer!==null) {
   if(s.writer.source==='host-observation'){exact(s.writer,['nativeHandle','actorId','observedAtMs','source','assurance']);text(s.writer.nativeHandle,200);text(s.writer.actorId,64);integer(s.writer.observedAtMs);if(s.writer.assurance!=='host-reported')sessionFailure();}
   else {exact(s.writer,['version','executionId','processId','processGroupId','ownerProcessId','processBirth','observedAtMs','source','assurance','status']);if(s.writer.version!==1||s.writer.source!=='owned-process'||s.writer.assurance!=='observed'||s.writer.status!=='started'||s.writer.processBirth!==null)sessionFailure();text(s.writer.executionId,100);integer(s.writer.processId,1);integer(s.writer.processGroupId,1);integer(s.writer.ownerProcessId,1);integer(s.writer.observedAtMs);}
  }
  if(s.stopReceipt!==null)stopReceipt(s.stopReceipt,s);
  if(!s || s.version!==1 || s.runId!==runId || s.nodeId!==nodeId || s.intentId!==intent?.id || s.id!==sessionId(intent.id,s.generation)
   || !Number.isSafeInteger(s.generation)||s.generation<1||s.generation>101
   || !['active','checkpoint-requested','checkpoint-ready','stopping','stopped','reconciling','completed','blocked'].includes(s.phase)
   || !Array.isArray(s.history)||s.history.length!==s.generation-1 || !Number.isSafeInteger(s.startedAtMs)||s.startedAtMs<0
   || !Number.isSafeInteger(s.actions)||s.actions<0 || !s.policy || !Number.isSafeInteger(s.policy.maxReplacements)
   || s.generation>s.policy.maxReplacements+1 || intent.session?.id!==s.id||intent.session?.generation!==s.generation) sessionFailure();
  if(['checkpoint-ready','stopping','stopped'].includes(s.phase) && !s.checkpoint) sessionFailure();
  if(s.phase==='stopped'&&s.stopReceipt?.status!=='stopped')sessionFailure();
 }
}
export function requireSession(state,nodeId,identity,phases=['active']) {
 const s=state.sessions?.[nodeId];
 if(!s || !phases.includes(s.phase) || identity && (identity.id!==s.id||identity.generation!==s.generation))sessionFailure();return s;
}
export function stopReceipt(input,session) {
 const receipt=immutableJson(input);
 if(!receipt || receipt.sessionId!==session.id || receipt.generation!==session.generation || !['stopped','unknown'].includes(receipt.status))sessionFailure('invalid-stop-receipt');
 if(receipt.source==='host-observation') {
  if(receipt.actorId!==session.writer?.actorId || !Number.isSafeInteger(receipt.observedAtMs)||receipt.observedAtMs<Math.max(session.writer?.observedAtMs??0,session.observedAtMs) || receipt.assurance!=='host-reported'||typeof receipt.nativeHandle!=='string'||receipt.nativeHandle.length>200
    ||receipt.nativeHandle!==session.writer?.nativeHandle||containsSecretMaterial(receipt.nativeHandle)
    ||Object.keys(receipt).some(k=>!['sessionId','generation','nativeHandle','actorId','observedAtMs','status','source','assurance'].includes(k)))sessionFailure('invalid-stop-receipt');
 } else if(receipt.source==='owned-process') {
  if(receipt.version!==1||receipt.processBirth!==null||receipt.assurance!=='observed'||receipt.executionId!==session.writer?.executionId||receipt.processId!==session.writer?.processId||receipt.processGroupId!==session.writer?.processGroupId||receipt.ownerProcessId!==session.writer?.ownerProcessId||!Number.isSafeInteger(receipt.observedAtMs)||receipt.observedAtMs<session.writer?.observedAtMs||Object.keys(receipt).some(k=>!['version','executionId','processId','processGroupId','ownerProcessId','processBirth','observedAtMs','source','assurance','status','sessionId','generation'].includes(k)))sessionFailure('invalid-stop-receipt');
 } else sessionFailure('invalid-stop-receipt');
 return receipt;
}
export function turnoverReason(session,nowMs) {
 const used=session.telemetry?.contextUsedTokens;const limit=session.telemetry?.contextWindowTokens;
 if(used?.assurance==='native-measured'&&limit?.assurance==='native-measured'&&Number.isFinite(used.value)&&limit.value>0
   &&used.value/limit.value*100>=session.policy.contextThresholdPercent)return 'measured-context-threshold';
 if(session.actions>=session.policy.maxActions)return 'observed-action-boundary';
 if(nowMs-session.startedAtMs>=session.policy.maxMinutes*60000)return 'elapsed-time-boundary';
 return null;
}

export function observeHostSession(session,input) {
 const receipt=immutableJson(input);
 exact(receipt,['sessionId','generation','nativeHandle','actorId','observedAtMs','source','assurance','actions','telemetry']);
 if(receipt.sessionId!==session.id||receipt.generation!==session.generation||receipt.source!=='host-observation'||receipt.assurance!=='host-reported')sessionFailure('invalid-observation');
 text(receipt.nativeHandle,200);text(receipt.actorId,64);integer(receipt.observedAtMs,session.observedAtMs);integer(receipt.actions,session.actions,10000);
 const telemetry=validateSessionTelemetry(receipt.telemetry);
 if(telemetry.provider!=='host'||['tokens','costUsd','contextUsedTokens','contextWindowTokens'].some(key=>!['unknown','host-reported'].includes(telemetry[key].assurance)))sessionFailure('invalid-observation');
 if(session.writer && (session.writer.nativeHandle!==receipt.nativeHandle||session.writer.actorId!==receipt.actorId))sessionFailure('writer-changed');
 session.writer??={nativeHandle:receipt.nativeHandle,actorId:receipt.actorId,observedAtMs:receipt.observedAtMs,source:receipt.source,assurance:receipt.assurance};
 session.observedAtMs=receipt.observedAtMs;session.actions=receipt.actions;session.telemetry=telemetry;
}
