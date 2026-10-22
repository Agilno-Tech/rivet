import {createHash} from 'node:crypto';
import {lstat,realpath} from 'node:fs/promises';
import {loadProjectConfig} from '../config/load.js';
import {resolveCleanupRetentionPaths,listExistingFeatureRunPaths} from '../state/paths.js';
import {acquireLock} from '../state/lock.js';
import {createSnapshotStore,readSnapshotWithoutLock} from '../state/snapshot-store.js';
import {createFeatureRunStore} from '../feature/run-store.js';
import {previewTaskWorktreeCleanup,confirmTaskWorktreeCleanup,applyTaskWorktreeCleanup,taskCleanupCompleted} from '../git/worktree-cleanup.js';

const roots=Object.freeze(['node_modules','.rivet-deps']);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminal=run=>['completed','cancelled'].includes(run.status);
async function identity(projectRoot,paths) {
 const stat=await lstat(projectRoot,{bigint:true});
 if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(projectRoot)!==projectRoot)throw Error('Cleanup retention requires the canonical project directory.');
 return {projectRoot,rootIdentity:`${stat.dev}:${stat.ino}`,gitCommonDir:paths.gitCommonDir,configurationDigest:hash(await loadProjectConfig(projectRoot))};
}
export async function configureWorktreeRetention({projectRoot,retention},{confirm}={}) {
 if(retention!=='off'&&!/^(?:[1-9]|[1-9][0-9]|[12][0-9]{2}|3[0-5][0-9]|36[0-5])d$/.test(retention))throw Error('Use --retention=1d through 365d, or --retention=off.');
 const paths=await resolveCleanupRetentionPaths(projectRoot),lock=await acquireLock(paths.runtimeLockPath);
 try {
  const store=createSnapshotStore(paths),saved=await store.read();
  if(retention==='off') {await store.write({version:1,enabled:false},{expectedVersion:saved?.version??0});return {status:'disabled'};}
  const policy={version:1,enabled:true,...await identity(projectRoot,paths),days:Number(retention.slice(0,-1)),roots:[...roots]};
  if(typeof confirm!=='function'||await confirm(structuredClone(policy))!==true)return {status:'declined'};
  if(hash(await identity(projectRoot,paths))!==hash(Object.fromEntries(['projectRoot','rootIdentity','gitCommonDir','configurationDigest'].map(k=>[k,policy[k]]))))throw Error('Project changed during retention approval.');
  await store.write(policy,{expectedVersion:saved?.version??0});return {status:'enabled',days:policy.days};
 }finally{await lock.release();}
}

// Foreground work only: no polling daemon, no status side effects, no stale-lock stealing.
export async function sweepWorktreeRetention(projectRoot,{gitClient,now=()=>Date.now(),signal}={}) {
 const diagnostics=[],removed=[];
 const paths=await resolveCleanupRetentionPaths(projectRoot,{existing:true});
 if(!paths)return {status:'disabled',removed,diagnostics};
 const initial=await readSnapshotWithoutLock(paths);
 if(!initial?.data.enabled)return {status:'disabled',removed,diagnostics};
 let lock;
 try {lock=await acquireLock(paths.runtimeLockPath);}catch{return {status:'retained',removed,diagnostics:['Cleanup retention is busy; checkouts retained.']};}
 const started=Date.now();
 try {
  const policy=(await readSnapshotWithoutLock(paths))?.data;
  const validate=async()=>{
   const current=await readSnapshotWithoutLock(paths);
   if(!current?.data.enabled||hash(current.data)!==hash(policy))throw Error('Cleanup retention approval changed.');
   if(policy.version!==1||!Number.isInteger(policy.days)||policy.days<1||policy.days>365||hash(policy.roots)!==hash(roots))throw Error('Cleanup retention approval is invalid.');
   const observed=await identity(projectRoot,paths);
   if(Object.entries(observed).some(([key,value])=>policy[key]!==value))throw Error('Cleanup retention suspended: project or configuration changed; approve the policy again.');
  };
  await validate();
  const runs=[];
  for(const runPaths of await listExistingFeatureRunPaths(projectRoot)) {
   const run=await createFeatureRunStore(runPaths).readOnly();
   if(run&&terminal(run)&&Number.isFinite(Date.parse(run.updatedAt)))runs.push({run,runPaths});
  }
  runs.sort((a,b)=>Date.parse(a.run.updatedAt)-Date.parse(b.run.updatedAt));
  let considered=0,attempted=0;
  for(const {run,runPaths} of runs) {
   if(considered>=4||attempted>=8||Date.now()-started>=10000)break;
   signal?.throwIfAborted();
   const eligibleAge=value=>terminal(value)&&Number.isFinite(Date.parse(value.updatedAt))&&Number(now())-Date.parse(value.updatedAt)>=policy.days*86400000;
   if(!eligibleAge(run))continue;
   try {
    if(await taskCleanupCompleted(projectRoot,run))continue;
    const preview=await previewTaskWorktreeCleanup({projectRoot,runId:run.runId},{gitClient});
    const count=preview.checkouts.filter(v=>v.eligible).length;
    if(!count){diagnostics.push(`Cleanup retained task ${run.runId}: no eligible checkout within the foreground limit.`);continue;}
    const allowance=Math.min(count,8-attempted);
    considered++;
    const guard=async()=>{
     signal?.throwIfAborted();await validate();
     const latest=await createFeatureRunStore(runPaths).readOnly();
     if(!latest||!eligibleAge(latest)||latest.version!==run.version)throw Error('Cleanup retention task age or state changed.');
     if(Date.now()-started>=10000)throw Error('Cleanup retention foreground time limit reached.');
    };
    const approval=await confirmTaskWorktreeCleanup(preview,async()=>{await guard();return true;},{beforeRemoval:guard,maxRemovals:allowance});
    attempted+=allowance;
    const result=await applyTaskWorktreeCleanup({projectRoot,runId:run.runId,preview,approval},{gitClient});
    for(const item of result.checkouts)if(item.status==='removed'&&preview.checkouts.some(v=>v.path===item.path&&v.eligible))removed.push(item.path);
   }catch(error){removed.push(...(error.cleanupRemoved??[]));diagnostics.push(`Cleanup retained task ${run.runId}: ${error.code==='ERR_STATE_LOCKED'?'owner operation is busy':error.message}`);}
  }
  return {status:'complete',removed,diagnostics};
 }catch(error){diagnostics.push(error.message);return {status:'retained',removed,diagnostics};}
 finally{await lock.release();}
}
