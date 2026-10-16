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
 const policyPath=join(root,'.rivet','orchestration.yaml');const policy=YAML.parse(await readFile(policyPath,'utf8'));policy.executionPolicy=managedPolicy();if(parallel)for(const role of policy.roles)if(['worker','manager'].includes(role.kind))role.capacity=2;await writeFile(policyPath,YAML.stringify(policy));
 await writeFile(join(root,'.gitignore'),'ignored/\n');await git(root,'init','-q','-b','main');await git(root,'add','.');await git(root,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture');
 const gitClient=await createGitClient({gitExecutable:await realpath('/usr/bin/git')});const workflow=createFeatureWorkflow({gitClient,now:()=>NOW,protocolsFor:async()=>[],planningClientFor:async()=>{throw Error('no provider');},executeFeature:async()=>{throw Error('no provider');}});
 const proposal=await workflow.propose({project:root,source:{kind:'inline',value:'# Add agenda\n\n## Acceptance criteria\n\n- Add agenda.\n'},client:'host',decomposition:{schemaVersion:1,kind:'agilno.feature-decomposition',workItems:parallel?['one','two'].map(id=>({id,dependencies:[],objective:`Add ${id}.`,ownedPaths:[`${id}.js`],acceptanceCriterionIndexes:[1]})):[{objective:'Add agenda.',ownedPaths:['agenda.js'],acceptanceCriterionIndexes:[1]}]}});
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
