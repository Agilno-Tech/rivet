import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {immutableJson} from '../clients/contract.js';
import {loadProjectConfig} from '../config/load.js';
import {CONFIG_FILES, MAX_CONFIG_FILE_BYTES} from '../config/defaults.js';
import {assertGitClient} from '../git/client.js';
import {assertSelectedProtocolRefs} from '../protocols/project.js';
import {resolveExistingFeatureRunPaths, verifyResolvedStatePaths} from '../state/paths.js';
import {createHostExecution} from './host-execution.js';
import {acquireHostRunLock} from './host-run-lock.js';
import {createFeatureRunStore} from './run-store.js';
import {createFeatureRuntimeState} from './runtime-bridge.js';

export class LocalApprovalError extends Error {
  constructor(reason = 'conflict') {
    const messages = {
      conflict: 'Local application requires unchanged verified evidence, configuration, and clean checkouts. Inspect task status before retrying.',
      interrupted: 'A local application was interrupted. Work is preserved. Inspect the source branch and private approval record; no merge was retried.',
      cancelled: 'Local application was cancelled before the Git update.',
      invalid: 'Local approval input is invalid.',
      configuration: 'Local application requires the four Rivet configuration files committed in the approved baseline and unchanged in both checkouts. Commit intended configuration changes, then create and verify a new reviewed task.',
    };
    super(messages[reason] ?? messages.conflict);
    this.name = 'LocalApprovalError';
    this.code = `ERR_LOCAL_APPROVAL_${reason.toUpperCase()}`;
    this.safeMessage = this.message;
  }
}
function fail(reason) { throw new LocalApprovalError(reason); }
function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function same(a,b) { return a.dev===b.dev && a.ino===b.ino; }
const MAX_RECORD = 64 * 1024;
async function readBounded(path, maximum, privateFile = false) {
  let handle;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink!==1 || before.size>maximum
      || (privateFile && (before.mode & 0o777)!==0o600)) fail();
    handle=await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened=await handle.stat();
    if(!same(before,opened))fail();
    const bytes=Buffer.alloc(maximum+1); let count=0;
    while(count<bytes.length){const result=await handle.read(bytes,count,bytes.length-count,null);if(!result.bytesRead)break;count+=result.bytesRead;}
    const after=await handle.stat();
    if(count>maximum||!same(after,await lstat(path))||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs)fail();
    return bytes.subarray(0,count);
  } finally {await handle?.close();}
}
async function record(paths,name) {
  await verifyResolvedStatePaths(paths);
  try {return JSON.parse((await readBounded(join(paths.runDir,name),MAX_RECORD,true)).toString('utf8'));}
  catch(error){if(error.code==='ENOENT')return null;fail();}
}
// Create once, fsync both file and directory. An interrupted partial write is
// intentionally an inspection boundary; neither a stale lock nor an intent is
// permission to execute a second merge. Private state is a trusted local boundary.
async function writeRecord(paths,name,value) {
  await verifyResolvedStatePaths(paths);
  const data=JSON.stringify(value);
  if(Buffer.byteLength(data)>MAX_RECORD)fail();
  const handle=await open(join(paths.runDir,name),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}
  await verifyResolvedStatePaths(paths);
  const directory=await open(paths.runDir,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{await directory.sync();}finally{await directory.close();}
}

export async function applyVerifiedTask(input) {
  let lock;
  let selectedRunId;
  try {
    if(!input || typeof input!=='object' || Array.isArray(input) || ![Object.prototype,null].includes(Object.getPrototypeOf(input))
      || Reflect.ownKeys(input).some(key=>typeof key!=='string'))fail('invalid');
    const descriptors=Object.getOwnPropertyDescriptors(input);
    if(Object.keys(descriptors).some(key=>!['project','runId','gitClient','confirm','signal'].includes(key)
      || !Object.hasOwn(descriptors[key],'value')))fail('invalid');
    const values=Object.fromEntries(Object.entries(descriptors).map(([key,descriptor])=>[key,descriptor.value]));
    const {project,runId,gitClient,confirm,signal}=values;
    if(typeof project!=='string'||resolve(project)!==project||typeof runId!=='string'
      ||! /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(runId)||runId.length>64||typeof confirm!=='function')fail('invalid');
    selectedRunId=runId;
    assertGitClient(gitClient);
    const cancelled=()=>{if(signal?.aborted)fail('cancelled');};
    cancelled();
    const paths=await resolveExistingFeatureRunPaths(project,runId);if(!paths)fail();
    lock=await acquireHostRunLock(paths);
    const store=createFeatureRunStore(paths);
    const host=createHostExecution({gitClient});
    async function observe() {
      await verifyResolvedStatePaths(paths);
      const status=await host.status({project,runId});
      const {run,verification,checkout,runtime}=status;
      const config=await loadProjectConfig(project);
      createFeatureRuntimeState({config,run});
      assertSelectedProtocolRefs(project,run.workRequest.contextRefs);
      if(!verification||!checkout||!runtime||checkout.status!=='clean'||verification.status!=='pass')fail();
      const source=await gitClient.inspectRepository(project);
      if(source.root!==project||source.dirty||source.detached||source.branch!==config.project.repository.defaultBranch)fail();
      // Require exact baseline configuration bytes, including files hidden from
      // ordinary Git status with assume-unchanged. Policy-changing work needs a
      // separate reviewed delivery flow, not reuse of this local approval.
      const configHashes=[];
      try {
      for(const name of Object.values(CONFIG_FILES)){
        const relative=`.rivet/${name}`;
        const tracked=await gitClient.inspectTrackedFile(project,run.featurePlan.baselineCommit,relative);
        const bytes=await readBounded(join(project,relative),MAX_CONFIG_FILE_BYTES);
        const blob=createHash(tracked.blob.length===40?'sha1':'sha256').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        if(blob!==tracked.blob)fail();
        const integrationBytes=await readBounded(join(checkout.path,relative),MAX_CONFIG_FILE_BYTES);
        if(!bytes.equals(integrationBytes))fail();
        configHashes.push(blob);
      }
      } catch { fail('configuration'); }
      const changed=await gitClient.changedPaths(project,run.featurePlan.baselineCommit,verification.commitSha);
      const selectedPaths=new Set(run.workRequest.contextRefs.filter(ref=>ref.startsWith('protocol:'))
        .map(ref=>`.rivet/protocols/${ref.split(':')[1]}.md`));
      if(changed.some(path=>selectedPaths.has(path)))fail();
      if(changed.length!==verification.changedPathCount||hash(changed)!==hash(verification.changedPaths))fail();
      const evidenceDigest=hash({configHashes,config,proposalDigest:run.proposalDigest,activation:run.activation,
        workRequest:run.workRequest,featurePlan:run.featurePlan,verification,runtime,checkout});
      return {status,source,evidenceDigest};
    }
    let current=await observe();
    const intent=await record(paths,'local-approval-intent.json');
    let receipt=await record(paths,'local-approval-receipt.json');
    const {run}=current.status;
    const preview=immutableJson({runId,targetBranch:current.source.branch,baselineCommit:run.featurePlan.baselineCommit,
      commitSha:current.status.verification.commitSha,integrationPath:current.status.checkout.path,
      changedPaths:current.status.verification.changedPaths,
      checks:current.status.verification.checks.map(({id,status,required,exitCode})=>({id,status,required,exitCode}))});
    const binding={schemaVersion:1,kind:'local-acceptance',runId,runVersion:run.status==='completed'?run.version-1:run.version,
      evidenceDigest:current.evidenceDigest,source:{root:current.source.root,rootIdentity:current.source.rootIdentity,
        gitCommonDir:current.source.gitCommonDir,repositoryId:current.source.repositoryId},preview};
    const identity=hash(binding);
    const reference=`local-acceptance:${identity}`;
    if(intent!==null){
      if(hash(intent)!==hash({...binding,digest:identity}))fail();
      if(current.source.headSha!==preview.commitSha)fail('interrupted');
      if(receipt!==null&&hash(receipt)!==hash({schemaVersion:1,kind:'local-acceptance',intentDigest:identity,commitSha:preview.commitSha}))fail();
      if(run.status==='completed'){
        if(receipt===null||!run.evidenceRefs.includes(reference))fail();
        return immutableJson({status:'completed',commitSha:preview.commitSha,nextAction:'Verified changes are in your local default branch. No push or deployment was performed.'});
      }
      if(!current.status.deliveryReady)fail();
      // Exact durable intent plus the already-observed target permits receipt-only
      // reconciliation. It never authorizes another Git mutation.
    }else{
      if(receipt!==null||run.status!=='awaiting-final-approval'||!current.status.deliveryReady
        ||current.source.headSha!==preview.baselineCommit)fail();
      if(await confirm(preview)!==true)return Object.freeze({status:'declined'});
      cancelled();
      const fresh=await observe();
      if(fresh.status.run.version!==run.version||fresh.evidenceDigest!==current.evidenceDigest
        ||hash(fresh.source)!==hash(current.source)||!fresh.status.deliveryReady)fail();
      await writeRecord(paths,'local-approval-intent.json',{...binding,digest:identity});
      cancelled();
      await gitClient.fastForward(project,{branch:preview.targetBranch,expectedTip:preview.baselineCommit,newTip:preview.commitSha});
      current=await observe();
      if(current.evidenceDigest!==binding.evidenceDigest||current.status.run.version!==run.version
        ||current.source.headSha!==preview.commitSha||!current.status.deliveryReady)fail('interrupted');
    }
    if(receipt===null){
      receipt={schemaVersion:1,kind:'local-acceptance',intentDigest:identity,commitSha:preview.commitSha};
      await writeRecord(paths,'local-approval-receipt.json',receipt);
    }
    await store.update({status:'completed',updatedAt:new Date(Math.max(Date.now(),Date.parse(run.updatedAt))).toISOString(),
      runtimeRefs:run.runtimeRefs,evidenceRefs:[...run.evidenceRefs,reference]}, {expectedVersion:run.version});
    return immutableJson({status:'completed',commitSha:preview.commitSha,nextAction:'Verified changes are in your local default branch. No push or deployment was performed.'});
  }catch(error){
    if(error instanceof LocalApprovalError)throw error;
    if(error?.code==='ERR_HOST_RUN_STALE_LOCK' && selectedRunId){
      const recovery=new LocalApprovalError('interrupted');
      recovery.message=`A prior local operation was interrupted. From this project, run rivet task recover --run=${selectedRunId}, then inspect task status before approving. No lock was removed automatically.`;
      recovery.safeMessage=recovery.message;
      throw recovery;
    }
    throw new LocalApprovalError();
  }
  finally{await lock?.release();}
}
