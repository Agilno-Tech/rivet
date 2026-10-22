import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, symlink, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createResourceCoordinator } from '../../src/runtime/resource-coordinator.js';
const key = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
async function fixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), 'rivet-history-'));
  const root = join(projectRoot, 'machine');
  let time = 1000;
  const c = createResourceCoordinator({ root, now:()=>time });
  const register = runId => c.register({ projectRoot, runId, deadlineMs:100000 });
  const seed = await register('seed');
  async function pressure({live=false,count=256}={}) {
    const path=join(root,'machine.json');
    const snapshot=JSON.parse(await readFile(path,'utf8'));
    while(snapshot.registrations.length<count) {
      const i=snapshot.registrations.length;
      snapshot.registrations.push({...seed,id:`seed-${i}`,runId:`seed-${i}`,cancelled:!live,paused:!live});
    }
    await writeFile(path,JSON.stringify(snapshot),{mode:0o600});
  }
  return {c,root,projectRoot,register,pressure,tick:value=>time=value,restart:()=>createResourceCoordinator({root,now:()=>time})};
}
test('archived cancellation, pause, deadline and exact claims remain fenced after restart', async()=>{
  const f=await fixture();
  const cancelled=await f.register('cancelled');
  await f.c.cancelRegistration(cancelled.id);
  const paused=await f.register('paused');
  const expired=await f.register('expired');
  const continuing=await f.register('continuing');
  const claims=[];
  for(const r of [paused,expired,continuing]) {
    const c=await f.c.request({registrationId:r.id,resource:'agentExecutions',idempotencyKey:'first',generation:1});
    await f.c.release({claimId:c.id,generation:1,completed:true});
    claims.push(c);
  }
  await f.c.pause(paused.id);
  await f.pressure();
  await f.c.inspect();
  assert.equal((await f.c.inspectReadOnly()).registrations.some(r=>r.id===paused.id),false);
  const c=f.restart();
  const before=await stat(join(f.root,'machine.json'));
  assert.equal((await c.getRegistration({registrationId:paused.id})).paused,true);
  assert.equal((await c.getClaim({claimId:claims[0].id})).status,'released');
  assert.equal((await stat(join(f.root,'machine.json'))).mtimeMs,before.mtimeMs);
  assert.equal((await readdir(f.root)).includes('machine.lock'),false);
  await assert.rejects(c.request({registrationId:cancelled.id,resource:'agentExecutions',idempotencyKey:'new',generation:1}),/cancelled/);
  const duplicate=await c.request({registrationId:continuing.id,resource:'agentExecutions',idempotencyKey:'first',generation:1});
  assert.equal(duplicate.id,claims[2].id);
  assert.equal(duplicate.status,'released');
  assert.equal((await c.request({registrationId:paused.id,resource:'agentExecutions',idempotencyKey:'next',generation:1})).reason,'paused');
  assert.equal((await c.request({registrationId:continuing.id,resource:'agentExecutions',idempotencyKey:'next',generation:1})).status,'held');
  f.tick(100001);
  assert.equal((await c.request({registrationId:expired.id,resource:'agentExecutions',idempotencyKey:'next',generation:1})).reason,'deadline');
  const r=await c.register({projectRoot:f.projectRoot,runId:'expired',deadlineMs:200000});
  assert.equal(r.deadlineMs,100000);
});
test('compaction retains parent policies, queued claims and unknown execution owners',async()=>{
  const f=await fixture();
  const parent=await f.c.register({projectRoot:f.projectRoot,deadlineMs:100000,limits:{agentExecutions:1}});
  const r=await f.register('unknown');
  const held=await f.c.request({registrationId:r.id,resource:'agentExecutions',idempotencyKey:'unknown',generation:1});
  await f.c.dispatch({claimId:held.id,generation:1});
  const queued=await f.c.request({registrationId:r.id,resource:'agentExecutions',idempotencyKey:'queued',generation:1});
  await f.pressure();
  const state=await f.c.inspect();
  assert.ok(state.registrations.some(x=>x.id===parent.id));
  assert.ok(state.registrations.some(x=>x.id===r.id));
  assert.equal(state.claims.find(x=>x.id===held.id).status,'held');
  assert.equal(state.claims.find(x=>x.id===queued.id).status,'queued');
  await assert.rejects(f.restart().release({claimId:held.id,generation:1,completed:true}),/stop-unknown/);
});
test('existing registration can be tightened at the full active registration bound',async()=>{
  const f=await fixture();
  await f.pressure({live:true,count:512});
  const existing=await f.c.register({projectRoot:f.projectRoot,runId:'seed',deadlineMs:90000,limits:{workersPerTask:1}});
  assert.equal(existing.deadlineMs,90000);
  await assert.rejects(f.register('overflow'),/registration-limit/);
});
test('unsafe archive directory fails without dropping snapshot history',async()=>{
  const f=await fixture();
  await f.pressure();
  await symlink(f.projectRoot,join(f.root,'history'));
  const before=await readFile(join(f.root,'machine.json'),'utf8');
  await assert.rejects(f.c.inspect(),/Unsafe private machine state/);
  assert.equal(await readFile(join(f.root,'machine.json'),'utf8'),before);
});
test('rehydrated mutations stay in the snapshot until a later committed compaction',async()=>{
  const f=await fixture();
  const r=await f.register('paused');
  const claim=await f.c.request({registrationId:r.id,resource:'agentExecutions',idempotencyKey:'work',generation:1});
  await f.c.release({claimId:claim.id,generation:1,completed:true});
  await f.c.pause(r.id);
  await f.pressure();
  await f.c.inspect();
  const digest=key('registration',r.id);
  const path=join(f.root,'history',digest.slice(0,2),`${digest}.json`);
  assert.equal(JSON.parse(await readFile(path,'utf8')).paused,true);
  await f.c.resume(r.id);
  // The archive is not overwritten with the operation's in-flight mutation.
  assert.equal(JSON.parse(await readFile(path,'utf8')).paused,true);
  assert.equal((await f.restart().getRegistration({registrationId:r.id})).paused,false);
  await assert.rejects(f.c.register({projectRoot:f.projectRoot,runId:'paused',deadlineMs:100000,operationOwner:'wrong'}),/operation-owner/);
  await f.c.inspect();
  assert.equal((await f.restart().getRegistration({registrationId:r.id})).paused,false);
});
test('full registration history makes bounded maintenance progress across large settled runs',async()=>{
  const f=await fixture();
  await f.pressure({count:512});
  const path=join(f.root,'machine.json');
  const snapshot=JSON.parse(await readFile(path,'utf8'));
  // Each of the first candidates exceeds the eight-claim maintenance budget.
  for(const r of snapshot.registrations.slice(1,5)) {
    for(let i=0;i<10;i++) snapshot.claims.push({id:`${r.id}-claim-${i}`,registrationId:r.id,resource:'agentExecutions',idempotencyKey:`work-${i}`,generation:1,sequence:++snapshot.sequence,status:'released',execution:null});
  }
  await writeFile(path,JSON.stringify(snapshot));
  const registered=await f.register('after-full-history');
  assert.equal(registered.runId,'after-full-history');
  assert.ok((await f.c.inspectReadOnly()).registrations.length<=512);
  assert.equal((await f.c.getClaim({claimId:'seed-1-claim-0'})).status,'released');
});

test('archived undispatched retries preserve claim identity and dispatch fence',async()=>{
  const f=await fixture();
  const r=await f.register('retry');
  const first=await f.c.request({registrationId:r.id,resource:'agentExecutions',idempotencyKey:'work',generation:2});
  await f.c.release({claimId:first.id,generation:2,completed:true});
  await f.pressure();
  await f.c.inspect();
  const c=f.restart();
  const retry=await c.request({registrationId:r.id,resource:'agentExecutions',idempotencyKey:'work',generation:2,retryUndispatched:true});
  assert.equal(retry.id,first.id);
  assert.equal(retry.status,'held');
  await c.dispatch({claimId:retry.id,generation:2});
  await assert.rejects(c.release({claimId:retry.id,generation:2,completed:true}),/stop-unknown/);
});
test('byte pressure compacts settled receipts before the snapshot file limit',async()=>{
  const f=await fixture();
  const r=await f.register('large-history');
  for(let i=0;i<12;i++) {
    const c=await f.c.request({registrationId:r.id,resource:'agentExecutions',idempotencyKey:`session-${i}`,generation:1});
    await f.c.hostStop({claimId:c.id,generation:1,sessionId:`session-${i}`,receipt:{source:'host-observation',assurance:'host-reported',status:'stopped',sessionId:`session-${i}`,generation:1,padding:'x'.repeat(150000)}});
  }
  assert.ok((await stat(join(f.root,'machine.json'))).size<2*1024*1024);
  const c=await f.restart().getClaim({registrationId:r.id,resource:'agentExecutions',idempotencyKey:'session-0',generation:1});
  assert.equal(c.status,'released');
});
test('unsafe archived record is rejected without fallback to unmanaged admission',async()=>{
  const f=await fixture();
  const r=await f.register('unsafe');
  await f.c.cancelRegistration(r.id);
  await f.pressure();
  await f.c.inspect();
  const digest=key('registration',r.id);
  const path=join(f.root,'history',digest.slice(0,2),`${digest}.json`);
  const {chmod}=await import('node:fs/promises');
  await chmod(path,0o644);
  await assert.rejects(f.restart().getRegistration({registrationId:r.id}),/Unsafe private machine state/);
});

test('archived identity lookup remains available at a full live bound and mutation fails closed',async()=>{
  const f=await fixture();
  const r=await f.register('archived-at-cap');
  await f.c.cancelRegistration(r.id);
  await f.pressure();
  await f.c.inspect();
  const path=join(f.root,'machine.json');
  const state=JSON.parse(await readFile(path,'utf8'));
  for(const item of state.registrations) { item.cancelled=false; item.paused=false; }
  await writeFile(path,JSON.stringify(state));
  while(state.registrations.length<512) {
    const i=state.registrations.length;
    state.registrations.push({...state.registrations[0],id:`live-cap-${i}`,runId:`live-cap-${i}`});
  }
  await writeFile(path,JSON.stringify(state));
  const before=await readFile(path,'utf8');
  assert.equal((await f.c.getRegistration({registrationId:r.id})).cancelled,true);
  await assert.rejects(f.c.resume(r.id),/registration-limit/);
  assert.equal(await readFile(path,'utf8'),before);
  assert.equal((await f.restart().getRegistration({registrationId:r.id})).cancelled,true);
});

test('claim compaction preserves settlement evidence for registrations outside its bounded batch',async()=>{
  const f=await fixture();
  const runs=[];
  for(let i=0;i<5;i++) runs.push(await f.register(`completed-${i}`));
  const parent=await f.c.register({projectRoot:f.projectRoot,deadlineMs:100000});
  const path=join(f.root,'machine.json');
  const state=JSON.parse(await readFile(path,'utf8'));
  for(let i=0;i<1024;i++) state.claims.push({id:`settled-${i}`,registrationId:i<5?runs[i].id:parent.id,resource:'agentExecutions',idempotencyKey:`work-${i}`,generation:1,sequence:++state.sequence,status:'released',execution:null});
  await writeFile(path,JSON.stringify(state));
  await f.c.inspect();
  // More maintenance pressure, without cancelling or expiring the fifth run.
  await f.pressure();
  await f.c.inspect();
  assert.equal((await f.c.inspectReadOnly()).registrations.some(r=>r.id===runs[4].id),false);
  assert.equal((await f.c.getRegistration({registrationId:runs[4].id})).deadlineMs,100000);
});
