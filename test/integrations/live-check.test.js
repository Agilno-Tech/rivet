import test from 'node:test';
import assert from 'node:assert/strict';
import {integrationsCommand} from '../../src/commands/integrations.js';
import {parseArgs} from '../../src/cli/parse-args.js';
import {createTrustedProviderTransport} from '../../src/adapters/http.js';
const secret='opaque-test-credential-192';
function fixture(status=200,{endpoint='https://api.bitbucket.org/2.0',resource='team/demo',fetch}={}) {
 const provider={id:'repo-main',kind:'git-ci',mode:'read-only',transport:'direct-api',capabilities:['repository-read'],endpoint,resourceIds:[resource],credentials:{tokenEnv:'REPO_TOKEN'}};
 const config={project:{id:'demo'},providers:{providers:[provider]}};
 let payload;const calls=[];
 const dependencies={env:{REPO_TOKEN:secret},configLoader:async()=>config,output:{json:value=>{payload=value;}},repositories:{transport:createTrustedProviderTransport({resolve:async()=>['93.184.216.34'],fetchPinned:async(url,init)=>{calls.push({url,init});return fetch?fetch(url,init):new Response(JSON.stringify(status===200?{values:[]}:{message:secret}),{status});}})}};
 return {provider,config,dependencies,calls,payload:()=>payload};
}
async function check(f,live=true) {
 const parsed=parseArgs(['integrations','check',...(live?['--live']:[]),'--json']);
 assert.equal(await integrationsCommand(parsed,f.dependencies),0);
 return f.payload().result;
}
test('default check stays offline even with a transport available',async()=>{const f=fixture();assert.equal((await check(f,false)).networkChecked,false);assert.equal(f.calls.length,0);});
for(const [status,expected] of [[200,'ok'],[401,'rejected'],[403,'insufficient_scope'],[404,'unavailable'],[429,'unavailable'],[500,'unavailable']])test(`live check classifies HTTP ${status} without echoing the response`,async()=>{
 const f=fixture(status);const result=await check(f);
 assert.equal(result.integrations[0].live.status,expected);assert.equal(result.integrations[0].live.httpStatus,status);
 assert.equal(result.networkChecked,true);assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].init.method,'GET');assert.equal(f.calls[0].init.headers.authorization,`Bearer ${secret}`);
 assert.equal(String(f.calls[0].url),'https://api.bitbucket.org/2.0/repositories/team/demo/pullrequests?pagelen=1');
 assert.doesNotMatch(JSON.stringify(result),new RegExp(secret));
});
for(const [endpoint,resource,path] of [['https://api.github.com','team/demo','/repos/team/demo/pulls?per_page=1'],['https://gitlab.com/api/v4','group/sub/demo','/projects/group%2Fsub%2Fdemo/merge_requests?per_page=1']])test(`single read for ${endpoint}`,async()=>{
 const f=fixture(200,{endpoint,resource});assert.equal((await check(f)).integrations[0].live.status,'ok');assert.equal(String(f.calls[0].url),endpoint+path);assert.equal(f.calls.length,1);
});
for(const change of [p=>{p.mode='disabled';},p=>{p.projectIds=['other'];},p=>{p.endpoint='https://custom.example.com';},p=>{p.resourceIds=['one/repo','two/repo'];},p=>{p.transport='harness-mcp';p.tools=['read'];},p=>{p.capabilities=['checks-read'];}])test('unsupported or unscoped live check never sends credentials',async()=>{
 const f=fixture();change(f.provider);const result=await check(f);assert.equal(result.networkChecked,false);assert.equal(result.integrations[0].live.status,'not_checked');assert.equal(f.calls.length,0);
});
test('missing credentials produce an actionable offline result',async()=>{
 const f=fixture();f.dependencies.env={};const result=await check(f);assert.equal(result.networkChecked,false);assert.equal(result.integrations[0].live.status,'not_checked');assert.equal(f.calls.length,0);
});
test('live check reports transport errors without raw error details',async()=>{
 const f=fixture(200,{fetch:async()=>{throw new Error(secret);}});const result=await check(f);assert.equal(result.integrations[0].live.status,'unavailable');assert.doesNotMatch(JSON.stringify(result),new RegExp(secret));
});
test('live check bounds a transport that never settles',async()=>{
 const f=fixture(200,{fetch:async()=>new Promise(()=>{})});f.dependencies.integrationProbeTimeoutMs=10;
 assert.equal((await check(f)).integrations[0].live.status,'timeout');assert.equal(f.calls.length,1);
});
test('live is only accepted on integrations check',async()=>{
 const f=fixture();await assert.rejects(integrationsCommand(parseArgs(['integrations','list','--live','--json']),f.dependencies),{code:'INVALID_INPUT'});assert.equal(f.calls.length,0);
});

test('saved remote selects one repository within configured scope',async()=>{
 const f=fixture();f.provider.resourceIds=['team/other','team/demo'];f.config.project.repository={remote:{name:'origin',url:'https://bitbucket.org/team/demo'}};
 assert.equal((await check(f)).integrations[0].live.status,'ok');assert.equal(f.calls.length,1);assert.match(String(f.calls[0].url),/repositories\/team\/demo\//);
});
for(const url of ['https://bitbucket.org/other/repo','https://github.com/team/demo','https://custom.example/team/demo'])test(`saved remote outside provider scope is not probed: ${url}`,async()=>{
 const f=fixture();f.config.project.repository={remote:{name:'origin',url}};assert.equal((await check(f)).networkChecked,false);assert.equal(f.calls.length,0);
});
test('credential with whitespace is not sent even when registry sees a present value',async()=>{
 const f=fixture();f.dependencies.env.REPO_TOKEN='bad token';assert.equal((await check(f)).integrations[0].live.status,'not_checked');assert.equal(f.calls.length,0);
});
test('all applicable providers receive one GET and retain independent results',async()=>{
 const f=fixture(401);f.config.providers.providers.push({...f.provider,id:'second',endpoint:'https://api.github.com'});
 const result=await check(f);assert.equal(f.calls.length,2);assert.deepEqual(result.integrations.map(row=>[row.id,row.live.status]),[['repo-main','rejected'],['second','rejected']]);
});
