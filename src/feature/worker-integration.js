import { createHash } from 'node:crypto';
import { reconcileWorktree } from '../git/reconcile.js';
import { verifyReservedWorktree } from '../git/worktrees.js';
import { prepareIntegrationCandidate, acceptIntegrationCandidate, inspectIntegrationCandidate, acquireCandidateIntegrationLock } from '../git/integration-candidate.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(reason) { throw new Error(`Worker integration ${reason}`); }

// Both adapter and host use this entry point. validateOwner must re-read live
// approval, intent/session and stopped-owner proof; a captured boolean is not an
// ownership check. verify must return the runner's genuine exact-candidate proof.
export async function integrateFeatureWorker(input, options) {
  const {runId, baselineCommit, runtimeVersion, intentId, sessionId, generation, policyDigest,
    verificationOutputs = [], ...request} = input;
  const {gitClient, acceptedStore, validateOwner, verify, nowMs} = options;
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(runId)
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baselineCommit)
    || !Number.isSafeInteger(runtimeVersion) || runtimeVersion < 1
    || typeof intentId !== 'string' || !intentId || intentId.length > 256
    || (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256))
    || (generation !== undefined && (!Number.isSafeInteger(generation) || generation < 1))
    || typeof validateOwner !== 'function' || typeof verify !== 'function'
    || typeof acceptedStore?.readOnly !== 'function' || typeof acceptedStore?.write !== 'function') fail('invalid input');
  const clock = () => typeof nowMs === 'function' ? nowMs() : nowMs;
  const validLedger = ledger => ledger && ledger.runId === runId && ledger.baselineCommit === baselineCommit
    && ledger.path === request.projectRoot && ledger.branch === request.integrationBranch
    && Number.isSafeInteger(ledger.runtimeVersion) && ledger.runtimeVersion >= 1;
  return reconcileWorktree(request, {gitClient, nowMs: clock(), candidate: async ({verified, report}) => {
    const source = verified.worker;
    const reservation = JSON.stringify(verified.reservation);
    const checkOwner = async context => {
      await validateOwner(context);
      const live = await verifyReservedWorktree({projectRoot:request.projectRoot,statePaths:request.statePaths,
        nodeId:request.nodeId,ownerId:request.ownerId,leaseId:request.leaseId}, {gitClient, nowMs: clock()});
      // Compare this exact reservation, never the global reservation-store version:
      // a cooperating peer can legitimately reserve or finish unrelated work.
      if (JSON.stringify(live.reservation) !== reservation || live.worker.headSha !== source.headSha
        || live.worker.rootIdentity.dev !== source.rootIdentity.dev || live.worker.rootIdentity.ino !== source.rootIdentity.ino) fail('source ownership changed');
    };
    let ledger = await acceptedStore.readOnly();
    if (ledger && !validLedger(ledger)) fail('ledger identity changed');
    let baseSha = ledger?.commitSha ?? baselineCommit;
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidateId = 'worker-' + hash({runId,intentId,sessionId,generation,nodeId:request.nodeId,
        leaseId:request.leaseId,sourceSha:source.headSha,baseSha,policyDigest}).slice(0,56);
      const candidate = {projectRoot:request.projectRoot,statePaths:request.statePaths,candidateId,baseSha,policyDigest,
        verificationOutputs,participants:[{runId,nodeId:request.nodeId,sourceSha:source.headSha,
          sourcePath:source.root,sourceBranch:source.branch}]};
      try {
        await prepareIntegrationCandidate(candidate,{gitClient,validateOwner:checkOwner});
        const accepted = await acceptIntegrationCandidate(candidate,{gitClient,validateOwner:checkOwner,verify,
          onAccepted:async record => {
            const current = await acceptedStore.readOnly();
            if (current && !validLedger(current)) fail('ledger identity changed');
            if ((current?.commitSha ?? baselineCommit) !== baseSha && current?.commitSha !== record.manifest.commitSha) fail('ledger changed');
            const target = await gitClient.inspectRepository(request.projectRoot);
            if (target.headSha !== record.manifest.commitSha || target.branch !== request.integrationBranch || target.dirty) fail('target changed');
            await acceptedStore.write({schemaVersion:1,runId,baselineCommit,commitSha:record.manifest.commitSha,
              runtimeVersion:Math.max(runtimeVersion,current?.runtimeVersion ?? 1),path:request.projectRoot,branch:request.integrationBranch});
          }});
        return Object.freeze({...report,status:'integrated',integrationTip:accepted.manifest.commitSha,
          candidateSha:accepted.manifest.commitSha});
      } catch (error) {
        // Only exact target drift with a durable peer acceptance can rebuild.
        // Failed verification, owner changes and ambiguous publication never retry.
        if (error.message !== 'Integration candidate target changed' || attempt === 2) throw error;
        // A peer can have advanced Git while its ledger publication is still
        // in flight. Observe both only after that short transaction finishes.
        const lock = await acquireCandidateIntegrationLock(request.statePaths);
        try {
          const current = await acceptedStore.readOnly();
          const target = await gitClient.inspectRepository(request.projectRoot);
          if (!validLedger(current) || current.commitSha === baseSha || current.commitSha !== target.headSha
            || target.branch !== request.integrationBranch || target.dirty
            || !(await gitClient.isAncestor(request.projectRoot,baseSha,current.commitSha))) throw error;
          // If this candidate was accepted but publication was lost, do not skip its
          // ledger transition based on arbitrary subsequent Git movement.
          const previous = await inspectIntegrationCandidate(candidate,{gitClient,validateOwner:checkOwner});
          if (previous?.status === 'accepted') throw error;
          await checkOwner({intent:previous?.intent ?? null,manifest:previous?.manifest ?? null});
          ledger = current; baseSha = current.commitSha;
        } finally { await lock.release(); }
      }
    }
    fail('retry limit');
  }});
}
