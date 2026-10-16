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
import { prepareIntegrationCandidate, inspectIntegrationCandidate, acceptIntegrationCandidate } from '../../src/git/integration-candidate.js';
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
    await gitClient.createWorktree(primary, {path:sourcePath,branch:sourceBranch,baseSha});
    const sourceSha = await commit(sourcePath, conflict ? 'base' : name, name + '\n');
    participants.push({runId:'test-run',nodeId:name,sourcePath,sourceBranch,sourceSha});
  }
  const request = {projectRoot:target,statePaths,candidateId:'candidate-one',baseSha,policyDigest:'a'.repeat(64),participants};
  const options = {gitClient,validateOwner:async () => {}};
  const verify = manifest => runQualityGates({projectRoot:manifest.path,commitSha:manifest.commitSha,
    authority:createAuthorityEnvelope({actorId:'quality',principal:'agent',actions:['command.unit'],ownedPaths:[],providers:[],commands:['unit']}),
    gates:[{id:'unit',executable:'/usr/bin/true',args:[],cwd:'.',required:true,artifactPaths:[],tests:[]}]}, {gitClient});
  return {root,primary,target,request,options,gitClient,verify};
}
test('isolates diverged siblings, preserves both ancestries, verifies and accepts exact candidate', async t => {
  const f = await fixture(t); const candidate = await prepareIntegrationCandidate(f.request, f.options);
  assert.equal(candidate.status,'ready'); assert.ok(Object.isFrozen(candidate.manifest));
  assert.equal(await git(f.target,'rev-parse','HEAD'),f.request.baseSha);
  for(const p of f.request.participants) assert.equal(await f.gitClient.isAncestor(candidate.manifest.path,p.sourceSha,candidate.manifest.commitSha),true);
  assert.equal(await readFile(join(candidate.manifest.path,'one'),'utf8'),'one\n');
  const replay = await prepareIntegrationCandidate(f.request,f.options); assert.equal(replay.manifest.digest,candidate.manifest.digest);
  const accepted = await acceptIntegrationCandidate(f.request,{...f.options,verify:f.verify});
  assert.equal(accepted.status,'accepted'); assert.equal(await git(f.target,'rev-parse','HEAD'),candidate.manifest.commitSha);
  assert.equal(await git(f.primary,'rev-parse','HEAD'),f.request.baseSha);
});
test('conflicts are retained for inspection without changing accepted target or replaying merges', async t => {
  const f = await fixture(t,true); await assert.rejects(prepareIntegrationCandidate(f.request,f.options));
  const record = await inspectIntegrationCandidate(f.request,f.options); assert.equal(record.status,'interrupted');
  assert.equal(await git(f.target,'rev-parse','HEAD'),f.request.baseSha);
  await assert.rejects(prepareIntegrationCandidate(f.request,f.options),/interrupted/);
});
test('rejects forged quality and candidate, source, target or owner changes after verification', async t => {
  for(const mode of ['forged','candidate','source','target','owner']) {
    const f = await fixture(t); await prepareIntegrationCandidate(f.request,f.options);
    let invalidOwner=false;
    await assert.rejects(acceptIntegrationCandidate(f.request,{...f.options,
      validateOwner:async()=>{if(invalidOwner) throw new Error('owner changed');},
      verify:async manifest=>{
        if(mode==='forged')return {status:'pass',commitSha:manifest.commitSha,projectRoot:manifest.path};
        const proof=await f.verify(manifest);
        if(mode==='candidate')await commit(manifest.path,'extra','bad\n');
        if(mode==='source')await commit(f.request.participants[0].sourcePath,'extra','bad\n');
        if(mode==='target')await commit(f.target,'extra','bad\n');
        if(mode==='owner')invalidOwner=true;
        return proof;
      }}));
    if(mode!=='target')assert.equal(await git(f.target,'rev-parse','HEAD'),f.request.baseSha);
  }
});
test('rejects primary target and mismatched replay intent', async t => {
  const f=await fixture(t);
  await assert.rejects(prepareIntegrationCandidate({...f.request,projectRoot:f.primary},f.options));
  await prepareIntegrationCandidate(f.request,f.options);
  await assert.rejects(prepareIntegrationCandidate({...f.request,policyDigest:'b'.repeat(64)},f.options));
});
test('failed genuine quality results cannot be accepted', async t => {
  const f=await fixture(t);await prepareIntegrationCandidate(f.request,f.options);
  await assert.rejects(acceptIntegrationCandidate(f.request,{...f.options,verify:manifest=>runQualityGates({
    projectRoot:manifest.path,commitSha:manifest.commitSha,
    authority:createAuthorityEnvelope({actorId:'quality',principal:'agent',actions:['command.unit'],ownedPaths:[],providers:[],commands:['unit']}),
    gates:[{id:'unit',executable:'/usr/bin/false',args:[],cwd:'.',required:true,artifactPaths:[],tests:[]}]}, {gitClient:f.gitClient})}),/verification failed/);
  assert.equal(await git(f.target,'rev-parse','HEAD'),f.request.baseSha);
});
test('changed candidate topology and interrupted persisted intent are never adopted on replay', async t => {
  const f=await fixture(t);const prepared=await prepareIntegrationCandidate(f.request,f.options);
  await git(prepared.manifest.path,'branch','-m','feature/foreign');
  await assert.rejects(prepareIntegrationCandidate(f.request,f.options),/candidate changed/);
  const {integrationCandidatePaths}=await import('../../src/state/paths.js');
  const {createSnapshotStore}=await import('../../src/state/snapshot-store.js');
  const store=createSnapshotStore(await integrationCandidatePaths(f.request.statePaths,f.request.candidateId));
  const saved=await store.read();await store.write({...saved.data,status:'assembling',manifest:null},{expectedVersion:saved.version});
  await assert.rejects(prepareIntegrationCandidate(f.request,f.options),/interrupted/);
  assert.equal((await inspectIntegrationCandidate(f.request,f.options)).status,'assembling');
  assert.equal(await git(f.target,'rev-parse','HEAD'),f.request.baseSha);
});
test('candidate merge refuses stale heads and executable merge config without writing user identity', async t => {
  const f=await fixture(t);
  await assert.rejects(f.gitClient.mergeCommit(f.target,{branch:'feature/integration',expectedTip:'f'.repeat(40),sourceSha:f.request.participants[0].sourceSha}));
  await git(f.primary,'config','merge.evil.driver','touch should-not-exist');
  await assert.rejects(f.gitClient.mergeCommit(f.target,{branch:'feature/integration',expectedTip:f.request.baseSha,sourceSha:f.request.participants[0].sourceSha}),error=>error.code==='ERR_GIT_EXECUTABLE_CONFIG');
  await git(f.primary,'config','--unset','merge.evil.driver');
  await assert.rejects(git(f.primary,'config','--local','--get','user.name'));
  assert.equal(await git(f.target,'rev-parse','HEAD'),f.request.baseSha);
});
test('recovers acceptance interrupted after exact fast-forward only with fresh verification and ownership', async t => {
  const f=await fixture(t);const prepared=await prepareIntegrationCandidate(f.request,f.options);
  // Emulate process loss between the Git fast-forward and private snapshot write.
  await f.gitClient.fastForward(f.target,{branch:'feature/integration',expectedTip:f.request.baseSha,newTip:prepared.manifest.commitSha});
  let verified=0, owners=0;
  const accepted=await acceptIntegrationCandidate(f.request,{...f.options,
    validateOwner:async()=>{owners+=1;},verify:async manifest=>{verified+=1;return f.verify(manifest);}});
  assert.equal(accepted.status,'accepted');assert.equal(verified,1);assert.ok(owners>=2);
});
test('accepted replay requires the target to retain the accepted exact commit', async t => {
  const f=await fixture(t);await prepareIntegrationCandidate(f.request,f.options);
  await acceptIntegrationCandidate(f.request,{...f.options,verify:f.verify});
  await git(f.target,'reset','--hard',f.request.baseSha);
  await assert.rejects(prepareIntegrationCandidate(f.request,f.options),/target changed/);
});
async function outputVerifier(f, {fail=false,directory=false}={}) {
  const executable=join(f.root,`gate-${fail?'fail':'pass'}-${directory?'directory':'file'}`);
  await writeFile(executable,`#!/bin/sh\n${directory?'mkdir -p reports; printf output > reports/build.log':'printf output > build.log'}\nexit ${fail?1:0}\n`,{mode:0o700});
  return manifest=>runQualityGates({projectRoot:manifest.path,commitSha:manifest.commitSha,
    authority:createAuthorityEnvelope({actorId:'quality',principal:'agent',actions:['command.unit'],ownedPaths:[],providers:[],commands:['unit']}),
    gates:[{id:'unit',executable,args:[],cwd:'.',required:true,artifactPaths:[],tests:[]}]},{gitClient:f.gitClient});
}
test('permits only declared ignored verification outputs with exact persisted ownership', async t => {
  for(const directory of [false,true]) {
    const f=await fixture(t);f.request.verificationOutputs=[directory?'reports':'build.log'];
    const prepared=await prepareIntegrationCandidate(f.request,f.options);
    const result=await acceptIntegrationCandidate(f.request,{...f.options,verify:await outputVerifier(f,{directory})});
    assert.equal(result.status,'accepted');assert.deepEqual(result.manifest.verificationOutputs,f.request.verificationOutputs);
    assert.ok(result.verificationArtifacts.length>0);
    assert.equal((await prepareIntegrationCandidate(f.request,f.options)).status,'accepted');
    assert.equal(await git(f.target,'rev-parse','HEAD'),prepared.manifest.commitSha);
  }
});
test('undeclared ignored output never reaches integration', async t => {
  const f=await fixture(t);await prepareIntegrationCandidate(f.request,f.options);
  await assert.rejects(acceptIntegrationCandidate(f.request,{...f.options,verify:await outputVerifier(f)}));
  assert.equal(await git(f.target,'rev-parse','HEAD'),f.request.baseSha);
});
test('failed verifier output is retryable only while its recorded content stays unchanged', async t => {
  const f=await fixture(t);f.request.verificationOutputs=['build.log'];
  await prepareIntegrationCandidate(f.request,f.options);
  await assert.rejects(acceptIntegrationCandidate(f.request,{...f.options,verify:await outputVerifier(f,{fail:true})}),/verification failed/);
  const retained=await inspectIntegrationCandidate(f.request,f.options);assert.ok(retained.verificationArtifacts.length);
  assert.equal((await acceptIntegrationCandidate(f.request,{...f.options,verify:await outputVerifier(f)})).status,'accepted');
  await writeFile(join(retained.manifest.path,'build.log'),'foreign');
  await assert.rejects(prepareIntegrationCandidate(f.request,f.options),/output/);
});
test('rejects unsafe output roots and preexisting foreign or symlink output content', async t => {
  const f=await fixture(t);
  for(const output of ['../escape','/tmp/escape','.git/config','node_modules','reports/../build.log'])
    await assert.rejects(prepareIntegrationCandidate({...f.request,verificationOutputs:[output]},f.options));
  f.request.verificationOutputs=['reports/build.log'];
  const prepared=await prepareIntegrationCandidate(f.request,f.options);
  await symlink(f.root,join(prepared.manifest.path,'reports'));
  await assert.rejects(acceptIntegrationCandidate(f.request,{...f.options,verify:f.verify}),/candidate changed|output/);
  await rm(join(prepared.manifest.path,'reports'));await mkdir(join(prepared.manifest.path,'reports'));
  await writeFile(join(prepared.manifest.path,'reports/build.log'),'foreign');
  await assert.rejects(acceptIntegrationCandidate(f.request,{...f.options,verify:f.verify}),/output/);
  await rm(join(prepared.manifest.path,'reports/build.log'));
  await symlink(join(f.primary,'base'),join(prepared.manifest.path,'reports/build.log'));
  await assert.rejects(acceptIntegrationCandidate(f.request,{...f.options,verify:f.verify}),/output/);
});
test('an ignored parent directory cannot hide undeclared sibling outputs', async t => {
  const f=await fixture(t);f.request.verificationOutputs=['reports/build.log'];
  await prepareIntegrationCandidate(f.request,f.options);
  const verify=await outputVerifier(f,{directory:true});
  await assert.rejects(acceptIntegrationCandidate(f.request,{...f.options,verify:async manifest=>{
    const proof=await verify(manifest);await writeFile(join(manifest.path,'reports/foreign.log'),'foreign');return proof;
  }}));
  assert.equal(await git(f.target,'rev-parse','HEAD'),f.request.baseSha);
});
test('acceptance publication follows durable acceptance and exact replay recovers publication failure', async t => {
  const f=await fixture(t);await prepareIntegrationCandidate(f.request,f.options);
  let calls=0;
  const onAccepted=async record=>{
    calls++;
    assert.equal((await inspectIntegrationCandidate(f.request,f.options)).status,'accepted');
    assert.equal(await git(f.target,'rev-parse','HEAD'),record.manifest.commitSha);
    if(calls===1)throw new Error('publication interrupted');
  };
  await assert.rejects(acceptIntegrationCandidate(f.request,{...f.options,verify:f.verify,onAccepted}),/publication interrupted/);
  assert.equal((await acceptIntegrationCandidate(f.request,{...f.options,verify:f.verify,onAccepted})).status,'accepted');
  assert.equal(calls,2);
});
