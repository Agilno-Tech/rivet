import {createHash,randomUUID} from 'node:crypto';
import {lstat,mkdir,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {inspectDependencyDirectory as ownedDirectory,readDependencyFile as regularFile} from './dependency-directory.js';
import {compileProjectDependencies} from '../config/commands.js';
import {assertGitClient} from '../git/client.js';
import {createApprovalReceipt,createApprovalRegistry} from '../policy/approvals.js';
import {createAuthorityEnvelope} from '../policy/authority.js';
import {runCommand,verifyCommandExecutable} from '../policy/commands.js';
import {WorktreeBootstrapError,verifyBootstrapCheckout} from './worktree-bootstrap.js';

const DIRECTORY='.rivet-deps';
const MARKER='.rivet-owner.json';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=(reason='unsafe-checkout')=>{throw new WorktreeBootstrapError(reason);};
function cancelled(signal){signal?.throwIfAborted();}

async function inputsFor(value,gitClient,config) {
 let total=0;const files=[];
 for(const path of config.inputs) {
  // Every ancestor is a real directory; a tracked symlink never becomes an input.
  let cursor=value.worktreePath;
  for(const part of path.split('/').slice(0,-1)) {cursor=join(cursor,part);const entry=await lstat(cursor);if(!entry.isDirectory()||entry.isSymbolicLink())fail();}
  const bytes=await regularFile(join(value.worktreePath,path),8*1024*1024);
  total+=bytes.length;if(total>16*1024*1024)fail();
  const tracked=await gitClient.inspectTrackedFile(value.worktreePath,value.expectedCommit,path);
  const blob=createHash(tracked.blob.length===40?'sha1':'sha256').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if(blob!==tracked.blob)fail();
  files.push(Object.freeze({path,sha256:hash(bytes)}));
 }
 return Object.freeze(files);
}
export async function inspectPortableDependencies(value,options) {
 try {
  assertGitClient(options.gitClient);
  const dependencies=compileProjectDependencies({schemaVersion:3,dependencies:value.dependencies});
  if(!dependencies)fail('invalid-input');
  cancelled(options.signal);
  await verifyBootstrapCheckout(value,options.gitClient);
  const ownership=await ownedDirectory(value.worktreePath);
  const inputs=await inputsFor(value,options.gitClient,dependencies);
  return Object.freeze({kind:'portable',projectRoot:value.projectRoot,worktreePath:value.worktreePath,expectedCommit:value.expectedCommit,expectedBranch:value.expectedBranch,inputs,steps:dependencies.steps,provides:dependencies.provides,ownership});
 }catch(error){if(error instanceof WorktreeBootstrapError)throw error;cancelled(options.signal);fail();}
}
function samePlan(a,b){return JSON.stringify(a)===JSON.stringify(b);}
async function directoryIdentity(path) {const stat=await lstat(path,{bigint:true});return `${stat.dev}:${stat.ino}`;}
async function ensureOwned(root,prior,signal) {
 if(prior)return prior;
 const path=join(root,DIRECTORY);
 // mkdir without recursive is the ownership claim; never adopt an existing entry.
 cancelled(signal);
 await mkdir(path,{mode:0o700});
 cancelled(signal);
 await writeFile(join(path,'.gitignore'),'*\n',{flag:'wx',mode:0o600});
 cancelled(signal);
 await writeFile(join(path,MARKER),JSON.stringify({kind:'rivet-dependencies',version:1,root,rootIdentity:await directoryIdentity(root),directoryIdentity:await directoryIdentity(path),token:randomUUID()}),{flag:'wx',mode:0o600});
 return ownedDirectory(root);
}
export async function bootstrapPortableDependencies(value,options) {
 const plan=await inspectPortableDependencies(value,options);
 if(typeof options.confirm!=='function'||typeof options.resolveCommandExecutable!=='function')fail('invalid-input');
 cancelled(options.signal);
 if(await options.confirm(plan)!==true)return Object.freeze({status:'declined'});
 cancelled(options.signal);
 if(!samePlan(plan,await inspectPortableDependencies(value,options)))fail();
 cancelled(options.signal);
 let ownership;
 try {ownership=await ensureOwned(plan.worktreePath,plan.ownership,options.signal);}catch{fail();}
 async function revalidate() {
  cancelled(options.signal);
  const current=await inspectPortableDependencies(value,options);
  if(!samePlan({...plan,ownership},current))fail('checkout-changed');
 }
 const results=[];
 for(const step of plan.steps) {
  await revalidate();
  const executable=await options.resolveCommandExecutable(step.argv[0],{execution:'argv',worktree:plan.worktreePath,cwd:step.cwd});
  await verifyCommandExecutable(executable,{execution:'argv'});
  await revalidate();
  const nowMs=Date.now(),commandId=step.id;
  const registry=createApprovalRegistry({approvers:[{id:'human-owner',principal:'human'}]});
  const approval=createApprovalReceipt({id:`approval-${randomUUID()}`,approverId:'human-owner',approverPrincipal:'human',subjectId:'rivet-bootstrap',action:'dependency.install',resource:`command:${commandId}:${plan.worktreePath}`,policyId:'dependency.install',decision:'approved',expiresAt:new Date(nowMs+60000).toISOString(),singleUse:true});
  const result=await runCommand({worktree:plan.worktreePath,authority:createAuthorityEnvelope({actorId:'rivet-bootstrap',principal:'agent',actions:['dependency.install'],ownedPaths:[],providers:[],commands:[commandId]}),commands:{[commandId]:{execution:'argv',executable,args:step.argv.slice(1),action:'dependency.install',elevated:true,approvalPolicyId:'dependency.install',approverId:'human-owner'}},environment:{PATH:[dirname(executable),dirname(process.execPath),'/usr/bin','/bin'].join(':')},timeoutMs:10*60000,maxOutputBytes:16384,maxStreamOutputBytes:16384},{actorId:'rivet-bootstrap',commandId,cwd:step.cwd,approval,approvalRegistry:registry,nowMs},{signal:options.signal});
  results.push(result);
  await revalidate();
  if(result.status!=='success')return Object.freeze({status:'failed',result,results:Object.freeze(results)});
 }
 for(const name of plan.provides) {
  const executable=await options.resolveCommandExecutable(name,{execution:'argv',worktree:plan.worktreePath,cwd:'.'});
  await verifyCommandExecutable(executable,{execution:'argv'});
 }
 await revalidate();
 return Object.freeze({status:'ready',results:Object.freeze(results)});
}
