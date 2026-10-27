import test from 'node:test';
import assert from 'node:assert/strict';

test('task review payload binds exact inputs and rejects credential material',async()=>{
 const {serializeTaskReviewPayload,validateTaskReviewPayload}=await import('../../src/quality/task-review-client.js');
 const context={subject:{headSha:'a'.repeat(40)},patch:'diff --git a/a b/a\n+safe',reportTemplate:{status:'FAIL'}};
 const worktree={path:'/tmp/review',dev:'1',ino:'2',reservationId:'review-read-only'};
 const payload=serializeTaskReviewPayload({worktree,context});
 assert.equal(validateTaskReviewPayload(payload).context.patch,context.patch);
 assert.match(payload,/Do not decide product questions/);
 assert.throws(()=>serializeTaskReviewPayload({worktree,context:{...context,patch:'Bearer abcdefghijklmnop'}}));
 assert.throws(()=>validateTaskReviewPayload(payload.replace('rivet.task-review','rivet.other')));
});

test('task reviewer output schema is compatible with strict structured output',async()=>{
 const {taskReviewSchema}=await import('../../src/quality/task-review-client.js');
 const visit=value=>{if(!value||typeof value!=='object')return;if(value.type==='object'){assert.equal(value.additionalProperties,false);assert.deepEqual([...value.required].sort(),Object.keys(value.properties).sort());}for(const child of Object.values(value))if(Array.isArray(child))child.forEach(visit);else visit(child);};
 visit(taskReviewSchema);
});

test('worker product questions are blocked results and cannot masquerade as success',async()=>{
 const {captureRuntimeResult}=await import('../../src/runtime/orchestrator.js');
 const question={id:'format',title:'Choose format',options:[{id:'json',description:'Use JSON'},{id:'text',description:'Use plain text'}],choice:'json',rationale:'Human product choice is needed.'};
 const result={version:1,status:'blocked',output:{summary:'Waiting for answer',evidence:[],question},usage:{tokens:5,costUsd:0}};
 assert.equal(captureRuntimeResult(result).output.question.id,'format');
 assert.throws(()=>captureRuntimeResult({...result,status:'success'}));
});

test('product questions distinguish worker and reviewer sources with the same name',async()=>{
 const {scopedProductQuestion}=await import('../../src/feature/product-question.js');
 const question={id:'format',title:'Choose format',options:[{id:'json',description:'Use JSON'},{id:'text',description:'Use plain text'}],choice:'json',rationale:'Human product choice is needed.'};
 const worker=scopedProductQuestion(question,'worker:general');
 assert.notEqual(worker.id,scopedProductQuestion(question,'reviewer:general').id);
 assert.equal(worker.id,scopedProductQuestion(question,'worker:general').id);
});
