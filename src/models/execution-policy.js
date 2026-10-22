import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { immutableJson } from '../clients/contract.js';
import { createModelRegistry } from './registry.js';

const source = JSON.parse(readFileSync(new URL('../../schemas/orchestration.schema.json', import.meta.url), 'utf8'));
const validate = new Ajv({ strict: true, allErrors: true }).compile({ ...source.properties.executionPolicy, $defs: source.$defs });
const registry = createModelRegistry();
function fail() { throw new TypeError('Invalid execution policy or selection.'); }
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function digest(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }

export function validateExecutionPolicy(input) {
  const policy = immutableJson(input);
  if (!validate(policy)) fail();
  for (const profile of Object.values(policy.profiles)) {
    // Reuse the provider registry for adapter identity; this is not a live capability probe.
    const resolved = registry.resolve({ provider: profile.harness === 'claude' ? 'claude-code' : profile.harness,
      model: profile.model, timeoutMs: 120000, maxOutputTokens: 1000 });
    if (resolved.provider.kind !== 'harness' || !profile.capabilities.includes('read')) fail();
  }
  for (const [classification, id] of Object.entries(policy.routing)) {
    if (!Object.hasOwn(policy.profiles, id)) fail();
    const profile = policy.profiles[id];
    const coding = ['bounded-fix', 'implementation'].includes(classification);
    if (coding ? !profile.capabilities.includes('edit') || !profile.capabilities.includes('commands')
      : profile.capabilities.some(capability => capability !== 'read')) fail();
  }
  return policy;
}

export function executionPolicyIdentity(input) {
  if (input === undefined) return undefined;
  return immutableJson({ version: 1, policyDigest: digest(validateExecutionPolicy(input)) });
}

export function resolveExecutionSelection(input, classification, { hostOnly = false } = {}) {
  if (input === undefined) return undefined;
  const policy = validateExecutionPolicy(input);
  if (typeof classification !== 'string' || !Object.hasOwn(policy.routing, classification) || typeof hostOnly !== 'boolean') fail();
  const profileId = policy.routing[classification];
  const profile = policy.profiles[profileId];
  return immutableJson({ version: 1, classification, profileId, profileDigest: digest(profile),
    policyDigest: digest(policy), ...profile, reason: `Approved ${classification} route selects ${profileId}.`, recommendationOnly: hostOnly });
}

export function matchesExecutionSelection(input, classification, selection, options) {
  try { return canonical(resolveExecutionSelection(input, classification, options)) === canonical(selection); }
  catch { return false; }
}
