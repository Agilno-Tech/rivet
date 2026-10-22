import {resolveStatePaths} from '../state/paths.js';
import {createReservationStore} from '../git/reservations.js';
import {verifyReservedWorktree} from '../git/worktrees.js';
import {createHash} from 'node:crypto';
import {immutableJson,containsSecretMaterial} from '../clients/contract.js';
import {sessionFailure} from './sessions.js';
export function checkpointDigest(value) {return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
export async function captureCheckpoint({gitClient,run,node,intent,session,summary,usage,nativeHandle,actorId,observedAtMs,nowMs=Date.now()}) {
 if(typeof summary!=='string'||!summary.length||summary.length>8000||containsSecretMaterial(summary))sessionFailure('invalid-checkpoint');
 if(!usage||!Number.isSafeInteger(usage.tokens)||usage.tokens<0||!Number.isFinite(usage.costUsd)||usage.costUsd<0
   ||(usage.timeMinutes!==undefined&&(!Number.isSafeInteger(usage.timeMinutes)||usage.timeMinutes<0))
  ||(usage.tasks!==undefined&&(!Number.isSafeInteger(usage.tasks)||usage.tasks<0))
  ||Object.keys(usage).some(key=>!['tokens','costUsd','timeMinutes','tasks'].includes(key)))sessionFailure('invalid-usage');
 const statePaths=await resolveStatePaths(intent.worktree.path,run.runId);
 const reservations=await createReservationStore(statePaths).list();
 const matching=reservations.reservations.filter(r=>r.nodeId===node.id&&r.ownerId===node.owner.id&&r.status==='active'&&r.worktreePath===intent.worktree.path);
 if(matching.length!==1)sessionFailure('lease-changed');
 const lease=matching[0];
 await verifyReservedWorktree({projectRoot:intent.worktree.path,statePaths,nodeId:node.id,ownerId:node.owner.id,leaseId:lease.leaseId},{gitClient,nowMs});
 const manifest=await gitClient.checkpointManifest(intent.worktree.path);
 if(manifest.rootIdentity.dev!==intent.worktree.dev||manifest.rootIdentity.ino!==intent.worktree.ino)sessionFailure('checkout-changed');
 const planNode=run.featurePlan.nodes.find(item=>item.id===node.id);
 if(manifest.entries.some(entry=>!planNode.ownedPaths.some(path=>entry.path===path||entry.path.startsWith(`${path}/`))))sessionFailure('scope-changed');
 if(nativeHandle!==undefined&&(typeof nativeHandle!=='string'||!nativeHandle.length||nativeHandle.length>200||containsSecretMaterial(nativeHandle)))sessionFailure('invalid-writer');
 const value={version:1,runId:run.runId,nodeId:node.id,intentId:intent.id,sessionId:session.id,generation:session.generation,
  proposalDigest:run.proposalDigest,policyDigest:run.featurePlan.executionPolicy.policyDigest,
  selectionDigest:planNode.executionSelection.profileDigest,baseSha:run.featurePlan.baselineCommit,
  reservation:{leaseId:lease.leaseId,ownerId:lease.ownerId,baseSha:lease.baseSha,expiresAt:lease.expiresAt},worktree:intent.worktree,manifest,summary,usage:structuredClone(usage),nativeHandle:nativeHandle??null,
  criteria:run.workRequest.acceptanceCriteria,decisionsRef:`governance:${run.runId}`,evidenceRefs:run.evidenceRefs};
 return immutableJson({...value,digest:checkpointDigest(value)});
}
export async function verifyCheckpoint(gitClient,checkpoint,run,nowMs=Date.now()) {
 const {digest,...value}=checkpoint;
 if(digest!==checkpointDigest(value)||checkpoint.runId!==run.runId||checkpoint.proposalDigest!==run.proposalDigest
  ||checkpoint.policyDigest!==run.featurePlan.executionPolicy.policyDigest)sessionFailure('checkpoint-changed');
 const statePaths=await resolveStatePaths(checkpoint.worktree.path,run.runId);
 const verified=await verifyReservedWorktree({projectRoot:checkpoint.worktree.path,statePaths,nodeId:checkpoint.nodeId,ownerId:checkpoint.reservation.ownerId,leaseId:checkpoint.reservation.leaseId},{gitClient,nowMs});
 if(verified.reservation.baseSha!==checkpoint.reservation.baseSha||verified.reservation.expiresAt!==checkpoint.reservation.expiresAt)sessionFailure('lease-changed');
 const current=await gitClient.checkpointManifest(checkpoint.worktree.path);
 if(current.digest!==checkpoint.manifest.digest)sessionFailure('checkout-changed');return current;
}
