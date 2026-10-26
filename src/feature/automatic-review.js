import {scopedProductQuestion} from './product-question.js';
import {createHash} from 'node:crypto';
import {containsSecretMaterial} from '../clients/contract.js';
import {inspectGovernance,taskGovernance} from './governance.js';
import {evaluateReviewReports} from '../quality/content-review.js';
import {resolveExecutionSelection} from '../models/execution-policy.js';
import {reserveReviewCall,completeReviewCall} from '../runtime/review-loop.js';
import {inspectFeatureRuntime} from './runtime-bridge.js';
import {admitted,admissionKey} from '../runtime/machine-admission.js';
import {redactSecrets} from '../state/redact.js';

const fail=message=>{const error=new Error(message);error.safeMessage=message;throw error;};
export async function automaticReview({project,run,config,gitClient,instance,checkout,reviewClientFor,signal,now,environment={},verification}) {
 const observe=()=>inspectGovernance({project,run,config,gitClient,phase:'final',checkout,forceReview:true});
 let observed=await observe();
 if(observed.decisions.some(d=>d.status==='pending'))fail('A product question needs your answer. Use rivet task approve-decision, then resume.');
 if(observed.scan?.status&&observed.scan.status!=='passed')fail('Content scanning failed. Automatic review cannot bypass it.');
 let state=await inspectFeatureRuntime(instance);
 if(Object.values(state.reviewCalls??{}).some(c=>c.status==='pending'))fail('A previous reviewer has an unknown outcome. Inspect the task before any further execution.');
 if(observed.review.valid)return {observed,findings:[]};
 if(observed.review.humanEscalation)fail('Independent review round limit reached with unresolved findings. Human action is required.');
 if(observed.review.blockers.some(b=>b.code==='uncovered-path'))fail('Required review paths have no assigned reviewer. Review the policy before continuing.');
 const executionSelection=resolveExecutionSelection(config.orchestration.executionPolicy,'independent-review');
 const reviewClient=await reviewClientFor(executionSelection?.harness??run.featurePlan.client,{project,signal,executionSelection});
 const manager=run.featurePlan.nodes.find(n=>n.role==='manager');
 const context=await taskGovernance({project,runId:run.runId,gitClient,operation:'review',phase:'final',now});
 const latest=new Map();for(const report of observed.review.reports)if(!latest.has(report.reviewerId)||latest.get(report.reviewerId).round<report.round)latest.set(report.reviewerId,report);
 // A recorded complete round with findings is corrected before spending another review call.
 const missing=observed.review.requiredReviewerIds.filter(id=>!latest.has(id));
 const currentRound=Math.max(0,...observed.review.reports.map(r=>r.round));
 const templates=context.reportTemplates.filter(t=>missing.includes(t.reviewerId)).map(t=>({...t,round:currentRound||t.round}));
 for(const template of templates){
  signal?.throwIfAborted();
  observed=await observe();
  const identity=createHash('sha256').update(JSON.stringify({subject:observed.subject,decisions:observed.decisions})).digest('hex');
  const callId=`review-${createHash('sha256').update(`${identity}:${template.reviewerId}:${template.round}`).digest('hex').slice(0,40)}`;
  state=await reserveReviewCall(instance,{expectedVersion:state.version,nodeId:manager.id,callId,subjectDigest:identity,round:template.round,nowMs:Date.parse(now())});
  const reportTemplate={...template,actorId:callId};
  const trustedVerification=verification?{commitSha:verification.commitSha,status:verification.status,gates:verification.gates.map(({id,status,executionStatus,exitCode})=>({id,status,executionStatus,exitCode}))}:null;
  const payload={trustedVerification,subject:observed.subject,patch:observed.patch,request:run.workRequest,plan:run.featurePlan,decisions:observed.decisions,reportTemplate,assignedPaths:observed.review.reviewerPaths[template.reviewerId]};
  let stopped=false;
  const result=await admitted('agentExecutions',`task-review-${admissionKey([run.runId,callId])}`,{signal},options=>reviewClient.review({context:payload,allocation:state.reviewCalls[callId].allocation,...options,onExecution:async receipt=>{await options.onExecution?.(receipt);stopped=receipt.status==='stopped';}}));
  if(!stopped)fail('Independent reviewer termination is unknown. No further execution is permitted.');
  if(!result||!['question,report,usage','question,report,usage,usageSource'].includes(Object.keys(result).sort().join(','))||(result.question===null)===(result.report===null)
    ||containsSecretMaterial(JSON.stringify(result))||JSON.stringify(redactSecrets(result,{environment}))!==JSON.stringify(result))fail('Independent review returned invalid or sensitive evidence.');
  const usageSource=result.usageSource??'reported';
  if(!['native','reported'].includes(usageSource))fail('Independent review usage assurance is invalid.');
  const usage=result.usage,allocation=state.reviewCalls[callId].allocation;
  if(!usage||Object.keys(usage).some(k=>!['tokens','costUsd'].includes(k))||!Number.isSafeInteger(usage.tokens)||usage.tokens<0||typeof usage.costUsd!=='number'||!Number.isFinite(usage.costUsd)||usage.costUsd<0)fail('Independent review usage is invalid or exceeds the reserved allowance. No further execution is permitted.');
  if(usage.tokens>allocation.tokenLimit||usage.costUsd>Number(allocation.costUsd)){await completeReviewCall(instance,{expectedVersion:state.version,callId,usage,usageSource});fail('Independent review exceeded its allowance. No further execution is permitted.');}
  const after=await observe();
  if(JSON.stringify(after.subject)!==JSON.stringify(observed.subject))fail('Review revision changed while the reviewer was running.');
  if(result.question!==null){
   const question=scopedProductQuestion(result.question,`reviewer:${template.reviewerId}`);
   await taskGovernance({project,runId:run.runId,gitClient,operation:'decide',input:{...question,tier:2},now});
   state=await completeReviewCall(instance,{expectedVersion:state.version,callId,usage,usageSource});
   fail(`Product question: ${result.question.title}. Use rivet task approve-decision --decision=${question.id}, then resume. No answer has been selected.`);
  }
  if(result.report.actorId!==callId||result.report.reviewerId!==template.reviewerId||result.report.round!==template.round||result.report.commandsExecuted?.length)fail('Independent reviewer identity or evidence is invalid.');
  // Receipt time is host evidence, not a model clock estimate.
  const report={...result.report,checkedAt:new Date().toISOString()};
  evaluateReviewReports(observed.policy,observed.subject,[report]);
  await taskGovernance({project,runId:run.runId,gitClient,operation:'review-submit',phase:'final',input:report,now});
  state=await completeReviewCall(instance,{expectedVersion:state.version,callId,usage,usageSource});
 }
 observed=await observe();
 if(observed.review.valid)return {observed,findings:[]};
 if(observed.review.humanEscalation)fail('Independent review round limit reached with unresolved findings. Human action is required.');
 const reports=new Map();for(const report of observed.review.reports)if(!reports.has(report.reviewerId)||reports.get(report.reviewerId).round<report.round)reports.set(report.reviewerId,report);
 const findings=[...reports.values()].flatMap(r=>r.findings.filter(f=>f.blocking));
 if(!findings.length)fail('Independent review did not provide complete passing evidence or actionable corrections.');
 return {observed,findings};
}
