import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verificationIdentity } from '../../src/quality/verification-identity.js';

test('identity fingerprints contents and private environment without retaining either', async t => {
  const root=await realpath(await mkdtemp(join(tmpdir(),'reuse-'))); t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'deps')); await mkdir(join(root,'tools')); await writeFile(join(root,'deps','a'),'one');
  const input={projectRoot:root,commitSha:'a'.repeat(40),gates:[{executable:process.execPath,artifactPaths:[],tests:[],resultPath:null}],environment:{SECRET:'private-value'},reuse:{configDigest:'b'.repeat(64),policy:{enabled:true,reproducible:true,dependencyRoots:['deps'],toolchainRoots:['tools']}}};
  const key=Buffer.alloc(32,7); const first=await verificationIdentity(input,key);
  assert.equal(first.reason,null); assert.match(first.identity,/^[a-f0-9]{64}$/); assert.ok(!JSON.stringify(first).includes('private-value'));
  await writeFile(join(root,'deps','a'),'two'); assert.notEqual((await verificationIdentity(input,key)).identity,first.identity);
  const latest=await verificationIdentity(input,key);
  assert.notEqual((await verificationIdentity({...input,environment:{SECRET:'changed'}},key)).identity,latest.identity);
  assert.notEqual((await verificationIdentity({...input,commitSha:'c'.repeat(40)},key)).identity,latest.identity);
  const executable=join(root,'tools','executable');await writeFile(executable,'binary-v1');
  const other={...input,gates:[{...input.gates[0],executable}]};const before=await verificationIdentity(other,key);
  await writeFile(executable,'binary-v2');assert.notEqual((await verificationIdentity(other,key)).identity,before.identity);
});
test('reuse accepts a canonical shell interpreter and rejects its symlink alias',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'reuse-shell-')));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'deps'));await mkdir(join(root,'tools'));
 const shell=await realpath('/bin/sh'),alias=join(root,'shell-alias'),executable=join(root,'gate');
 await symlink(shell,alias);
 const input={projectRoot:root,commitSha:'a'.repeat(40),gates:[{executable,artifactPaths:[],tests:[],resultPath:null}],environment:{},reuse:{configDigest:'b'.repeat(64),policy:{enabled:true,reproducible:true,dependencyRoots:['deps'],toolchainRoots:['tools']}}};
 const key=Buffer.alloc(32,7);
 await writeFile(executable,`#!${alias}\nexit 0\n`);
 assert.equal((await verificationIdentity(input,key)).reason,'inputs-not-safely-fingerprintable');
 await writeFile(executable,`#!${shell}\nexit 0\n`);
 assert.match((await verificationIdentity(input,key)).identity,/^[a-f0-9]{64}$/);
});
test('unsafe or unattested inputs bypass reuse',async()=>{
  for(const reuse of [undefined,{policy:{enabled:true,reproducible:false}}]) assert.equal((await verificationIdentity({reuse},Buffer.alloc(32))).identity,null);
});

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createGitClient } from '../../src/git/client.js';
import { createAuthorityEnvelope } from '../../src/policy/authority.js';
import { runQualityGates, assertQualityRun } from '../../src/quality/runner.js';
import { openVerificationQueue } from '../../src/quality/verification-queue.js';
const execFile=promisify(execFileCallback);
async function fixture(t) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'reuse-git-')));t.after(()=>rm(root,{recursive:true,force:true}));
  await execFile('git',['init','-q',root]);
  await mkdir(join(root,'deps'));await mkdir(join(root,'tools'));
  await writeFile(join(root,'deps','input'),'one');await writeFile(join(root,'tools','input'),'one');
  await writeFile(join(root,'gate.cjs'),"setTimeout(()=>require('fs').appendFileSync(process.argv[2], 'run\\n'), Number(process.env.VERIFY_DELAY || 0));");
  await execFile('git',['-C',root,'add','.']);await execFile('git',['-C',root,'-c','user.name=Test','-c','user.email=t@example.com','commit','-qm','init']);
  const commitSha=(await execFile('git',['-C',root,'rev-parse','HEAD'])).stdout.trim();
  const gitExecutable=await realpath((await execFile('which',['git'])).stdout.trim());
  const gitClient=await createGitClient({gitExecutable});
  const count=join(root,'.git','count');
  const input={projectRoot:root,commitSha,authority:createAuthorityEnvelope({actorId:'quality-worker',principal:'agent',actions:['command.unit'],ownedPaths:[],providers:[],commands:['unit']}),gates:[{id:'unit',executable:process.execPath,execution:'argv',args:[join(root,'gate.cjs'),count],cwd:'.',required:true,artifactPaths:[],tests:[]}],reuse:{configDigest:'a'.repeat(64),policy:{enabled:true,reproducible:true,dependencyRoots:['deps'],toolchainRoots:['tools']}}};
  return {root,input,gitClient,count};
}
test('runner reuses exact passing verification, brands inside boundary, and invalidates changed policy',async t=>{
  const {input,gitClient,count}=await fixture(t);
  const first=await runQualityGates(input,{gitClient});assert.equal(first.verificationReuse.status,'executed');
  const second=await runQualityGates(input,{gitClient});assert.equal(second.verificationReuse.status,'reused');assertQualityRun(second);
  assert.throws(()=>assertQualityRun(JSON.parse(JSON.stringify(second))));assert.equal(await readFile(count,'utf8'),'run\n');
  const changed=await runQualityGates({...input,reuse:{...input.reuse,configDigest:'b'.repeat(64)}},{gitClient});assert.equal(changed.verificationReuse.status,'executed');assert.equal(await readFile(count,'utf8'),'run\nrun\n');
});
test('runner cancellation detaches waiter without cancelling owner, and corrupt state fails closed',async t=>{
  const {root,input,gitClient,count}=await fixture(t);input.environment={VERIFY_DELAY:'1000'};
  const owner=runQualityGates(input,{gitClient});
  await new Promise(r=>setTimeout(r,600));const controller=new AbortController();
  const waiter=runQualityGates(input,{gitClient,signal:controller.signal});
  setTimeout(()=>controller.abort(),200);
  await assert.rejects(waiter,/cancelled/);await owner;
  assert.equal(await readFile(count,'utf8'),'run\n');
  const path=join(root,'.git','rivet','verification-reuse','snapshot.json');const data=JSON.parse(await readFile(path,'utf8'));data.data.entries[0].result={timings:[['fake','fake']]};await writeFile(path,JSON.stringify(data)+'\n');
  await assert.rejects(runQualityGates(input,{gitClient}),/corrupt-state/);
});
test('separate OS processes execute one shared runner generation',async t=>{
  const {root,input,count}=await fixture(t);input.environment={VERIFY_DELAY:'1000'};
  const runnerUrl=new URL('../../src/quality/runner.js',import.meta.url).href;
  const gitUrl=new URL('../../src/git/client.js',import.meta.url).href;
  const authorityUrl=new URL('../../src/policy/authority.js',import.meta.url).href;
  const gitExecutable=await realpath((await execFile('which',['git'])).stdout.trim());
  const code=`import {runQualityGates} from ${JSON.stringify(runnerUrl)};import {createGitClient} from ${JSON.stringify(gitUrl)};import {createAuthorityEnvelope} from ${JSON.stringify(authorityUrl)}; const input=JSON.parse(process.argv[1]);input.authority=createAuthorityEnvelope(input.authority);const gitClient=await createGitClient({gitExecutable:process.argv[2]});const r=await runQualityGates(input,{gitClient});console.log(r.verificationReuse.status);`;
  const results=await Promise.all([1,2].map(()=>execFile(process.execPath,['--input-type=module','-e',code,JSON.stringify(input),gitExecutable])));
  assert.equal(await readFile(count,'utf8'),'run\n');assert.deepEqual(results.map(x=>x.stdout.trim()).sort(),['executed','reused']);
});
test('healthy shared verification may run longer than ten seconds',async t=>{
  const {input,gitClient,count}=await fixture(t);input.environment={VERIFY_DELAY:'11000'};
  const results=await Promise.all([runQualityGates(input,{gitClient}),runQualityGates(input,{gitClient})]);
  assert.deepEqual(results.map(x=>x.verificationReuse.status).sort(),['executed','reused']);assert.equal(await readFile(count,'utf8'),'run\n');
});
test('crashed owner remains blocked; PID absence does not authorize stealing',async t=>{
  const {root}=await fixture(t);await openVerificationQueue(root);
  const moduleUrl=new URL('../../src/quality/verification-queue.js',import.meta.url).href;
  const code=`import {openVerificationQueue} from ${JSON.stringify(moduleUrl)};const q=await openVerificationQueue(process.argv[1]);await q.execute('e'.repeat(64),async()=>process.exit(0));`;
  await execFile(process.execPath,['--input-type=module','-e',code,root]);
  const q=await openVerificationQueue(root);let ran=false;
  await assert.rejects(q.execute('e'.repeat(64),()=>{ran=true;},{waitMs:100}),error=>error.queued===true && error.code==='ERR_VERIFICATION_PENDING' && error.reason==='owner-unresolved');assert.equal(ran,false);
});
test('denied authority never obtains cached proof; secrets stay out of persisted records',async t=>{
  const {root,input,gitClient}=await fixture(t);
  input.environment={MY_SECRET:'a-private-fixture-value'};
  await runQualityGates(input,{gitClient});
  const data=await readFile(join(root,'.git','rivet','verification-reuse','snapshot.json'),'utf8');
  assert.ok(!data.includes('a-private-fixture-value'));assert.ok(!data.includes('MY_SECRET'));
  const denied=createAuthorityEnvelope({actorId:'quality-worker',principal:'agent',actions:[],ownedPaths:[],providers:[],commands:[]});
  await assert.rejects(runQualityGates({...input,authority:denied},{gitClient}));
});
test('unsafe roots bypass and failed executions are retried as new generations',async t=>{
  const {root,input,gitClient,count}=await fixture(t);
  const unsafe={...input,reuse:{...input.reuse,policy:{...input.reuse.policy,dependencyRoots:['../outside']}}};
  const output=await runQualityGates(unsafe,{gitClient});assert.equal(output.verificationReuse.status,'inputs-not-safely-fingerprintable');assert.equal(await readFile(count,'utf8'),'run\n');
  const q=await openVerificationQueue(root);let countRuns=0;
  await q.execute('f'.repeat(64),async()=>{countRuns++;return null;});
  await q.execute('f'.repeat(64),async()=>{countRuns++;return null;});assert.equal(countRuns,2);
});
import { loadProjectConfig } from '../../src/config/load.js';
import { validateProjectConfiguration } from '../../src/config/validate.js';
import { fileURLToPath } from 'node:url';
test('quality config requires reproducibility and safe explicit roots before enabling reuse',async()=>{
  const config=structuredClone(await loadProjectConfig(fileURLToPath(new URL('../fixtures/config/valid',import.meta.url))));
  config.quality.verificationReuse={enabled:true};assert.throws(()=>validateProjectConfiguration(config));
  config.quality.verificationReuse={enabled:true,reproducible:true,dependencyRoots:['deps'],toolchainRoots:['tools']};assert.equal(validateProjectConfiguration(config),true);
  for(const path of ['../escape','/absolute','.git','deps/*','.GIT','node_modules','.rivet-deps','folder./x','con','foo:bar','space dir','Ａ','a'.repeat(257)]) {
    config.quality.verificationOutputs=[path];assert.throws(()=>validateProjectConfiguration(config));
  }
  config.quality.verificationOutputs=['reports','coverage'];assert.equal(validateProjectConfiguration(config),true);
});

test('generic queue completion cannot manufacture branded passing proof',async t=>{
 const {root,input,gitClient}=await fixture(t);
 input.gates[0].args=['-e','process.exit(1)'];
 assert.equal((await runQualityGates(input,{gitClient})).status,'fail');
 const snapshot=JSON.parse(await readFile(join(root,'.git','rivet','verification-reuse','snapshot.json'),'utf8'));
 const q=await openVerificationQueue(root);assert.equal(q.key,undefined);
 await assert.rejects(q.execute(snapshot.data.entries[0].identity,async()=>({timings:[['2026-10-16T00:00:00.000Z','2026-10-16T00:00:01.000Z']]})));
 const next=await runQualityGates(input,{gitClient});assertQualityRun(next);assert.equal(next.status,'fail');
});

import { chmod } from 'node:fs/promises';
test('directory and checkout permission changes invalidate real gate evidence',async t=>{
  for(const directory of ['deps','tools','.'])await t.test(directory,async t=>{
    const {root,input,gitClient,count}=await fixture(t);
    const target=join(root,directory);
    await chmod(target,0o755);
    await writeFile(join(root,'gate.cjs'),"const fs=require('fs');fs.appendFileSync(process.argv[2], 'run\\n');if((fs.statSync(process.argv[3]).mode & 0o200) === 0)process.exit(1);");
    await execFile('git',['-C',root,'add','gate.cjs']);
    await execFile('git',['-C',root,'-c','user.name=Test','-c','user.email=t@example.com','commit','-qm','permission-sensitive gate']);
    input.commitSha=(await execFile('git',['-C',root,'rev-parse','HEAD'])).stdout.trim();
    input.gates[0].args.push(target);
    const first=await runQualityGates(input,{gitClient});assert.equal(first.status,'pass');
    assert.equal((await runQualityGates(input,{gitClient})).verificationReuse.status,'reused');
    try {
      await chmod(target,0o555);
      const changed=await runQualityGates(input,{gitClient});
      assert.equal(changed.verificationReuse.status,'executed');assert.equal(changed.status,'fail');
      assert.equal(await readFile(count,'utf8'),'run\nrun\n');
    }finally{await chmod(target,0o755);}
  });
});
