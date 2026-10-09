import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { assertUpdateTasksIdle } from '../../src/update/task-safety.js';
import { createWorkRequest } from '../../src/work-request/contract.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'rivet-update-state-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  await mkdir(join(root,'.git'));
  const runner = async (_command,args) => { assert.deepEqual(args,['rev-parse','--git-common-dir']); return {code:0,stdout:join(root,'.git')}; };
  return {root,options:{runner,env:process.env}};
}
async function record(root, path, data) {
  const directory=join(root,'.git','rivet',path);
  await mkdir(directory,{recursive:true,mode:0o700});
  await writeFile(join(directory,path.startsWith('feature-runs/')?'run.json':'snapshot.json'),JSON.stringify({version:1,data})+'\n',{mode:0o600});
  return directory;
}
function feature(status) {
  const at='2026-10-09T00:00:00.000Z';
  const workRequest=createWorkRequest({source:{kind:'inline',ref:'inline'},title:'Test',description:'Test update',acceptanceCriteria:['Works'],contextRefs:[],capturedAt:at});
  const featurePlan={workRequestDigest:workRequest.digest};
  const proposalDigest=createHash('sha256').update(JSON.stringify(featurePlan)).digest('hex');
  return {schemaVersion:1,runId:'sample',status,workRequest,featurePlan,proposalDigest,tracker:null,activation:status==='proposed'?null:{approverId:'owner',approvedAt:at,requestDigest:workRequest.digest,proposalDigest},runtimeRefs:[],evidenceRefs:[],createdAt:at,updatedAt:at};
}
test('checking a repository without state creates nothing',async t=>{
 const {root,options}=await fixture(t); await assertUpdateTasksIdle(root,options); assert.deepEqual(await readdir(join(root,'.git')),[]);
});
for(const status of ['proposed','approved','running','blocked','awaiting-final-approval']) test(`blocks ${status} feature task without writing`,async t=>{
 const {root,options}=await fixture(t); const dir=await record(root,'feature-runs/sample',feature(status)); const before=await readFile(join(dir,'run.json')); await assert.rejects(assertUpdateTasksIdle(root,options),/unfinished Rivet tasks/); assert.deepEqual(await readdir(dir),['run.json']); assert.deepEqual(await readFile(join(dir,'run.json')),before);
});
for(const status of ['completed','cancelled']) test(`allows ${status} feature task`,async t=>{
 const {root,options}=await fixture(t); await record(root,'feature-runs/sample',feature(status)); await assertUpdateTasksIdle(root,options);
});
test('rejects corrupt completed feature state',async t=>{
 const {root,options}=await fixture(t); await record(root,'feature-runs/sample',{status:'completed'}); await assert.rejects(assertUpdateTasksIdle(root,options),/cannot safely inspect/);
});
test('rejects symlinked state root',async t=>{
 const {root,options}=await fixture(t); const elsewhere=join(root,'elsewhere'); await mkdir(elsewhere,{mode:0o700}); await symlink(elsewhere,join(root,'.git','rivet')); await assert.rejects(assertUpdateTasksIdle(root,options),/cannot safely inspect/);
});
test('does not trust a terminal label on corrupt orchestration state',async t=>{
 const {root,options}=await fixture(t); await record(root,'sample',{terminal:'completed'}); await assert.rejects(assertUpdateTasksIdle(root,options),/cannot safely inspect/);
});
test('rejects an existing lock even on completed feature state without removing it',async t=>{
 const {root,options}=await fixture(t); const dir=await record(root,'feature-runs/sample',feature('completed')); await writeFile(join(dir,'run.lock'),'busy',{mode:0o600}); await assert.rejects(assertUpdateTasksIdle(root,options),/in use/); assert.equal(await readFile(join(dir,'run.lock'),'utf8'),'busy');
});
for(const terminal of [null,'completed','cancelled','blocked']) test(`inspects orchestration state (${terminal})`,async t=>{
 const {root,options}=await fixture(t);
 const graph=JSON.parse(await readFile(new URL('../fixtures/graphs/parallel-fan-in.json',import.meta.url),'utf8'));
 if(terminal){graph.status=terminal;for(const node of graph.nodes)node.status=terminal;}
 await record(root,'sample',{schemaVersion:1,version:0,activated:true,terminal,graph,events:[],limits:{tokens:1000000,costUsd:100,retries:1}});
 if(['completed','cancelled'].includes(terminal))await assertUpdateTasksIdle(root,options);
 else await assert.rejects(assertUpdateTasksIdle(root,options),/unfinished Rivet tasks/);
});
test('fails closed when Git common directory lookup fails',async t=>{
 const {root}=await fixture(t);await assert.rejects(assertUpdateTasksIdle(root,{runner:async()=>({code:1,stdout:''}),env:process.env}),/cannot safely inspect/);
});
test('does not skip a feature directory without its snapshot',async t=>{
 const {root,options}=await fixture(t);await mkdir(join(root,'.git','rivet','feature-runs','sample'),{recursive:true,mode:0o700});await assert.rejects(assertUpdateTasksIdle(root,options),/cannot safely inspect/);
});
for(const mode of ['complete','context','pending','corrupt']) test(`saved PR review ${mode} is distinguished from runtime state`,async t=>{
 const {root,options}=await fixture(t),url='https://github.com/example/project/pull/1';
 const digest=value=>createHash('sha256').update(value).digest('hex');
 const diff='diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n';
 const snapshot={url,headSha:'a'.repeat(40),baseSha:'b'.repeat(40),diffDigest:digest(diff),diff};
 const report={url,headSha:snapshot.headSha,baseSha:snapshot.baseSha,diffDigest:snapshot.diffDigest,summary:'No findings.',findings:[],limitations:['No tests run.']};
 await record(root,`pr-review-${digest(url).slice(0,32)}`,{snapshot:mode==='corrupt'?{...snapshot,diffDigest:'bad'}:snapshot,report:mode==='context'?null:report,publication:mode==='pending'?{status:'pending'}:null});
 if(mode==='complete')await assertUpdateTasksIdle(root,options);else await assert.rejects(assertUpdateTasksIdle(root,options),mode==='corrupt'?/cannot safely inspect/:/unfinished Rivet tasks/);
});
