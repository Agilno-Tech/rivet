import test from 'node:test';
import assert from 'node:assert/strict';
import {createTrustedProviderTransport} from '../../src/adapters/http.js';
import {createReviewSource,parseReviewUrl} from '../../src/review/source.js';
const head='a'.repeat(40),base='b'.repeat(40);
for(const host of ['github.com','bitbucket.org','gitlab.com']) test(`${host} captures bounded diff with head recheck`,async()=>{
 const suffix={'github.com':'pull','bitbucket.org':'pull-requests','gitlab.com':'-/merge_requests'}[host];
 const target=parseReviewUrl(`https://${host}/team/repo/${suffix}/7`);
 let reads=0;
 const metadata=host==='github.com'?{number:7,changed_files:1,state:'open',head:{sha:head},base:{sha:base},title:'Fix',body:'Description'}:host==='bitbucket.org'?{id:7,state:'OPEN',source:{commit:{hash:head}},destination:{commit:{hash:base}},title:'Fix',description:'Description'}:{iid:7,changes_count:'1',state:'opened',sha:head,diff_refs:{base_sha:base,head_sha:head},title:'Fix',description:'Description'};
 const transport=createTrustedProviderTransport({resolve:async()=>['93.184.216.34'],fetchPinned:async(url,init)=>{
 if(new URL(url).pathname.includes('/diffstat/'))return new Response(JSON.stringify({size:1,values:[{}]}));
 if(init.headers.accept==='application/vnd.github.diff'||new URL(url).pathname.includes('/diff/')||url.endsWith('/raw_diffs'))return new Response('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n');
 reads++;return new Response(JSON.stringify(metadata));
 }});
 const source=createReviewSource({target,transport,headers:{}});
 const result=await source.capture();
 assert.equal(result.headSha,head); assert.equal(result.baseSha,base);assert.equal(result.title,'Fix');assert.equal(reads,2);assert.match(result.diffDigest,/^[a-f0-9]{64}$/);
});
test('URL rejects credentials, queries, unsupported hosts and extra paths',()=>{
 for(const value of ['https://evil.com/team/repo/pull/7','https://u:p@github.com/team/repo/pull/7','https://github.com/team/repo/pull/7/files','https://github.com/team/repo/pull/7?x=1']) assert.throws(()=>parseReviewUrl(value));
});
test('head drift rejects captured diff',async()=>{
 let count=0;
 const target=parseReviewUrl('https://github.com/team/repo/pull/7');
 const transport=createTrustedProviderTransport({resolve:async()=>['93.184.216.34'],fetchPinned:async(url,init)=>{
 if(init.headers.accept==='application/vnd.github.diff')return new Response('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n');
 return new Response(JSON.stringify({number:7,changed_files:1,state:'open',title:'Fix',body:'',head:{sha:++count===1?head:base},base:{sha:base}}));
 }});
 await assert.rejects(createReviewSource({target,transport,headers:{}}).capture(),/changed/);
});
test('publishes only a summary comment after rechecking exact captured head',async()=>{
 const target=parseReviewUrl('https://github.com/team/repo/pull/7');let posts=0;
 const transport=createTrustedProviderTransport({resolve:async()=>['93.184.216.34'],fetchPinned:async(url,init)=>{
 if(init.method==='POST'){posts++;assert.equal(new URL(url).pathname,'/repos/team/repo/issues/7/comments');assert.equal(JSON.parse(init.body).body,'Reviewed summary');return new Response(JSON.stringify({id:42}),{status:201});}
 return new Response(JSON.stringify({number:7,changed_files:1,state:'open',title:'Fix',body:'',head:{sha:head},base:{sha:base}}));
 }});
 const source=createReviewSource({target,transport,headers:{}});
 assert.deepEqual(await source.publishComment({headSha:head,baseSha:base,title:'Fix',description:''},'Reviewed summary'),{id:42});assert.equal(posts,1);
 await assert.rejects(source.publishComment({headSha:base,baseSha:base,title:'Fix',description:''},'Reviewed summary'),/changed/);assert.equal(posts,1);
});
for(const provider of ['bitbucket','gitlab'])test(`${provider} posts a summary comment, never an approval`,async()=>{
 const target=parseReviewUrl(provider==='bitbucket'?'https://bitbucket.org/team/repo/pull-requests/7':'https://gitlab.com/team/repo/-/merge_requests/7');let posted;
 const metadata=provider==='bitbucket'?{id:7,state:'OPEN',source:{commit:{hash:head}},destination:{commit:{hash:base}},title:'Fix',description:''}:{iid:7,state:'opened',sha:head,diff_refs:{head_sha:head,base_sha:base},changes_count:'1',title:'Fix',description:''};
 const transport=createTrustedProviderTransport({resolve:async()=>['93.184.216.34'],fetchPinned:async(url,init)=>{if(init.method==='POST'){posted={url,body:JSON.parse(init.body)};return new Response(JSON.stringify({id:9}),{status:201});}return new Response(JSON.stringify(metadata));}});
 await createReviewSource({target,transport,headers:{}}).publishComment({headSha:head,baseSha:base,title:'Fix',description:''},'Summary');
 assert.match(posted.url,provider==='bitbucket'?/\/pullrequests\/7\/comments$/:/\/merge_requests\/7\/notes$/);assert.deepEqual(posted.body,provider==='bitbucket'?{content:{raw:'Summary'}}:{body:'Summary'});
});
test('exact configured credential in diff is rejected before context escapes',async()=>{
 const target=parseReviewUrl('https://github.com/team/repo/pull/7'),token='an-opaque-credential-value';
 const transport=createTrustedProviderTransport({resolve:async()=>['93.184.216.34'],fetchPinned:async(_url,init)=>new Response(init.headers.accept==='application/vnd.github.diff'?`diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+${token}\n`:JSON.stringify({number:7,changed_files:1,state:'open',head:{sha:head},base:{sha:base},title:'Fix',body:''}))});
 await assert.rejects(createReviewSource({target,transport,headers:{authorization:`Bearer ${token}`}}).capture(),/secret|credential/i);
});
