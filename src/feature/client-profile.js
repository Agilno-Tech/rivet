export const FEATURE_PLANNING_TIMEOUT_MS = 120_000;

export const CLAUDE_FEATURE_PROFILE = Object.freeze({
  schemaVersion: 1,
  id: 'claude-bounded-sonnet-v1',
  provider: 'claude',
  model: 'sonnet',
  planning: Object.freeze({
    effort: 'low',
    timeoutMs: FEATURE_PLANNING_TIMEOUT_MS,
    maxCostUsd: 1,
  }),
  execution: Object.freeze({ maxCostUsd: 2 }),
  fallbackModel: null,
});

function exactObject(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  const expectedKeys = Object.keys(expected);
  if (keys.length !== expectedKeys.length || keys.some(key => typeof key !== 'string' || !expectedKeys.includes(key))) return false;
  return expectedKeys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
    const expectedValue = expected[key];
    return expectedValue && typeof expectedValue === 'object'
      ? exactObject(descriptor.value, expectedValue)
      : descriptor.value === expectedValue;
  });
}

export function clientProfileFor(client, caps = {}) {
  if (client !== 'claude') return undefined;
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(caps))) throw new TypeError('Invalid Claude spending caps.');
  const values = {};
  for (const key of Reflect.ownKeys(caps)) {
    const descriptor = Object.getOwnPropertyDescriptor(caps, key);
    const value = descriptor?.value;
    if (!['planningMaxCostUsd', 'workerMaxCostUsd'].includes(key) || !descriptor?.enumerable
      || typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 10_000
      || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(String(value))) throw new TypeError('Invalid Claude spending caps.');
    values[key] = value;
  }
  if (Object.keys(values).length === 0) return CLAUDE_FEATURE_PROFILE;
  return Object.freeze({
    ...CLAUDE_FEATURE_PROFILE,
    planning: Object.freeze({...CLAUDE_FEATURE_PROFILE.planning, maxCostUsd: values.planningMaxCostUsd ?? CLAUDE_FEATURE_PROFILE.planning.maxCostUsd}),
    execution: Object.freeze({maxCostUsd: values.workerMaxCostUsd ?? CLAUDE_FEATURE_PROFILE.execution.maxCostUsd}),
  });
}

// Validate a captured profile without comparing it to today's project settings.
// Policy matching happens when the proposal is created or resumed.
export function isClientProfile(client, value) {
  if (client !== 'claude') return value === undefined;
  try {
    const planning = Object.getOwnPropertyDescriptor(value, 'planning')?.value;
    const execution = Object.getOwnPropertyDescriptor(value, 'execution')?.value;
    const expected = clientProfileFor(client, {
      planningMaxCostUsd: Object.getOwnPropertyDescriptor(planning, 'maxCostUsd')?.value,
      workerMaxCostUsd: Object.getOwnPropertyDescriptor(execution, 'maxCostUsd')?.value,
    });
    return exactObject(value, expected);
  } catch { return false; }
}

export function matchesClientProfile(client, value, caps) {
  const expected = clientProfileFor(client, caps);
  return expected === undefined ? value === undefined : exactObject(value, expected);
}

export function workerExecutionFor(role, caps) {
  if (role.harness === undefined) return undefined;
  if (role.kind !== 'worker' || !['claude', 'codex'].includes(role.harness)) throw new TypeError('Invalid worker harness.');
  const clientProfile = clientProfileFor(role.harness, caps);
  return Object.freeze({ client: role.harness, ...(clientProfile === undefined ? {} : { clientProfile }) });
}

export function matchesWorkerExecution(role, execution, caps) {
  const expected = workerExecutionFor(role, caps);
  return expected === undefined ? execution === undefined : exactObject(execution, expected);
}

export function executionForNode(plan, node) {
  if (node.executionSelection && !node.executionSelection.recommendationOnly) return { client: node.executionSelection.harness, clientProfile: node.executionSelection.harness === 'claude' ? plan.managedClaudeProfile ?? plan.clientProfile ?? clientProfileFor('claude') : undefined, executionSelection: node.executionSelection };
  return node.execution ?? { client: plan.client, clientProfile: plan.clientProfile };
}
