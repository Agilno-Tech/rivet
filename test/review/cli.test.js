import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,mkdir,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parse,stringify} from 'yaml';
import {reviewComment} from '../../src/commands/review.js';
import {main} from '../../src/cli/main.js';
import {createOutput} from '../../src/cli/output.js';
import {createTrustedProviderTransport} from '../../src/adapters/http.js';
const url='https://github.com/team/demo/pull/7', head='a'.repeat(40),base='b'.repeat(40);
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'rivet-review-cli-')));t.after(()=>rm(root,{recursive:true,force:true}));
 await cp(new URL('../fixtures/config/valid/.rivet',import.meta.url),join(root,'.rivet'),{recursive:true});await mkdir(join(root,'.git'));
 const file=join(root,'.rivet/providers.yaml'),config=parse(await readFile(file,'utf8'));
 config.providers.push({id:'github-main',kind:'git-ci',mode:'read-only',capabilities:['repository-read'],endpoint:'https://api.github.com',resourceIds:['team/demo'],credentials:{tokenEnv:'TEST_REPO_TOKEN'}});await writeFile(file,stringify(config));
 let output='',calls=0,launches=0,posts=0,liveHead=head,postFails=false,customDiff=null,lastSnapshot;
 const deps={reportFailure:false,cwd:()=>root,env:{TEST_REPO_TOKEN:'sample-token'},runGit:async(_command,args)=>({code:0,stdout:args.includes('--git-common-dir')?join(root,'.git')+'\n':root+'\n'}),repositories:{discoverRemotes:async()=>[{name:'origin',url:'git@github.com:team/demo.git'}],transport:createTrustedProviderTransport({resolve:async()=>['93.184.216.34'],fetchPinned:async(_url,init)=>{calls++;if(init.method==='POST'){posts++;if(postFails)throw new Error('connection dropped');return new Response(JSON.stringify({id:42}),{status:201});}assert.equal(init.method,'GET');return new Response(init.headers.accept==='application/vnd.github.diff'?customDiff??'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n':JSON.stringify({number:7,changed_files:1,state:'open',head:{sha:liveHead},base:{sha:base},title:'Fix',body:''}));}})},harnesses:{discover:async()=>[{kind:'codex',executable:'/usr/bin/fake',version:'1'}],select:async()=>({kind:'codex',executable:'/usr/bin/fake',version:'1'})},review:{run:async({snapshot})=>{launches++;lastSnapshot=snapshot;return {url,headSha:head,baseSha:base,diffDigest:snapshot.diffDigest,summary:'No findings in supplied diff',findings:[],limitations:['Checks not executed']};}},output:createOutput({stdout:{write:value=>output+=value},stderr:{write:value=>output+=value}})};
 return {root,deps,text:()=>output,setDiff:value=>{customDiff=value;},snapshot:()=>lastSnapshot,result:()=>JSON.parse(output),clear:()=>{output='';},calls:()=>calls,launches:()=>launches,posts:()=>posts,setHead:value=>{liveHead=value;},failPost:()=>{postFails=true;},enablePublish:async()=>{config.providers.at(-1).mode='read-write-with-approval';config.providers.at(-1).capabilities.push('review-comment');await writeFile(file,stringify(config));}};
}
test('default review executes harness and saves private independent findings',async t=>{const f=await fixture(t);assert.equal(await main(['review',url,'--json'],f.deps),0);assert.equal(f.launches(),1);assert.equal(f.result().result.report.summary,'No findings in supplied diff');assert.equal(f.result().result.checksExecuted,false);});
test('context export does not launch harness; import rejects stale identity before model launch',async t=>{const f=await fixture(t);assert.equal(await main(['review',url,'--context','--json'],f.deps),0);assert.equal(f.launches(),0);const snapshot=f.result().result.snapshot;const path=join(f.root,'report.json');await writeFile(path,JSON.stringify({url,headSha:base,baseSha:base,diffDigest:snapshot.diffDigest,summary:'Summary',findings:[],limitations:['Untested']}));f.clear();assert.notEqual(await main(['review',url,`--input=${path}`,'--json'],f.deps),0);assert.equal(f.launches(),0);});
test('different repository URL fails before provider calls',async t=>{const f=await fixture(t);assert.notEqual(await main(['review','https://github.com/other/repo/pull/7','--context','--json'],f.deps),0);assert.equal(f.calls(),0);});

test('publishing requires terminal and explicit approval, then records exactly one comment',async t=>{
 const f=await fixture(t);await f.enablePublish();assert.equal(await main(['review',url,'--json'],f.deps),0);f.clear();
 f.deps.terminalIsInteractive=()=>false;assert.notEqual(await main(['review',url,'--publish'],f.deps),0);assert.equal(f.posts(),0);
 f.deps.terminalIsInteractive=()=>true;f.deps.review.confirm=async()=>false;assert.equal(await main(['review',url,'--publish'],f.deps),0);assert.equal(f.posts(),0);
 f.deps.review.confirm=async()=>true;assert.equal(await main(['review',url,'--publish'],f.deps),0);assert.equal(f.posts(),1);
 assert.notEqual(await main(['review',url,'--publish'],f.deps),0);assert.equal(f.posts(),1);
});
test('head change during approval prevents publication',async t=>{
 const f=await fixture(t);await f.enablePublish();assert.equal(await main(['review',url,'--json'],f.deps),0);
 f.deps.terminalIsInteractive=()=>true;f.deps.review.confirm=async()=>{f.setHead(base);return true;};assert.notEqual(await main(['review',url,'--publish'],f.deps),0);assert.equal(f.posts(),0);
});
test('uncertain publication never automatically retries',async t=>{
 const f=await fixture(t);await f.enablePublish();assert.equal(await main(['review',url,'--json'],f.deps),0);
 f.deps.terminalIsInteractive=()=>true;f.deps.review.confirm=async()=>true;f.failPost();assert.notEqual(await main(['review',url,'--publish'],f.deps),0);assert.equal(f.posts(),1);
 assert.notEqual(await main(['review',url,'--publish'],f.deps),0);assert.equal(f.posts(),1);
});
test('provider policy changes during approval prevent publication',async t=>{
 const f=await fixture(t);await f.enablePublish();assert.equal(await main(['review',url,'--json'],f.deps),0);
 f.deps.terminalIsInteractive=()=>true;f.deps.review.confirm=async()=>{const path=join(f.root,'.rivet/providers.yaml');const config=parse(await readFile(path,'utf8'));config.providers.at(-1).mode='read-only';await writeFile(path,stringify(config));return true;};
 assert.notEqual(await main(['review',url,'--publish'],f.deps),0);assert.equal(f.posts(),0);
});
test('preview output failure prevents publication even with an approving callback',async t=>{
 const f=await fixture(t);await f.enablePublish();assert.equal(await main(['review',url,'--json'],f.deps),0);
 f.deps.terminalIsInteractive=()=>true;f.deps.review.confirm=async()=>true;
 f.deps.output=createOutput({stdout:{write(){throw new Error('broken output');}},stderr:{write(){}}});
 assert.notEqual(await main(['review',url,'--publish'],f.deps),0);assert.equal(f.posts(),0);
});
for(const publish of [false,true])test(`opaque credential environment name cannot leak through imported report (${publish?'publish':'save'})`,async t=>{
 const f=await fixture(t);await f.enablePublish();
 const providerFile=join(f.root,'.rivet/providers.yaml'),config=parse(await readFile(providerFile,'utf8'));
 config.providers.at(-1).credentials={tokenEnv:'REPO_LOGIN'};await writeFile(providerFile,stringify(config));
 const credential='opaque_value_without_known_prefix_4819';f.deps.env={REPO_LOGIN:credential};
 assert.equal(await main(['review',url,'--context','--json'],f.deps),0);
 const {snapshot,savedTo}=f.result().result,reportFile=join(f.root,'report.json');
 await writeFile(reportFile,JSON.stringify({url,headSha:head,baseSha:base,diffDigest:snapshot.diffDigest,summary:`Untrusted report echoes ${credential}`,findings:[],limitations:['Checks not executed']}));
 let output='',approvals=0;f.deps.output=createOutput({stdout:{write:value=>output+=value},stderr:{write:value=>output+=value}});
 f.deps.terminalIsInteractive=()=>true;f.deps.review.confirm=async()=>{approvals++;return true;};
 assert.notEqual(await main(['review',url,`--input=${reportFile}`,...(publish?['--publish']:['--json'])],f.deps),0);
 assert.equal(output.includes(credential),false);assert.equal((await readFile(savedTo,'utf8')).includes(credential),false);assert.equal(f.posts(),0);assert.equal(approvals,0);
});
test('publish with harness selection is rejected before any external work',async t=>{
 const f=await fixture(t);await f.enablePublish();
 assert.equal(await main(['review',url,'--json'],f.deps),0);
 const before={calls:f.calls(),launches:f.launches()};
 f.deps.terminalIsInteractive=()=>true;f.deps.review.confirm=async()=>true;
 assert.notEqual(await main(['review',url,'--publish','--harness=codex'],f.deps),0);
 assert.equal(f.calls(),before.calls);assert.equal(f.launches(),before.launches);assert.equal(f.posts(),0);
});

import {createResourceCoordinator} from '../../src/runtime/resource-coordinator.js';
import {managedPolicy} from '../fixtures/execution-policy.js';
import {observeExecutionAttempt} from '../../src/clients/execution-proof.js';
async function managedReview(t) {
 const f=await fixture(t);
 const path=join(f.root,'.rivet/orchestration.yaml'),config=parse(await readFile(path,'utf8'));
 config.executionPolicy=managedPolicy();config.executionPolicy.profiles.review.harness='codex';config.executionPolicy.profiles.review.model='configured-model';config.executionPolicy.limits.agentExecutions=1;
 await writeFile(path,stringify(config));
 const machineRoot=await realpath(await mkdtemp(join(tmpdir(),'rivet-review-machine-')));t.after(()=>rm(machineRoot,{recursive:true,force:true}));
 f.deps.machine=createResourceCoordinator({root:join(machineRoot,'machine')});
 const occupied=await f.deps.machine.register({projectRoot:f.root,runId:'existing-task',deadlineMs:Date.now()+30000,limits:config.executionPolicy.limits,projectLimits:config.executionPolicy.limits});
 const claim=await f.deps.machine.request({registrationId:occupied.id,resource:'agentExecutions',idempotencyKey:'occupied',generation:1});
 const run=f.deps.review.run;f.deps.review.run=async args=>{observeExecutionAttempt();return run(args);};
 return {...f,claim};
}
async function reviewWaiting(f) {
 for(let n=0;n<100;n++) {
  const state=await f.deps.machine.inspect();
  if(f.launches()||state.claims.some(c=>c.status==='queued')) return state;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 throw new Error('Review never reached admission');
}
test('managed standalone review waits for project capacity without a parent registration and releases on completion',async t=>{
 const f=await managedReview(t);const pending=main(['review',url,'--json'],f.deps);
 const state=await reviewWaiting(f);
 assert.equal(f.launches(),0);assert.equal(state.claims.find(c=>c.status==='queued')?.reason,'project-agentExecutions');
 await f.deps.machine.release({claimId:f.claim.id,generation:1,completed:true});
 assert.equal(await pending,0);assert.equal(f.launches(),1);
 assert.equal((await f.deps.machine.inspect()).claims.some(c=>['held','queued'].includes(c.status)),false);
});
test('interrupting a queued managed standalone review prevents launch and frees its claim',async t=>{
 const f=await managedReview(t);const pending=main(['review',url,'--json'],f.deps);
 await reviewWaiting(f);process.emit('SIGINT');
 assert.notEqual(await pending,0);assert.equal(f.launches(),0);
 assert.equal((await f.deps.machine.inspect()).claims.filter(c=>['held','queued'].includes(c.status)).length,1);
});
test('legacy standalone review remains unenrolled when a machine is configured',async t=>{
 const f=await fixture(t);const parent=await realpath(await mkdtemp(join(tmpdir(),'rivet-legacy-review-machine-')));t.after(()=>rm(parent,{recursive:true,force:true}));
 f.deps.machine=createResourceCoordinator({root:join(parent,'machine')});
 assert.equal(await main(['review',url,'--json'],f.deps),0);assert.equal(f.launches(),1);assert.equal((await f.deps.machine.inspect()).configured,false);
});

const literalDiff="diff --git a/tests/test_user.py b/tests/test_user.py\n--- a/tests/test_user.py\n+++ b/tests/test_user.py\n@@ -0,0 +1 @@\n+password='testpassword123'\n";
test('interactive review omits approved literal before saving or launching and records limitation',async t=>{
 const f=await fixture(t);f.setDiff(literalDiff);f.deps.terminalIsInteractive=()=>true;let prompts=0;
 f.deps.review.confirmRedactions=async()=>{prompts++;assert.match(f.text(),/tests\/test_user.py:1/);assert.ok(!f.text().includes('testpassword123'));return true;};
 assert.equal(await main(['review',url],f.deps),0);assert.equal(prompts,1);assert.equal(f.launches(),1);
 assert.ok(!JSON.stringify(f.snapshot()).includes('testpassword123'));assert.match(f.snapshot().diff,/omitted/);
 const path=/Saved privately: ([^\n]+)/.exec(f.text())[1];const saved=await readFile(path,'utf8');assert.ok(!saved.includes('testpassword123'));assert.match(saved,/omitted/);
 const comment=reviewComment(f.snapshot(),{summary:'No findings',findings:[],limitations:[]});assert.match(comment,/omitted with approval/);assert.ok(!comment.includes('testpassword123'));
});
for(const mode of ['decline','noninteractive','json','broken-output','drift'])test(`redaction approval fails closed: ${mode}`,async t=>{
 const f=await fixture(t);f.setDiff(literalDiff);f.deps.terminalIsInteractive=()=>mode!=='noninteractive';let prompts=0;
 f.deps.review.confirmRedactions=async()=>{prompts++;if(mode==='drift')f.setHead(base);return mode!=='decline';};
 if(mode==='broken-output')f.deps.output=createOutput({stdout:{write(){throw Error('broken');}},stderr:{write(){}}});
 assert.notEqual(await main(['review',url,...(mode==='json'?['--json']:[])],f.deps),0);
 assert.equal(f.launches(),0);assert.ok(!f.text().includes('testpassword123'));
 if(['json','noninteractive','broken-output'].includes(mode))assert.equal(prompts,0);
});
test('environment secret cannot reach redaction approval or model',async t=>{
 const f=await fixture(t);f.setDiff(literalDiff);f.deps.env.APP_PASSWORD='testpassword123';f.deps.terminalIsInteractive=()=>true;let prompts=0;
 f.deps.review.confirmRedactions=async()=>{prompts++;return true;};assert.notEqual(await main(['review',url],f.deps),0);
 assert.equal(prompts,0);assert.equal(f.launches(),0);assert.ok(!f.text().includes('testpassword123'));
});
