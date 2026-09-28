import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';

import { loadProjectConfig } from '../config/load.js';
import { createFeaturePlan } from './plan-contract.js';
import { createFeatureRuntimeState } from './runtime-bridge.js';
import { immutableJson } from '../clients/contract.js';
import { validateRuntimeSnapshot } from '../runtime/orchestrator.js';
import { acquireLock, recoverAbandonedLock } from '../state/lock.js';
import { resolveExistingFeatureRunPaths, resolveExistingStatePaths, verifyResolvedStatePaths } from '../state/paths.js';
import { readSnapshotWithoutLock } from '../state/snapshot-store.js';
import { createFeatureRunStore } from './run-store.js';

function invalid() {
  const error = new Error('Lock recovery requires valid saved host state or a finished spawned task awaiting local acceptance.');
  error.code = 'ERR_HOST_RUN_RECOVERY_STATE';
  error.safeMessage = error.message;
  throw error;
}

/** Recover lock ownership only. Never construct a runtime or change a saved run. */
export async function recoverHostRunLocks(project, runId) {
  const paths = await resolveExistingFeatureRunPaths(project, runId);
  if (paths === null) invalid();
  const runtimePaths = await resolveExistingStatePaths(project, runId);
  const config = await loadProjectConfig(project);
  async function validate() {
    await verifyResolvedStatePaths(paths);
    const run = await createFeatureRunStore(paths).readOnly();
    if (!run) invalid();
    const spawned = run.featurePlan.client !== 'host';
    if (spawned && !['awaiting-final-approval', 'completed'].includes(run.status)) invalid();
    createFeaturePlan({ proposal: run.featurePlan, config, workRequest: run.workRequest, baselineCommit: run.featurePlan.baselineCommit, client: run.featurePlan.client });
    let runtime = null;
    let savedSnapshot = null;
    if (runtimePaths !== null) {
      await verifyResolvedStatePaths(runtimePaths);
      savedSnapshot = await readSnapshotWithoutLock(runtimePaths);
      if (savedSnapshot === null) {
        if (run.status !== 'approved' || run.runtimeRefs.length !== 0) invalid();
      } else {
        runtime = validateRuntimeSnapshot(savedSnapshot.data, runId);
        const expected = createFeatureRuntimeState({ config, run }).graph;
        const fixedGraph = graph => ({ ...graph, status: undefined, nodes: graph.nodes.map(node => ({ ...node, status: undefined, evidenceRefs: undefined })) });
        if (!isDeepStrictEqual(fixedGraph(runtime.graph), fixedGraph(expected))) invalid();
      }
    } else if (!['proposed', 'approved'].includes(run.status) || run.runtimeRefs.length !== 0) invalid();
    // A finished spawned task may have crashed while holding this lock during
    // local confirmation/application. Recover ownership only: this does not
    // authorize a Git update, restart a Worker, or change acceptance evidence.
    if (spawned && (!runtime
      || runtime.graph.nodes.find(node => node.id === 'final-delivery')?.status !== 'ready'
      || runtime.graph.nodes.some(node => node.owner.role === 'worker'
        && !['completed', 'archived'].includes(node.status)))) invalid();
    return { spawned, runVersion: run.version, runtimeVersion: runtime?.version ?? null,
      fingerprint: createHash('sha256').update(JSON.stringify({ run, savedSnapshot })).digest('hex') };
  }
  const initial = await validate();
  const recoveredLocks = [];
  const held = [];
  let blockedLock = 'host-operation';
  let failure = false;
  const lockPaths = [
    ['host-operation', join(paths.runDir, 'host-operation.lock'), paths],
    ['run', paths.lockPath, paths],
    ...(runtimePaths ? [['runtime', runtimePaths.runtimeLockPath, runtimePaths], ['state', runtimePaths.lockPath, runtimePaths]] : []),
  ];
  try {
    for (const [label, path, ownerPaths] of lockPaths) {
      blockedLock = label;
      await verifyResolvedStatePaths(ownerPaths);
      const current = await validate();
      if (current.fingerprint !== initial.fingerprint) invalid();
      if (await recoverAbandonedLock(path)) recoveredLocks.push(label);
      held.push({ label, lock: await acquireLock(path) });
    }
    if ((await validate()).fingerprint !== initial.fingerprint) invalid();
  } catch {
    failure = true;
  } finally {
    for (const { label, lock } of held.reverse()) {
      try { await lock.release(); }
      catch { if (!failure) blockedLock = label; failure = true; }
    }
  }
  return immutableJson({
    status: failure ? 'blocked' : 'recovered', runId, runVersion: initial.runVersion, runtimeVersion: initial.runtimeVersion, recoveredLocks,
    ...(failure ? { blockedLock } : {}),
    nextAction: failure
      ? 'Recovery stopped safely. Inspect the remaining lock owner and private state before retrying; recovered locks are listed above.'
      : initial.spawned
        ? 'Read rivet task status, then rivet task approve to inspect local acceptance. Recovery did not resume workers, apply changes, or change task state.'
        : 'Read task status and continue in the owning harness. Recovery did not resume workers or change task state.',
  });
}
