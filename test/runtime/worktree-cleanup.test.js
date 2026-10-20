import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile as callback} from 'node:child_process';
import {promisify} from 'node:util';
import {cp,lstat,mkdir,mkdtemp,readFile,realpath,rm,writeFile,rename,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import YAML from 'yaml';
import {managedPolicy} from '../fixtures/execution-policy.js';
import {createFeatureWorkflow} from '../../src/feature/workflow.js';
import {createHostExecution} from '../../src/feature/host-execution.js';
import {createGitClient} from '../../src/git/client.js';
import {resolveExistingStatePaths,resolveExistingFeatureRunPaths} from '../../src/state/paths.js';
import {previewTaskWorktreeCleanup,applyTaskWorktreeCleanup,confirmTaskWorktreeCleanup} from '../../src/git/worktree-cleanup.js';
import {main} from '../../src/cli/main.js';
const execFile=promisify(callback), NOW='2029-01-01T00:00:00.000Z';
async function git(root,...args){return (await execFile('/usr/bin/git',['-C',root,...args])).stdout.trim();}
async function fixture(t,{parallel=false}={}){
 const parent=await realpath(await mkdtemp(join(tmpdir(),'rivet-cleanup-'))),root=join(parent,'project');
 t.after(()=>rm(parent,{recursive:true,force:true}));await mkdir(root);
 await cp(new URL('../fixtures/config/valid/.rivet/',import.meta.url),join(root,'.rivet'),{recursive:true});
 const policyPath=join(root,'.rivet','orchestration.yaml');const policy=YAML.parse(await readFile(policyPath,'utf8'));policy.executionPolicy=managedPolicy();if(typeof parallel==='number'){policy.executionPolicy.limits.workersPerTask=parallel;policy.executionPolicy.limits.agentExecutions=parallel;}if(parallel)for(const role of policy.roles){if(['worker','manager'].includes(role.kind))role.capacity=typeof parallel==='number'?parallel:2;if(typeof parallel==='number'&&role.kind==='worker')role.budget={timeMinutes:1,tokenLimit:1000,costUsd:1,taskLimit:1};}await writeFile(policyPath,YAML.stringify(policy));
 await writeFile(join(root,'.gitignore'),'ignored/\n');await git(root,'init','-q','-b','main');await git(root,'add','.');await git(root,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture');
 const gitClient=await createGitClient({gitExecutable:await realpath('/usr/bin/git')});const workflow=createFeatureWorkflow({gitClient,now:()=>NOW,protocolsFor:async()=>[],planningClientFor:async()=>{throw Error('no provider');},executeFeature:async()=>{throw Error('no provider');}});
 const proposal=await workflow.propose({project:root,source:{kind:'inline',value:'# Add agenda\n\n## Acceptance criteria\n\n- Add agenda.\n'},client:'host',decomposition:{schemaVersion:1,kind:'agilno.feature-decomposition',workItems:parallel?Array.from({length:typeof parallel==='number'?parallel:2},(_,i)=>`item${i}`).map(id=>({id,dependencies:[],objective:`Add ${id}.`,ownedPaths:[`${id}.js`],acceptanceCriterionIndexes:[1]})):[{objective:'Add agenda.',ownedPaths:['agenda.js'],acceptanceCriterionIndexes:[1]}]}});
 const approved=await workflow.start({project:root,runId:proposal.runId,expectedVersion:proposal.version,proposalDigest:proposal.proposalDigest});
 const execution=createHostExecution({gitClient,now:()=>NOW});const prepared=await execution.prepare({project:root,runId:approved.runId,expectedRunVersion:approved.version});
 const next=await execution.nextAction({project:root,runId:approved.runId,expectedRuntimeVersion:prepared.runtimeVersion});
 const actions=next.actions?.map(offer=>offer.action)??[next.action];
 const path=JSON.parse(actions[0].payload).contract.worktree.path;
 const statePaths=await resolveExistingStatePaths(root,approved.runId),runPaths=await resolveExistingFeatureRunPaths(root,approved.runId);
 const state=JSON.parse(await readFile(statePaths.snapshotPath,'utf8'));for(const action of actions){const session=state.data.sessions[action.nodeId];
 session.writer={source:'host-observation',nativeHandle:'fixture-handle',actorId:'fixture-owner',observedAtMs:Date.parse(NOW),assurance:'host-reported'};
 session.stopReceipt={sessionId:session.id,generation:session.generation,nativeHandle:'fixture-handle',actorId:'fixture-owner',observedAtMs:Date.parse(NOW),status:'stopped',source:'host-observation',assurance:'host-reported'};
 session.phase='completed';state.data.graph.nodes.find(n=>n.id===action.nodeId).status='completed';state.data.launchIntents[action.nodeId].status='complete';}
 await writeFile(statePaths.snapshotPath,JSON.stringify(state)+'\n');
 const run=JSON.parse(await readFile(runPaths.snapshotPath,'utf8'));run.data.status='completed';await writeFile(runPaths.snapshotPath,JSON.stringify(run)+'\n');
 return {root,path,gitClient,runId:approved.runId,statePaths,runPaths,state,run};
}
test('cleanup preview observes exact stopped completed Worker without changing state, refs or files',async t=>{
 const f=await fixture(t);const before=await Promise.all([readFile(f.statePaths.snapshotPath),readFile(f.runPaths.snapshotPath),git(f.root,'show-ref'),git(f.root,'worktree','list','--porcelain')]);
 const result=await previewTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId},{gitClient:f.gitClient});assert.equal(result.checkouts[0].eligible,true);assert.equal(result.checkouts[0].path,f.path);assert.equal(result.checkouts[0].commit,await git(f.path,'rev-parse','HEAD'));
 const after=await Promise.all([readFile(f.statePaths.snapshotPath),readFile(f.runPaths.snapshotPath),git(f.root,'show-ref'),git(f.root,'worktree','list','--porcelain')]);assert.deepEqual(after,before);
});
test('cleanup retains active/failed/blocked tasks, unknown owners, dirt, ignored contents and symlinks',async t=>{
 const f=await fixture(t);const inspect=async()=> (await previewTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId},{gitClient:f.gitClient})).checkouts[0];
 for(const status of ['running','blocked']){f.run.data.status=status;await writeFile(f.runPaths.snapshotPath,JSON.stringify(f.run)+'\n');assert.equal((await inspect()).eligible,false);}
 f.run.data.status='completed';await writeFile(f.runPaths.snapshotPath,JSON.stringify(f.run)+'\n');
 const reservationFile=join(f.statePaths.instanceDir,'worktree-reservations.json');const reservations=JSON.parse(await readFile(reservationFile,'utf8'));
 const originalPath=reservations.reservations[0].worktreePath;reservations.reservations[0].worktreePath=f.root;await writeFile(reservationFile,JSON.stringify(reservations)+'\n');assert.equal((await inspect()).reason,'primary-checkout');reservations.reservations[0].worktreePath=originalPath;
 reservations.reservations.push({...reservations.reservations[0],leaseId:'12345678-1234-4234-8234-123456789abc'});await writeFile(reservationFile,JSON.stringify(reservations)+'\n');assert.equal((await inspect()).reason,'shared-checkout');reservations.reservations.pop();await writeFile(reservationFile,JSON.stringify(reservations)+'\n');
 const worker=f.state.data.graph.nodes.find(n=>n.owner.role==='worker');worker.status='failed';await writeFile(f.statePaths.snapshotPath,JSON.stringify(f.state)+'\n');assert.equal((await inspect()).reason,'worker-failed');worker.status='completed';
 const session=Object.values(f.state.data.sessions)[0],receipt=session.stopReceipt;session.stopReceipt=null;await writeFile(f.statePaths.snapshotPath,JSON.stringify(f.state)+'\n');assert.equal((await inspect()).reason,'owner-stop-unproven');session.stopReceipt=receipt;await writeFile(f.statePaths.snapshotPath,JSON.stringify(f.state)+'\n');
 await writeFile(join(f.path,'untracked'),'preserve');assert.equal((await inspect()).reason,'dirty-checkout');await rm(join(f.path,'untracked'));
 await mkdir(join(f.path,'ignored'));await writeFile(join(f.path,'ignored','file'),'preserve');assert.equal((await inspect()).reason,'ignored-or-untracked-content');await rm(join(f.path,'ignored'),{recursive:true});
 const owned=join(f.path,'.rivet-deps');await mkdir(owned,{mode:0o700});const rootStat=await lstat(f.path),dirStat=await lstat(owned);
 await writeFile(join(owned,'.rivet-owner.json'),JSON.stringify({version:1,kind:'rivet-dependencies',root:f.path,rootIdentity:`${rootStat.dev}:${rootStat.ino}`,directoryIdentity:`${dirStat.dev}:${dirStat.ino}`,token:'12345678-1234-1234-1234-123456789abc'}));await writeFile(join(owned,'.gitignore'),'*\n');
 assert.deepEqual(await f.gitClient.statusPaths(f.path,{includeIgnoredDirectories:true}),[]);assert.equal((await inspect()).reason,'ignored-or-untracked-content');await rm(owned,{recursive:true});
 await rename(f.path,f.path+'-saved');await symlink(f.path+'-saved',f.path);assert.equal((await inspect()).reason,'symlink-or-noncanonical');
});
test('task cleanup previews completed tasks and requires interactive exact approval',async t=>{
 const f=await fixture(t),messages=[];const options={resolveCommandExecutable:async()=>realpath('/usr/bin/git'),cwd:()=>f.root,output:{log:v=>messages.push(v),error:v=>messages.push(v),json(){}}};
 assert.equal(await main(['task','cleanup','--preview'],options),0);assert.ok(messages.some(v=>v.startsWith('Eligible:')));assert.ok(messages.some(v=>v.includes('No checkout')));
 assert.notEqual(await main(['task','cleanup'],{...options,terminalIsInteractive:()=>false}),0);
 assert.equal(await main(['task','cleanup'],{...options,terminalIsInteractive:()=>true,confirmWorktreeCleanup:async()=>false}),0);assert.ok((await lstat(f.path)).isDirectory());
 assert.equal(await main(['task','cleanup'],{...options,terminalIsInteractive:()=>true,confirmWorktreeCleanup:async()=>true}),0);await assert.rejects(lstat(f.path),{code:'ENOENT'});assert.notEqual(await main(['task','cleanup','--apply'],options),0);assert.notEqual(await main(['task','status','--preview'],options),0);
});

test('approved cleanup removes only checkout, preserves worker commits and durable evidence, and replay is explicit',async t=>{
 const f=await fixture(t);await writeFile(join(f.path,'agenda.js'),'export const agenda = [];\n');await git(f.path,'add','.');await git(f.path,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','work');
 const preview=await previewTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId},{gitClient:f.gitClient});
 const refs=await git(f.root,'show-ref'),evidence=await readFile(f.statePaths.snapshotPath);
 await assert.rejects(applyTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId,preview},{gitClient:f.gitClient}),/approval/i);
 const result=await applyTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId,preview,approval:await confirmTaskWorktreeCleanup(preview,async()=>true)},{gitClient:f.gitClient});
 assert.equal(result.checkouts[0].status,'removed');await assert.rejects(lstat(f.path),{code:'ENOENT'});assert.equal(await git(f.root,'show-ref'),refs);assert.deepEqual(await readFile(f.statePaths.snapshotPath),evidence);
 const replay=await applyTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId,preview,approval:await confirmTaskWorktreeCleanup(preview,async()=>true)},{gitClient:f.gitClient});assert.equal(replay.checkouts[0].status,'removed');
});
test('cleanup rejects stale approval after worker changes and preserves unknown ignored files',async t=>{
 const f=await fixture(t);const preview=await previewTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId},{gitClient:f.gitClient});
 await mkdir(join(f.path,'ignored'));await writeFile(join(f.path,'ignored','keep'),'precious');
 await assert.rejects(applyTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId,preview,approval:await confirmTaskWorktreeCleanup(preview,async()=>true)},{gitClient:f.gitClient}),/changed|eligible/i);assert.equal(await readFile(join(f.path,'ignored','keep'),'utf8'),'precious');
});

test('cleanup rejects copied previews, changed approval and active owners',async t=>{
 const f=await fixture(t);const preview=await previewTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId},{gitClient:f.gitClient});
 await assert.rejects(confirmTaskWorktreeCleanup(structuredClone(preview),async()=>true),/fresh cleanup preview/);
 const approval=await confirmTaskWorktreeCleanup(preview,async()=>true);
 f.run.data.status='running';await writeFile(f.runPaths.snapshotPath,JSON.stringify(f.run)+'\n');
 await assert.rejects(applyTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId,preview,approval},{gitClient:f.gitClient}),/changed/);
 assert.ok((await lstat(f.path)).isDirectory());
});
test('cancelled stopped tasks can clean up and interrupted removal replays without adopting a replacement',async t=>{
 const f=await fixture(t);f.run.data.status='cancelled';f.state.data.graph.nodes.find(n=>n.owner.role==='worker').status='cancelled';
 await writeFile(f.runPaths.snapshotPath,JSON.stringify(f.run)+'\n');await writeFile(f.statePaths.snapshotPath,JSON.stringify(f.state)+'\n');
 const preview=await previewTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId},{gitClient:f.gitClient});
 const approval=await confirmTaskWorktreeCleanup(preview,async()=>true);
 await applyTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId,preview,approval},{gitClient:f.gitClient});
 const journalPath=join(f.statePaths.instanceDir,'worktree-cleanup.json');const journal=JSON.parse(await readFile(journalPath,'utf8'));journal.data.checkouts[0].status='removing';await writeFile(journalPath,JSON.stringify(journal)+'\n');
 const resume=await previewTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId},{gitClient:f.gitClient});assert.deepEqual(resume,preview);
 await applyTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId,preview:resume,approval:await confirmTaskWorktreeCleanup(resume,async()=>true)},{gitClient:f.gitClient});
 const done=await previewTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId},{gitClient:f.gitClient});assert.equal(done.checkouts[0].reason,'checkout-removed-branch-preserved');
 await mkdir(f.path);await writeFile(join(f.path,'keep'),'replacement');
 await assert.rejects(applyTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId,preview,approval},{gitClient:f.gitClient}),/changed/);assert.equal(await readFile(join(f.path,'keep'),'utf8'),'replacement');
});

test('cleanup rechecks after confirmation and rejects changed checkout inode and commit',async t=>{
 const f=await fixture(t);let preview=await previewTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId},{gitClient:f.gitClient});
 let approval=await confirmTaskWorktreeCleanup(preview,async()=>{await writeFile(join(f.path,'agenda.js'),'changed after display');return true;});
 await assert.rejects(applyTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId,preview,approval},{gitClient:f.gitClient}),/changed/);
 await git(f.path,'add','.');await git(f.path,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','new head');
 await assert.rejects(applyTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId,preview,approval},{gitClient:f.gitClient}),/changed/);
 preview=await previewTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId},{gitClient:f.gitClient});approval=await confirmTaskWorktreeCleanup(preview,async()=>true);
 await rename(f.path,f.path+'-old');await cp(f.path+'-old',f.path,{recursive:true});
 await assert.rejects(applyTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId,preview,approval},{gitClient:f.gitClient}),/changed/);assert.ok((await lstat(f.path)).isDirectory());
});


test('fresh confirmed preview resumes a partial multi-worker cleanup without original approval objects',async t=>{
 const f=await fixture(t,{parallel:true});const preview=await previewTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId},{gitClient:f.gitClient});assert.equal(preview.checkouts.length,2);assert.ok(preview.checkouts.every(item=>item.eligible));
 const refs=await git(f.root,'show-ref');
 await applyTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId,preview,approval:await confirmTaskWorktreeCleanup(preview,async()=>true)},{gitClient:f.gitClient});
 // Crash after removing B, before recording its completion; A was already durably completed.
 const journalPath=join(f.statePaths.instanceDir,'worktree-cleanup.json');const journal=JSON.parse(await readFile(journalPath,'utf8'));journal.data.checkouts[1].status='removing';await writeFile(journalPath,JSON.stringify(journal)+'\n');
 const fresh=await previewTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId},{gitClient:f.gitClient});assert.equal(fresh.checkouts[0].eligible,false);assert.equal(fresh.checkouts[1].eligible,true);
 const result=await applyTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId,preview:fresh,approval:await confirmTaskWorktreeCleanup(fresh,async()=>true)},{gitClient:f.gitClient});
 assert.ok(result.checkouts.every(item=>item.status==='removed'));assert.equal(await git(f.root,'show-ref'),refs);
 const recorded=JSON.parse(await readFile(journalPath,'utf8'));assert.deepEqual(recorded.data.preview,preview);assert.equal(recorded.data.approvalDigest,journal.data.approvalDigest);
});

test('fresh partial-cleanup approval cannot adopt a changed still-present pending checkout',async t=>{
 const f=await fixture(t,{parallel:true});const preview=await previewTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId},{gitClient:f.gitClient});
 await confirmTaskWorktreeCleanup(preview,async()=>true);
 const [first,pending]=preview.checkouts;
 await f.gitClient.removePreservedWorktree(f.root,{path:first.path,branch:first.branch,commit:first.commit,dev:first.identity.dev,ino:first.identity.ino});
 const journal={version:1,data:{approvalDigest:createHash('sha256').update(JSON.stringify(preview)).digest('hex'),preview,checkouts:[{...first,status:'removed'},{...pending,status:'removing'}]}};
 await writeFile(join(f.statePaths.instanceDir,'worktree-cleanup.json'),JSON.stringify(journal)+'\n',{mode:0o600});
 await writeFile(join(pending.path,'new.js'),'changed after partial cleanup');await git(pending.path,'add','.');await git(pending.path,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','new work');
 const fresh=await previewTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId},{gitClient:f.gitClient});assert.equal(fresh.checkouts[1].eligible,true);assert.notEqual(fresh.checkouts[1].commit,pending.commit);
 await assert.rejects(applyTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId,preview:fresh,approval:await confirmTaskWorktreeCleanup(fresh,async()=>true)},{gitClient:f.gitClient}),/changed/);
 assert.equal(await readFile(join(pending.path,'new.js'),'utf8'),'changed after partial cleanup');
});

test('cleanup removes protected regenerable dependencies but preserves external symlink targets and evidence',async t=>{
 const f=await fixture(t);
 const {beginLegacyDependencyInstall,finishLegacyDependencyInstall}=await import('../../src/runtime/legacy-dependency-directory.js');
 await git(f.root,'config','core.excludesFile',join(f.root,'.git','cleanup-ignore'));
 await writeFile(join(f.root,'.git','cleanup-ignore'),'node_modules/\n');
 const owner=await beginLegacyDependencyInstall(f.path);await mkdir(join(f.path,'node_modules'));
 const outside=join(f.root,'keep');await writeFile(outside,'precious');await symlink(outside,join(f.path,'node_modules','outside'));
 await finishLegacyDependencyInstall(owner,true);
 const before=await git(f.root,'show-ref');const preview=await previewTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId},{gitClient:f.gitClient});
 assert.equal(preview.checkouts[0].eligible,true);assert.equal(preview.checkouts[0].artifacts[0].name,'node_modules');
 await applyTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId,preview,approval:await confirmTaskWorktreeCleanup(preview,async()=>true)},{gitClient:f.gitClient});
 assert.equal(await readFile(outside,'utf8'),'precious');assert.equal(await git(f.root,'show-ref'),before);await assert.rejects(lstat(f.path),{code:'ENOENT'});
});

test('pending installer and tracked regenerable roots retain checkout',async t=>{
 const f=await fixture(t);const deps=await import('../../src/runtime/legacy-dependency-directory.js');
 const owner=await deps.beginLegacyDependencyInstall(f.path);await deps.abandonLegacyDependencyInstall(owner);
 let preview=await previewTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId},{gitClient:f.gitClient});assert.equal(preview.checkouts[0].eligible,false);
 const g=await fixture(t);await mkdir(join(g.path,'node_modules'));await writeFile(join(g.path,'node_modules','tracked'),'keep');await git(g.path,'add','.');await git(g.path,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','tracked artifact');
 preview=await previewTaskWorktreeCleanup({projectRoot:g.root,runId:g.runId},{gitClient:g.gitClient});assert.equal(preview.checkouts[0].eligible,false);assert.equal(await readFile(join(g.path,'node_modules','tracked'),'utf8'),'keep');
});

test('dependency installer locks fence cleanup even when directory is absent',async t=>{
 const f=await fixture(t);const deps=await import('../../src/runtime/legacy-dependency-directory.js');
 const preview=await previewTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId},{gitClient:f.gitClient});
 const owner=await deps.beginLegacyDependencyInstall(f.path,'.rivet-deps');
 await assert.rejects(applyTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId,preview,approval:await confirmTaskWorktreeCleanup(preview,async()=>true)},{gitClient:f.gitClient}));
 await deps.abandonLegacyDependencyInstall(owner);assert.ok((await lstat(f.path)).isDirectory());
});

test('retention is disabled by default, requires separate approval, honors age and revocation',async t=>{
 const f=await fixture(t);const {configureWorktreeRetention,sweepWorktreeRetention}=await import('../../src/runtime/worktree-retention.js');
 const options={gitClient:f.gitClient,now:()=>Date.parse(NOW)+8*86400000};
 assert.equal((await sweepWorktreeRetention(f.root,options)).status,'disabled');
 assert.equal((await configureWorktreeRetention({projectRoot:f.root,retention:'7d'},{confirm:async()=>false})).status,'declined');
 assert.equal((await sweepWorktreeRetention(f.root,options)).status,'disabled');
 await configureWorktreeRetention({projectRoot:f.root,retention:'7d'},{confirm:async policy=>{assert.deepEqual(policy.roots,['node_modules','.rivet-deps']);return true;}});
 assert.equal((await sweepWorktreeRetention(f.root,{...options,now:()=>Date.parse(NOW)+6*86400000})).removed.length,0);
 await configureWorktreeRetention({projectRoot:f.root,retention:'off'});
 assert.equal((await sweepWorktreeRetention(f.root,options)).status,'disabled');
 await configureWorktreeRetention({projectRoot:f.root,retention:'7d'},{confirm:async()=>true});
 const refs=await git(f.root,'show-ref');const result=await sweepWorktreeRetention(f.root,options);assert.equal(result.removed.length,1,JSON.stringify(result));assert.equal(await git(f.root,'show-ref'),refs);
});

test('retention configuration drift suspends removal and CLI approval is separate from one-time cleanup',async t=>{
 const f=await fixture(t);const {configureWorktreeRetention,sweepWorktreeRetention}=await import('../../src/runtime/worktree-retention.js');
 const output={log(){},error(){},json(){}};
 const options={resolveCommandExecutable:async()=>realpath('/usr/bin/git'),cwd:()=>f.root,output,terminalIsInteractive:()=>true,confirmWorktreeCleanup:async()=>{throw Error('wrong approval');},confirmWorktreeRetention:async()=>false};
 assert.equal(await main(['task','cleanup','--retention=7d'],options),0);
 assert.notEqual(await main(['task','cleanup','--retention=7d'],{...options,terminalIsInteractive:()=>false}),0);
 assert.equal(await main(['task','cleanup','--retention=7d'],{...options,confirmWorktreeRetention:async()=>true}),0);
 const file=join(f.root,'.rivet','orchestration.yaml'),policy=YAML.parse(await readFile(file,'utf8'));policy.executionPolicy.sessions.maxMinutes+=1;await writeFile(file,YAML.stringify(policy));
 const result=await sweepWorktreeRetention(f.root,{gitClient:f.gitClient,now:()=>Date.parse(NOW)+8*86400000});assert.equal(result.removed.length,0);assert.equal(result.status,'retained');assert.ok((await lstat(f.path)).isDirectory());
 assert.equal(await main(['task','cleanup','--retention=off'],{...options,terminalIsInteractive:()=>false}),0);
 await assert.rejects(configureWorktreeRetention({projectRoot:f.root,retention:'0d'},{confirm:async()=>true}));
});

test('application status never runs retention but foreground host execution does',async t=>{
 const f=await fixture(t);const {configureWorktreeRetention}=await import('../../src/runtime/worktree-retention.js');const {createRivetApplication}=await import('../../src/runtime/application.js');
 await configureWorktreeRetention({projectRoot:f.root,retention:'7d'},{confirm:async()=>true});
 const app=createRivetApplication({env:{...process.env,RIVET_GIT_EXECUTABLE:await realpath('/usr/bin/git')},now:()=>new Date(Date.parse(NOW)+8*86400000).toISOString()});
 await app.work.status({project:f.root,runId:f.runId});assert.ok((await lstat(f.path)).isDirectory());
 // This task is terminal, so preparation itself can reject after the foreground sweep.
 await app.work.prepare({project:f.root,runId:f.runId,expectedRunVersion:f.run.version}).catch(()=>{});
 await assert.rejects(lstat(f.path),{code:'ENOENT'});
});

test('bounded cleanup makes progress over successive approvals and never repeats old removals',async t=>{
 const f=await fixture(t,{parallel:true});
 let preview=await previewTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId},{gitClient:f.gitClient});assert.equal(preview.checkouts.filter(v=>v.eligible).length,2);
 let result=await applyTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId,preview,approval:await confirmTaskWorktreeCleanup(preview,async()=>true,{maxRemovals:1})},{gitClient:f.gitClient});assert.equal(result.checkouts.filter(v=>v.status==='removed').length,1);
 preview=await previewTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId},{gitClient:f.gitClient});assert.equal(preview.checkouts.filter(v=>v.eligible).length,1);
 result=await applyTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId,preview,approval:await confirmTaskWorktreeCleanup(preview,async()=>true,{maxRemovals:1})},{gitClient:f.gitClient});assert.equal(result.checkouts.filter(v=>v.status==='removed').length,1);
 const {configureWorktreeRetention,sweepWorktreeRetention}=await import('../../src/runtime/worktree-retention.js');await configureWorktreeRetention({projectRoot:f.root,retention:'1d'},{confirm:async()=>true});
 assert.deepEqual((await sweepWorktreeRetention(f.root,{gitClient:f.gitClient,now:()=>Date.parse(NOW)+8*86400000})).removed,[]);
});

test('partial artifact deletion resumes only the approved inode and preserves replacement content',async t=>{
 const f=await fixture(t);const deps=await import('../../src/runtime/legacy-dependency-directory.js');
 await git(f.root,'config','core.excludesFile',join(f.root,'.git','cleanup-ignore'));await writeFile(join(f.root,'.git','cleanup-ignore'),'node_modules/\n');
 const owner=await deps.beginLegacyDependencyInstall(f.path);await mkdir(join(f.path,'node_modules'));await writeFile(join(f.path,'node_modules','file'),'rebuild');await deps.finishLegacyDependencyInstall(owner);
 let preview=await previewTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId},{gitClient:f.gitClient});let calls=0;
 await assert.rejects(applyTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId,preview,approval:await confirmTaskWorktreeCleanup(preview,async()=>true,{beforeRemoval:async()=>{if(++calls===3)throw Error('stop after artifact');}})},{gitClient:f.gitClient}),/stop after artifact/);
 await assert.rejects(lstat(join(f.path,'node_modules')),{code:'ENOENT'});
 await mkdir(join(f.path,'node_modules'));await writeFile(join(f.path,'node_modules','foreign'),'keep');
 preview=await previewTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId},{gitClient:f.gitClient});assert.equal(preview.checkouts[0].eligible,false);assert.equal(await readFile(join(f.path,'node_modules','foreign'),'utf8'),'keep');
 await rm(join(f.path,'node_modules'),{recursive:true});
 preview=await previewTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId},{gitClient:f.gitClient});assert.equal(preview.checkouts[0].eligible,true);
 await applyTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId,preview,approval:await confirmTaskWorktreeCleanup(preview,async()=>true)},{gitClient:f.gitClient});await assert.rejects(lstat(f.path),{code:'ENOENT'});
});

test('fresh approved portable install is reclaimable with its protected receipt',async t=>{
 const f=await fixture(t);const {bootstrapWorktreeDependencies}=await import('../../src/runtime/worktree-bootstrap.js');
 const input={projectRoot:f.root,worktreePath:f.path,expectedCommit:await git(f.path,'rev-parse','HEAD'),expectedBranch:await git(f.path,'branch','--show-current'),dependencies:{inputs:['.gitignore'],provides:[],steps:[{cwd:'.',argv:['node','-e','require("node:fs").writeFileSync(".rivet-deps/cache", "regenerable")']}]}};
 assert.equal((await bootstrapWorktreeDependencies(input,{gitClient:f.gitClient,confirm:async()=>true,resolveCommandExecutable:async()=>realpath(process.execPath)})).status,'ready');
 const preview=await previewTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId},{gitClient:f.gitClient});assert.equal(preview.checkouts[0].eligible,true);assert.equal(preview.checkouts[0].artifacts[0].name,'.rivet-deps');
 await applyTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId,preview,approval:await confirmTaskWorktreeCleanup(preview,async()=>true)},{gitClient:f.gitClient});await assert.rejects(lstat(f.path),{code:'ENOENT'});
});

test('retention makes bounded progress on a task with more than eight Worker checkouts',async t=>{
 const f=await fixture(t,{parallel:9});const {configureWorktreeRetention,sweepWorktreeRetention}=await import('../../src/runtime/worktree-retention.js');
 const initial=await previewTaskWorktreeCleanup({projectRoot:f.root,runId:f.runId},{gitClient:f.gitClient});assert.equal(initial.checkouts.filter(v=>v.eligible).length,9);
 await configureWorktreeRetention({projectRoot:f.root,retention:'1d'},{confirm:async()=>true});const seen=new Set();
 // Count bounded progress independently of Git throughput; cutoff is tested separately.
 t.mock.method(Date,'now',()=>Date.parse(NOW)+8*86400000);
 for(let i=0;i<10&&seen.size<9;i++){
  const result=await sweepWorktreeRetention(f.root,{gitClient:f.gitClient,now:()=>Date.parse(NOW)+8*86400000});assert.ok(result.removed.length<=8);assert.ok(result.removed.length>0,JSON.stringify(result));
  for(const path of result.removed){assert.equal(seen.has(path),false);seen.add(path);}
 }
 assert.equal(seen.size,9);
 assert.deepEqual((await sweepWorktreeRetention(f.root,{gitClient:f.gitClient,now:()=>Date.parse(NOW)+8*86400000})).removed,[]);
});


test('retention keeps checkouts when preparation exhausts the foreground time budget',async t=>{
 const f=await fixture(t);
 const {configureWorktreeRetention,sweepWorktreeRetention}=await import('../../src/runtime/worktree-retention.js');
 await configureWorktreeRetention({projectRoot:f.root,retention:'1d'},{confirm:async()=>true});
 let clock=Date.parse(NOW)+8*86400000;
 t.mock.method(Date,'now',()=>clock);
 // Age eligibility is checked after entering the sweep, before preview/removal.
 // Advance the wall clock at that boundary to exercise the pre-removal guard.
 const result=await sweepWorktreeRetention(f.root,{gitClient:f.gitClient,now:()=>{clock+=10001;return clock;}});
 assert.deepEqual(result.removed,[]);
 assert.ok(result.diagnostics.some(message=>message.includes('foreground time limit')),JSON.stringify(result));
 assert.ok((await lstat(f.path)).isDirectory());
});
