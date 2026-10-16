import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { assertGitClient } from './client.js';
import { assertResolvedStatePaths, integrationCandidatePaths, verifyResolvedStatePaths } from '../state/paths.js';
import { createSnapshotStore } from '../state/snapshot-store.js';
import { acquireLock, LockBusyError } from '../state/lock.js';
import { setTimeout as delay } from 'node:timers/promises';
import { assertQualityRun } from '../quality/runner.js';
import { readDependencyFile } from '../runtime/dependency-directory.js';

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const freeze = value => value && typeof value === 'object'
  ? Object.freeze(Array.isArray(value) ? value.map(freeze) : Object.fromEntries(Object.entries(value).map(([k,v]) => [k,freeze(v)]))) : value;
function fail(reason) { throw new Error(`Integration candidate ${reason}`); }
function id(value) { return typeof value === 'string' && value.length <= 64 && ID.test(value); }
function path(value) { return typeof value === 'string' && value.length <= 1024 && isAbsolute(value) && resolve(value) === value && !/[\0\r\n]/.test(value); }
function outputPath(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || value.normalize('NFKC') !== value
    || /[\\:\x00-\x20\x7f]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..'
      || part.endsWith('.') || /^(?:\.git|\.rivet-deps|node_modules)$/i.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('unsafe output path');
  return value;
}
function capture(input, options) {
  assertGitClient(options.gitClient); assertResolvedStatePaths(input.statePaths);
  if (!path(input.projectRoot) || !id(input.candidateId) || !SHA.test(input.baseSha)
    || !/^[a-f0-9]{64}$/.test(input.policyDigest) || typeof options.validateOwner !== 'function'
    || !Array.isArray(input.participants) || !input.participants.length || input.participants.length > 64) fail('invalid input');
  const participants = input.participants.map(p => {
    if (!id(p.runId) || !id(p.nodeId) || !SHA.test(p.sourceSha) || !path(p.sourcePath)
      || typeof p.sourceBranch !== 'string' || p.sourceBranch.length > 200) fail('invalid participant');
    return {runId:p.runId,nodeId:p.nodeId,sourceSha:p.sourceSha,sourcePath:p.sourcePath,sourceBranch:p.sourceBranch};
  });
  if (new Set(participants.map(p=>`${p.runId}/${p.nodeId}`)).size !== participants.length
    || new Set(participants.map(p=>p.sourcePath)).size !== participants.length) fail('duplicate participant');
  const verificationOutputs = input.verificationOutputs ?? [];
  if (!Array.isArray(verificationOutputs) || verificationOutputs.length > 32) fail('invalid output paths');
  const outputs = verificationOutputs.map(outputPath);
  if (outputs.some((root, index) => outputs.some((other, otherIndex) => index !== otherIndex
    && (root === other || root.startsWith(other + '/'))))) fail('overlapping output paths');
  return Object.freeze({verificationOutputs:Object.freeze(outputs),projectRoot:input.projectRoot,statePaths:input.statePaths,candidateId:input.candidateId,
    baseSha:input.baseSha,policyDigest:input.policyDigest,participants:freeze(participants)});
}
async function secureDirectory(path) {
  await mkdir(path,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
  const a=await lstat(path); const canonical=await realpath(path); const b=await lstat(path);
  if(!a.isDirectory() || a.isSymbolicLink() || canonical!==path || a.dev!==b.dev || a.ino!==b.ino || (b.mode & 0o777)!==0o700)fail('unsafe path');
}
function sameCheckout(a,b) {
  return a.root===b.root && a.repositoryId===b.repositoryId && a.branch===b.branch
    && a.rootIdentity.dev===b.rootIdentity.dev && a.rootIdentity.ino===b.rootIdentity.ino;
}
async function context(value, options) {
  await verifyResolvedStatePaths(value.statePaths);
  const client=options.gitClient;
  const target=await client.inspectRepository(value.projectRoot);
  const topology=await client.listWorktrees(value.projectRoot);
  if(target.root!==value.projectRoot || target.gitCommonDir!==value.statePaths.gitCommonDir || target.detached
    || topology[0].path===target.root || topology.filter(w=>w.path===target.root && w.branch===target.branch).length!==1)fail('unsafe target');
  const parent=join(dirname(topology[0].path),'.rivet-worktrees',target.repositoryId,basename(value.statePaths.instanceDir));
  const candidatePath=join(parent,`candidate-${value.candidateId}`);
  const branch=`rivet-candidate/${basename(value.statePaths.instanceDir)}/${value.candidateId}`;
  if(value.participants.some(p=>p.sourcePath===target.root || p.sourcePath===candidatePath || p.sourceBranch===branch))fail('unsafe participant');
  const intent={repositoryId:target.repositoryId,baseSha:value.baseSha,candidateId:value.candidateId,
    path:candidatePath,branch,participants:value.participants,policyDigest:value.policyDigest,
    targetPath:target.root,targetBranch:target.branch,verificationOutputs:value.verificationOutputs};
  return {client,target,topology,parent,intent,store:createSnapshotStore(await integrationCandidatePaths(value.statePaths,value.candidateId))};
}
async function sources(value, ctx) {
  const result=[];
  for(const p of value.participants) {
    const source=await ctx.client.inspectRepository(p.sourcePath);
    if(source.root!==p.sourcePath || source.repositoryId!==ctx.target.repositoryId || source.headSha!==p.sourceSha
      || source.branch!==p.sourceBranch || source.dirty || (await ctx.client.statusPaths(p.sourcePath)).length)fail('source changed');
    if((await ctx.client.listWorktrees(value.projectRoot)).filter(w=>w.path===p.sourcePath && w.branch===p.sourceBranch && w.head===p.sourceSha).length!==1)fail('source topology changed');
    result.push(source);
  }
  return result;
}
function validateRecord(record, intent) {
  if(!record || digest(record.intent)!==digest(intent) || record.intentDigest!==digest(intent)
    || !['assembling','interrupted','ready','accepted'].includes(record.status))fail('intent changed');
  if(record.manifest) {
    const {digest:hash,...body}=record.manifest;
    if(hash!==digest(body) || digest({...body,commitSha:undefined})!==digest({...intent,commitSha:undefined}))fail('manifest changed');
  }
}
function insideOutput(path, roots) {
  return roots.some(root => path === root || path.startsWith(root + '/'));
}
async function outputArtifacts(ctx, roots) {
  const observe = async () => {
    const entries = [];
    let bytes = 0;
    const visit = async relative => {
      const path = join(ctx.intent.path, relative);
      let before;
      try { before = await lstat(path, {bigint:true}); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (entries.length >= 256 || before.isSymbolicLink() || await realpath(path) !== path) fail('unsafe output');
      if (before.isDirectory()) {
        entries.push({path:relative,type:'directory',dev:String(before.dev),ino:String(before.ino)});
        const children = (await readdir(path)).sort();
        if (!children.length && !(await ctx.client.isIgnoredPath(ctx.intent.path,relative))) fail('unsafe output directory');
        for (const child of children) await visit(outputPath(relative + '/' + child));
      } else {
        if (!before.isFile() || before.nlink !== 1n || before.size > 8n * 1024n * 1024n
          || !(await ctx.client.isIgnoredPath(ctx.intent.path, relative))) fail('unsafe output');
        bytes += Number(before.size);
        if (bytes > 32 * 1024 * 1024) fail('excessive output');
        const contents = await readDependencyFile(path, 8 * 1024 * 1024);
        entries.push({path:relative,type:'file',dev:String(before.dev),ino:String(before.ino),
          digest:createHash('sha256').update(contents).digest('hex')});
      }
      const after = await lstat(path, {bigint:true});
      if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs
        || before.ctimeNs !== after.ctimeNs) fail('output changed');
    };
    for (const root of roots) {
      // A declared nested output cannot traverse a symlink in an existing parent.
      let parent = ctx.intent.path;
      for (const component of root.split('/').slice(0,-1)) {
        parent = join(parent,component);
        const stat = await lstat(parent).catch(error => {if(error.code==='ENOENT')return null;throw error;});
        if (!stat) break;
        if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(parent)!==parent) fail('unsafe output parent');
      }
      await visit(root);
    }
    return entries;
  };
  const first = await observe();
  if (digest(first) !== digest(await observe())) fail('output changed');
  return first;
}
async function checkCandidateOutputs(value,ctx,record) {
  const paths = await ctx.client.statusPaths(ctx.intent.path,{includeIgnoredDirectories:true});
  // Only ignored paths are eligible: inspectRepository rejects tracked and
  // untracked changes before this function. Every declared output is also read
  // without symlink traversal and pinned by content and filesystem identity.
  if (paths.some(path => !insideOutput(path,value.verificationOutputs)
    && !value.verificationOutputs.some(root=>root.startsWith(path + '/')))) fail('candidate changed');
  // Git may collapse an ignored parent to one directory record. Expand that
  // container so declaring reports/build.log cannot authorize reports/foreign.
  let visited = 0;
  const inspectContainer = async relative => {
    if (++visited > 256) fail('excessive output');
    if (insideOutput(relative,value.verificationOutputs)) return;
    if (!value.verificationOutputs.some(root=>root.startsWith(relative + '/'))) fail('undeclared output');
    const absolute = join(ctx.intent.path,relative);
    const stat = await lstat(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(absolute)!==absolute) fail('unsafe output parent');
    for (const child of await readdir(absolute)) await inspectContainer(outputPath(relative + '/' + child));
  };
  for (const path of paths) await inspectContainer(path);
  const artifacts = await outputArtifacts(ctx,value.verificationOutputs);
  if (digest(artifacts) !== digest(record.verificationArtifacts ?? [])) fail('output ownership changed');
}
async function acceptanceTip(value, ctx, record) {
  const current = await ctx.client.inspectRepository(value.projectRoot);
  // A crash may happen after Git advances but before the accepted snapshot is
  // durable. Only the exact candidate can be reconciled; it still needs fresh
  // verification and current ownership checks before recording acceptance.
  return current.headSha === record.manifest?.commitSha ? current.headSha : value.baseSha;
}
async function check(value,ctx,record,expectedTarget=value.baseSha) {
  validateRecord(record,ctx.intent);
  await optionsOwner(value,ctx,record);
  const target=await ctx.client.inspectRepository(value.projectRoot);
  if(!sameCheckout(target,record.target) || target.headSha!==expectedTarget || target.dirty
    || (await ctx.client.statusPaths(target.root)).length)fail('target changed');
  const observed=await sources(value,ctx);
  if(observed.some((s,i)=>!sameCheckout(s,record.sources[i])))fail('source identity changed');
  if(record.manifest) {
    const candidate=await ctx.client.inspectRepository(ctx.intent.path);
    if(!sameCheckout(candidate,record.candidate) || candidate.headSha!==record.manifest.commitSha || candidate.dirty)fail('candidate changed');
    await checkCandidateOutputs(value,ctx,record);
    const tree=await ctx.client.listWorktrees(value.projectRoot);
    if(tree.filter(w=>w.path===candidate.root || w.branch===candidate.branch).length!==1)fail('candidate topology changed');
  }
}
// The caller supplies the current run/lease owner check, never a stored boolean.
async function optionsOwner(value,ctx,record) { await ctx.validateOwner(freeze({intent:ctx.intent,manifest:record?.manifest??null})); }

export async function prepareIntegrationCandidate(input, options) {
  const value=capture(input,options); const ctx=await context(value,options); ctx.validateOwner=options.validateOwner;
  const lock=await acquireLock(join(value.statePaths.instanceDir,`candidate-${value.candidateId}.operation.lock`));
  try {
    const existing=await ctx.store.read();
    if(existing) {
      validateRecord(existing.data,ctx.intent);
      if(!['ready','accepted'].includes(existing.data.status))fail('interrupted; retained for inspection');
      await check(value,ctx,existing.data,existing.data.status === 'accepted'
        ? existing.data.manifest.commitSha : await acceptanceTip(value,ctx,existing.data));
      return freeze(existing.data);
    }
    if(ctx.target.headSha!==value.baseSha || ctx.target.dirty)fail('target changed');
    const observed=await sources(value,ctx);
    await optionsOwner(value,ctx,null);
    // Candidate locations are derived in an owner-only workspace, never caller paths.
    await secureDirectory(dirname(dirname(ctx.parent))); await secureDirectory(dirname(ctx.parent)); await secureDirectory(ctx.parent);
    if(await ctx.client.branchTip(value.projectRoot,ctx.intent.branch)!==null
      || ctx.topology.some(w=>w.path===ctx.intent.path || w.branch===ctx.intent.branch))fail('topology collision');
    try {await lstat(ctx.intent.path);fail('path collision');}catch(e){if(e.code!=='ENOENT')throw e;}
    let record={intent:ctx.intent,intentDigest:digest(ctx.intent),status:'assembling',target:ctx.target,sources:observed,manifest:null};
    let saved=await ctx.store.write(record,{expectedVersion:0});
    try {
      await check(value,ctx,record);
      await secureDirectory(dirname(dirname(ctx.parent)));
      await secureDirectory(dirname(ctx.parent));
      await secureDirectory(ctx.parent);
      await ctx.client.createWorktree(value.projectRoot,{path:ctx.intent.path,branch:ctx.intent.branch,baseSha:value.baseSha});
      let candidate=await ctx.client.inspectRepository(ctx.intent.path);
      for(const p of value.participants) candidate=await ctx.client.mergeCommit(ctx.intent.path,{branch:ctx.intent.branch,expectedTip:candidate.headSha,sourceSha:p.sourceSha});
      const body={...ctx.intent,commitSha:candidate.headSha};
      record={...record,status:'ready',candidate,manifest:{...body,digest:digest(body)}};
      await check(value,ctx,record);
      await ctx.store.write(record,{expectedVersion:saved.version});
      return freeze(record);
    }catch(error){
      // Retain every partial merge and its ownership intent. No abort/reset/removal.
      await ctx.store.write({...record,status:'interrupted'},{expectedVersion:saved.version}).catch(()=>{});
      throw error;
    }
  }finally{await lock.release();}
}

export async function inspectIntegrationCandidate(input,options) {
  const value=capture(input,options);const ctx=await context(value,options);
  const saved=await ctx.store.read(); if(!saved)return null;
  validateRecord(saved.data,ctx.intent); return freeze(saved.data);
}

export async function acquireCandidateIntegrationLock(statePaths) {
  assertResolvedStatePaths(statePaths);
  const path = join(statePaths.instanceDir,'integration.lock');
  const deadline = Date.now() + 2_000;
  while (true) {
    try { return await acquireLock(path); } catch (error) {
      if (!(error instanceof LockBusyError) || Date.now() >= deadline) throw error;
      await delay(5);
    }
  }
}

export async function acceptIntegrationCandidate(input,options) {
  const value=capture(input,options);if(typeof options.verify!=='function')fail('verification required');
  if(options.onAccepted !== undefined && typeof options.onAccepted !== 'function')fail('invalid publication callback');
  const ctx=await context(value,options);ctx.validateOwner=options.validateOwner;
  const operation = await acquireLock(join(value.statePaths.instanceDir,`candidate-${value.candidateId}.operation.lock`));
  try {
    let saved=await ctx.store.read(); if(!['ready','accepted'].includes(saved?.data.status))fail('not ready');
    const expectedTip = record => record.status === 'accepted' ? record.manifest.commitSha : acceptanceTip(value,ctx,record);
    await check(value,ctx,saved.data,await expectedTip(saved.data));
    const manifest=freeze(saved.data.manifest);
    // Verification may be long; keep the integration lock free while it runs.
    const proof=await options.verify(manifest); assertQualityRun(proof);
    if(proof.commitSha!==manifest.commitSha || proof.projectRoot!==manifest.path)fail('verification failed');
    const artifacts = await outputArtifacts(ctx,value.verificationOutputs);
    const verified = {...saved.data,verificationArtifacts:artifacts};
    await check(value,ctx,verified,await expectedTip(verified));
    // Genuine failed gates can still generate authorized ignored files. Pin
    // them before reporting failure so a later retry never adopts foreign data.
    saved=await ctx.store.write(verified,{expectedVersion:saved.version});
    if(proof.status!=='pass')fail('verification failed');
    await verifyResolvedStatePaths(value.statePaths);
    const lock=await acquireCandidateIntegrationLock(value.statePaths);
    try {
      const current=await ctx.store.read();
      if(current.version!==saved.version)fail('state changed');
      const tip = await expectedTip(current.data);
      await check(value,ctx,current.data,tip);
      if (tip !== manifest.commitSha) {
        await ctx.client.fastForward(value.projectRoot,{branch:ctx.intent.targetBranch,expectedTip:value.baseSha,newTip:manifest.commitSha});
      }
      const accepted={...current.data,status:'accepted'};
      await ctx.store.write(accepted,{expectedVersion:current.version});
      // Publication is part of the same cooperating integration transaction. A
      // crash leaves durable acceptance available for exact, freshly verified replay.
      await options.onAccepted?.(freeze(accepted));
      return freeze(accepted);
    }finally{await lock.release();}
  }finally{await operation.release();}
}
