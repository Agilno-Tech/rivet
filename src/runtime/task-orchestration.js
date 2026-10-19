import { CliError } from '../cli/output.js';
import { loadProjectConfig } from '../config/load.js';
import { executionPolicyIdentity } from '../models/execution-policy.js';
import { randomUUID } from 'node:crypto';
import { findRegistration, withMachineContext } from './machine-admission.js';

export function taskAllowance(value) {
  if (value === undefined) return undefined;
  const match = typeof value === 'string' && /^([1-9][0-9]*)(s|m|h)$/.exec(value);
  const result = match && Number(match[1]) * { s: 1000, m: 60000, h: 3600000 }[match[2]];
  if (!Number.isSafeInteger(result) || result < 1 || result > 2147483647)
    throw new CliError('Use --for with a positive duration such as 30m or 1h (at most 596h).', 'INVALID_INPUT');
  return result;
}
export function requireManagedAllowance(record, allowanceMs) {
  if (allowanceMs !== undefined && !record.featurePlan?.executionPolicy)
    throw new CliError('--for requires an approved managed execution policy.', 'INVALID_INPUT');
}
export async function activateTaskAdmission(coordinator, record, project, { allowanceMs, resume = false } = {}) {
  requireManagedAllowance(record, allowanceMs);
  if (!record.featurePlan?.executionPolicy || !['approved', 'running', 'blocked'].includes(record.status)) return null;
  if (allowanceMs !== undefined && (!Number.isSafeInteger(allowanceMs) || allowanceMs < 1 || allowanceMs > 2147483647))
    throw new CliError('Task allowance is invalid.', 'INVALID_INPUT');
  const config = await loadProjectConfig(project);
  const policy = config.orchestration.executionPolicy;
  if (!policy || executionPolicyIdentity(policy).policyDigest !== record.featurePlan.executionPolicy.policyDigest)
    throw new CliError('Execution policy changed since approval. Review a new plan before execution.', 'REPOSITORY_CONFLICT');
  const previous = await findRegistration(coordinator, project, record.runId);
  const parent = await findRegistration(coordinator, project, null);
  const deadlineMs = Math.min(previous?.deadlineMs ?? Infinity, parent?.deadlineMs ?? Infinity,
    Date.now() + (allowanceMs ?? (previous ? 2147483647 : 3600000)));
  if (deadlineMs <= Date.now()) throw new CliError('Task execution allowance expired. Review a new task; resume cannot extend its deadline.', 'REPOSITORY_CONFLICT');
  const limits = { ...policy.limits };
  for (const [key, value] of Object.entries(parent?.limits ?? {})) limits[key] = Math.min(limits[key] ?? 64, value);
  const registration = await coordinator.register({ projectRoot: project, runId: record.runId, deadlineMs, limits, projectLimits: policy.limits });
  if (resume && registration.paused) return coordinator.resume(registration.id);
  return registration;
}
export async function taskCapacity(coordinator, project, runId) {
  const state = await coordinator.inspect();
  const registration = await findRegistration(coordinator, project, runId);
  if (!registration) return null;
  const claims = state.claims.filter(c => c.registrationId === registration.id);
  return { paused: registration.paused, deadlineMs: registration.deadlineMs,
    waiting: [...new Set(claims.filter(c => c.status === 'queued').map(c => c.reason ?? c.resource))],
    capacity: Object.fromEntries(Object.entries(state.limits).map(([resource, limit]) => [resource, {
      held: state.claims.filter(c => c.resource === resource && c.status === 'held').length, limit,
    }])) };
}

// Planning and standalone reviews have no approved run yet. Give each bounded
// invocation its own durable owner so it shares project and machine capacity.
export async function withOperationAdmission(coordinator, project, operation, options = {}) {
  const config = await loadProjectConfig(project);
  const policy = config.orchestration.executionPolicy;
  if (!policy) return withMachineContext(coordinator, project, null, operation, options);
  options.signal?.throwIfAborted();
  const parent = await findRegistration(coordinator, project, null);
  if (parent?.cancelled) throw new CliError('Managed execution stopped: cancelled.', 'REPOSITORY_CONFLICT');
  const deadlineMs = Math.min(Date.now() + 120000, options.deadlineMs ?? Infinity, parent?.deadlineMs ?? Infinity);
  if (deadlineMs <= Date.now()) throw new CliError('Managed execution stopped: deadline.', 'REPOSITORY_CONFLICT');
  const limits = { ...policy.limits };
  for (const [key, value] of Object.entries(parent?.limits ?? {})) limits[key] = Math.min(limits[key] ?? 64, value);
  const operationOwner = randomUUID();
  const runId = `operation-${operationOwner}`;
  const registration = await coordinator.register({ projectRoot: project, runId, operationOwner, deadlineMs, limits, projectLimits: policy.limits });
  try {
    return await withMachineContext(coordinator, project, runId, operation, { ...options, deadlineMs });
  } finally {
    await coordinator.retireOperation({ registrationId: registration.id, operationOwner });
  }
}
