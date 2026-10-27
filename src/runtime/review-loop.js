import {createHash} from 'node:crypto';
import {evaluateAuthority} from '../policy/authority.js';
import {containsSecretMaterial} from '../clients/contract.js';
import {validatedGraphSnapshot} from '../graph/validate.js';
import {runtimeTransaction,transitionRuntimeState,remainingRuntimeNodeBudget,remainingRuntimeCorrectionBudget,chargeReviewBudget,settleReviewBudget} from './orchestrator.js';

const fail=()=>{throw new Error('Automatic review state is invalid or its allowance is exhausted.');};
const id=value=>typeof value==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(value);

// The conservative maximum is charged before dispatch, including unknown outcomes.
// This avoids guessing token/cost telemetry for tool-disabled review adapters.
export async function reserveReviewCall(instance,{expectedVersion,nodeId,callId,subjectDigest,round,nowMs}) {
  if(!id(callId)||!id(nodeId)||!/^[a-f0-9]{64}$/.test(subjectDigest)||!Number.isInteger(round)||round<1||round>10||!Number.isSafeInteger(nowMs))fail();
  return runtimeTransaction(instance,expectedVersion,state=>{
    if(!state.activated||state.terminal!==null||state.reviewCalls?.[callId]||Object.keys(state.reviewCalls??{}).length>=650)fail();
    const node=state.graph.nodes.find(n=>n.id===nodeId);
    if(node?.owner.role!=='manager'||node.status!=='completed')fail();
    const allocation=chargeReviewBudget(state,node);
    state.reviewCalls??={};
    state.reviewCalls[callId]={nodeId,subjectDigest,round,startedAtMs:nowMs,status:'pending',allocation};
    return state;
  });
}
export async function completeReviewCall(instance,{expectedVersion,callId,usage,usageSource='reported'}) {
  return runtimeTransaction(instance,expectedVersion,state=>{
    const call=state.reviewCalls?.[callId];if(call?.status!=='pending')fail();
    if(!['native','reported'].includes(usageSource))fail();
    if(usage){call.usageSource=usageSource;settleReviewBudget(state,call,usage);}
    else call.status='complete';return state;
  });
}

export async function scheduleReviewCorrection(instance,{expectedVersion,sourceNodeId,nodeId,round,authority,reason,batchSize=1,nowMs}) {
  if(!Number.isInteger(batchSize)||batchSize<1||batchSize>1000||!id(sourceNodeId)||!id(nodeId)||!Number.isInteger(round)||round<1||round>9
    ||typeof reason!=='string'||!reason.trim()||reason.length>12000||containsSecretMaterial(reason))fail();
  return runtimeTransaction(instance,expectedVersion,state=>{
    const source=state.graph.nodes.find(n=>n.id===sourceNodeId),parent=state.graph.nodes.find(n=>n.id===source?.parentId);
    const final=state.graph.nodes.find(n=>n.approvalGate==='final-delivery');
    if(!state.activated||state.terminal!==null||source?.owner.role!=='worker'||source.status!=='completed'
      ||!final||final.status!=='ready'||parent?.owner.id!==authority?.actorId
      ||evaluateAuthority(authority,{actorId:authority.actorId,action:'orchestration.correct',resource:source.id}).decision!=='allow'
      ||state.graph.nodes.some(n=>n.id===nodeId)||state.graph.nodes.length>=1000)fail();
    const remaining=remainingRuntimeCorrectionBudget(state,source,batchSize);
    if(remaining.tokenLimit<1||remaining.timeMinutes<1||remaining.taskLimit<1||Number(remaining.costUsd)<=0)fail();
    const evidenceRefs=source.requiredEvidenceTypes.map((_,i)=>`fix-${createHash('sha256').update(nodeId).digest('hex').slice(0,32)}-${i}`);
    transitionRuntimeState(state,source,'archived',nowMs);
    const correction={...source,id:nodeId,objective:`Correct review findings for ${source.id}`,budget:{...remaining,costUsd:Number(remaining.costUsd)},evidenceRefs,status:'ready'};
    state.graph=validatedGraphSnapshot({...state.graph,nodes:[...state.graph.nodes.map(n=>({...n,dependencies:n.dependencies.map(d=>d===source.id?nodeId:d)})),correction]});
    state.reviewCorrections??={};state.reviewCorrections[nodeId]={sourceNodeId,round,reason};
    return state;
  });
}

export function validateReviewLoopState(state) {
  for(const [key,call] of Object.entries(state.reviewCalls??{})) {
    if(!id(key)||!call||!['pending','complete','over-budget'].includes(call.status)||!id(call.nodeId)
      ||!/^[a-f0-9]{64}$/.test(call.subjectDigest)||!Number.isInteger(call.round)||call.round<1||call.round>10
      ||!Number.isSafeInteger(call.startedAtMs)||!state.graph.nodes.some(n=>n.id===call.nodeId&&n.owner.role==='manager'))fail();
  }
  const totals={};
  for(const call of Object.values(state.reviewCalls??{})) {
    if(call.usage!==undefined&&(!Number.isSafeInteger(call.usage.tokens)||call.usage.tokens<0||typeof call.usage.costUsd!=='number'||!Number.isFinite(call.usage.costUsd)||call.usage.costUsd<0||!['native','reported'].includes(call.usageSource)))fail();
    const a=call.allocation;
    if(!a||Object.keys(a).sort().join(',')!=='costUsd,taskLimit,timeMinutes,tokenLimit'||!Number.isSafeInteger(a.tokenLimit)||a.tokenLimit<1||a.tokenLimit>64000||!Number.isSafeInteger(a.timeMinutes)||a.timeMinutes<1||a.timeMinutes>2||a.taskLimit!==1||typeof a.costUsd!=='string'||!Number.isFinite(Number(a.costUsd))||Number(a.costUsd)<=0||Number(a.costUsd)>1)fail();
    const t=totals[call.nodeId]??={tokens:0,costUsd:0,timeMinutes:0,tasks:0};t.tokens+=a.tokenLimit;t.costUsd+=Number(a.costUsd);t.timeMinutes+=a.timeMinutes;t.tasks++;
  }
  for(const [nodeId,total] of Object.entries(totals)) {
    const own=state.nodeUsage?.[nodeId];if(!own||own.tokens<total.tokens||Number(own.costUsd)+1e-9<total.costUsd||own.timeMinutes<total.timeMinutes||own.tasks<total.tasks)fail();
  }
  for(const [key,value] of Object.entries(state.reviewCorrections??{})) {
    const node=state.graph.nodes.find(n=>n.id===key),source=state.graph.nodes.find(n=>n.id===value.sourceNodeId);
    if(!node||!source||source.status!=='archived'||node.owner.role!=='worker'||source.owner.id!==node.owner.id
      ||node.parentId!==source.parentId||JSON.stringify(node.authorityScopes)!==JSON.stringify(source.authorityScopes)
      ||!Number.isInteger(value.round)||value.round<1||value.round>9||typeof value.reason!=='string'||value.reason.length>12000||containsSecretMaterial(value.reason))fail();
    const remaining=remainingRuntimeNodeBudget(state,source);
    if(['timeMinutes','tokenLimit','taskLimit'].some(k=>node.budget[k]>remaining[k])||node.budget.costUsd>Number(remaining.costUsd))fail();
  }
  for(const [nodeId,head] of Object.entries(state.acceptedWorkerHeads??{}))if(!state.graph.nodes.some(n=>n.id===nodeId&&n.owner.role==='worker')||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head))fail();
}
