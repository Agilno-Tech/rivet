import test from 'node:test';
import assert from 'node:assert/strict';
import {validateReport,serializeReviewPayload,validateReviewPayload,reviewReportSchema} from '../../src/review/contract.js';
const snapshot={url:'https://github.com/a/b/pull/1',headSha:'a'.repeat(40),baseSha:'b'.repeat(40),diffDigest:'c'.repeat(64),diff:'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1,2 +1,2 @@\n a\n-old\n+new\n'};
const report={url:snapshot.url,headSha:snapshot.headSha,baseSha:snapshot.baseSha,diffDigest:snapshot.diffDigest,summary:'One defect',findings:[{path:'src/a.js',line:2,severity:'high',message:'Missing guard'}],limitations:['Checks not executed']};
test('findings bind exact captured identity and reject stale results',()=>{
 assert.deepEqual(JSON.parse(JSON.stringify(validateReport(report,snapshot))),report);
 for(const key of ['headSha','baseSha','diffDigest','url'])assert.throws(()=>validateReport({...report,[key]:'wrong'},snapshot));
 assert.throws(()=>validateReport({...report,findings:[{...report.findings[0],path:'../secret'}]},snapshot));
 assert.throws(()=>validateReport({...report,approved:true},snapshot));
});
test('review payload is canonical data with tools and changes forbidden',()=>{
 const source=serializeReviewPayload({worktree:{path:'/tmp/review',dev:'1',ino:'2',reservationId:'review-read-only'},snapshot});
 const payload=validateReviewPayload(source);assert.equal(payload.worktree.path,'/tmp/review');
 assert.throws(()=>validateReviewPayload(source.replace('rivet.pull-request-review','rivet.other')));
 assert.equal(reviewReportSchema.additionalProperties,false);
});
test('findings cannot cite unseen paths, uncaptured lines or terminal controls',()=>{
 for(const finding of [{...report.findings[0],path:'missing.js'},{...report.findings[0],line:99},{...report.findings[0],message:'bad\u001b[0m'}])assert.throws(()=>validateReport({...report,findings:[finding]},snapshot));
});
