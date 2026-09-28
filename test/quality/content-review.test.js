import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReviewPolicy, validateReviewReport, evaluateReviewReports } from '../../src/quality/content-review.js';
const digest='sha256:'+'a'.repeat(64), sha='b'.repeat(40), nowMs=Date.parse('2026-09-28T12:00:00Z');
const subject={phase:'final',runId:'run-1',requestDigest:digest,planDigest:digest,baseSha:sha,headSha:sha,diffDigest:digest,acceptanceCriteria:['Health responds successfully'],planNodeIds:['worker-1'],changedPaths:['src/health.js'],workerActorIds:['worker-1']};
const report=(overrides={})=>({...Object.fromEntries(['phase','runId','requestDigest','planDigest','baseSha','headSha','diffDigest'].map(k=>[k,subject[k]])),reviewerId:'general',actorId:'reviewer-1',round:1,status:'PASS',blocking:false,coverage:[{criterionIndex:1,planNodeIds:['worker-1'],paths:['src/health.js'],evidence:[{kind:'test',reference:'test-health',summary:'Health behavior checked'}]}],findings:[],filesReviewed:['src/health.js'],commandsExecuted:['node --test test/health.js'],checkedAt:new Date(nowMs).toISOString(),...overrides});
const evaluate=(reports,policy={required:true},s=subject)=>evaluateReviewReports(policy,s,reports,{nowMs});
test('missing required review blocks and fallback general review passes without adding an agent',()=>{
 assert.deepEqual(normalizeReviewPolicy().reviewers,[]);
 assert.equal(evaluate([]).valid,false);
 assert.deepEqual(evaluate([]).requiredReviewerIds,['general']);
 const result=evaluate([report()]);assert.equal(result.valid,true);assert.equal(result.rounds,1);assert.equal(Object.isFrozen(result),true);
});
test('stale subject identity, self-review, extra fields and malformed verdicts reject',()=>{
 for(const value of [report({headSha:'c'.repeat(40)}),report({actorId:'worker-1'}),report({status:'PASS',blocking:true}),report({extra:true}),report({checkedAt:new Date(nowMs+1).toISOString()}),report({round:0})])assert.throws(()=>evaluate([value]));
});
test('PASS requires every criterion, evidence, known plan nodes and reviewed changed paths',()=>{
 for(const value of [report({coverage:[]}),report({filesReviewed:[]}),report({coverage:[{...report().coverage[0],evidence:[]}]}),report({coverage:[{...report().coverage[0],planNodeIds:['unknown']}]}),report({findings:[{kind:'missing',summary:'Missing behavior',blocking:true}]})])assert.throws(()=>validateReviewReport(subject,value,{nowMs}));
 assert.throws(()=>validateReviewReport({...subject,acceptanceCriteria:['one','two']},report(),{nowMs}));
});
test('failed review is retained, later same-subject round can pass, and cap escalates without clearing blockers',()=>{
 const failed=report({status:'FAIL',blocking:true,coverage:[],filesReviewed:[],findings:[{kind:'missing',summary:'Missing acceptance coverage',blocking:true}]});
 assert.equal(evaluate([failed]).valid,false);
 assert.equal(evaluate([failed,report({round:2})]).valid,true);
 const capped=evaluate([failed],{required:true,maxRounds:1});assert.equal(capped.humanEscalation,true);assert.equal(capped.valid,false);
 assert.throws(()=>evaluate([report({round:2})],{required:true,maxRounds:1}));
 assert.throws(()=>evaluate([report(),report()]));
});
test('strict path coverage blocks; default policy assigns unmatched paths to general',()=>{
 const policy={required:true,reviewers:[{id:'security',paths:['src/auth/**'],required:true}]};
 assert.deepEqual(evaluate([],policy).requiredReviewerIds,['general']);
 const result=evaluate([],{...policy,strictCoverage:true});assert.equal(result.valid,false);assert.ok(result.blockers.some(x=>x.code==='uncovered-path'));
});
test('matching configured reviewer is required and wildcard does not cross a path segment',()=>{
 const policy={required:true,reviewers:[{id:'security',paths:['src/*.js'],required:true}]};
 assert.deepEqual(evaluate([],policy).requiredReviewerIds,['security']);
 assert.equal(evaluate([report({reviewerId:'security'})],policy).valid,true);
 assert.deepEqual(evaluate([],policy,{...subject,changedPaths:['src/nested/health.js']}).requiredReviewerIds,['general']);
});
test('plan review permits an empty diff but still requires acceptance-to-plan evidence',()=>{
 const plan={...subject,phase:'plan',changedPaths:[]};const value=report({phase:'plan',filesReviewed:[],coverage:[{...report().coverage[0],paths:[]}]});
 assert.equal(evaluate([value],{required:true},plan).valid,true);
 assert.throws(()=>evaluate([report({phase:'plan',filesReviewed:[],coverage:[]})],{required:true},plan));
});
test('disabled policy preserves legacy workflow but validates supplied reviews',()=>{
 assert.equal(evaluateReviewReports(undefined,subject,[],{nowMs}).valid,true);
 assert.throws(()=>evaluateReviewReports(undefined,subject,[report({actorId:'worker-1'})],{nowMs}));
});
test('malformed policies, unsafe paths, unbounded fields and unknown report reviewers reject',()=>{
 for(const p of [{maxRounds:0},{required:'yes'},{reviewers:[{id:'security',paths:['../**'],required:true}]},{reviewers:[{id:'same',paths:['**'],required:true},{id:'same',paths:['**'],required:false}]}])assert.throws(()=>normalizeReviewPolicy(p));
 assert.throws(()=>evaluate([report({filesReviewed:['../secret']})]));
 assert.throws(()=>evaluate([report({commandsExecuted:['x'.repeat(4097)]})]));
 assert.throws(()=>evaluate([report({reviewerId:'unknown'})]));
});
test('recursive globs cover root and nested paths; assignments permit focused file review',()=>{
 const s={...subject,changedPaths:['src/health.js','docs/readme.md']};
 const policy={required:true,reviewers:[{id:'code',paths:['**/*.js'],required:true},{id:'docs',paths:['docs/**'],required:true}]};
 const code=report({reviewerId:'code'});
 const docs=report({reviewerId:'docs',filesReviewed:['docs/readme.md'],coverage:[{...report().coverage[0],paths:['docs/readme.md']}]});
 assert.equal(evaluate([code,docs],policy,s).valid,true);
 assert.equal(evaluate([code],policy,s).valid,false);
 assert.deepEqual(evaluate([], {required:true,reviewers:[{id:'code',paths:['**/*.js'],required:true}]}, {...subject,changedPaths:['health.js']}).requiredReviewerIds,['code']);
});
test('optional reviewers cannot leave changed content unreviewed in required policy',()=>{
 const result=evaluate([],{required:true,reviewers:[{id:'optional',paths:['**'],required:false}]});
 assert.equal(result.valid,false);assert.ok(result.blockers.some(item=>item.code==='unreviewed-path'));
});
test('fallback cannot lose required status when a configured general reviewer is optional',()=>{
 const s={...subject,changedPaths:['src/health.js','docs/readme.md']};
 const result=evaluate([],{required:true,reviewers:[{id:'general',paths:['src/**'],required:false}]},s);
 assert.deepEqual(result.requiredReviewerIds,['general']);
});
test('getters, sparse arrays and unsupported glob grammar reject without executing accessors',()=>{
 let called=false;const value=report();Object.defineProperty(value,'status',{enumerable:true,get(){called=true;return 'PASS';}});
 assert.throws(()=>evaluate([value]));assert.equal(called,false);
 const coverage=new Array(1);assert.throws(()=>evaluate([report({coverage})]));
 assert.throws(()=>normalizeReviewPolicy({reviewers:[{id:'bad',required:true,paths:['a**b']}]}));
});
test('criterion-specific worker mapping rejects unrelated known nodes',()=>{
 const mapped={...subject,planNodeIds:['worker-1','worker-2'],criterionPlanNodeIds:[['worker-1']]};
 assert.equal(evaluate([report()],{required:true},mapped).valid,true);
 assert.throws(()=>evaluate([report({coverage:[{...report().coverage[0],planNodeIds:['worker-2']}]})],{required:true},mapped));
 for(const map of [[],[[]],[['unknown']],[['worker-1'],['worker-2']]])assert.throws(()=>evaluate([],{required:true},{...mapped,criterionPlanNodeIds:map}));
});
test('literal framework route brackets and SHA-256 Git identities remain supported',()=>{
 const path='app/[tenant]/(dashboard)/{layout}.tsx';
 const s={...subject,baseSha:'b'.repeat(64),headSha:'c'.repeat(64),changedPaths:[path]};
 const value=report({baseSha:s.baseSha,headSha:s.headSha,filesReviewed:[path],coverage:[{...report().coverage[0],paths:[path]}]});
 const result=evaluate([value],{required:true,reviewers:[{id:'general',paths:['app/[tenant]/**'],required:true}]},s);
 assert.equal(result.valid,true);assert.deepEqual(result.reviewerPaths,{general:[path]});
});
