import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile as callback} from 'node:child_process';
import {promisify} from 'node:util';
const execFile=promisify(callback);
async function fixture(t) {
 const root=await realpath(await mkdtemp(join(tmpdir(),'rivet-batch-queue-')));
 t.after(()=>rm(root,{recursive:true,force:true}));await execFile('git',['init','-q',root]);
 const module=await import('../../src/quality/verification-batch-queue.js');
 return module.openBatchQueue(root);
}
const member=id=>({runId:id,identity:id,compatibility:'same'});
test('batch queue freezes FIFO compatible membership and never adopts running ownership',async t=>{
 const q=await fixture(t);
 await q.enqueue([member('one'),member('two'),{...member('other'),compatibility:'other'}]);
 const batch=await q.claim({maxTasks:2,waitMs:30000});assert.deepEqual(batch.members.map(m=>m.runId),['one','two']);
 await q.enqueue([member('late')]);assert.equal(await q.claim({maxTasks:2,waitMs:30000}),null);
 assert.equal((await q.forRun('one')).status,'running');
 await q.finish(batch,{status:'pass'});
 assert.equal((await q.forRun('one')).status,'pass');
});
test('elapsed singleton is actually claimed only after its deadline',async t=>{
 const q=await fixture(t);await q.enqueue([member('one')]);
 assert.equal(await q.claim({maxTasks:2,waitMs:80}),null);
 await new Promise(r=>setTimeout(r,90));
 assert.equal((await q.claim({maxTasks:2,waitMs:80})).members.length,1);
});

test('simultaneous claims execute only one owner and pending runs never display an old pass',async t=>{
 const q=await fixture(t);await q.enqueue([member('one'),member('two')]);
 const claims=await Promise.all([q.claim({maxTasks:2,waitMs:1}),q.claim({maxTasks:2,waitMs:1})]);
 assert.equal(claims.filter(Boolean).length,1);
 await q.finish(claims.find(Boolean),{status:'pass'});
 await q.enqueue([{...member('one'),identity:'new'}]);assert.equal((await q.forRun('one')).status,'queued');
});
test('an incompatible caller cannot change the frozen queue flush policy',async t=>{
 const q=await fixture(t);await q.enqueue([{...member('one'),policy:{maxTasks:3,waitMs:30000}}]);
 assert.equal(await q.claim({maxTasks:2,waitMs:1}),null);
});

test('queue rejects modified durable ownership instead of treating an unknown owner as stopped',async t=>{
 const q=await fixture(t);await q.enqueue([member('one'),member('two')]);await q.claim({maxTasks:2,waitMs:1});
 const {createSnapshotStore}=await import('../../src/state/snapshot-store.js');
 const store=createSnapshotStore(q.paths);const saved=await store.read();saved.data.batches[0].status='pass';
 await store.write(saved.data,{expectedVersion:saved.version});
 await assert.rejects(q.claim({maxTasks:2,waitMs:1}),/integrity/);
 await assert.rejects(q.forRun('one'),/integrity/);
});

test('verbose reports stay separate from bounded queue ownership and do not wedge later batches',async t=>{
 const q=await fixture(t);
 for(let i=0;i<5;i++) {
  const id='run-'+i;await q.enqueue([{...member(id),compatibility:id}]);await new Promise(r=>setTimeout(r,2));
  const cap=await q.claim({maxTasks:2,waitMs:1},[id]);
  await q.finish(cap,{status:'pass',checks:[{id:'gate',output:'x'.repeat(1024*1024)}]});
  assert.equal((await q.forRun(id)).status,'pass');
 }
 const {stat}=await import('node:fs/promises');assert.ok((await stat(q.paths.snapshotPath)).size<100000);
});
test('failed durable queue write leaves the owner capability usable for a blocked fallback',async t=>{
 const q=await fixture(t);await q.enqueue([member('one'),member('two')]);const cap=await q.claim({maxTasks:2,waitMs:1});
 const {acquireLock}=await import('../../src/state/lock.js');let lockPromise;
 // Take the queue snapshot lock after transaction.read(), while the distinct
 // report snapshot is being published, to fault only the final durable write.
 const completion=q.finish(cap,{get status(){lockPromise??=acquireLock(q.paths.lockPath);return 'pass';}});
 while(!lockPromise)await new Promise(r=>setTimeout(r,1));
 const lock=await lockPromise;
 assert.equal((await q.forRun('one')).status,'running');
 try {await assert.rejects(completion);assert.equal((await q.forRun('one')).status,'running');}finally{await lock.release();}
 await q.finish(cap,{status:'blocked',reason:'write failed'});assert.equal((await q.forRun('one')).status,'blocked');
});
test('explicit re-enrollment replaces stale pending heads and invalidates waiting dependencies without changing frozen members',async t=>{
 const q=await fixture(t);await q.enqueue([member('one')]);await q.enqueue([{...member('one'),identity:'new'}]);
 await q.enqueue([member('two')]);const cap=await q.claim({maxTasks:2,waitMs:1});assert.equal(cap.members[0].identity,'new');
 await q.finish(cap,{status:'dependencies-needed'});
 await q.enqueue([{...member('one'),identity:'newer'}]);
 assert.equal((await q.forRun('one')).status,'queued');assert.equal((await q.forRun('two')).status,'blocked');
 const {createSnapshotStore}=await import('../../src/state/snapshot-store.js');const state=(await createSnapshotStore(q.paths).read()).data;
 assert.equal(state.batches[0].members[0].identity,'new');assert.equal(state.pending[0].identity,'newer');
 const second=await q.claim({maxTasks:2,waitMs:1});
 if(second)await assert.rejects(q.enqueue([{...member('one'),identity:'again'}]),/Frozen/);
});
