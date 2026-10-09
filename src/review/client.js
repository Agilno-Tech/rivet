import {mkdtemp,lstat,rm,writeFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProcessRunner} from '../clients/process-runner.js';
import {checkCompatibility} from '../clients/compatibility.js';
import {serializeReviewPayload,reviewReportSchema,validateReport} from './contract.js';
export function reviewArguments(kind,schemaPath) {
 if(kind==='claude')return ['--print','--input-format','text','--output-format','json','--no-session-persistence','--safe-mode','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--tools=','--permission-mode','dontAsk','--model','sonnet','--max-budget-usd','1','--json-schema',JSON.stringify(reviewReportSchema)];
 if(kind==='codex')return ['exec','--ephemeral','--ignore-user-config','--ignore-rules','--color','never','--sandbox','read-only','--skip-git-repo-check','--disable','shell_tool','--disable','unified_exec','--disable','apps','--disable','plugins','--config','web_search="disabled"','--config','project_doc_max_bytes=0','--output-schema',schemaPath,'-'];
 throw new Error('Unsupported review harness');
}
export async function runReviewClient({selected,snapshot,environment,signal}) {
 const worktree=await realpath(await mkdtemp(join(tmpdir(),'rivet-review-')));
 try {
  const metadata=await lstat(worktree,{bigint:true});
  const identity={dev:String(metadata.dev),ino:String(metadata.ino)};
  const schemaPath=join(worktree,'report-schema.json');
  await writeFile(schemaPath,JSON.stringify(reviewReportSchema),{mode:0o600,flag:'wx'});
  const runner=await createProcessRunner({executable:selected.executable,...(selected.interpreter?{interpreter:selected.interpreter}:{}),worktree,worktreeIdentity:identity,environment:Object.fromEntries(['PATH','LANG','LC_ALL','TZ','TERM','TMPDIR','HOME','USER','LOGNAME','SHELL'].filter(key=>environment[key]!==undefined).map(key=>[key,environment[key]])),signal,timeoutMs:120000,maxInputBytes:512*1024,maxOutputBytes:256*1024,allowOptionArgs:true});
  const args=reviewArguments(selected.kind,schemaPath);
  await checkCompatibility(runner,selected.kind,[...args,'--tools'].filter(arg=>selected.kind==='claude'||arg!=='--tools'),selected.version);
  const report=await runner.runReview({args,cwd:'.',payload:serializeReviewPayload({worktree:{path:worktree,...identity,reservationId:'review-read-only'},snapshot}),signal});
  return validateReport(report,snapshot);
 } finally {await rm(worktree,{recursive:true,force:true});}
}
