import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, realpath, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitClient } from '../../src/git/client.js';
import { resolveStatePaths } from '../../src/state/paths.js';
import { createAuthorityEnvelope } from '../../src/policy/authority.js';
import { runQualityGates } from '../../src/quality/runner.js';
import { integrateFeatureWorker } from '../../src/feature/worker-integration.js';
import { createReservedWorktree } from '../../src/git/worktrees.js';
const execFile = promisify(callback);
const git = async (cwd, ...args) => (await execFile('git', ['-C', cwd, ...args])).stdout.trim();
async function commit(path, name, content) {
  await writeFile(join(path, name), content); await git(path, 'add', '--', name);
  await git(path, '-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'change');
  return git(path, 'rev-parse', 'HEAD');
}
async function fixture(t, conflict = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rivet-candidate-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = join(root, 'repo'); await mkdir(primary); await git(primary, 'init', '-q', '-b', 'main');
  await writeFile(join(primary,'.gitignore'),'build.log\nreports/\n');
  await git(primary,'add','.gitignore');
  const baseSha = await commit(primary, 'base', 'base\n');
  const gitClient = await createGitClient({gitExecutable: await realpath('/usr/bin/git')});
  const statePaths = await resolveStatePaths(primary, 'test-run');
  const target = join(root, 'integration'); await gitClient.createWorktree(primary, {path:target,branch:'feature/integration',baseSha});
  const participants = [];
  for (const name of ['one','two']) {
    const sourcePath = join(root, name), sourceBranch = 'feature/' + name;
    const created=await createReservedWorktree({projectRoot:target,statePaths,nodeId:name,ownerId:'manager',branch:sourceBranch,worktreePath:sourcePath,baseSha,responsibilities:[name],intendedPaths:[name],expiresAt:new Date(Date.now()+3600000).toISOString()}, {gitClient});
    const sourceSha = await commit(sourcePath, conflict ? 'base' : name, name + '\n');
    participants.push({runId:'test-run',nodeId:name,sourcePath,sourceBranch,sourceSha,leaseId:created.reservation.leaseId});
  }
  const request = {projectRoot:target,statePaths,candidateId:'candidate-one',baseSha,policyDigest:'a'.repeat(64),participants};
  const options = {gitClient,validateOwner:async () => {}};
  const verify = manifest => runQualityGates({projectRoot:manifest.path,commitSha:manifest.commitSha,
    authority:createAuthorityEnvelope({actorId:'quality',principal:'agent',actions:['command.unit'],ownedPaths:[],providers:[],commands:['unit']}),
    gates:[{id:'unit',executable:'/usr/bin/true',args:[],cwd:'.',required:true,artifactPaths:[],tests:[]}]}, {gitClient});
  return {root,primary,target,request,options,gitClient,verify};
}

function requests(f) {
  let ledger=null;
  const acceptedStore={readOnly:async()=>ledger,write:async value=>{ledger=value;return value;}};
  const options={...f.options,acceptedStore,verify:f.verify};
  const request = p => ({projectRoot:f.target,statePaths:f.request.statePaths,nodeId:p.nodeId,ownerId:'manager',
    leaseId:p.leaseId,integrationBranch:'feature/integration',integrate:true,runId:'test-run',
    baselineCommit:f.request.baseSha,runtimeVersion:2,intentId:'intent-'+p.nodeId,
    sessionId:'session-'+p.nodeId,generation:1,policyDigest:'a'.repeat(64)});
  return {options,request,ledger:()=>ledger};
}
test('shared worker integration preserves same-base siblings and publishes verified accepted tips', async t=>{
  const f=await fixture(t), r=requests(f);
  const first=await integrateFeatureWorker(r.request(f.request.participants[0]),r.options);
  const second=await integrateFeatureWorker(r.request(f.request.participants[1]),r.options);
  assert.equal(first.status,'integrated');assert.equal(second.status,'integrated');
  for(const p of f.request.participants)assert.equal(await f.gitClient.isAncestor(f.target,p.sourceSha,second.integrationTip),true);
  assert.equal(r.ledger().commitSha,second.integrationTip);
});
test('failed candidate verification and source drift preserve the accepted ledger and target', async t=>{
  for(const mode of ['failed','source']){
    const f=await fixture(t),r=requests(f);
    await assert.rejects(integrateFeatureWorker(r.request(f.request.participants[0]),{...r.options,verify:async manifest=>{
      if(mode==='source'){const proof=await f.verify(manifest);await commit(f.request.participants[0].sourcePath,'one','changed');return proof;}
      return runQualityGates({projectRoot:manifest.path,commitSha:manifest.commitSha,
        authority:createAuthorityEnvelope({actorId:'quality',principal:'agent',actions:['command.unit'],ownedPaths:[],providers:[],commands:['unit']}),
        gates:[{id:'unit',executable:'/usr/bin/false',args:[],cwd:'.',required:true,artifactPaths:[],tests:[]}]},{gitClient:f.gitClient});
    }}));
    assert.equal(await git(f.target,'rev-parse','HEAD'),f.request.baseSha);assert.equal(r.ledger(),null);
  }
});
test('arbitrary target movement is not adopted as peer progress', async t=>{
  const f=await fixture(t),r=requests(f);
  const other=await commit(f.target,'foreign','foreign');
  await assert.rejects(integrateFeatureWorker(r.request(f.request.participants[0]),r.options),/target changed/);
  assert.equal(await git(f.target,'rev-parse','HEAD'),other);assert.equal(r.ledger(),null);
});
test('ledger publication failure is recovered from durable exact acceptance', async t=>{
  const f=await fixture(t),r=requests(f);let failures=1;
  const options={...r.options,acceptedStore:{...r.options.acceptedStore,write:async value=>{
    if(failures-- > 0)throw new Error('publication lost');return r.options.acceptedStore.write(value);
  }}};
  const request=r.request(f.request.participants[0]);
  await assert.rejects(integrateFeatureWorker(request,options),/publication lost/);
  assert.equal(r.ledger(),null);
  const result=await integrateFeatureWorker(request,options);
  assert.equal(result.status,'integrated');assert.equal(r.ledger().commitSha,result.integrationTip);
});
test('verified peer acceptance during verification rebuilds against the new ledger without regressing version', async t=>{
  const f=await fixture(t),r=requests(f);let peer=false,verifications=0;
  const request=r.request(f.request.participants[0]);
  const result=await integrateFeatureWorker(request,{...r.options,verify:async manifest=>{
    verifications++;
    const proof=await f.verify(manifest);
    if(!peer){peer=true;await integrateFeatureWorker({...r.request(f.request.participants[1]),runtimeVersion:9},r.options);}
    return proof;
  }});
  assert.equal(verifications,2);assert.equal(r.ledger().runtimeVersion,9);
  for(const p of f.request.participants)assert.equal(await f.gitClient.isAncestor(f.target,p.sourceSha,result.integrationTip),true);
});
test('peer publication window waits for the integration transaction before diagnosing drift', async t=>{
  const f=await fixture(t),r=requests(f);
  let entered,release;
  const publicationEntered=new Promise(resolve=>{entered=resolve;});
  const publicationReleased=new Promise(resolve=>{release=resolve;});
  const first=integrateFeatureWorker(r.request(f.request.participants[0]),{...r.options,
    acceptedStore:{...r.options.acceptedStore,write:async value=>{
      entered();await publicationReleased;return r.options.acceptedStore.write(value);
    }}});
  await publicationEntered;
  let timer;
  const secondOptions={...r.options,acceptedStore:{...r.options.acceptedStore,readOnly:async()=>{
    timer ??= setTimeout(release,1_500);
    return r.options.acceptedStore.readOnly();
  }}};
  try {
    const second=await integrateFeatureWorker(r.request(f.request.participants[1]),secondOptions);
    assert.equal(second.status,'integrated');
    await first;
    for(const p of f.request.participants)assert.equal(await f.gitClient.isAncestor(f.target,p.sourceSha,second.integrationTip),true);
  } finally { clearTimeout(timer);release();await first; }
});

test('live lease clock is re-evaluated after verification', async t=>{
  const f=await fixture(t),r=requests(f);let now=Date.now();
  await assert.rejects(integrateFeatureWorker(r.request(f.request.participants[0]),{
    ...r.options,nowMs:()=>now,verify:async manifest=>{
      const proof=await f.verify(manifest);now+=2*3600000;return proof;
    }
  }),error=>error.code==='ERR_WORKTREE_STALE_LEASE');
  assert.equal(await git(f.target,'rev-parse','HEAD'),f.request.baseSha);
  assert.equal(r.ledger(),null);
});
