import {createHash} from 'node:crypto';
import {hostReconciliationPaths} from '../state/paths.js';
import {createSnapshotStore,readSnapshotWithoutLock} from '../state/snapshot-store.js';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function hostReconciliationStore(paths,nodeId) {
  const location=await hostReconciliationPaths(paths,nodeId);
  const store=createSnapshotStore(location,{environment:{}});
  return {
    async read() {return (await readSnapshotWithoutLock(location))?.data??null;},
    async pin({action,result,worker,reservation}) {
      const identity={actionDigest:digest(action),resultDigest:digest(result),sourceSha:worker.headSha,
        sourcePath:worker.root,sourceBranch:worker.branch,sourceIdentity:worker.rootIdentity,reservationDigest:digest(reservation)};
      const prior=await this.read();
      if(prior) {
        if(JSON.stringify(prior.identity)!==JSON.stringify(identity))throw new Error('Host reconciliation identity changed');
        return prior;
      }
      const record={identity,candidate:null};
      await store.write(record,{expectedVersion:0,environment:{}});return record;
    },
    async candidate(manifest) {
      const prior=await this.read();if(!prior)throw new Error('Host reconciliation identity missing');
      const candidate={path:manifest.path,commit:manifest.commitSha,branch:manifest.branch,kind:'candidate'};
      await store.write({...prior,candidate},{expectedVersion:await store.version(),environment:{}});
    },
  };
}
