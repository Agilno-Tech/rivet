import test from 'node:test';
import assert from 'node:assert/strict';
import {createTrustedProviderTransport} from '../../src/adapters/http.js';
import {createReviewSource,parseReviewUrl,digest} from '../../src/review/source.js';
import {serializeReviewPayload,validateReviewPayload,validateReport} from '../../src/review/contract.js';
const head='a'.repeat(40),base='b'.repeat(40);
const worktree={path:'/tmp/review',dev:'1',ino:'2',reservationId:'review-read-only'};
function fixture(lines,{title='Fix',description='',headers={},environment={},path='tests/test_review.py',gitPath=path}={}) {
 const diff=`diff --git a/${gitPath} b/${gitPath}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line=>'+'+line).join('\n')}\n`;
 let reads=0;
 const metadata={number:7,changed_files:1,state:'open',head:{sha:head},base:{sha:base},title,body:description};
 const transport=createTrustedProviderTransport({resolve:async()=>['93.184.216.34'],fetchPinned:async(_url,init)=>{
  if(init.headers.accept==='application/vnd.github.diff')return new Response(diff);
  reads++;return new Response(JSON.stringify(metadata));
 }});
 const source=createReviewSource({target:parseReviewUrl('https://github.com/team/repo/pull/7'),transport,headers,environment});
 return {source,diff,metadata,reads:()=>reads};
}
for(const code of ["api_key=os.environ.get('SENDGRID_API_KEY')",'token = build_resolution_review_token(...)','token = build_resolution_review_token(review.id, user, expires_at)','token = build_token(resolve(user), 123)'])test(`review accepts nonliteral code: ${code}`,async()=>{
 const {source,diff}=fixture([code]);const snapshot=await source.capture();assert.equal(snapshot.diff,diff);
 const payload=serializeReviewPayload({worktree,snapshot});assert.equal(validateReviewPayload(payload).snapshot.diff,diff);
 const report={url:snapshot.url,headSha:head,baseSha:base,diffDigest:snapshot.diffDigest,summary:code,findings:[],limitations:['No tests run']};
 assert.equal(validateReport(report,snapshot).summary,code);
});
test('literal fixture requires approval and only sanitized context crosses capture and payload boundaries',async()=>{
 const f=fixture(["password='testpassword123'","api_key=os.environ.get('SENDGRID_API_KEY')"]);
 await assert.rejects(f.source.capture(),/credential|secret|redact/i);
 let preview;
 const snapshot=await f.source.capture({confirmRedactions:async value=>{preview=value;return true}});
 assert.equal(preview.length,1);assert.equal(preview[0].path,'tests/test_review.py');assert.equal(preview[0].line,1);
 assert.ok(!JSON.stringify(preview).includes('testpassword123'));
 assert.ok(!JSON.stringify(snapshot).includes('testpassword123'));
 assert.match(snapshot.diff,/omitted/);assert.equal(snapshot.diffDigest,digest(snapshot.diff));
 assert.ok(snapshot.limitations.some(x=>/omitted/i.test(x)));
 const payload=serializeReviewPayload({worktree,snapshot});assert.ok(!payload.includes('testpassword123'));validateReviewPayload(payload);
 const tampered={...snapshot,diff:f.diff,diffDigest:digest(f.diff)};
 assert.throws(()=>serializeReviewPayload({worktree,snapshot:tampered}));
});
test('declined redaction and PR drift during approval fail closed',async()=>{
 const f=fixture(["password='testpassword123'"]);
 await assert.rejects(f.source.capture({confirmRedactions:async()=>false}));
 await assert.rejects(f.source.capture({confirmRedactions:async()=>{f.metadata.head.sha='c'.repeat(40);return true}}),/changed/);
});
for(const code of ["api_key=os.environ.get('SENDGRID_API_KEY', 'real-secret')",'token = builder(secret="real-secret")','token = builder("real-secret")','token = builder() + "real-secret"','token = builder(\n"real-secret")',"password='unterminated",'token = builder(ghp_abcdefgh12345678)','token = builder() # -----BEGIN PRIVATE KEY-----'])test(`unsafe code stays blocked: ${code}`,async()=>{
 const f=fixture(code.split('\n'));await assert.rejects(f.source.capture());
});
for(const options of [{headers:{authorization:'Bearer testpassword123'}},{environment:{APP_PASSWORD:'testpassword123'}}])test(`actual configured secret cannot be approved away ${JSON.stringify(Object.keys(options))}`,async()=>{
 let called=false;const f=fixture(["password='testpassword123'"],options);
 await assert.rejects(f.source.capture({confirmRedactions:async()=>{called=true;return true}}));assert.equal(called,false);
});
for(const text of ['token = build_token(...)',"password='testpassword123'"])test('metadata retains strict secret checks: '+text,async()=>{
 const f=fixture(['pass'],{description:text});await assert.rejects(f.source.capture({confirmRedactions:async()=>true}));
});

for(const code of [
 'token = build_token(); password="actual-value"',
 'token = build_token(secret="actual-value")',
 'token = build_token() + "actual-value"',
 'token = build_token() || "actual-value"',
 'password = derive() // "literal-private-value"',
 'token = build_token()`actual-value`',
 'token = build_token() # api_key="actual-value"',
 'ｔｏｋｅｎ = build_token()',
 'to\u200bken = build_token()',
])test('serialized payload cannot hide remaining secret material: '+code,async()=>{
 const f=fixture(['pass']);const snapshot=await f.source.capture();
 const diff=snapshot.diff.replace('+pass','+'+code);
 assert.throws(()=>serializeReviewPayload({worktree,snapshot:{...snapshot,diff,diffDigest:digest(diff)}}));
});
for(const value of ['ghp_abcdefgh12345678','npm_abcdefgh12345678','glpat-abcdefgh12345678','-----BEGIN PRIVATE KEY-----','AKIAABCDEFGHIJKLMNOP'])test('known credential cannot be approved for omission: '+value.split('_')[0],async()=>{
 let approvals=0;const f=fixture([`password='${value}'`]);
 await assert.rejects(f.source.capture({confirmRedactions:async()=>{approvals++;return true}}));assert.equal(approvals,0);
});
test('approval preview mutation cannot alter the source snapshot',async()=>{
 const f=fixture(["password='testpassword123'"]);
 const snapshot=await f.source.capture({confirmRedactions:async findings=>{findings[0].path='elsewhere';return true}});
 assert.ok(!snapshot.diff.includes('testpassword123'));assert.equal(snapshot.files[0].path,'tests/test_review.py');
});
test('redaction cannot consume an unfinished multiline literal',async()=>{
 for(const lines of [["password='first", "second'"],["password='first' \\","'second'"],["password='''first", "second'''"],["password=", "'testpassword123'"]]) {
  let approvals=0;const f=fixture(lines);await assert.rejects(f.source.capture({confirmRedactions:async()=>{approvals++;return true}}));assert.equal(approvals,0);
 }
});
for(const code of ["password = get_password(), 'hunter2'","token = get_token(), ('super-private-value',)","token = build_token(),\n 'super-private-value'"])test('tuple RHS cannot hide a literal credential: '+code,async()=>{
 const f=fixture(code.split('\n'));let approvals=0;
 await assert.rejects(f.source.capture({confirmRedactions:async()=>{approvals++;return true}}));assert.equal(approvals,0);
 const clean=await fixture(['pass']).source.capture();const diff=f.diff;
 assert.throws(()=>serializeReviewPayload({worktree,snapshot:{...clean,diff,diffDigest:digest(diff)}}));
});

for(const path of ['.env','settings.ini','config.txt'])test('call-shaped config values remain blocked: '+path,async()=>{
 const f=fixture(['PASSWORD=myPasswordFunction()'],{path});
 await assert.rejects(f.source.capture({confirmRedactions:async()=>true}));
 const original=await fixture(['pass']).source.capture();
 assert.throws(()=>serializeReviewPayload({worktree,snapshot:{...original,diff:f.diff,diffDigest:digest(f.diff)}}));
});
for(const lines of [
 ['data = \"\"\"','password=myPasswordFunction()','\"\"\"'],
 ["data = 'password=myPasswordFunction()'"],
 ['# password=myPasswordFunction()'],
])test('quoted or commented call-shaped text remains blocked: '+lines[0],async()=>{
 const f=fixture(lines);await assert.rejects(f.source.capture({confirmRedactions:async()=>true}));
 const original=await fixture(['pass']).source.capture();
 assert.throws(()=>serializeReviewPayload({worktree,snapshot:{...original,diff:f.diff,diffDigest:digest(f.diff)}}));
});

test('capture and payload check authoritative file headers despite misleading git header',async()=>{
 await assert.rejects(fixture(['PASSWORD=myPasswordFunction()'],{path:'.env',gitPath:'x.py'}).source.capture({confirmRedactions:async()=>true}));
 const snapshot=await fixture(['token = build_token()']).source.capture();
 const diff=snapshot.diff.replace('--- a/tests/test_review.py','--- a/.env').replace('+++ b/tests/test_review.py','+++ b/.env');
 assert.throws(()=>serializeReviewPayload({worktree,snapshot:{...snapshot,diff,diffDigest:digest(diff)}}));
});

test('Python floor division cannot hide a literal operand during capture',async()=>{
 await assert.rejects(fixture(["password = derive() // 'literal-private-value'"]).source.capture({confirmRedactions:async()=>true}));
});
