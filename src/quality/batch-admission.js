import { currentMachineContext, withMachineContext } from '../runtime/machine-admission.js';

// A combined check consumes one command slot, but every contributing task must
// retain authority. This guard also runs after a command's capacity wait.
export async function withBatchAdmission(projectRoot, members, options, operation) {
  const coordinator = options.coordinator ?? currentMachineContext()?.coordinator;
  if (!coordinator) return operation(options);
  const runIds = new Set(members.map(member => member.runId));
  const applicable = state => state.registrations.filter(registration =>
    registration.projectRoot === projectRoot
      && (registration.runId === null || runIds.has(registration.runId)));
  const initial = applicable(await coordinator.inspect());
  const pinned = new Set(initial.map(registration => registration.id));
  const validateAdmission = async () => {
    options.signal?.throwIfAborted();
    const current = applicable(await coordinator.inspect());
    if ([...pinned].some(id => !current.some(registration => registration.id === id))) {
      throw new Error('Batch member admission identity changed');
    }
    if (current.some(registration => registration.paused || registration.cancelled
      || Date.now() >= registration.deadlineMs)) {
      throw new Error('Batch member admission is paused, cancelled or expired');
    }
    await options.validateAdmission?.();
  };
  await validateAdmission();
  const deadlineMs = initial.length ? Math.min(...initial.map(registration => registration.deadlineMs)) : undefined;
  // Do not accidentally bypass admission when the first selected task is
  // unmanaged but a later actual participant has a machine registration.
  const registeredMember = initial.find(registration => runIds.has(registration.runId));
  const ownerRunId = registeredMember?.runId ?? members[0].runId;
  return withMachineContext(coordinator, projectRoot, ownerRunId,
    signal => operation({ ...options, signal, validateAdmission }),
    { signal: options.signal, deadlineMs, beforeDispatch: validateAdmission });
}
