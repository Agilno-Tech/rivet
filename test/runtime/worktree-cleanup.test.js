import assert from 'node:assert/strict';
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
import {previewTaskWorktreeCleanup} from '../../src/git/worktree-cleanup.js';
import {main} from '../../src/cli/main.js';
const execFile=promisify(callback), NOW='2029-01-01T00:00:00.000Z';
async function git(root,...args){return (await execFile('/usr/bin/git',['-C',root,...args])).stdout.trim();}
async function fixture(t){
 const parent=await realpath(await mkdtemp(join(tmpdir(),'rivet-cleanup-'))),root=join(parent,'project');
 t.after(()=>rm(parent,{recursive:true,force:true}));await mkdir(root);
 await cp(new URL('../fixtures/config/valid/.rivet/',import.meta.url),join(root,'.rivet'),{recursive:true});
 const policyPath=join(root,'.rivet','orchestration.yaml');const policy=YAML.parse(await readFile(policyPath,'utf8'));policy.executionPolicy=managedPolicy();await writeFile(policyPath,YAML.stringify(policy));
 await writeFile(join(root,'.gitignore'),'ignored/\n');await git(root,'init','-q','-b','main');await git(root,'add','.');await git(root,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture');
 const gitClient=await createGitClient({gitExecutable:await realpath('/usr/bin/git')});const workflow=createFeatureWorkflow({gitClient,now:()=>NOW,protocolsFor:async()=>[],planningClientFor:async()=>{throw Error('no provider');},executeFeature:async()=>{throw Error('no provider');}});
 const proposal=await workflow.propose({project:root,source:{kind:'inline',value:'# Add agenda\n\n## Acceptance criteria\n\n- Add agenda.\n'},client:'host',decomposition:{schemaVersion:1,kind:'agilno.feature-decomposition',workItems:[{objective:'Add agenda.',ownedPaths:['agenda.js'],acceptanceCriterionIndexes:[1]}]}});
 const approved=await workflow.start({project:root,runId:proposal.runId,expectedVersion:proposal.version,proposalDigest:proposal.proposalDigest});
 const execution=createHostExecution({gitClient,now:()=>NOW});const prepared=await execution.prepare({project:root,runId:approved.runId,expectedRunVersion:approved.version});
 const next=await execution.nextAction({project:root,runId:approved.runId,expectedRuntimeVersion:prepared.runtimeVersion});
 const path=JSON.parse(next.action.payload).contract.worktree.path;
 const statePaths=await resolveExistingStatePaths(root,approved.runId),runPaths=await resolveExistingFeatureRunPaths(root,approved.runId);
 const state=JSON.parse(await readFile(statePaths.snapshotPath,'utf8'));const session=state.data.sessions[next.action.nodeId];
 session.writer={source:'host-observation',nativeHandle:'fixture-handle',actorId:'fixture-owner',observedAtMs:Date.parse(NOW),assurance:'host-reported'};
 session.stopReceipt={sessionId:session.id,generation:session.generation,nativeHandle:'fixture-handle',actorId:'fixture-owner',observedAtMs:Date.parse(NOW),status:'stopped',source:'host-observation',assurance:'host-reported'};
 session.phase='completed';state.data.graph.nodes.find(n=>n.id===next.action.nodeId).status='completed';state.data.launchIntents[next.action.nodeId].status='complete';
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
test('task cleanup requires preview, selects completed tasks and rejects apply',async t=>{
 const f=await fixture(t),messages=[];const options={resolveCommandExecutable:async()=>realpath('/usr/bin/git'),cwd:()=>f.root,output:{log:v=>messages.push(v),error:v=>messages.push(v),json(){}}};
 assert.equal(await main(['task','cleanup','--preview'],options),0);assert.ok(messages.some(v=>v.startsWith('Eligible:')));assert.ok(messages.some(v=>v.includes('No checkout')));
 assert.notEqual(await main(['task','cleanup'],options),0);assert.notEqual(await main(['task','cleanup','--apply'],options),0);assert.notEqual(await main(['task','status','--preview'],options),0);
});
