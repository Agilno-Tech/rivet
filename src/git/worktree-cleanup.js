import { createHash } from 'node:crypto';
import { acquireLock } from '../state/lock.js';
import { acquireHostRunLock } from '../feature/host-run-lock.js';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { assertGitClient } from './client.js';
import { createReservationStore } from './reservations.js';
import { createFeatureRunStore } from '../feature/run-store.js';
import { resolveExistingFeatureRunPaths, resolveExistingStatePaths, worktreeCleanupPaths, verifyResolvedStatePaths } from '../state/paths.js';
import { readSnapshotWithoutLock, createSnapshotStore } from '../state/snapshot-store.js';
import { validateRuntimeSnapshot } from '../runtime/orchestrator.js';

const observations = new WeakMap();
const approvals = new WeakMap();

export async function confirmTaskWorktreeCleanup(preview, confirm) {
  const original = observations.get(preview);
  if (!original || original.digest !== digest(preview) || typeof confirm !== 'function') throw new Error('A fresh cleanup preview is required for approval.');
  if (await confirm(structuredClone(preview)) !== true) return null;
  if (original.digest !== digest(preview)) changed();
  const approval = Object.freeze({});
  approvals.set(approval, original);
  return approval;
}

/** Read-only observation, never an authorization to remove a checkout later. */
export async function previewTaskWorktreeCleanup({projectRoot, runId}, {gitClient: client}) {
  assertGitClient(client);
  const runPaths = await resolveExistingFeatureRunPaths(projectRoot, runId);
  if (!runPaths) throw new Error('Task state is unavailable for cleanup preview.');
  const run = await createFeatureRunStore(runPaths).readOnly();
  if (!run) throw new Error('Task state is incomplete.');
  const paths = await resolveExistingStatePaths(projectRoot, runId);
  if (!paths) return {runId, checkouts:[]};
  const snapshot = await readSnapshotWithoutLock(paths);
  const {reservations, version:reservationVersion} = await createReservationStore(paths).readOnly();
  if (reservations.length > 64) throw new Error('Cleanup preview exceeds its bounded checkout limit.');
  if (snapshot) validateRuntimeSnapshot(snapshot.data, runId);
  const repository = await client.inspectRepository(projectRoot);
  const topology = await client.listWorktrees(projectRoot);
  const parent = join(dirname(projectRoot), '.rivet-worktrees', repository.repositoryId, basename(paths.instanceDir), 'workers');
  const journal = await readSnapshotWithoutLock(await worktreeCleanupPaths(paths));
  if (journal) validateJournal(journal.data,runId);
  const recorded = [...(journal?.data.history ?? []),...(journal ? [journal.data] : [])].flatMap(value=>value.checkouts);
  const checkouts = [];
  for (const reservation of reservations) {
    const item = {path:reservation.worktreePath, branch:reservation.branch, commit:null, eligible:false, reason:'unknown-ownership'};
    const retain = reason => {item.reason = reason; checkouts.push(item);};
    if (!['completed','cancelled'].includes(run.status)) {retain(`task-${run.status}`); continue;}
    const prior = recorded.find(value=>value.path===item.path && value.status==='removed');
    if (prior) {item.commit=prior.commit;retain('checkout-removed-branch-preserved');continue;}
    const interrupted = recorded.find(value=>value.path===item.path && value.status==='removing');
    if (interrupted) {
      let absent=false;
      try {await lstat(item.path);} catch(error) {if(error.code==='ENOENT')absent=true;else throw error;}
      if(absent && !topology.some(value=>value.path===item.path || value.branch===item.branch)
        && await client.branchTip(projectRoot,item.branch)===interrupted.commit) {
        const {status,...original}=interrupted;
        checkouts.push(original);continue;
      }
    }
    if (item.path === projectRoot || item.path === topology[0]?.path) {retain('primary-checkout'); continue;}
    const state = snapshot?.data;
    const node = state?.graph.nodes.find(value => value.id === reservation.nodeId);
    const planned = run.featurePlan.nodes.find(value => value.id === reservation.nodeId);
    const intent = state?.launchIntents?.[reservation.nodeId];
    const session = state?.sessions?.[reservation.nodeId];
    if (!node || planned?.role !== 'worker' || node.owner.role !== 'worker'
      || node.owner.id !== reservation.ownerId || reservation.repositoryId !== repository.repositoryId
      || repository.gitCommonDir !== paths.gitCommonDir
      || item.branch !== `worker/${runId}/${node.id}` || item.path !== join(parent,node.id)
      || intent?.worktree?.path !== item.path || intent.worktree.reservationId !== intent.reservationId) {retain('unknown-ownership'); continue;}
    if (!['completed','cancelled'].includes(node.status)) {retain(`worker-${node.status}`); continue;}
    if (session?.stopReceipt?.status !== 'stopped' || !['completed','stopped','blocked'].includes(session.phase)) {
      retain('owner-stop-unproven'); continue;
    }
    if (reservations.filter(value => value.worktreePath === item.path || value.branch === item.branch).length !== 1
      || topology.filter(value => value.branch === item.branch).length !== 1) {retain('shared-checkout'); continue;}
    try {
      const metadata = await lstat(item.path);
      if (metadata.isSymbolicLink() || await realpath(item.path) !== item.path) {retain('symlink-or-noncanonical'); continue;}
      if (!metadata.isDirectory() || metadata.dev.toString() !== intent.worktree.dev || metadata.ino.toString() !== intent.worktree.ino) {retain('unknown-checkout'); continue;}
      const observed = await client.inspectRepository(item.path);
      item.commit = observed.headSha;
      item.identity = {dev:metadata.dev.toString(),ino:metadata.ino.toString(),nodeId:node.id,ownerId:reservation.ownerId,leaseId:reservation.leaseId,sessionId:session.id,generation:session.generation};
      const registered = topology.filter(value => value.path === item.path);
      if (observed.root !== item.path || observed.gitCommonDir !== paths.gitCommonDir
        || observed.branch !== item.branch || registered.length !== 1 || registered[0].head !== item.commit
        || registered[0].branch !== item.branch || await client.branchTip(projectRoot,item.branch) !== item.commit
        || !(await client.isAncestor(projectRoot,reservation.baseSha,item.commit))) {retain('identity-changed'); continue;}
      if (observed.dirty) {retain('dirty-checkout'); continue;}
      if ((await client.statusPaths(item.path,{includeIgnoredDirectories:true,includeManagedDependencies:true})).length) {
        retain('ignored-or-untracked-content'); continue;
      }
      item.eligible = true;
      retain('completed-owned-checkout');
    } catch {retain('unavailable-or-unsafe-checkout');}
  }
  const result = {runId, runVersion:run.version, runtimeVersion:snapshot?.version ?? null, reservationVersion, checkouts};
  observations.set(result,{projectRoot,runId,digest:digest(result)});
  return result;
}

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function validateJournal(data,runId) {
  const records = [...(data?.history ?? []),data];
  if (records.length>65) throw new Error('Cleanup journal exceeds its bounded history.');
  for (const record of records) {
    if (!record || record.preview?.runId!==runId || record.approvalDigest!==digest(record.preview)
      || !Array.isArray(record.checkouts) || record.checkouts.length>64) throw new Error('Invalid cleanup journal.');
    for(const entry of record.checkouts) {
      const {status,...item}=entry;
      if(!['removing','removed'].includes(status) || !record.preview.checkouts.some(value=>value.eligible && digest(value)===digest(item))) throw new Error('Invalid cleanup journal.');
    }
  }
}
const changed = () => { throw new Error('Cleanup approval changed or checkout is no longer eligible. Preview and approve again.'); };

/** Apply exactly the displayed observation after explicit approval; no timeout authorizes removal. */
export async function applyTaskWorktreeCleanup({projectRoot,runId,preview,approval}, {gitClient:client}) {
  assertGitClient(client);
  const authorized = approvals.get(approval);
  if (!authorized || authorized.projectRoot !== projectRoot || authorized.runId !== runId || authorized.digest !== digest(preview)) throw new Error('Explicit cleanup approval is required.');
  if (!preview || preview.runId !== runId || !Array.isArray(preview.checkouts) || preview.checkouts.length > 64) changed();
  const captured = structuredClone(preview);
  const paths = await resolveExistingStatePaths(projectRoot,runId);
  const runPaths = await resolveExistingFeatureRunPaths(projectRoot,runId);
  if (!paths || !runPaths) changed();
  const locks = [];
  try {
    locks.push(await acquireHostRunLock(runPaths));
    locks.push(await acquireLock(runPaths.lockPath));
    locks.push(await acquireLock(paths.runtimeLockPath));
    locks.push(await acquireLock(paths.lockPath));
    await verifyResolvedStatePaths(paths);
    const journalPaths = await worktreeCleanupPaths(paths);
    const store = createSnapshotStore(journalPaths, {environment:{}});
    let stored = await store.read();
    const approvalDigest = digest(captured);
    if (stored) validateJournal(stored.data,runId);
    const fresh = await previewTaskWorktreeCleanup({projectRoot,runId},{gitClient:client});
    if (stored && stored.data.approvalDigest !== approvalDigest) {
      if (stored.data.checkouts.some(item => item.status === 'removing')) {
        // A fresh confirmation may omit already removed checkouts. Resume the original
        // journal only for unchanged, originally approved targets; never adopt new work.
        if (digest(fresh)!==approvalDigest
          || ['runVersion','runtimeVersion','reservationVersion'].some(key=>captured[key]!==stored.data.preview[key])
          || captured.checkouts.filter(item=>item.eligible).some(item=>
            !stored.data.preview.checkouts.some(original=>original.eligible && digest(original)===digest(item)))) changed();
      } else {
        const {history:previousHistory=[],...previous}=stored.data;
        if (previousHistory.length>=64) throw new Error('Cleanup journal exceeds its bounded history.');
        stored = await store.write({approvalDigest,preview:captured,checkouts:[],history:[...previousHistory,previous]},{expectedVersion:stored.version,environment:{}});
      }
    }
    if (fresh.runVersion !== captured.runVersion || fresh.runtimeVersion !== captured.runtimeVersion
      || fresh.reservationVersion !== captured.reservationVersion) changed();
    const targets = captured.checkouts.filter(item => item.eligible);
    if (!stored) stored = await store.write({approvalDigest,preview:captured,checkouts:[]},{expectedVersion:0,environment:{}});
    const save = async entries => { stored = await store.write({...stored.data,checkouts:entries},{expectedVersion:stored.version,environment:{}}); };
    for (const item of targets) {
      let entry = stored.data.checkouts.find(value => value.path === item.path);
      const observed = fresh.checkouts.find(value => value.path === item.path);
      if (entry && ['removing','removed'].includes(entry.status)) {
        let absent = false;
        try { await lstat(item.path); } catch (error) { if(error.code==='ENOENT') absent=true; else throw error; }
        if (absent && !(await client.listWorktrees(projectRoot)).some(value=>value.path===item.path || value.branch===item.branch)
          && await client.branchTip(projectRoot,item.branch)===item.commit) {
          await save(stored.data.checkouts.map(value=>value.path===item.path?{...value,status:'removed'}:value));
          continue;
        }
        if (entry.status === 'removed') changed(); // Never adopt a replacement checkout.
      }
      if (!observed?.eligible || digest(observed)!==digest(item)) changed();
      entry = {...item,status:'removing'};
      await save([...stored.data.checkouts.filter(value=>value.path!==item.path),entry]);
      try {
        // Re-observe after journaling, while all owner/reservation mutation locks remain held.
        const current = await previewTaskWorktreeCleanup({projectRoot,runId},{gitClient:client});
        if (digest(current.checkouts.find(value=>value.path===item.path))!==digest(item)) changed();
        await client.removePreservedWorktree(projectRoot,{path:item.path,branch:item.branch,commit:item.commit,dev:item.identity.dev,ino:item.identity.ino});
        await save(stored.data.checkouts.map(value=>value.path===item.path?{...value,status:'removed'}:value));
      } catch (error) {
        // Keep 'removing' when filesystem outcome is unknown, allowing only exact absent-path replay.
        throw error;
      }
    }
    return {runId,checkouts:stored.data.checkouts};
  } finally { for(const lock of locks.reverse()) await lock.release(); }
}
