import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile as callback} from 'node:child_process';
import {promisify} from 'node:util';
import {chmod,cp,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import YAML from 'yaml';
import {loadProjectConfig} from '../../src/config/load.js';
import {createFeatureExecutor} from '../../src/feature/runtime-bridge.js';
import {createHostExecution} from '../../src/feature/host-execution.js';
import {createGitClient} from '../../src/git/client.js';
import {applyVerifiedTask} from '../../src/feature/local-approval.js';
import {createFeatureWorkflow} from '../../src/feature/workflow.js';
import {taskGovernance,inspectGovernance,requireGovernance} from '../../src/feature/governance.js';
import {createFeatureRunStore} from '../../src/feature/run-store.js';
import {createAcceptedIntegrationStore} from '../../src/feature/accepted-integration.js';
import {acceptedIntegrationPaths,governancePaths,resolveExistingFeatureRunPaths} from '../../src/state/paths.js';
import {readSnapshotWithoutLock} from '../../src/state/snapshot-store.js';
const execFile=promisify(callback);
const git=async(root,...args)=>(await execFile('/usr/bin/git',['-C',root,...args])).stdout.trim();
async function fixture(t,{review,contentScan,client='host',workItems}={}){
 const parent=await realpath(await mkdtemp(join(tmpdir(),'rivet-governance-'))),root=join(parent,'app');
 await mkdir(root);t.after(()=>rm(parent,{recursive:true,force:true}));
 await cp(new URL('../fixtures/config/valid/.rivet/',import.meta.url),join(root,'.rivet'),{recursive:true});
 await writeFile(join(root,'package.json'),JSON.stringify({scripts:{build:'x',test:'x',lint:'x',typecheck:'x',dev:'x'}}));
 await writeFile(join(root,'README.md'),'# Fixture\n');
 const qpath=join(root,'.rivet','quality.yaml'),quality=YAML.parse(await readFile(qpath,'utf8'));
 if(review!==undefined)quality.review=review;if(contentScan!==undefined)quality.contentScan=contentScan;
 await writeFile(qpath,YAML.stringify(quality));
 await execFile('/usr/bin/git',['init','--quiet','--initial-branch=main',root]);
 await git(root,'add','.');await git(root,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--quiet','-m','fixture');
 await loadProjectConfig(root);
 const gitClient=await createGitClient({gitExecutable:await realpath('/usr/bin/git')});
 const decomposition={schemaVersion:1,kind:'agilno.feature-decomposition',workItems:workItems??[{objective:'Add a working health endpoint.',ownedPaths:['src/health.js','docs/health.md'],acceptanceCriterionIndexes:[1]}]};
 const workflow=createFeatureWorkflow({gitClient,now:()=>new Date().toISOString(),protocolsFor:async()=>[],planningClientFor:async()=>{
  if(client==='host')throw Error('No extra model');return {propose:async()=>decomposition};
 },executeFeature:async()=>{throw Error('No spawned executor');}});
 const proposal=await workflow.propose({project:root,source:{kind:'inline',value:'# Health\n\n## Acceptance criteria\n\n- Add a working health endpoint.\n'},client,...(client==='host'?{decomposition}:{})});
 const paths=await resolveExistingFeatureRunPaths(root,proposal.runId),run=await createFeatureRunStore(paths).readOnly();
 const call=(operation,extra={})=>taskGovernance({project:root,runId:run.runId,gitClient,operation,...extra});
 const inspect=(extra={})=>inspectGovernance({project:root,run,gitClient,...extra});
 const snapshot=async()=>readSnapshotWithoutLock(await governancePaths(paths));
 return {root,parent,paths,run,call,inspect,snapshot,gitClient,workflow,proposal};
}
function decision(tier=1,id='health-response'){
 return {id,tier,title:'Health response format',options:[{id:'json',description:'Use a JSON response'},{id:'text',description:'Use plain text'}],choice:'json',rationale:'Existing endpoint conventions use JSON.'};
}
function report(subject,overrides={}){
 const identity=Object.fromEntries(['phase','runId','requestDigest','planDigest','baseSha','headSha','diffDigest'].map(key=>[key,subject[key]]));
 return {...identity,reviewerId:'general',actorId:'independent-reviewer',round:1,status:'PASS',blocking:false,
  coverage:subject.acceptanceCriteria.map((_,index)=>({criterionIndex:index+1,planNodeIds:[subject.planNodeIds.find(id=>id.includes('worker'))??subject.planNodeIds[0]],paths:subject.changedPaths,evidence:[{kind:'manual',reference:'review-health',summary:'Compared the requested health behavior with the plan and changed content.'}]})),
  findings:[],filesReviewed:subject.changedPaths,commandsExecuted:[],checkedAt:new Date().toISOString(),...overrides};
}
async function commitContent(f,content='export const health = true;\n'){
 await mkdir(join(f.root,'src'),{recursive:true});await mkdir(join(f.root,'docs'),{recursive:true});
 await writeFile(join(f.root,'src','health.js'),content);await writeFile(join(f.root,'docs','health.md'),'# Health endpoint\n');
 await git(f.root,'add','.');await git(f.root,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--quiet','-m','health');
 return {path:f.root,branch:'main',commitSha:await git(f.root,'rev-parse','HEAD')};
}
test('decision journal persists monotonically and replays without duplicate IDs',async t=>{
 const f=await fixture(t);assert.equal((await f.inspect()).ready,true);
 const first=await f.call('decide',{input:decision()});assert.equal(first.status,'recorded');assert.equal(first.actor.id,'host-agent');
 assert.equal((await f.snapshot()).version,1);
 const listed=await f.call('decisions');assert.equal(listed.decisions.length,1);assert.match(listed.markdown,/Health response format/);
 await assert.rejects(f.call('decide',{input:decision()}),/already exists/);assert.equal((await f.snapshot()).version,1);
 await f.call('decide',{input:decision(1,'response-header')});assert.equal((await f.snapshot()).version,2);
 assert.equal((await f.call('decisions')).decisions.length,2);assert.equal((await f.inspect()).ready,true);
});
test('pending human decision blocks; decline is non-mutating and exact approval restores readiness',async t=>{
 const f=await fixture(t);const pending=await f.call('decide',{input:decision(2)});
 assert.equal(pending.status,'pending');assert.equal((await f.inspect()).ready,false);
 await assert.rejects(requireGovernance({project:f.root,run:f.run,gitClient:f.gitClient}),/decision-needs-human-approval/);
 assert.deepEqual(await f.call('approve-decision',{decisionId:pending.id,confirm:async()=>false}),{status:'declined'});
 assert.equal((await f.snapshot()).version,1);assert.equal((await f.inspect()).ready,false);
 const approved=await f.call('approve-decision',{decisionId:pending.id,confirm:async record=>record.digest===pending.digest});
 assert.equal(approved.status,'approved');assert.equal(approved.approval.decisionDigest,pending.digest);assert.equal((await f.snapshot()).version,2);
 assert.equal((await f.inspect()).ready,true);await assert.rejects(f.call('approve-decision',{decisionId:pending.id,confirm:async()=>true}));
});
test('journal rejects changed decision payload and changed task binding on replay',async t=>{
 const f=await fixture(t);await f.call('decide',{input:decision()});
 const file=(await governancePaths(f.paths)).snapshotPath,raw=JSON.parse(await readFile(file,'utf8'));
 raw.data.events[0].data.rationale='Changed after recording';await writeFile(file,JSON.stringify(raw)+'\n');
 await assert.rejects(f.call('decisions'));
 const g=await fixture(t);await g.call('decide',{input:decision()});
 const otherFile=(await governancePaths(g.paths)).snapshotPath,other=JSON.parse(await readFile(otherFile,'utf8'));
 other.data.planDigest='f'.repeat(64);await writeFile(otherFile,JSON.stringify(other)+'\n');await assert.rejects(g.call('decisions'));
});
test('required plan review blocks until submitted coverage and rejects self-review and duplicate round',async t=>{
 const f=await fixture(t,{review:{required:true,maxRounds:2}});
 const observed=await f.call('review',{phase:'plan'});assert.equal(observed.ready,false);assert.deepEqual(observed.subject.changedPaths,[]);
 await assert.rejects(f.call('review-submit',{phase:'plan',input:report(observed.subject,{actorId:'host-agent'})}),/self-review/);
 await assert.rejects(f.call('review-submit',{phase:'plan',input:report(observed.subject,{coverage:[]})}),/incomplete-pass/);
 const value=report(observed.subject);assert.equal((await f.call('review-submit',{phase:'plan',input:value})).status,'recorded');
 assert.equal((await f.inspect({phase:'plan'})).ready,true);
 await assert.rejects(f.call('review-submit',{phase:'plan',input:value}),/already recorded/);
});
test('review cap escalates failure and cannot be cleared by an extra round',async t=>{
 const f=await fixture(t,{review:{required:true,maxRounds:1}}),observed=await f.call('review',{phase:'plan'});
 await f.call('review-submit',{phase:'plan',input:report(observed.subject,{status:'FAIL',blocking:true,coverage:[],findings:[{kind:'missing',summary:'Plan omits error behavior',blocking:true}]})});
 const state=await f.inspect({phase:'plan'});assert.equal(state.ready,false);assert.equal(state.review.humanEscalation,true);
 await assert.rejects(f.call('review-submit',{phase:'plan',input:report(observed.subject,{round:2})}),/round-limit/);
 assert.equal((await f.snapshot()).version,1);
});
test('configured scan reads committed content, blocks secrets, and refuses dirty checkout',async t=>{
 const f=await fixture(t,{contentScan:{secrets:true}}),checkout=await commitContent(f,'export const secret = "ghp_'+ 'A'.repeat(36)+'";\n');
 const result=await f.inspect({phase:'final',checkout});assert.equal(result.ready,false);assert.equal(result.scan.status,'failed');
 assert.ok(result.blockers.some(item=>item.code==='content-scan-failed'));assert.equal(JSON.stringify(result.scan).includes('A'.repeat(36)),false);
 await writeFile(join(f.root,'src','health.js'),'export const safe = true;\n');await assert.rejects(f.inspect({phase:'final',checkout}),/checkout changed/);
});
test('passing configured scan records once and optional review needs no model or report',async t=>{
 const f=await fixture(t,{contentScan:{secrets:true}}),checkout=await commitContent(f);
 const input={project:f.root,run:f.run,gitClient:f.gitClient,phase:'final',checkout};
 assert.equal((await requireGovernance(input)).ready,true);const snapshot=await f.snapshot();assert.equal(snapshot.version,1);assert.equal(snapshot.data.events[0].type,'scan.recorded');
 await requireGovernance(input);assert.equal((await f.snapshot()).version,1);
});
test('focused final reviewers replay durably and stale integration identity cannot satisfy a new head',async t=>{
 const policy={required:true,maxRounds:2,reviewers:[{id:'code',paths:['src/**'],required:true},{id:'docs',paths:['docs/**'],required:true}]};
 const f=await fixture(t,{review:policy}),checkout=await commitContent(f);
 const accepted=createAcceptedIntegrationStore(await acceptedIntegrationPaths(f.paths));
 await accepted.write({schemaVersion:1,runId:f.run.runId,baselineCommit:f.run.featurePlan.baselineCommit,commitSha:checkout.commitSha,runtimeVersion:1,path:checkout.path,branch:checkout.branch});
 const initial=await f.call('review',{phase:'final'});assert.equal(initial.ready,false);
 for(const [reviewerId,path] of [['code','src/health.js'],['docs','docs/health.md']]){
  const value=report(initial.subject,{reviewerId,filesReviewed:[path],coverage:report(initial.subject).coverage.map(item=>({...item,paths:[path]}))});
  await f.call('review-submit',{phase:'final',input:value});
 }
 assert.equal((await f.inspect({phase:'final'})).ready,true);assert.equal((await f.snapshot()).version,2);
 const second=await commitContent(f,'export const health = "changed";\n');
 await accepted.write({schemaVersion:1,runId:f.run.runId,baselineCommit:f.run.featurePlan.baselineCommit,commitSha:second.commitSha,runtimeVersion:2,path:second.path,branch:second.branch});
 const changed=await f.inspect({phase:'final'});assert.equal(changed.ready,false);assert.equal(changed.review.reports.length,0);
 assert.equal((await f.snapshot()).version,2);
 const exported=await f.call('review',{phase:'final'});
 assert.equal(exported.review.rounds,1);assert.equal(exported.review.humanEscalation,false);
 assert.ok(exported.reportTemplates.every(value=>value.round===2));
 for(const [reviewerId,path] of [['code','src/health.js'],['docs','docs/health.md']]){
  const value=report(changed.subject,{reviewerId,round:2,filesReviewed:[path],coverage:report(changed.subject).coverage.map(item=>({...item,paths:[path]}))});
  await assert.rejects(f.call('review-submit',{phase:'final',input:{...value,round:1}}),/advance.*round/);
  await f.call('review-submit',{phase:'final',input:value});
  if(reviewerId==='code'){
   const waiting=await f.call('review',{phase:'final'});
   assert.equal(waiting.review.humanEscalation,false);
   assert.deepEqual(waiting.reportTemplates.map(({reviewerId,round})=>({reviewerId,round})),[{reviewerId:'docs',round:2}]);
  }
 }
 const completed=await f.call('review',{phase:'final'});
 assert.equal(completed.ready,true);assert.equal(completed.review.rounds,2);
 assert.equal(completed.review.humanEscalation,false);assert.deepEqual(completed.reportTemplates,[]);
 assert.equal((await f.snapshot()).version,4);
});
test('required final review without an accepted integration reports a blocker without creating evidence',async t=>{
 const f=await fixture(t,{review:{required:true}}),result=await f.inspect({phase:'final'});
 assert.equal(result.ready,false);assert.ok(result.blockers.some(item=>item.code==='integration-not-ready'));assert.equal(await f.snapshot(),null);
});
const startInput=f=>({project:f.root,runId:f.run.runId,expectedVersion:f.run.version,proposalDigest:f.run.proposalDigest});
test('feature start enforces required plan review and pending decision before activation',async t=>{
 const f=await fixture(t,{review:{required:true}});
 await assert.rejects(f.workflow.start(startInput(f)),/missing-review/);
 assert.equal((await createFeatureRunStore(f.paths).readOnly()).status,'proposed');
 const observed=await f.call('review',{phase:'plan'});await f.call('review-submit',{phase:'plan',input:report(observed.subject)});
 const pending=await f.call('decide',{input:decision(3)});
 await assert.rejects(f.workflow.start(startInput(f)),/decision-needs-human-approval/);
 await f.call('approve-decision',{decisionId:pending.id,confirm:async()=>true});
 const activated=await f.workflow.start(startInput(f));assert.equal(activated.status,'approved');
 const host=createHostExecution({gitClient:f.gitClient});
 const status=await host.status({project:f.root,runId:f.run.runId});
 assert.equal(status.governance.subject.phase,'plan');assert.equal(status.governance.ready,true);
 assert.match(status.nextAction,/work prepare/);assert.equal(status.deliveryReady,false);
});
async function hostCompletedWorker(t,f,content='export const health = true;\n'){
 const approved=await f.workflow.start(startInput(f)),gate=join(f.parent,'gate');
 await writeFile(gate,'#!/bin/sh\nexit 0\n');await chmod(gate,0o700);
 const execution=createHostExecution({gitClient:f.gitClient,now:()=>new Date().toISOString(),resolveCommandExecutable:async()=>gate,environment:{PATH:process.env.PATH}});
 const prepared=await execution.prepare({project:f.root,runId:f.run.runId,expectedRunVersion:approved.version});
 const next=await execution.nextAction({project:f.root,runId:f.run.runId,expectedRuntimeVersion:prepared.runtimeVersion});
 const payload=JSON.parse(next.action.payload),worktree=payload.contract.worktree.path;
 await mkdir(join(worktree,'src'),{recursive:true});await mkdir(join(worktree,'docs'),{recursive:true});
 await writeFile(join(worktree,'src','health.js'),content);await writeFile(join(worktree,'docs','health.md'),'# Health endpoint\n');
 const submitted=await execution.submitResult({project:f.root,runId:f.run.runId,expectedRuntimeVersion:next.runtimeVersion,action:next.action,result:{version:1,status:'success',output:{summary:'Implemented health endpoint.',evidence:payload.contract.evidence},usage:{tokens:10,costUsd:0}}});
 assert.equal(submitted.status,'accepted');
 return {execution,verifyInput:{project:f.root,runId:f.run.runId,expectedRunVersion:prepared.run.version,expectedRuntimeVersion:submitted.runtimeVersion}};
}
test('host verification cannot become deliverable until required final review passes',async t=>{
 const f=await fixture(t,{review:{required:true}});
 const plan=await f.call('review',{phase:'plan'});await f.call('review-submit',{phase:'plan',input:report(plan.subject)});
 const {execution,verifyInput}=await hostCompletedWorker(t,f);
 await assert.rejects(execution.verify(verifyInput),{code:'ERR_HOST_EXECUTION_VERIFICATION_FAILED'});
 let status=await execution.status({project:f.root,runId:f.run.runId});assert.equal(status.deliveryReady,false);
 const final=await f.call('review',{phase:'final'});assert.equal(final.subject.changedPaths.length,2);
 await f.call('review-submit',{phase:'final',input:report(final.subject)});
 await execution.verify(verifyInput);status=await execution.status({project:f.root,runId:f.run.runId});assert.equal(status.deliveryReady,true);
});
test('new pending decision prevents verified task delivery until explicit human approval',async t=>{
 const f=await fixture(t),{execution,verifyInput}=await hostCompletedWorker(t,f);
 await execution.verify(verifyInput);assert.equal((await execution.status({project:f.root,runId:f.run.runId})).deliveryReady,true);
 const pending=await f.call('decide',{input:decision(2)});
 assert.equal((await execution.status({project:f.root,runId:f.run.runId})).deliveryReady,false);
 let prompted=false;await assert.rejects(applyVerifiedTask({project:f.root,runId:f.run.runId,gitClient:f.gitClient,confirm:async()=>{prompted=true;return true;}}));
 assert.equal(prompted,false);assert.equal(await git(f.root,'rev-parse','HEAD'),f.run.featurePlan.baselineCommit);
 await f.call('approve-decision',{decisionId:pending.id,confirm:async()=>false});assert.equal((await execution.status({project:f.root,runId:f.run.runId})).deliveryReady,false);
 await f.call('approve-decision',{decisionId:pending.id,confirm:async()=>true});assert.equal((await execution.status({project:f.root,runId:f.run.runId})).deliveryReady,true);
});
test('concurrent decision writers never lose or overwrite a successful append',async t=>{
 const f=await fixture(t),results=await Promise.allSettled([f.call('decide',{input:decision(1,'first-decision')}),f.call('decide',{input:decision(1,'second-decision')})]);
 const succeeded=results.filter(result=>result.status==='fulfilled').map(result=>result.value.id).sort();assert.ok(succeeded.length>=1);
 const saved=await f.call('decisions');assert.deepEqual(saved.decisions.map(record=>record.id).sort(),succeeded);assert.equal((await f.snapshot()).version,succeeded.length);
});
test('configured secret scan prevents host final verification despite successful project commands',async t=>{
 const f=await fixture(t,{contentScan:{secrets:true}});
 const {execution,verifyInput}=await hostCompletedWorker(t,f,'export const token = "ghp_'+'A'.repeat(36)+'";\n');
 await assert.rejects(execution.verify(verifyInput),{code:'ERR_HOST_EXECUTION_VERIFICATION_FAILED'});
 const status=await execution.status({project:f.root,runId:f.run.runId});assert.equal(status.deliveryReady,false);
 assert.equal(status.governance.scan.status,'failed');assert.ok(status.governance.blockers.some(blocker=>blocker.code==='content-scan-failed'));
});
test('hidden working-tree policy edits cannot bypass required plan review',async t=>{
 const f=await fixture(t,{review:{required:true}}),path=join(f.root,'.rivet','quality.yaml');
 const config=YAML.parse(await readFile(path,'utf8'));config.review.required=false;
 await git(f.root,'update-index','--assume-unchanged','.rivet/quality.yaml');await writeFile(path,YAML.stringify(config));
 assert.equal(await git(f.root,'status','--porcelain'),'');
 await assert.rejects(f.workflow.start(startInput(f)));
 assert.equal((await createFeatureRunStore(f.paths).readOnly()).status,'proposed');
});
test('spawned execution stops before another worker when the previous worker records a pending decision',async t=>{
 const f=await fixture(t,{client:'codex',workItems:[{objective:'Implement health endpoint',ownedPaths:['src/health.js'],acceptanceCriterionIndexes:[1]},{objective:'Document health endpoint',ownedPaths:['docs/health.md'],acceptanceCriterionIndexes:[1]}]});
 await f.workflow.start(startInput(f));const approved=await createFeatureRunStore(f.paths).readOnly();
 const gate=join(f.parent,'gate');await writeFile(gate,'#!/bin/sh\nexit 0\n');await chmod(gate,0o700);let launches=0;
 const executor=createFeatureExecutor({gitClient:f.gitClient,now:()=>new Date().toISOString(),environment:{PATH:process.env.PATH},resolveCommandExecutable:async()=>gate,clientFor:async kind=>({provider:kind,async launch(contract){
  launches++;assert.equal(launches,1,'A pending decision must prevent the second worker');
  for(const path of contract.ownedPaths){const target=join(contract.worktree.path,path);await mkdir(join(target,'..'),{recursive:true});await writeFile(target,'Implemented health endpoint\n');}
  await f.call('decide',{input:decision(2,'response-policy')});
  return {version:1,status:'success',output:{summary:'Implemented first unit',evidence:contract.evidence},usage:{tokens:1,costUsd:0}};
 }})});
 const result=await executor({project:f.root,run:approved});assert.equal(result.status,'blocked');assert.equal(launches,1);
 assert.equal((await f.call('decisions')).decisions[0].status,'pending');assert.equal(await git(f.root,'rev-parse','HEAD'),f.run.featurePlan.baselineCommit);
});
test('untracked review or scan policies reject a new proposal before resolving a planning client',async t=>{
 for(const configuration of [{review:{required:true}},{contentScan:{secrets:true}}]){
  const f=await fixture(t,configuration);
  await git(f.root,'rm','--cached','.rivet/quality.yaml');
  await writeFile(join(f.root,'.git','info','exclude'),'.rivet/quality.yaml\n');
  await git(f.root,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--quiet','-m','make policy local only');
  assert.equal(await git(f.root,'status','--porcelain'),'');let planningCalls=0;
  const workflow=createFeatureWorkflow({gitClient:f.gitClient,protocolsFor:async()=>[],planningClientFor:async()=>{planningCalls++;throw Error('Must reject before planner');},executeFeature:async()=>{throw Error('Must not execute');}});
  await assert.rejects(workflow.propose({project:f.root,source:{kind:'inline',value:'# Other endpoint\n\n## Acceptance criteria\n\n- Add another endpoint.\n'},client:'codex'}),/Commit the quality policy/);
  assert.equal(planningCalls,0);
 }
});
test('a changed accepted head cannot reset the same phase review-round budget',async t=>{
 const f=await fixture(t,{review:{required:true,maxRounds:1}}),first=await commitContent(f);
 const accepted=createAcceptedIntegrationStore(await acceptedIntegrationPaths(f.paths));
 const accept=checkout=>accepted.write({schemaVersion:1,runId:f.run.runId,baselineCommit:f.run.featurePlan.baselineCommit,commitSha:checkout.commitSha,runtimeVersion:1,path:checkout.path,branch:checkout.branch});
 await accept(first);const initial=await f.call('review',{phase:'final'});
 await f.call('review-submit',{phase:'final',input:report(initial.subject,{status:'FAIL',blocking:true,findings:[{kind:'missing',summary:'Health behavior needs correction',blocking:true}]})});
 const second=await commitContent(f,'export const health = "corrected";\n');await accept(second);
 const revised=await f.call('review',{phase:'final'});
 assert.equal(revised.review.reports.length,0,'Old-head evidence must not satisfy the corrected head');
 assert.equal(revised.review.rounds,1);assert.deepEqual(revised.reportTemplates,[]);
 await assert.rejects(f.call('review-submit',{phase:'final',input:report(revised.subject,{round:1})}),/round|limit|escalat/i);
 assert.equal((await f.snapshot()).version,1,'Rejected reset must not append evidence');
 const status=await f.inspect({phase:'final'});assert.equal(status.ready,false);assert.equal(status.review.humanEscalation,true);
});
