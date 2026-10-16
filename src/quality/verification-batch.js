import {withBatchAdmission} from './batch-admission.js';
import {createHash} from 'node:crypto';
import {basename,dirname,join,relative,isAbsolute} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {loadProjectConfig} from '../config/load.js';
import {resolveExistingFeatureRunPaths,resolveExistingStatePaths,resolveStatePaths,acceptedIntegrationPaths} from '../state/paths.js';
import {readSnapshotWithoutLock} from '../state/snapshot-store.js';
import {createFeatureRunStore} from '../feature/run-store.js';
import {createAcceptedIntegrationStore} from '../feature/accepted-integration.js';
import {createFeatureRuntimeState,configuredFeatureGates,featureQualityAuthority,featureBranchFor} from '../feature/runtime-bridge.js';
import {validateRuntimeSnapshot} from '../runtime/orchestrator.js';
import {stopReceipt} from '../feature/sessions.js';
import {assertSelectedProtocolRefs} from '../protocols/project.js';
import {prepareIntegrationWorktree} from '../git/integration-worktree.js';
import {prepareIntegrationCandidate,verifyIntegrationCandidate} from '../git/integration-candidate.js';
import {inspectWorktreeDependencies,bootstrapWorktreeDependencies,WorktreeBootstrapError} from '../runtime/worktree-bootstrap.js';
import {inspectLegacyDependencyDirectory} from '../runtime/legacy-dependency-directory.js';
import {openBatchQueue} from './verification-batch-queue.js';
import {runQualityGates} from './runner.js';
import {readDependencyFile} from '../runtime/dependency-directory.js';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(message) {throw new Error(`Batch verification: ${message}`);}
function policy(config) {
 const value=config.quality.verificationBatch;
 if(value?.enabled!==true)fail('enable quality.verificationBatch in the committed project policy first');
 return {maxTasks:value.maxTasks??3,waitMs:value.waitMs??2000,maxIsolationTasks:value.maxIsolationTasks??2};
}
async function captureParticipant(projectRoot,runId,options,queue) {
 const paths=await resolveExistingFeatureRunPaths(projectRoot,runId);
 if(!paths)fail('task not found');
 const run=await createFeatureRunStore(paths).readOnly();
 if(!run||!['running','awaiting-final-approval'].includes(run.status))fail('task is not ready');
 const config=await loadProjectConfig(projectRoot);policy(config);
 createFeatureRuntimeState({config,run});
 assertSelectedProtocolRefs(projectRoot,run.workRequest.contextRefs);
 const runtimePaths=await resolveExistingStatePaths(projectRoot,runId);
 if(!runtimePaths)fail('runtime missing');
 const snapshot=await readSnapshotWithoutLock(runtimePaths);
 if(!snapshot)fail('runtime missing');
 const runtime=validateRuntimeSnapshot(snapshot.data,runId);
 const final=runtime.graph.nodes.find(n=>n.approvalGate==='final-delivery');
 if(!runtime.graph.nodes.filter(n=>!n.approvalGate).every(n=>['completed','archived'].includes(n.status))
  || !['ready','completed'].includes(final?.status))fail('task work is not complete');
 for(const session of Object.values(runtime.sessions??{})) {
  if(session.phase!=='completed'||!session.stopReceipt||stopReceipt(session.stopReceipt,session).status!=='stopped')fail('writer ownership is unresolved');
 }
 const accepted=await createAcceptedIntegrationStore(await acceptedIntegrationPaths(paths)).readOnly();
 const repository=await options.gitClient.inspectRepository(projectRoot);
 if(repository.dirty||repository.detached||repository.branch!==config.project.repository.defaultBranch||repository.headSha!==run.featurePlan.baselineCommit)fail('baseline changed');
 const expectedPath=join(dirname(projectRoot),'.rivet-worktrees',repository.repositoryId,basename(runtimePaths.instanceDir),'integration');
 if(!accepted||accepted.runId!==runId||accepted.baselineCommit!==run.featurePlan.baselineCommit
  ||accepted.runtimeVersion>runtime.version||accepted.path!==expectedPath||accepted.branch!==featureBranchFor(config,run.featurePlan,runId))fail('accepted integration changed');
 const checkout=await options.gitClient.inspectRepository(accepted.path);
 if(checkout.dirty||checkout.headSha!==accepted.commitSha||checkout.branch!==accepted.branch
  ||accepted.commitSha===accepted.baselineCommit||!(await options.gitClient.isAncestor(accepted.path,accepted.baselineCommit,accepted.commitSha)))fail('participant head changed');
 const gates=await configuredFeatureGates(config,options.resolveCommandExecutable,accepted.path);
 const normalizedGates=[];
 for(const gate of gates) {
  const local=relative(accepted.path,gate.executable);
  if(local&&!local.startsWith('../')&&!isAbsolute(local)) {
   // Per-checkout absolute paths differ even for the same approved command.
   // Compare the checkout-relative location and exact executable content instead.
   const executableDigest=createHash('sha256').update(await readDependencyFile(gate.executable,8*1024*1024)).digest('hex');
   normalizedGates.push({...gate,executable:{checkoutPath:local,contentDigest:executableDigest}});
  }else normalizedGates.push(gate);
 }
 // Executable locations and the entire configuration are pinned, but never persist raw environment values.
 const compatibility=queue.fingerprint({config,gates:normalizedGates,environment:options.environment??{},platform:process.platform,node:process.version,baseline:accepted.baselineCommit});
 const member={runId,policy:policy(config),proposalDigest:run.proposalDigest,runVersion:run.version,runtimeVersion:runtime.version,
  sourceSha:accepted.commitSha,sourcePath:accepted.path,sourceBranch:accepted.branch,baseSha:accepted.baselineCommit,
  rootIdentity:checkout.rootIdentity,configDigest:digest(config),compatibility,criteria:run.workRequest.acceptanceCriteria};
 return {...member,identity:digest(member)};
}
async function dependencyNeeded(projectRoot,manifest,config,gitClient,completed) {
 if(!config.project.dependencies&&!['npm','pnpm','yarn','bun'].includes(config.project.stack.packageManager))return false;
 const input={projectRoot,worktreePath:manifest.path,expectedCommit:manifest.commitSha,expectedBranch:manifest.branch,
  ...(config.project.dependencies?{dependencies:config.project.dependencies}:{manager:config.project.stack.packageManager})};
 try {await inspectWorktreeDependencies(input,{gitClient});}
 catch(error) {if(error instanceof WorktreeBootstrapError&&error.details.reason==='missing-lockfile')return false;throw error;}
 if(config.project.dependencies) {
  // Portable inspection validates the installed plan and outputs; missing outputs fail closed.
  const {inspectDependencyDirectory}=await import('../runtime/dependency-directory.js');
  return !completed?.includes(manifest.digest)||!(await inspectDependencyDirectory(manifest.path));
 }
 return !(await inspectLegacyDependencyDirectory(manifest.path));
}
async function executeBatch(projectRoot,batch,options,queue,config) {
 const validateOwner=async()=>{
  options.signal?.throwIfAborted();
  await options.validateAdmission?.();
  for(const member of batch.members) {
   const current=await captureParticipant(projectRoot,member.runId,options,queue);
   if(current.identity!==member.identity)fail('frozen participant, policy, or baseline changed');
  }
  options.signal?.throwIfAborted();await options.validateAdmission?.();
 };
 await validateOwner();
 const statePaths=await resolveStatePaths(projectRoot,batch.id);
 const repository=await options.gitClient.inspectRepository(projectRoot);
 const target=await prepareIntegrationWorktree({projectRoot,statePaths,branch:`rivet-batch/${batch.id}`,
  worktreePath:join(dirname(projectRoot),'.rivet-worktrees',repository.repositoryId,basename(statePaths.instanceDir),'integration'),
  baseSha:batch.members[0].baseSha},{gitClient:options.gitClient});
 const execute=async(members,candidateId)=>{
  await validateOwner();
  const input={projectRoot:target.path,statePaths,candidateId,baseSha:batch.members[0].baseSha,
   policyDigest:batch.members[0].configDigest,verificationOutputs:config.quality.verificationOutputs??[],
   participants:members.map(m=>({runId:m.runId,nodeId:'accepted-integration',sourceSha:m.sourceSha,sourcePath:m.sourcePath,sourceBranch:m.sourceBranch}))};
  const candidate=await prepareIntegrationCandidate(input,{gitClient:options.gitClient,validateOwner});
  const manifest=candidate.manifest;
  if(await dependencyNeeded(projectRoot,manifest,config,options.gitClient,batch.dependenciesCompleted))return {status:'dependencies-needed',candidate:manifest,
   dependencyTarget:{kind:'batch-candidate',path:manifest.path,commit:manifest.commitSha,branch:manifest.branch}};
  const verified=await verifyIntegrationCandidate(input,{gitClient:options.gitClient,validateOwner,signal:options.signal,
   verify:async manifest=>{
    await validateOwner();
    const gates=await configuredFeatureGates(config,options.resolveCommandExecutable,manifest.path);
    return runQualityGates({projectRoot:manifest.path,commitSha:manifest.commitSha,authority:featureQualityAuthority(config),gates,
     environment:options.environment??{}},{gitClient:options.gitClient,signal:options.signal});
   }});
  return {status:verified.proof.status,candidate:manifest,checks:verified.proof.gates};
 };
 const combined=await execute(batch.members,'combined');
 if(combined.status==='dependencies-needed')return combined;
 const diagnostics=[];
 if(combined.status==='fail'&&batch.members.length>1) {
  for(const [index,member] of batch.members.entries()) {
   if(index>=policy(config).maxIsolationTasks) {diagnostics.push({runId:member.runId,status:'untested'});continue;}
   const result=await execute([member],`isolation-${index+1}`);
   if(result.status==='dependencies-needed')return {...result,combined,diagnostics};
   diagnostics.push({runId:member.runId,...result});
  }
 }
 await validateOwner();
 return {...combined,diagnostics,interactionFailure:combined.status==='fail'&&diagnostics.length===batch.members.length&&diagnostics.every(d=>d.status==='pass')};
}

export async function verifyTaskBatch({projectRoot,runIds},options) {
 if(!Array.isArray(runIds)||runIds.length<1||runIds.length>5||new Set(runIds).size!==runIds.length)fail('select one to five tasks');
 const config=await loadProjectConfig(projectRoot);const configured=policy(config);
 const queue=await openBatchQueue(projectRoot);
 const members=[];for(const id of runIds)members.push(await captureParticipant(projectRoot,id,options,queue));
 await queue.enqueue(members);
 let waitedMs=0,executed=0;
 while(waitedMs<configured.waitMs+5000&&executed<5) {
  options.signal?.throwIfAborted();
  const batch=await queue.claim(configured,runIds,members[0].compatibility);
  if(batch) {
   executed++;
   try {
    await withBatchAdmission(projectRoot,batch.members,options,async scoped=>{
     const report=await executeBatch(projectRoot,batch,scoped,queue,config);
     await scoped.validateAdmission?.();scoped.signal?.throwIfAborted();
     await queue.finish(batch,report);
    });
   }
   catch(error) {await queue.finish(batch,{status:'blocked',reason:options.signal?.aborted?'Verification interrupted; inspect the retained candidate.':'Verification could not safely complete. Inspect participant state, configuration, ownership and the retained candidate.'});}
  }
  const reports=await Promise.all(runIds.map(id=>queue.forRun(id)));
  if(reports.every(r=>r&& !['queued','running'].includes(r.status))&&!(await queue.hasPending(members[0].compatibility)))return reports;
  // A durable running owner is observed, never stolen even if its process vanished.
  if(!batch&&reports.some(r=>r?.status==='running'))return reports;
  await delay(25,undefined,{signal:options.signal});waitedMs+=25;
 }
 return Promise.all(runIds.map(id=>queue.forRun(id)));
}


export async function bootstrapTaskBatchDependencies({projectRoot,runId},options) {
 const queue=await openBatchQueue(projectRoot);const batch=await queue.forRun(runId);
 if(batch?.status!=='dependencies-needed'||!batch.dependencyTarget)fail('no pending batch dependencies');
 return withBatchAdmission(projectRoot,batch.members,options,scoped=>bootstrapBatchDependencies(projectRoot,batch,queue,scoped));
}

async function bootstrapBatchDependencies(projectRoot,batch,queue,options) {
 const validate=async()=>{
  options.signal?.throwIfAborted();
  await options.validateAdmission?.();
  for(const member of batch.members)if((await captureParticipant(projectRoot,member.runId,options,queue)).identity!==member.identity)fail('frozen batch changed');
 };
 await validate();
 const config=await loadProjectConfig(projectRoot),target=batch.dependencyTarget;
 const manifest=batch.candidate,statePaths=await resolveExistingStatePaths(projectRoot,batch.id);
 if(!statePaths)fail('candidate ownership missing');
 await prepareIntegrationCandidate({projectRoot:manifest.targetPath,statePaths,candidateId:manifest.candidateId,baseSha:manifest.baseSha,
  policyDigest:manifest.policyDigest,verificationOutputs:manifest.verificationOutputs,participants:manifest.participants},
  {gitClient:options.gitClient,validateOwner:validate});

 const result=await bootstrapWorktreeDependencies({projectRoot,worktreePath:target.path,expectedCommit:target.commit,expectedBranch:target.branch,
  ...(config.project.dependencies?{dependencies:config.project.dependencies}:{manager:config.project.stack.packageManager})},options);
 await validate();
 if(result.status==='ready')await queue.completeDependencies(batch.id,batch.owner,batch.candidate.digest);
 return result;
}
