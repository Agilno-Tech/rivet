import { withExecutionProof } from '../clients/execution-proof.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const context = new AsyncLocalStorage();
export const admissionKey = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
function error(reason) {
  const e = new Error(`Managed execution stopped: ${reason}.`);
  e.code = 'ERR_MACHINE_ADMISSION';
  e.safeMessage = e.message;
  return e;
}
export async function findRegistration(coordinator, project, runId) {
  const state = await coordinator.inspect();
  return state.registrations.find(
    (r) => r.projectRoot === project && r.runId === (runId ?? null),
  );
}
export async function withMachineContext(
  coordinator,
  project,
  runId,
  operation,
  { signal, nonblocking = false, cleanup = false } = {},
) {
  let registration = await findRegistration(coordinator, project, runId);
  if (!registration && runId && !cleanup) {
    const enrolled = await findRegistration(coordinator, project, null);
    if (enrolled)
      registration = await coordinator.register({
        projectRoot: project,
        runId,
        deadlineMs: enrolled.deadlineMs,
        limits: enrolled.limits,
      });
  }
  if (!registration) return operation(signal);
  const remaining = registration.deadlineMs - Date.now();
  if (remaining <= 0 && !cleanup) throw error('deadline');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, {
    once: true,
  });
  if (signal?.aborted) abort();
  const timer = cleanup
    ? undefined
    : setTimeout(abort, Math.min(remaining, 2147483647));
  try {
    return await context.run(
      {
        coordinator,
        registration,
        signal: controller.signal,
        nonblocking,
        admissionClosed: remaining <= 0 || registration.cancelled === true,
      },
      () => operation(controller.signal),
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
export async function admitted(resource, key, options, operation) {
  const selected = context.getStore();
  if (!selected) return operation(options);
  const { coordinator, registration } = selected;
  const signal = options?.signal ?? selected.signal;
  const generation = options?.generation ?? 1;
  const prior = (await coordinator.inspect()).claims.filter(
    (c) =>
      c.registrationId === registration.id &&
      c.resource === resource &&
      c.idempotencyKey.startsWith(`${key}:`) &&
      c.generation === generation,
  );
  const pending = prior.find((c) => ['queued', 'held'].includes(c.status));
  const operationKey = pending?.idempotencyKey ?? `${key}:${prior.length + 1}`;
  const claim = await coordinator.request({
    registrationId: registration.id,
    resource,
    idempotencyKey: operationKey,
    generation,
  });
  let current = claim;
  try {
    while (current.status === 'queued') {
      if (selected.nonblocking) {
        const e = error('queued');
        e.queued = true;
        e.claim = current;
        throw e;
      }
      if (signal?.aborted) throw error('cancelled');
      if (current.reason === 'deadline') throw error('deadline');
      await delay(25, undefined, {
        signal,
      });
      current = (await coordinator.inspect()).claims.find(
        (c) => c.id === claim.id,
      );
    }
    if (current.status !== 'held')
      throw error('operation already consumed; inspect its saved outcome');
    if (signal?.aborted) throw error('cancelled');
    await options?.beforeDispatch?.();
    const dispatchId = randomUUID();
    if (resource !== 'activeTasks')
      await coordinator.dispatch({
        dispatchId,
        claimId: claim.id,
        generation,
      });
    return await withExecutionProof(dispatchId, () => operation({
      ...options,
      signal,
      onExecution: async (receipt) => {
        await coordinator.execution({
          claimId: claim.id,
          generation,
          receipt,
        });
        await options?.onExecution?.(receipt);
      },
    }), proof => coordinator.release({
      claimId: claim.id,
      generation,
      completed: true,
      noExecutionProof: proof,
      dispatchId,
    }));
  } finally {
    const saved = (await coordinator.inspect()).claims.find(
      (c) => c.id === claim.id,
    );
    if (
      (saved?.status === 'queued' && !selected.nonblocking) ||
      (saved?.status === 'held' && !saved.dispatched)
    ) {
      await coordinator
        .release({
          claimId: claim.id,
          generation,
          completed: true,
        })
        .catch((e) => {
          if (resource !== 'activeTasks') throw e;
        });
    }
  }
}
export async function taskAdmission(operation) {
  const selected = context.getStore();
  if (!selected) return operation();
  const { coordinator, registration, signal } = selected;
  const ownerId = randomUUID();
  const claim = await coordinator.request({
    registrationId: registration.id,
    resource: 'activeTasks',
    idempotencyKey: 'run-task',
    generation: 1,
  });
  // A task slot represents the run, while this owner token serializes callers.
  // A contender never enters the workflow and never releases another owner.
  await coordinator.claimTask({ claimId: claim.id, generation: 1, ownerId });
  try {
    let current = claim;
    while (current.status === 'queued') {
      signal?.throwIfAborted();
      if (current.reason === 'deadline') throw error('deadline');
      await delay(25, undefined, { signal });
      current = (await coordinator.inspect()).claims.find(
        (c) => c.id === claim.id,
      );
    }
    if (current.status !== 'held') throw error('task admission cancelled');
    signal?.throwIfAborted();
    return await operation();
  } finally {
    await coordinator
      .release({ claimId: claim.id, generation: 1, ownerId, completed: true })
      .catch((e) => {
        // An unresolved child deliberately keeps both its run and agent capacity.
        if (!e.message.includes('children-held')) throw e;
      });
  }
}
export function currentMachineContext() {
  return context.getStore();
}
