import assert from 'node:assert/strict';
import test from 'node:test';
import { selectionArguments, sessionTelemetry } from '../../src/clients/session-capabilities.js';
import { managedPolicy } from '../fixtures/execution-policy.js';
import { resolveExecutionSelection } from '../../src/models/execution-policy.js';
import { reviewArguments } from '../../src/review/client.js';
const selection = resolveExecutionSelection(managedPolicy(), 'implementation');
test('bounded selected model and effort become literal argv', () => {
 assert.deepEqual(selectionArguments('codex',selection), ['--model','configured-model','--config','model_reasoning_effort="high"']);
 assert.deepEqual(selectionArguments('claude',resolveExecutionSelection(managedPolicy(),'coordination')), ['--model','sonnet','--effort','low']);
 for(const patch of [{effort:'high"\nfoo=true'},{model:'--help'},{recommendationOnly:true},{harness:'claude'}]) assert.throws(()=>selectionArguments('codex',{...selection,...patch}));
});
test('independent review dispatches selection without duplicate legacy model',()=>{
 const chosen=resolveExecutionSelection(managedPolicy(),'independent-review');
 const args=reviewArguments('claude','/tmp/schema',chosen);
 assert.equal(args.filter(x=>x==='--model').length,1);
 assert.equal(args[args.indexOf('--effort')+1],'low');
});
test('telemetry distinguishes unknown billing and context from measured zero',()=>{
 const codex=sessionTelemetry('codex',{tokens:10,costUsd:0});
 assert.equal(codex.costUsd.value,null); assert.equal(codex.contextUsedTokens.value,null);
 assert.equal(codex.tokens.assurance,'model-reported');
 const claude=sessionTelemetry('claude',{tokens:0,costUsd:0});
 assert.equal(claude.costUsd.value,0); assert.equal(claude.costUsd.assurance,'native-estimate');
 assert.equal(claude.contextUsedTokens.value,null);
});

test('managed worker and planning argv reach subprocess and unsupported effort options block before launch',async t=>{
 const {mkdtemp,realpath,mkdir,lstat,writeFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {createClaudeClient,createClaudePlanningClient,CLAUDE_ADAPTER_SYNTAX}=await import('../../src/clients/claude.js');
 const {createCodexClient,createCodexPlanningClient,CODEX_ADAPTER_SYNTAX}=await import('../../src/clients/codex.js');
 const {agentResultContract}=await import('../../src/clients/result-contract.js');
 const {featureDecompositionResultContract}=await import('../../src/feature/decomposition-contract.js');
 const root=await realpath(await mkdtemp(join(tmpdir(),'rivet-managed-argv-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const worktree=join(root,'work');await mkdir(worktree);const stat=await lstat(worktree,{bigint:true});const interpreter=await realpath(process.execPath);
 const launch={nodeId:'worker-one',parentId:'manager-one',objective:'Implement change.',ownedPaths:['src/change.js'],authority:{actions:['code.write'],providers:[]},commands:['test.unit'],evidence:['test-results'],budget:{maxTokens:12000,maxRuntimeMs:30000,maxCostUsd:2},worktree:{path:worktree,dev:String(stat.dev),ino:String(stat.ino),reservationId:'lease-one'},contextRefs:[],heartbeatInterval:5000,stopConditions:['objective-complete']};
 const plan={schemaVersion:1,baselineCommit:'a'.repeat(40),client:'codex',workRequest:{schemaVersion:1,digest:'b'.repeat(64),title:'Plan'},policy:{projectId:'fixture'}};
 const result={version:1,status:'success',output:{summary:'done',evidence:['tests']},usage:{tokens:1,costUsd:0}};
 const decomposition={schemaVersion:1,kind:'agilno.feature-decomposition',workItems:[{objective:'Implement planned feature.',ownedPaths:['src/feature.js'],acceptanceCriterionIndexes:[1]}]};
 for(const [kind,worker,planner,syntax] of [['claude',createClaudeClient,createClaudePlanningClient,CLAUDE_ADAPTER_SYNTAX],['codex',createCodexClient,createCodexPlanningClient,CODEX_ADAPTER_SYNTAX]]){
  const chosen=resolveExecutionSelection(managedPolicy(),kind==='claude'?'coordination':'implementation');
  for(const mode of ['worker','planning']){
   const expected=[...syntax.args.slice(0,-1),...selectionArguments(kind,chosen),...(kind==='claude'?(mode==='worker'?['--json-schema',JSON.stringify(agentResultContract(launch.evidence).schema),'--max-budget-usd','2']:['--max-budget-usd','1','--permission-mode','dontAsk','--tools','Read,Glob,Grep','--json-schema',JSON.stringify(featureDecompositionResultContract().schema)]):mode==='planning'?['--sandbox','read-only']:[])];
   const output=mode==='worker'?result:decomposition;const envelope=kind==='claude'?{type:'result',subtype:'success',is_error:false,total_cost_usd:0,modelUsage:{fixture:{inputTokens:1,outputTokens:0,cacheCreationInputTokens:0,cacheReadInputTokens:0}},structured_output:output}:output;
   for(const compatible of [true,false]){
    const executable=join(root,`${kind}-${mode}-${compatible}.js`);
    const help=[...new Set(expected.filter(arg=>/^--[a-z-]+$/.test(arg)))].filter(arg=>compatible||arg!==(kind==='claude'?'--effort':'--config')).join('\n');
    await writeFile(executable,`#!${interpreter}\nif(process.argv[2]==='--version')console.log('fixture 1');else if(process.argv.includes('--help'))console.log(${JSON.stringify(help)});else{if(JSON.stringify(process.argv.slice(2))!==${JSON.stringify(JSON.stringify(expected))})process.exit(41);process.stdin.resume();process.stdin.on('end',()=>console.log(${JSON.stringify(JSON.stringify(envelope))}));}`,{mode:0o700});
    const receipts=[];const config={executable,interpreter,executionSelection:chosen,onTelemetry:r=>receipts.push(r)};
    const invoke=()=>mode==='worker'?worker({...config,args:syntax.args}).launch(launch):planner({...config,worktree}).propose(plan);
    if(compatible){await invoke();assert.equal(receipts.length,1);assert.equal(receipts[0].costUsd.value,kind==='claude'?0:null);
      config.onTelemetry=async()=>{throw new Error('receipt write failed');};
      await assert.rejects(invoke,error=>error.code==='ERR_AGENT_OUTPUT_INVALID');
    }
    else await assert.rejects(invoke,error=>error.code==='ERR_AGENT_PROVIDER_UNAVAILABLE');
   }
  }
 }
});

test('selected review profile reaches read-only subprocess and missing capability blocks it',async t=>{
 const {mkdtemp,realpath,writeFile,rm}=await import('node:fs/promises');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const {runReviewClient}=await import('../../src/review/client.js');
 const root=await realpath(await mkdtemp(join(tmpdir(),'rivet-review-argv-')));t.after(()=>rm(root,{recursive:true,force:true}));const interpreter=await realpath(process.execPath);
 const snapshot={url:'https://github.com/example/repo/pull/1',headSha:'a'.repeat(40),baseSha:'b'.repeat(40),diffDigest:'c'.repeat(64),diff:'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n'};
 const report={url:snapshot.url,headSha:snapshot.headSha,baseSha:snapshot.baseSha,diffDigest:snapshot.diffDigest,summary:'Reviewed.',findings:[],limitations:['Diff only.']};
 for(const kind of ['claude','codex']){
  const executionSelection=resolveExecutionSelection(managedPolicy(),kind==='claude'?'independent-review':'implementation');
  for(const compatible of [true,false]){
   const expected=reviewArguments(kind,'SCHEMA',executionSelection);const help=[...new Set([...expected.filter(arg=>/^--[a-z-]+$/.test(arg)),'--tools'])].filter(arg=>compatible||arg!==(kind==='claude'?'--effort':'--config')).join('\n');
   const executable=join(root,`${kind}-${compatible}.js`);
   const output=kind==='claude'?{type:'result',subtype:'success',structured_output:report}:report;
   await writeFile(executable,`#!${interpreter}\nif(process.argv[2]==='--version')console.log('fixture 1');else if(process.argv.includes('--help'))console.log(${JSON.stringify(help)});else{const args=process.argv.slice(2);const i=args.indexOf('--output-schema');if(i>=0)args[i+1]='SCHEMA';if(JSON.stringify(args)!==${JSON.stringify(JSON.stringify(expected))})process.exit(41);process.stdin.resume();process.stdin.on('end',()=>console.log(${JSON.stringify(JSON.stringify(output))}));}`,{mode:0o700});
   const invoke=()=>runReviewClient({selected:{kind,executable,interpreter},snapshot,environment:{},executionSelection});
   if(compatible)assert.deepEqual(JSON.parse(JSON.stringify(await invoke())),report);else await assert.rejects(invoke,e=>e.code==='ERR_AGENT_PROVIDER_UNAVAILABLE');
  }
 }
});

test('Codex config escape hatches remain rejected',async()=>{
 const {createCodexClient,CODEX_ADAPTER_SYNTAX}=await import('../../src/clients/codex.js');
 for(const value of ['model_reasoning_effort="high"\nfoo=true','approval_policy="never"','model_reasoning_effort="$(id)"','model_reasoning_effort="high" extra=true']){
  assert.throws(()=>createCodexClient({executable:'/missing/codex',args:[...CODEX_ADAPTER_SYNTAX.args.slice(0,-1),'--config',value,'{stdin}']}));
 }
});
