import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { assertGitClient } from './client.js';
import { createReservationStore } from './reservations.js';
import { createFeatureRunStore } from '../feature/run-store.js';
import { resolveExistingFeatureRunPaths, resolveExistingStatePaths } from '../state/paths.js';
import { readSnapshotWithoutLock } from '../state/snapshot-store.js';
import { validateRuntimeSnapshot } from '../runtime/orchestrator.js';

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
  const {reservations} = await createReservationStore(paths).readOnly();
  if (reservations.length > 64) throw new Error('Cleanup preview exceeds its bounded checkout limit.');
  if (snapshot) validateRuntimeSnapshot(snapshot.data, runId);
  const repository = await client.inspectRepository(projectRoot);
  const topology = await client.listWorktrees(projectRoot);
  const parent = join(dirname(projectRoot), '.rivet-worktrees', repository.repositoryId, basename(paths.instanceDir), 'workers');
  const checkouts = [];
  for (const reservation of reservations) {
    const item = {path:reservation.worktreePath, branch:reservation.branch, commit:null, eligible:false, reason:'unknown-ownership'};
    const retain = reason => {item.reason = reason; checkouts.push(item);};
    if (!['completed','cancelled'].includes(run.status)) {retain(`task-${run.status}`); continue;}
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
      || intent?.worktree?.path !== item.path) {retain('unknown-ownership'); continue;}
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
  return {runId, checkouts};
}
