import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {immutableJson,containsSecretMaterial} from '../clients/contract.js';
import {loadProjectConfig,parseYaml} from '../config/load.js';
import {createSnapshotStore,readSnapshotWithoutLock} from '../state/snapshot-store.js';
import {governancePaths,resolveExistingFeatureRunPaths,acceptedIntegrationPaths} from '../state/paths.js';
import {createFeatureRunStore} from './run-store.js';
import {createAcceptedIntegrationStore} from './accepted-integration.js';
import {acquireHostRunLock} from './host-run-lock.js';
import {createDecision,validateDecision,approveDecision,renderDecisions} from './decisions.js';
import {normalizeReviewPolicy,evaluateReviewReports} from '../quality/content-review.js';
import {scanChangedContent,validateContentScanPolicy} from '../quality/content-scan.js';

export class GovernanceError extends Error {
  constructor(message='Task decision or review evidence is invalid or stale.') {
    super(message);this.name='GovernanceError';this.code='ERR_TASK_GOVERNANCE';this.safeMessage=message;
  }
}
const fail=message=>{throw new GovernanceError(message);};
const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const binding=run=>({runId:run.runId,requestDigest:run.workRequest.digest,planDigest:run.proposalDigest});
const sameBinding=(left,right)=>Object.entries(right).every(([key,value])=>left[key]===value);
const approved=decisions=>decisions.filter(value=>value.status==='approved').map(({id,choice})=>({id,choice}));

async function journal(paths,run) {
  const selected=await governancePaths(paths), snapshot=await readSnapshotWithoutLock(selected);
  const events=snapshot?.data?.events??[];
  if(snapshot&&(snapshot.data.schemaVersion!==1||!sameBinding(snapshot.data,binding(run))
    ||!Array.isArray(events)||events.length>1000||Buffer.byteLength(JSON.stringify(snapshot.data))>1024*1024))fail();
  const decisions=new Map(),reviews=[];
  for(const event of events){
    if(!event||!['decision.recorded','decision.approved','review.recorded','scan.recorded'].includes(event.type))fail();
    if(event.type.startsWith('decision.')){
      const context={...binding(run),approvedPlanDecisions:approved([...decisions.values()])};
      const value=validateDecision(event.data,context),prior=decisions.get(value.id);
      if(event.type==='decision.recorded' ? prior!==undefined : !prior||prior.status!=='pending'||value.status!=='approved')fail();
      if(prior&&value.approval?.decisionDigest!==prior.digest)fail();
      decisions.set(value.id,value);
    }else if(event.type==='review.recorded'){
      if(!sameBinding(event.subject,binding(run)))fail();
      evaluateReviewReports(event.policy,event.subject,[event.data]);reviews.push(event);
    }
  }
  return {paths:selected,version:snapshot?.version??0,events,decisions:[...decisions.values()],reviews};
}
async function append(state,run,event){
  const data={schemaVersion:1,...binding(run),events:[...state.events,event]};
  if(data.events.length>1000||Buffer.byteLength(JSON.stringify(data))>1024*1024)fail('Task evidence storage limit reached. Start a new bounded task.');
  await createSnapshotStore(state.paths,{environment:{}}).write(data,{expectedVersion:state.version});
}
async function inputs(project,runId){
  const paths=await resolveExistingFeatureRunPaths(project,runId);if(!paths)fail('Task was not found.');
  const run=await createFeatureRunStore(paths).readOnly();if(!run)fail();
  return {paths,run};
}

export async function assertGovernancePolicy({project,baselineCommit,gitClient,config}) {
  const baselineQuality=await gitClient.readCommittedFile(project,baselineCommit,'.rivet/quality.yaml');
  if(!baselineQuality){
    if(config.quality.review!==undefined||config.quality.contentScan!==undefined)
      fail('Commit the quality policy before proposing a task with review or content scanning.');
    return; // Preserve existing local-only configuration when governance is not enabled.
  }
  if(!isDeepStrictEqual(parseYaml(baselineQuality.content,'quality.yaml'),config.quality))
    fail('Quality policy changed since the task was proposed. Restore the approved policy or propose a new task.');
}

export async function inspectGovernance({project,run,gitClient,config,phase,checkout,forceReview=false}) {
  const paths=await resolveExistingFeatureRunPaths(project,run.runId);if(!paths)fail();
  const state=await journal(paths,run);
  const configured=config??await loadProjectConfig(project);
  await assertGovernancePolicy({project,baselineCommit:run.featurePlan.baselineCommit,gitClient,config:configured});
  const policy=normalizeReviewPolicy(forceReview?{...configured.quality.review,required:true}:configured.quality.review);
  const selectedPhase=phase??(run.status==='proposed'?'plan':'final');
  if(!['plan','final'].includes(selectedPhase))fail();
  let target=checkout;
  if(selectedPhase==='final'&&!target){
    const accepted=await createAcceptedIntegrationStore(await acceptedIntegrationPaths(paths)).readOnly();
    if(accepted)target={path:accepted.path,commitSha:accepted.commitSha,branch:accepted.branch};
  }
  const baseSha=run.featurePlan.baselineCommit;
  let headSha=baseSha,patch='',changedPaths=[];
  if(target){
    const identity=await gitClient.inspectRepository(target.path);
    if(identity.dirty||identity.headSha!==target.commitSha||identity.branch!==target.branch)fail('Review checkout changed. Inspect task status before continuing.');
    headSha=target.commitSha;
    changedPaths=await gitClient.changedPaths(target.path,baseSha,headSha);
    if(policy.required||state.reviews.length)patch=(await gitClient.reviewDiff(target.path,{fromSha:baseSha,toSha:headSha})).patch;
  }
  const subject={phase:selectedPhase,...binding(run),baseSha,headSha,
    diffDigest:digest(selectedPhase==='plan'?run.featurePlan:patch),
    acceptanceCriteria:run.workRequest.acceptanceCriteria,
    planNodeIds:run.featurePlan.nodes.filter(node=>node.role==='worker').map(node=>node.id),
    criterionPlanNodeIds:run.workRequest.acceptanceCriteria.map(criterion=>run.featurePlan.nodes.filter(node=>node.role==='worker'&&node.acceptanceCriteria.includes(criterion)).map(node=>node.id)),changedPaths,
    workerActorIds:['host-agent',...run.featurePlan.nodes.filter(node=>node.role==='worker').map(node=>node.id)]};
  // Historical reports remain auditable; only reports for these exact inputs can satisfy a gate.
  const phaseReviews=state.reviews.filter(event=>event.subject.phase===selectedPhase);
  const reports=phaseReviews.filter(event=>event.subject.headSha===headSha
    &&event.subject.diffDigest===subject.diffDigest).map(event=>event.data);
  const evaluated=evaluateReviewReports(policy,subject,reports);
  // Corrections consume the task phase's budget even when their new inputs invalidate old evidence.
  const rounds=Math.max(0,...phaseReviews.map(event=>event.data.round));
  const otherInputRound=Math.max(0,...phaseReviews.filter(event=>event.subject.headSha!==headSha
    ||event.subject.diffDigest!==subject.diffDigest).map(event=>event.data.round));
  const pendingAtCap=otherInputRound<policy.maxRounds?evaluated.requiredReviewerIds.filter(reviewerId=>
    !reports.some(report=>report.reviewerId===reviewerId&&report.round===policy.maxRounds)):[];
  const repairableAtCap=blocker=>['missing-review','blocking-review'].includes(blocker.code)
    ?pendingAtCap.includes(blocker.reviewerId):blocker.code==='unreviewed-path'
      &&pendingAtCap.some(reviewerId=>evaluated.reviewerPaths[reviewerId].includes(blocker.path));
  const review={...evaluated,rounds,humanEscalation:!evaluated.valid&&rounds>=policy.maxRounds
    &&!evaluated.blockers.every(repairableAtCap)};
  const blockers=[...review.blockers];
  if(selectedPhase==='final'&&!target&&policy.required)blockers.push({code:'integration-not-ready'});
  for(const decision of state.decisions)if(decision.status==='pending')blockers.push({code:'decision-needs-human-approval',decisionId:decision.id});
  let scan=null;
  if(selectedPhase==='final'&&target&&configured.quality.contentScan!==undefined){
    const scanPolicy=validateContentScanPolicy(configured.quality.contentScan);
    if(changedPaths.length>scanPolicy.maxFiles)fail('Content scan file limit exceeded. Split the task or review its scan policy.');
    const files=[];let bytes=0;
    for(const path of changedPaths){
      const file=await gitClient.readCommittedFile(target.path,headSha,path);
      if(file){
        bytes+=Buffer.byteLength(file.content);
        if(bytes>scanPolicy.maxBytes)fail('Content scan byte limit exceeded. Split the task or review its scan policy.');
        files.push({path,content:file.content});
      }
    }
    scan=scanChangedContent({files,policy:configured.quality.contentScan});
    if(scan.status!=='passed')blockers.push({code:'content-scan-failed'});
  }
  return immutableJson({subject,policy,decisions:state.decisions,decisionMarkdown:renderDecisions(state.decisions,{...binding(run),approvedPlanDecisions:approved(state.decisions)}),
    review,scan,blockers,ready:blockers.length===0,patch,
    nextAction:blockers.length?'Use rivet task decisions and rivet task review to inspect required evidence. Human approval never replaces failed required checks.':'Decision and content review requirements are satisfied.'});
}
export async function requireGovernance(input){
  const result=await inspectGovernance(input);
  if(result.scan){
    const {paths}=await inputs(input.project,input.run.runId),state=await journal(paths,input.run);
    const identity=digest({subject:result.subject,scan:result.scan});
    if(!state.events.some(event=>event.type==='scan.recorded'&&event.digest===identity))
      await append(state,input.run,{type:'scan.recorded',digest:identity,subject:result.subject,data:result.scan,checkedAt:new Date().toISOString()});
  }
  if(!result.ready)fail(`${result.nextAction} Blocking: ${result.blockers.map(item=>item.code).join(', ')}.`);
  return result;
}

export async function taskGovernance({project,runId,gitClient,operation,input,phase,decisionId,confirm,signal,now=()=>new Date().toISOString()}){
  const {paths}=await inputs(project,runId),lock=await acquireHostRunLock(paths);
  try{
    const run=await createFeatureRunStore(paths).readOnly(),state=await journal(paths,run);
    if(['decide','approve-decision','review-submit'].includes(operation)&&['completed','cancelled'].includes(run.status))fail('Completed tasks cannot accept new decision or review evidence.');
    const context={...binding(run),approvedPlanDecisions:approved(state.decisions)};
    if(operation==='decisions')return {decisions:state.decisions,markdown:renderDecisions(state.decisions,context)};
    signal?.throwIfAborted();
    if(operation==='decide'){
      if(state.decisions.length>=128)fail('Decision journal limit reached. Start a new bounded task.');
      const record=createDecision(input,{...context,actor:{kind:'agent',id:'host-agent'},now:now()});
      if(state.decisions.some(value=>value.id===record.id))fail('Decision ID already exists. Record a new decision that explains the change.');
      await append(state,run,{type:'decision.recorded',data:record});return record;
    }
    if(operation==='approve-decision'){
      const record=state.decisions.find(value=>value.id===decisionId);if(!record)fail('Decision was not found.');
      if(typeof confirm!=='function'||await confirm(record)!==true)return {status:'declined'};
      signal?.throwIfAborted();
      const updated=approveDecision(record,{...context,actor:{kind:'human',id:'human-cli-operator'},now:now(),humanConfirmed:true});
      await append(state,run,{type:'decision.approved',data:updated});return updated;
    }
    if(operation==='review'||operation==='review-submit'){
      const config=await loadProjectConfig(project);
      // Explicit review exports always include the actual diff, even for optional policies.
      const observed=await inspectGovernance({project,run,gitClient,config,phase,forceReview:true});
      if(operation==='review'){
        const keys=['phase','runId','requestDigest','planDigest','baseSha','headSha','diffDigest'];
        const identity=Object.fromEntries(keys.map(key=>[key,observed.subject[key]]));
        const atCap=observed.review.rounds>=observed.policy.maxRounds;
        const otherInputRound=Math.max(0,...state.reviews.filter(event=>event.subject.phase===observed.subject.phase
          &&(event.subject.headSha!==observed.subject.headSha||event.subject.diffDigest!==observed.subject.diffDigest)).map(event=>event.data.round));
        const templateReviewers=atCap&&observed.review.valid?[]:atCap?observed.review.requiredReviewerIds.filter(reviewerId=>
          otherInputRound<observed.policy.maxRounds&&!observed.review.reports.some(report=>report.reviewerId===reviewerId&&report.round===observed.policy.maxRounds))
          :observed.review.requiredReviewerIds;
        const reportTemplates=templateReviewers.map(reviewerId=>({
          ...identity,reviewerId,actorId:'replace-with-reviewer-identity',round:atCap?observed.policy.maxRounds:observed.review.rounds+1,
          status:'FAIL',blocking:true,coverage:[],findings:[{kind:'general',summary:'Review has not been performed yet.',blocking:true}],
          filesReviewed:[],commandsExecuted:[],checkedAt:now(),
        }));
        return {...observed,request:run.workRequest,plan:run.featurePlan,reportTemplates,
          reportInstructions:'Complete the review before submitting. For each acceptance criterion provide its 1-based criterionIndex, assigned planNodeIds, reviewed paths and evidence [{kind:test|manual,reference,summary}]. Record missing or unrequested work as blocking findings. PASS requires complete coverage and no blocking findings. Templates intentionally do not claim a passing review.'};
      }
      const report=evaluateReviewReports(observed.policy,observed.subject,[input]).reports[0];
      if(containsSecretMaterial(JSON.stringify(report)))fail('Review evidence contains credential-like material. Remove it before recording the report.');
      const phaseReviews=state.reviews.filter(event=>event.subject.phase===observed.subject.phase);
      const matchesCurrent=event=>event.subject.headSha===observed.subject.headSha&&event.subject.diffDigest===observed.subject.diffDigest;
      const prior=phaseReviews.filter(matchesCurrent).map(event=>event.data);
      const previousInputRound=Math.max(0,...phaseReviews.filter(event=>!matchesCurrent(event)).map(event=>event.data.round));
      if(report.round<=previousInputRound)fail('A revised review subject must advance the phase review round.');
      if(prior.some(value=>value.reviewerId===report.reviewerId&&value.round===report.round))fail('This reviewer round is already recorded.');
      evaluateReviewReports(observed.policy,observed.subject,[...prior,report]);
      await append(state,run,{type:'review.recorded',subject:observed.subject,policy:observed.policy,data:report});
      return {status:'recorded',reviewerId:report.reviewerId,round:report.round};
    }
    fail('Unknown task evidence operation.');
  }finally{await lock.release();}
}
