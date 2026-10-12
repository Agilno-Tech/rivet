import assert from 'node:assert/strict';
import test from 'node:test';
import { loadProjectConfig } from '../../src/config/load.js';
const DEFAULT_CONFIG = await loadProjectConfig(new URL('../fixtures/config/valid/', import.meta.url).pathname);
import { validateProjectConfiguration } from '../../src/config/validate.js';

import { managedPolicy } from '../fixtures/execution-policy.js';

test('accepts managed policy without changing legacy enabled:false', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.orchestration.executionPolicy = managedPolicy();
  assert.equal(validateProjectConfiguration(config), true);
  config.orchestration.enabled = true;
  assert.throws(() => validateProjectConfiguration(config));
});

test('rejects unsafe profiles, unknown efforts, missing/ambiguous routes and advisory writes', () => {
  for (const mutate of [
    p => { p.profiles.implementation.model = '--config=unsafe'; },
    p => { p.profiles.review.effort = 'extreme'; },
    p => { p.routing.implementation = ['implementation', 'review']; },
    p => { delete p.routing.coordination; },
    p => { p.routing.coordination = 'missing'; },
    p => { p.profiles.review.capabilities.push('edit'); },
    p => { p.sessions.maxReplacements = 1000; },
  ]) {
    const config = structuredClone(DEFAULT_CONFIG);
    config.orchestration.executionPolicy = managedPolicy();
    mutate(config.orchestration.executionPolicy);
    assert.throws(() => validateProjectConfiguration(config));
  }
});

test('resolves immutable approved identity and never falls back to another route', async () => {
  const { resolveExecutionSelection, matchesExecutionSelection, executionPolicyIdentity } = await import('../../src/models/execution-policy.js');
  const policy = managedPolicy();
  const selection = resolveExecutionSelection(policy, 'independent-review');
  assert.equal(selection.harness, 'claude');
  assert.equal(selection.recommendationOnly, false);
  assert.deepEqual(selection.capabilities, ['read']);
  assert.equal(Object.isFrozen(selection.capabilities), true);
  assert.equal(selection.policyDigest, executionPolicyIdentity(policy).policyDigest);
  assert.equal(matchesExecutionSelection(policy, 'independent-review', selection), true);
  for (const field of ['model', 'effort', 'reason', 'profileDigest', 'policyDigest']) {
    assert.equal(matchesExecutionSelection(policy, 'independent-review', { ...selection, [field]: 'changed' }), false);
  }
  assert.throws(() => resolveExecutionSelection(policy, ['bounded-fix', 'implementation']));
  assert.throws(() => resolveExecutionSelection(policy, 'unknown'));
  assert.equal(resolveExecutionSelection(undefined, 'implementation'), undefined);
  assert.equal(executionPolicyIdentity(undefined), undefined);
  const changed = structuredClone(policy);
  changed.sessions.maxMinutes++;
  assert.equal(matchesExecutionSelection(changed, 'independent-review', selection), false);
});
