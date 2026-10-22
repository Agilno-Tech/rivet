import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {resolveStatePaths,resolveExistingStatePaths,integrationCandidatePaths} from '../state/paths.js';
import {createSnapshotStore,readSnapshotWithoutLock} from '../state/snapshot-store.js';
import {acquireLock,LockBusyError} from '../state/lock.js';
import {setTimeout as delay} from 'node:timers/promises';
import {verificationPrivateKey} from './verification-queue.js';
import {privateDigest} from './verification-identity.js';

const leases=new WeakMap();
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminal=new Set(['pass','fail','blocked']);
// Logs are evidence for inspection, never durable ownership state. Bound each
// diagnostic string while retaining the tail where command failures appear.
function boundedEvidence(value,key='') {
 if(typeof value==='string'&&['output','stdout','stderr','reason','failure'].includes(key)&&value.length>4096)return '[earlier output omitted]\n'+value.slice(-4096);
 if(Array.isArray(value))return value.map(item=>boundedEvidence(item,key));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,boundedEvidence(item,name)]));
 return value;
}
function compact(batch) {
 const result={...batch};delete result.checks;delete result.combined;delete result.diagnostics;
 if(terminal.has(batch.status)) {
  result.members=batch.members.map(({runId,identity,compatibility})=>({runId,identity,compatibility}));
  delete result.candidate;delete result.dependencyTarget;delete result.dependenciesCompleted;
 }
 return result;
}
function validate(snapshot) {
 const state=snapshot?.data??{pending:[],batches:[]};
 if(!Array.isArray(state.pending)||!Array.isArray(state.batches)||state.pending.length>128||state.batches.length>128)throw new Error('Invalid batch queue');
 for(const member of [...state.pending,...state.batches.flatMap(b=>b.members??[])]) {
  if(!member||typeof member.runId!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(member.runId)
   ||typeof member.identity!=='string'||member.identity.length>128||typeof member.compatibility!=='string'||member.compatibility.length>128)throw new Error('Invalid batch member');
 }
 for(const batch of state.batches) {
  if(!/^batch-[a-f0-9-]{36}$/.test(batch.id)||!Array.isArray(batch.members)||batch.members.length<1||batch.members.length>5
   ||!['running','pass','fail','blocked','dependencies-needed'].includes(batch.status)||typeof batch.owner!=='string')throw new Error('Invalid batch record');
 }
 return state;
}
async function reportPathsFor(paths,hash) {
 if(typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))throw new Error('Invalid batch report identity');
 return integrationCandidatePaths(paths,'report-'+hash.slice(0,56));
}
async function readReport(paths,hash) {
 const reportPaths=await reportPathsFor(paths,hash);
 const saved=await readSnapshotWithoutLock(reportPaths);
 if(!saved||digest(saved.data)!==hash)throw new Error('Batch report changed');
 return {data:saved.data,path:reportPaths.snapshotPath};
}
export async function batchForRun(projectRoot,runId) {
 const paths=await resolveExistingStatePaths(projectRoot,'verification-batches');if(!paths)return null;
 const snapshot=await readSnapshotWithoutLock(paths);const state=validate(snapshot);
 if(snapshot) {const key=await verificationPrivateKey(paths,{existing:true});const {integrity,...body}=state;if(integrity!==privateDigest(key,body))throw new Error('Batch queue integrity changed');}
 if(state.pending.some(m=>m.runId===runId))return {status:'queued'};
 const batch=state.batches.findLast(b=>b.members.some(m=>m.runId===runId));
 if(!batch)return state.pending.some(m=>m.runId===runId)?{status:'queued'}:null;
 const report=await readReport(paths,batch.reportDigest);
 return {...report.data,reportPath:report.path};
}
export async function openBatchQueue(projectRoot) {
 const paths=await resolveStatePaths(projectRoot,'verification-batches');
 const key=await verificationPrivateKey(paths);
 const store=createSnapshotStore(paths,{environment:{}});
 async function transaction(fn) {
  let lock;for(let attempt=0;attempt<100;attempt++) {
   try {lock=await acquireLock(join(paths.instanceDir,'queue.lock'));break;}
   catch(error) {if(!(error instanceof LockBusyError))throw error;await delay(20);}
  }
  if(!lock)throw new Error('Batch queue is busy');
  try {const snapshot=await store.read();const state=validate(snapshot);
   if(snapshot) {const {integrity,...body}=state;if(integrity!==privateDigest(key,body))throw new Error('Batch queue integrity changed');}
   const result=await fn(state);
   while(Buffer.byteLength(JSON.stringify(state))>2*1024*1024) {
    const old=state.batches.findIndex(batch=>terminal.has(batch.status));
    if(old<0)throw new Error('Batch queue data budget exhausted');state.batches.splice(old,1);
   }
   const {integrity,...body}=state;state.integrity=privateDigest(key,body);
   await store.write(state,{expectedVersion:snapshot?.version??0,environment:{}});return result;
  }finally{await lock.release();}
 }
 async function publish(batch,report) {
  const previous=batch.reportDigest?await readReport(paths,batch.reportDigest):null;
  const {reportDigest,...record}=batch;
  // Publish immutable content first. A failed index commit leaves its prior
  // report readable and the new report as harmless retained evidence.
  const data=boundedEvidence({...previous?.data,...record,...report,scope:'combined-candidate'});
  if(Buffer.byteLength(JSON.stringify(data))>3*1024*1024)throw new Error('Batch report data budget exhausted');
  const hash=digest(data),reportPaths=await reportPathsFor(paths,hash);
  const reports=createSnapshotStore(reportPaths,{environment:{}});
  const existing=await reports.read();
  if(existing) {
   if(digest(existing.data)!==hash)throw new Error('Batch report address collision');
  }else await reports.write(data,{expectedVersion:0,environment:{}});
  batch.reportDigest=hash;
 }
 return Object.freeze({paths,fingerprint:value=>privateDigest(key,value),
  forRun:runId=>batchForRun(projectRoot,runId),
  async hasPending(compatibility) {
   const snapshot=await store.read();const state=validate(snapshot);
   if(snapshot) {const {integrity,...body}=state;if(integrity!==privateDigest(key,body))throw new Error('Batch queue integrity changed');}
   return state.pending.some(m=>m.compatibility===compatibility);
  },
  async enqueue(members) {return transaction(async state=>{
   for(const member of members) {
    const live=state.batches.find(b=>!terminal.has(b.status)&&b.members.some(m=>m.runId===member.runId));
    if(live) {
     if(live.members.some(m=>m.identity===member.identity))continue;
     if(live.status==='running')throw new Error('Frozen batch participant changed');
     live.status='blocked';live.reason='An explicitly re-enrolled participant changed while dependencies were pending.';
     await publish(live,{});state.batches[state.batches.indexOf(live)]=compact(live);
    }
    const pending=state.pending.find(m=>m.runId===member.runId);
    if(pending) {
     if(pending.identity!==member.identity) {
      const index=state.pending.indexOf(pending);
      state.pending[index]={...member,queuedAt:Date.now(),supersededIdentity:pending.identity};
     }
     continue;
    }
    if(state.pending.length>=128)throw new Error('Batch queue is full');
    state.pending.push({...member,queuedAt:Date.now()});
   }
  });},
  async claim(policy,selected=[],compatibility=null) {return transaction(async state=>{
   // A running owner is never reclaimed on age or PID observations.
   if(state.batches.some(b=>b.status==='running'))return null;
   let batch=state.batches.find(b=>b.status==='dependencies-needed'&&b.members.some(m=>selected.includes(m.runId)));
   if(!batch) {
    const first=state.pending.find(m=>selected.length===0||selected.includes(m.runId)||m.compatibility===compatibility);if(!first)return null;
    policy=first.policy??policy;
    const members=state.pending.filter(m=>m.compatibility===first.compatibility).slice(0,policy.maxTasks);
    if(members.length<policy.maxTasks&&Date.now()-members[0].queuedAt<policy.waitMs)return null;
    if(state.batches.length>=128) {const old=state.batches.findIndex(b=>terminal.has(b.status));if(old<0)throw new Error('Batch index is full');state.batches.splice(old,1);}
    batch={id:'batch-'+randomUUID(),members,status:'running',createdAt:Date.now(),scope:'combined-candidate'};
    state.pending=state.pending.filter(m=>!members.includes(m));state.batches.push(batch);
   }
   batch.status='running';batch.owner=randomUUID();
   await publish(batch,{});
   const capability=Object.freeze(structuredClone(batch));leases.set(capability,batch.owner);return capability;
  });},
  async completeDependencies(id,expectedOwner,manifestDigest) {return transaction(async state=>{
   const batch=state.batches.find(b=>b.id===id);
   if(!batch||batch.status!=='dependencies-needed'||batch.owner!==expectedOwner||batch.candidate?.digest!==manifestDigest)throw new Error('Batch dependency state changed');
   batch.dependenciesCompleted=[...new Set([...(batch.dependenciesCompleted??[]),manifestDigest])];await publish(batch,{});
  });},
  async finish(capability,report) {await transaction(async state=>{
   const batch=state.batches.find(b=>b.id===capability.id);
   if(!batch||batch.owner!==leases.get(capability)||batch.status!=='running')throw new Error('Batch ownership changed');
   if(!['pass','fail','blocked','dependencies-needed'].includes(report.status))throw new Error('Invalid batch result');
   Object.assign(batch,report);await publish(batch,report);
   state.batches[state.batches.indexOf(batch)]=compact(batch);
  });leases.delete(capability);},
 });
}
