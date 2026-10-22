import {mkdtemp,lstat,realpath,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProcessRunner} from '../clients/process-runner.js';
import {checkCompatibility} from '../clients/compatibility.js';
import {reviewArguments} from '../review/client.js';
import {policyTranslationSchema,serializePolicyPayload,validatePolicyTranslation} from './policy-contract.js';
export function policyArguments(kind,schemaPath){
 const args=reviewArguments(kind,schemaPath);
 // Reuse the reviewed no-tools CLI surface, replacing only the result schema.
 if(kind==='claude')args[args.indexOf('--json-schema')+1]=JSON.stringify(policyTranslationSchema);
 return args;
}
export async function translateModelPolicy({selected,prose,profiles,routing,environment,signal,timeoutMs=120000}){
 const worktree=await realpath(await mkdtemp(join(tmpdir(),'rivet-policy-')));
 try{
  const meta=await lstat(worktree,{bigint:true}),identity={dev:String(meta.dev),ino:String(meta.ino)};
  const schemaPath=join(worktree,'policy-schema.json');await writeFile(schemaPath,JSON.stringify(policyTranslationSchema),{mode:0o600,flag:'wx'});
  const runner=await createProcessRunner({executable:selected.executable,...(selected.interpreter?{interpreter:selected.interpreter}:{}),worktree,worktreeIdentity:identity,environment:Object.fromEntries(['PATH','LANG','LC_ALL','TZ','TERM','TMPDIR','HOME','USER','LOGNAME','SHELL'].filter(k=>environment[k]!==undefined).map(k=>[k,environment[k]])),signal,timeoutMs,maxInputBytes:64000,maxOutputBytes:64000,allowOptionArgs:true});
  const args=policyArguments(selected.kind,schemaPath);await checkCompatibility(runner,selected.kind,[...args,'--tools'].filter(arg=>selected.kind==='claude'||arg!=='--tools'),selected.version);
  const result=await runner.runPolicy({args,cwd:'.',payload:serializePolicyPayload({worktree:{path:worktree,...identity,reservationId:'policy-read-only'},prose,profiles,routing}),signal});
  return validatePolicyTranslation(result,prose,profiles);
 }finally{await rm(worktree,{recursive:true,force:true});}
}
