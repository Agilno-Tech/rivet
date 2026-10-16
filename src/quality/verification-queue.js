import { constants } from 'node:fs';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveStatePaths, verifyResolvedStatePaths } from '../state/paths.js';
import { acquireLock, LockBusyError } from '../state/lock.js';
import { createSnapshotStore } from '../state/snapshot-store.js';
import { assertVerificationCompletion } from './runner.js';
import { privateDigest, verificationIdentity } from './verification-identity.js';

export class VerificationBlockedError extends Error {
  constructor(reason='owner-unresolved') { super(`Verification reuse blocked: ${reason}`);this.code='ERR_VERIFICATION_BLOCKED';this.reason=reason; }
}
export class VerificationPendingError extends Error {
  constructor() {
    super('Verification pending: owner-unresolved');
    this.code='ERR_VERIFICATION_PENDING';
    this.reason='owner-unresolved';
    this.queued=true;
    this.claim=Object.freeze({reason:'verification-running'});
  }
}
export async function verificationPrivateKey(paths,{existing=false}={}) {
  await verifyResolvedStatePaths(paths);
  const path=join(paths.instanceDir,'identity-key');
  let initialization;
  for(let attempt=0;!existing&&attempt<100;attempt++) {
    try { initialization=await acquireLock(join(paths.instanceDir,'identity.lock'));break; }
    catch(error) { if(!(error instanceof LockBusyError))throw error;await delay(20); }
  }
  if(!existing&&!initialization)throw new VerificationBlockedError('identity-key-busy');
  let key;
  try {
  if(!existing)try {
    const handle=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{await handle.writeFile(randomBytes(32));await handle.sync();}finally{await handle.close();}
  } catch(error){if(error.code!=='EEXIST')throw error;}
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const before=await handle.stat();
    if(!before.isFile() || before.nlink!==1 || before.size!==32 || (before.mode&0o777)!==0o600)throw new VerificationBlockedError('unsafe-identity-key');
    key=await handle.readFile();
    const after=await lstat(path);
    if(after.dev!==before.dev || after.ino!==before.ino || after.size!==32)throw new VerificationBlockedError('changed-identity-key');
  }finally{await handle.close();}
  } finally { await initialization?.release(); }
  return key;
}

export async function openVerificationQueue(projectRoot) {
  const paths=await resolveStatePaths(projectRoot,'verification-reuse');
  const key=await verificationPrivateKey(paths);
  const store=createSnapshotStore(paths,{environment:{}});
  function validate(snapshot) {
    if(!snapshot)return [];
    const entries=snapshot.data?.entries;
    if(!Array.isArray(entries) || entries.length>32)throw new VerificationBlockedError('corrupt-state');
    for(const entry of entries) {
      if(!entry || !/^[a-f0-9]{64}$/.test(entry.identity) || !['queued','running','completed','failed','blocked'].includes(entry.state)
        || !Number.isSafeInteger(entry.generation) || entry.generation<1 || typeof entry.owner!=='string')throw new VerificationBlockedError('corrupt-state');
      const {integrity,...record}=entry;
      const expected=privateDigest(key,['runner-completion-v2',record]);
      if(typeof integrity!=='string' || integrity.length!==64 || !timingSafeEqual(Buffer.from(expected),Buffer.from(integrity)))throw new VerificationBlockedError('corrupt-state');
    }
    return entries;
  }
  async function update(identity,operation) {
    for(let attempt=0;attempt<100;attempt++) {
      const snapshot=await store.read(); const entries=validate(snapshot);
      const index=entries.findIndex(e=>e.identity===identity);
      const next=operation(index<0?null:entries[index]);
      if(!next)return index<0?null:entries[index];
      if(index<0 && entries.length>=32) {
        const removable=entries.findIndex(e=>['completed','failed'].includes(e.state));
        if(removable<0)throw new VerificationBlockedError('queue-full');
        entries.splice(removable,1);
      }
      const signed={...next,integrity:privateDigest(key,['runner-completion-v2',next])};
      if(index>=0)entries[index]=signed;else entries.push(signed);
      try{await store.write({entries},{expectedVersion:snapshot?.version??0,environment:{}});return signed;}
      catch(error){if(error.message!=='state version conflict')throw error;}
    }
    throw new VerificationBlockedError('queue-contention');
  }
  return Object.freeze({fingerprint: value => verificationIdentity(value,key), async execute(identity,operation,{signal,waitMs=30000}={}) {
    const owner=randomUUID();
    let record=await update(identity,current=>{
      if(current && current.state!=='failed')return null;
      return {identity,generation:(current?.generation??0)+1,owner,state:'queued',pid:process.pid};
    });
    if(record.owner===owner) {
      await update(identity,current=>{const {integrity,...record}=current;return {...record,state:'running'};});
      try {
        if(signal?.aborted)throw new VerificationBlockedError('cancelled');
        const completion=await operation();
        if(completion!==null)assertVerificationCompletion(completion,identity);
        const result=completion===null?null:{timings:completion.gates.map(g=>[g.startedAt,g.endedAt])};
        if(Buffer.byteLength(JSON.stringify(result))>65536)throw new VerificationBlockedError('result-too-large');
        await update(identity,current=>({identity,generation:current.generation,owner,state:result===null?'failed':'completed',pid:process.pid,...(result===null?{}:{result})}));
        return {result,reused:false};
      }catch(error){await update(identity,current=>({identity,generation:current.generation,owner,state:'failed',pid:process.pid}));throw error;}
    }
    const deadline=Date.now()+waitMs;
    while(['queued','running'].includes(record.state)) {
      if(signal?.aborted)throw new VerificationBlockedError('cancelled');
      if(Date.now()>=deadline)throw new VerificationPendingError();
      await delay(50); record=await update(identity,()=>null);
      if(!record)throw new VerificationBlockedError('record-missing');
    }
    if(record.state!=='completed')throw new VerificationBlockedError(record.state);
    return {result:record.result,reused:true};
  }});
}
