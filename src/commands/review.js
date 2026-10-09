import {redactSecrets} from '../state/redact.js';
import {loadProjectConfig} from '../config/load.js';
import {discoverHarnesses} from '../runtime/harness-discovery.js';
import {withTerminalInterruption} from '../cli/interrupt.js';
import {constants} from 'node:fs';
import {lstat,open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {CliError,EXIT_CODES,observeOutputErrors} from '../cli/output.js';
import {gitExecutable,resolveConfiguredProject} from '../cli/project-discovery.js';
import {runArgv} from '../discovery/tools.js';
import {createNodeProviderTransport} from '../adapters/node-transport.js';
import {discoverRepositoryRemotes,selectConfiguredRepositoryRemote} from '../repositories/index.js';
import {selectRepositoryProvider,repositoryHeaders} from './repositories.js';
import {createReviewSource,parseReviewUrl,digest} from '../review/source.js';
import {reviewReportSchema,validateReport} from '../review/contract.js';
import {runReviewClient} from '../review/client.js';
import {resolveStatePaths} from '../state/paths.js';
import {createSnapshotStore} from '../state/snapshot-store.js';
import {confirmTaskAction} from '../cli/task-confirmation.js';
const fail=(message,code='INVALID_INPUT')=>{throw new CliError(message,code);};
const visible=value=>String(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f\u009b]/g,c=>`\\u${c.codePointAt(0).toString(16).padStart(4,'0')}`);
async function readReport(path) {
 const before=await lstat(path);if(!before.isFile()||before.isSymbolicLink())fail('Review report must be a regular JSON file.');
 const handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
 try{const stat=await handle.stat();if(!stat.isFile()||stat.dev!==before.dev||stat.ino!==before.ino||stat.size>128*1024)fail('Review report must be a regular JSON file at most 128 KiB.');const bytes=Buffer.alloc(128*1024+1);let length=0;while(length<bytes.length){const item=await handle.read(bytes,length,bytes.length-length,null);if(!item.bytesRead)break;length+=item.bytesRead;}if(length>128*1024)fail('Review report is too large.');return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length)));}finally{await handle.close();}
}
export async function reviewCommand(parsed,dependencies) {return withTerminalInterruption(signal=>executeReview(parsed,dependencies,signal));}
async function executeReview(parsed,dependencies,signal) {
 const {flags,operands}=parsed;
 if(operands.length!==1||parsed.subcommand!==null||Object.keys(flags).some(key=>!['project','remote','provider','harness','input','context','publish','json'].includes(key))||flags.context&&(flags.input||flags.publish||flags.harness)||flags.input&&flags.harness||flags.publish&&flags.harness||flags.publish&&flags.json||flags.harness&&!['claude','codex'].includes(flags.harness))fail('Use rivet review <PR-URL> [--harness=claude|codex] or --context or --input=<report.json>. Add --publish only for an interactive approved summary comment.');
 const target=parseReviewUrl(operands[0]);
 const project=await resolveConfiguredProject(dependencies.cwd(),flags.project,{runner:dependencies.runGit,env:dependencies.env});
 const executable=await gitExecutable(dependencies.env);
 const runner=(_command,args,options)=>(dependencies.runGit??runArgv)(executable,args,options);
 const remotes=await (dependencies.repositories?.discoverRemotes??discoverRepositoryRemotes)(project.root,{runner});
 const repository=selectConfiguredRepositoryRemote(remotes,project.config.project.repository.remote,flags.remote);
 if(repository.url!==target.repository.url)fail('The PR belongs to another repository. Run review inside its configured checkout or select its configured remote.','REPOSITORY_CONFLICT');
 const provider=selectRepositoryProvider(project.config,repository,{provider:flags.provider});
 if(flags.publish&&(provider.mode!=='read-write-with-approval'||!provider.capabilities.includes('review-comment')))fail('Publishing requires a scoped git-ci provider in read-write-with-approval mode with review-comment capability.','MISSING_CONFIGURATION');
 if(flags.publish&&dependencies.terminalIsInteractive?.()!==true)fail('Publishing a review summary needs an interactive terminal for approval.');
 const auth=repositoryHeaders(provider,dependencies.env);
 const credentialText=JSON.stringify(auth.authorization.slice('Bearer '.length)).slice(1,-1);
 const source=createReviewSource({target,transport:dependencies.repositories?.transport??createNodeProviderTransport(),headers:auth,signal});
 const paths=await resolveStatePaths(project.root,`pr-review-${digest(target.url).slice(0,32)}`,{runner});
 const store=createSnapshotStore(paths,{environment:dependencies.env});
 let saved=await store.read(),snapshot,report;
 if(flags.input||flags.publish){
  if(!saved?.data?.snapshot)fail('No saved review exists. Run rivet review <PR-URL> --context first.');
  snapshot=saved.data.snapshot;
  if(snapshot.url!==target.url||digest(snapshot.diff)!==snapshot.diffDigest)fail('Saved review is invalid. Capture a new review.','REPOSITORY_CONFLICT');
  await source.assertCurrent(snapshot);
  report=flags.input?validateReport(await readReport(resolve(dependencies.cwd(),flags.input)),snapshot):saved.data.report;
  if(!report)fail('No findings report is saved. Run the review or import a report first.');
  report=validateReport(report,snapshot);
 }else{
  if(saved?.data?.publication?.status==='pending')fail('A previous publication has an unknown outcome. Inspect the PR before replacing this review.','REPOSITORY_CONFLICT');
  snapshot=await source.capture();
  if(JSON.stringify(redactSecrets(snapshot,{environment:dependencies.env}))!==JSON.stringify(snapshot))fail('Review contains sensitive environment material. Remove it before delegation.');
  saved=await store.write({snapshot,report:null,publication:null},{expectedVersion:saved?.version??0});
  if(!flags.context){
   const harnesses=dependencies.harnesses??{discover:root=>discoverHarnesses({env:dependencies.env,projectRoot:root,signal}),select:async(kind,root)=>(await discoverHarnesses({env:dependencies.env,projectRoot:root,signal})).find(item=>item.kind===kind&&item.executable)};
   const available=(await harnesses.discover(project.root,{signal})).filter(item=>item.executable);
   const chosen=flags.harness?available.find(item=>item.kind===flags.harness):available.find(item=>item.kind==='claude')??available[0];
   if(!chosen)fail('No compatible review CLI is installed. Install/authenticate Claude or Codex, or use --context --json in your existing harness.','PROVIDER_UNAVAILABLE');
   const selected=await harnesses.select(chosen.kind,project.root,{signal});
   if(!flags.json)dependencies.output.log(`Reviewing with ${selected.kind}. The supplied diff is sent to this harness; project checks are not run.`);
   report=await (dependencies.review?.run??runReviewClient)({selected,snapshot,environment:dependencies.env,signal});
   report=validateReport(report,snapshot);
   await source.assertCurrent(snapshot);
  }
 }
 if(report&&(JSON.stringify(report).includes(credentialText)||JSON.stringify(redactSecrets(report,{environment:dependencies.env}))!==JSON.stringify(report)))fail('Review output contains sensitive material and cannot be saved or shared.');
 if(report)saved=await store.write({...saved.data,snapshot,report},{expectedVersion:saved.version});
 if(flags.publish){
  if(saved.data.publication)fail('This review already has a publication attempt. Inspect the PR; Rivet does not retry potentially accepted comments.','REPOSITORY_CONFLICT');
  const body=reviewComment(snapshot,report);
  if(Buffer.byteLength(body)>60000)fail('Review summary exceeds the 60000-byte publication limit. Shorten the imported report before publishing.');
  let outputFailed=false,approved=false;const unobserve=observeOutputErrors(dependencies.output,()=>{outputFailed=true;});
  try{dependencies.output.log(visible(`Publish this summary comment to ${target.url}:\n\n${body}`));if(outputFailed||signal.aborted)fail('Could not display the review preview. Publication cancelled.','REPOSITORY_CONFLICT');try{approved=await (dependencies.review?.confirm??confirmTaskAction)('Publish this exact review summary comment? [y/N] ',{signal})===true;}catch{}if(outputFailed||signal.aborted)fail('Review output failed or publication was interrupted.','REPOSITORY_CONFLICT');}finally{unobserve?.();}
  if(!approved)return EXIT_CODES.SUCCESS;
  if(digest(await loadProjectConfig(project.root))!==digest(project.config))fail('Provider/project configuration changed during approval. Review again.','REPOSITORY_CONFLICT');
  const currentRemotes=await (dependencies.repositories?.discoverRemotes??discoverRepositoryRemotes)(project.root,{runner});
  if(selectConfiguredRepositoryRemote(currentRemotes,project.config.project.repository.remote,flags.remote).url!==target.repository.url)fail('Repository remote changed during approval.','REPOSITORY_CONFLICT');
  await source.assertCurrent(snapshot);
  saved=await store.write({...saved.data,publication:{status:'pending',bodyDigest:digest(body)}},{expectedVersion:saved.version});
  const receipt=await source.publishComment(snapshot,body);
  saved=await store.write({...saved.data,publication:{status:'published',bodyDigest:digest(body),receipt}},{expectedVersion:saved.version});
 }
 const result={snapshot,report:report??null,reportSchema:reviewReportSchema,checksExecuted:false,published:saved.data.publication?.status==='published',savedTo:paths.snapshotPath};
 if(flags.json)dependencies.output.json({ok:true,result});else{
  dependencies.output.log(visible(`Review: ${target.url}\nHead: ${snapshot.headSha}\nSaved privately: ${paths.snapshotPath}`));
  if(report){dependencies.output.log(visible(report.summary));for(const item of report.findings)dependencies.output.log(visible(`[${item.severity}] ${item.path}:${item.line}: ${item.message}`));dependencies.output.log('Diff-only review. No tests were executed; no findings is not proof of correctness.');}
  else{dependencies.output.log('Context captured. Use --context --json to export the snapshot and report schema to your harness, then --input=<report.json> to save its findings.');}
 }
 return EXIT_CODES.SUCCESS;
}
export function reviewComment(snapshot,report){return `Rivet review summary\n\nReviewed head: ${snapshot.headSha}\nReviewed base: ${snapshot.baseSha}\nDiff digest: ${snapshot.diffDigest}\n\n${report.summary}\n\n${report.findings.map(item=>`- [${item.severity}] ${item.path}:${item.line}: ${item.message}`).join('\n')||'No findings in the supplied diff.'}\n\nLimitations:\n- Diff-only review; no project checks were executed. This is a summary comment, not an approval.\n${report.limitations.map(item=>`- ${item}`).join('\n')}`;}
