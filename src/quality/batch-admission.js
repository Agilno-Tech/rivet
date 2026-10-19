import { currentMachineContext, withMachineContext } from '../runtime/machine-admission.js';

async function applicableRegistrations(coordinator,projectRoot,runIds) {
  const registrations=await Promise.all([null,...runIds].map(runId=>coordinator.getRegistration({projectRoot,runId})));
  return registrations.filter(Boolean);
}
function assertOpen(registrations) {
  if(registrations.some(registration=>registration.paused||registration.cancelled||Date.now()>=registration.deadlineMs))
    throw new Error('Batch member admission is paused, cancelled or expired');
}
export async function inspectBatchReadinessAdmission(projectRoot,runId,options) {
  const coordinator=options.coordinator??currentMachineContext()?.coordinator;
  if(!coordinator)return;
  // Listing is observational: ordinary inspect refreshes queue admission.
  assertOpen(await applicableRegistrations(coordinator,projectRoot,new Set([runId])));
}

// A combined check consumes one command slot, but every contributing task must
// retain authority. This guard also runs after a command's capacity wait.
export async function withBatchAdmission(projectRoot, members, options, operation) {
  const coordinator = options.coordinator ?? currentMachineContext()?.coordinator;
  if (!coordinator) return operation(options);
  const runIds = new Set(members.map(member => member.runId));
  const applicable = () => applicableRegistrations(coordinator,projectRoot,runIds);
  const initial = await applicable();
  const pinned = new Set(initial.map(registration => registration.id));
  const validateAdmission = async () => {
    options.signal?.throwIfAborted();
    const current = await applicable();
    if ([...pinned].some(id => !current.some(registration => registration.id === id))) {
      throw new Error('Batch member admission identity changed');
    }
    assertOpen(current);
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
