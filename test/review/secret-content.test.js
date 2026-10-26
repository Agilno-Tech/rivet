import test from 'node:test';
import assert from 'node:assert/strict';
import {createTrustedProviderTransport} from '../../src/adapters/http.js';
import {createReviewSource,parseReviewUrl,digest} from '../../src/review/source.js';
import {serializeReviewPayload,validateReviewPayload,validateReport} from '../../src/review/contract.js';
const head='a'.repeat(40),base='b'.repeat(40);
const worktree={path:'/tmp/review',dev:'1',ino:'2',reservationId:'review-read-only'};
function fixture(lines,{title='Fix',description='',headers={},environment={},path='tests/test_review.py',gitPath=path,diffOverride}={}) {
 const diff=diffOverride??`diff --git a/${gitPath} b/${gitPath}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line=>'+'+line).join('\n')}\n`;
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
test('unfinished multiline values require whole-file omission',async()=>{
 for(const lines of [["password='first", "second'"],["password='first' \\","'second'"],["password='''first", "second'''"],["password=", "'testpassword123'"]]) {
  const f=fixture(lines);await assertSafeFileOmission(f);
 }
});
for(const code of ["password = get_password(), 'hunter2'","token = get_token(), ('super-private-value',)","token = build_token(),\n 'super-private-value'"])test('tuple RHS cannot hide a literal credential: '+code,async()=>{
 const f=fixture(code.split('\n'));await assertSafeFileOmission(f);
 const clean=await fixture(['pass']).source.capture();const diff=f.diff;
 assert.throws(()=>serializeReviewPayload({worktree,snapshot:{...clean,diff,diffDigest:digest(diff)}}));
});

for(const path of ['.env','settings.ini','config.txt'])test('call-shaped config values remain blocked: '+path,async()=>{
 const f=fixture(['PASSWORD=myPasswordFunction()'],{path});
 await assertSafeFileOmission(f);
 const original=await fixture(['pass']).source.capture();
 assert.throws(()=>serializeReviewPayload({worktree,snapshot:{...original,diff:f.diff,diffDigest:digest(f.diff)}}));
});
for(const lines of [
 ['data = \"\"\"','password=myPasswordFunction()','\"\"\"'],
 ["data = 'password=myPasswordFunction()'"],
 ['# password=myPasswordFunction()'],
])test('quoted or commented call-shaped text remains blocked: '+lines[0],async()=>{
 const f=fixture(lines);await assertSafeFileOmission(f);
 const original=await fixture(['pass']).source.capture();
 assert.throws(()=>serializeReviewPayload({worktree,snapshot:{...original,diff:f.diff,diffDigest:digest(f.diff)}}));
});

test('capture and payload check authoritative file headers despite misleading git header',async()=>{
 await assertSafeFileOmission(fixture(['PASSWORD=myPasswordFunction()'],{path:'.env',gitPath:'x.py'}));
 const snapshot=await fixture(['token = build_token()']).source.capture();
 const diff=snapshot.diff.replace('--- a/tests/test_review.py','--- a/.env').replace('+++ b/tests/test_review.py','+++ b/.env');
 assert.throws(()=>serializeReviewPayload({worktree,snapshot:{...snapshot,diff,diffDigest:digest(diff)}}));
});

test('Python floor division cannot hide a literal operand during capture',async()=>{
 await assertSafeFileOmission(fixture(["password = derive() // 'literal-private-value'"]));
});

for(const [path,code] of [
 ['docs/design.md','token: create one guest from a store build and read the API log'],
 ['users/tests.py',"self._post(token=f'ip-token-{attempt}')"],
 ['users/tests.py','self.verify_token.side_effect = lambda token: {}'],
 ['users/tests.py',"email='idle_customer@example.test', password='testpassword123',"],
])test('Ana follow-up: approved file omission for '+code,async()=>{
 const f=fixture([code,'unlabeled_private_continuation'],{path});
 await assert.rejects(f.source.capture());
 const snapshot=await f.source.capture({confirmRedactions:async findings=>{assert.equal(findings[0].scope,'file');return true;}});
 assert.deepEqual(snapshot.omittedFiles,[path]);
 assert.ok(!snapshot.diff.includes(code));assert.ok(!snapshot.diff.includes('unlabeled_private_continuation'));
 validateReviewPayload(serializeReviewPayload({worktree,snapshot}));
 assert.throws(()=>validateReport({url:snapshot.url,headSha:head,baseSha:base,diffDigest:snapshot.diffDigest,summary:'Finding',findings:[{path,line:1,severity:'high',message:'Claim about omitted code'}],limitations:['No tests']},snapshot));
});

async function assertSafeFileOmission(f) {
 await assert.rejects(f.source.capture());
 const snapshot=await f.source.capture({confirmRedactions:async()=>true});
 assert.equal(snapshot.omittedFiles.length,1);
 for(const line of f.diff.split('\n').filter(line=>line.startsWith('+')&&!line.startsWith('+++')))assert.ok(!snapshot.diff.includes(line));
 validateReviewPayload(serializeReviewPayload({worktree,snapshot}));
}

test('whole-file omission removes continuation and context across distant hunks',async()=>{
 const diff="diff --git a/tests/test_review.py b/tests/test_review.py\n--- a/tests/test_review.py\n+++ b/tests/test_review.py\n@@ -0,0 +1 @@ header_private_text\n+password='''first\n@@ -10 +11 @@ continuation_private_text\n-old_private_text\n+last_private_text'''\n";
 const f=fixture([],{diffOverride:diff});const snapshot=await f.source.capture({confirmRedactions:async()=>true});
 for(const value of ['header_private_text','continuation_private_text','old_private_text','last_private_text','first'])assert.ok(!snapshot.diff.includes(value));
 validateReviewPayload(serializeReviewPayload({worktree,snapshot}));
 assert.ok(snapshot.limitations.some(item=>item.startsWith('All file diffs')));
});
test('quoted assignment cannot leak a continued literal on another line',async()=>{
 await assertSafeFileOmission(fixture(["password = 'prefix'", "  + 'real-secret-suffix'"],{path:'a.js'}));
});

test('credential-shaped function context in hunk headers can be omitted safely',async()=>{
 const diff="diff --git a/tests/test_review.py b/tests/test_review.py\n--- a/tests/test_review.py\n+++ b/tests/test_review.py\n@@ -0,0 +1 @@ def authenticate(password='fixture')\n+return user\n";
 const f=fixture([],{diffOverride:diff});await assert.rejects(f.source.capture());
 const snapshot=await f.source.capture({confirmRedactions:async()=>true});
 assert.deepEqual(snapshot.omittedFiles,['tests/test_review.py']);assert.ok(!snapshot.diff.includes('fixture'));assert.ok(!snapshot.diff.includes('return user'));
 validateReviewPayload(serializeReviewPayload({worktree,snapshot}));
});
