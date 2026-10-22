import { AsyncLocalStorage } from 'node:async_hooks';

const attempts = new AsyncLocalStorage();
const proofs = new WeakMap();

// This evidence stays in the current process and cannot be reconstructed from
// a public error code, a PID, or a serialized receipt after a restart.
export async function withExecutionProof(identity, operation, reconcile) {
  const attempt = { observed: false, pending: new Set(), closed: false };
  try {
    return await attempts.run(attempt, operation);
  } finally {
    // Fence saved runners before reconciliation can release their capacity.
    attempt.closed = true;
    if (attempt.observed && attempt.pending.size === 0) {
      const proof = Object.freeze({});
      proofs.set(proof, identity);
      await reconcile(proof);
    }
  }
}

export function validExecutionProof(proof, identity) {
  return typeof identity === 'string' && proofs.has(proof) && proofs.get(proof) === identity;
}

export function observeExecutionAttempt() {
  const attempt = attempts.getStore();
  function assertCurrent() {
    if (attempt?.closed || attempts.getStore() !== attempt) {
      throw new Error('Execution attempt has settled or changed.');
    }
  }
  assertCurrent();
  if (attempt) attempt.observed = true;
  return () => {
    assertCurrent();
    const child = {};
    attempt?.pending.add(child);
    return () => attempt?.pending.delete(child);
  };
}
