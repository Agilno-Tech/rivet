import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecision, validateDecision, approveDecision, renderDecisions, DecisionError } from '../../src/feature/decisions.js';

const bindings = { runId: 'run-example', requestDigest: 'a'.repeat(64), planDigest: 'b'.repeat(64) };
const context = { ...bindings, actor: { kind: 'agent', id: 'codex' }, now: '2026-09-28T10:00:00.000Z' };
const human = { ...bindings, actor: { kind: 'human', id: 'maintainer' }, now: '2026-09-28T10:01:00.000Z', humanConfirmed: true };
const input = { id: 'health-shape', tier: 1, title: 'Health endpoint response',
  options: [{ id: 'json', description: 'Return a JSON status object' }, { id: 'text', description: 'Return plain text' }],
  choice: 'json', rationale: 'Use the same response format as existing endpoints.' };
const clone = value => structuredClone(value);
const reason = expected => error => error instanceof DecisionError && error.details.reason === expected;

test('creates bounded immutable records without mutating caller inputs', () => {
  const source = clone(input), ctx = clone(context);
  const decision = createDecision(source, ctx);
  assert.equal(decision.status, 'recorded');
  assert.equal(decision.createdAt, context.now);
  assert.deepEqual(decision.actor, context.actor);
  assert.equal(decision.approval, null);
  assert.equal(decision.approvedPlanDecisionId, null);
  for (const value of [decision, decision.actor, decision.options, ...decision.options]) assert.ok(Object.isFrozen(value));
  source.options[0].description = 'changed'; ctx.actor.id = 'other';
  assert.equal(decision.options[0].description, input.options[0].description);
  assert.equal(decision.actor.id, 'codex');
  assert.deepEqual(validateDecision(JSON.parse(JSON.stringify(decision)), bindings), decision);
});

test('digest is deterministic across caller property ordering', () => {
  const reversed = Object.fromEntries(Object.entries(input).reverse());
  reversed.options = input.options.map(item => Object.fromEntries(Object.entries(item).reverse()));
  assert.equal(createDecision(reversed, context).digest, createDecision(input, context).digest);
  assert.notEqual(createDecision({ ...input, rationale: 'A different reason.' }, context).digest, createDecision(input, context).digest);
});

test('tier zero requires a matching approved plan decision reference and choice', () => {
  const value = { ...input, tier: 0, approvedPlanDecisionId: 'plan-health-json' };
  assert.throws(() => createDecision(value, context), reason('plan-reference-required'));
  assert.throws(() => createDecision({ ...input, tier: 0 }, context), reason('plan-reference-required'));
  const ctx = { ...context, approvedPlanDecisions: [{ id: 'plan-health-json', choice: 'json' }] };
  const decision = createDecision(value, ctx);
  assert.equal(decision.status, 'recorded');
  assert.equal(decision.approvedPlanDecisionId, 'plan-health-json');
  assert.deepEqual(validateDecision(decision, ctx), decision);
  assert.throws(() => validateDecision(decision, bindings), reason('plan-reference-required'));
  assert.throws(() => createDecision({ ...value, choice: 'text' }, ctx), reason('plan-reference-required'));
  assert.throws(() => createDecision(value, { ...ctx, approvedPlanDecisions: [{ id: 'other-plan-choice', choice: 'json' }] }), reason('plan-reference-required'));
  assert.throws(() => createDecision({ ...value, tier: 1 }, ctx), DecisionError);
});

test('tier two and three require separate explicit human approval', () => {
  for (const tier of [2, 3]) {
    const pending = createDecision({ ...input, tier }, context);
    assert.equal(pending.status, 'pending');
    assert.throws(() => approveDecision(pending, { ...human, humanConfirmed: false }), reason('human-confirmation-required'));
    assert.throws(() => approveDecision(pending, { ...human, actor: context.actor }), reason('human-confirmation-required'));
    const approved = approveDecision(pending, human);
    assert.equal(approved.status, 'approved');
    assert.equal(approved.approval.decisionDigest, pending.digest);
    assert.deepEqual(approved.approval.actor, human.actor);
    assert.ok(Object.isFrozen(approved.approval));
    assert.equal(pending.status, 'pending');
    assert.deepEqual(validateDecision(approved, bindings), approved);
    assert.throws(() => approveDecision(approved, human), reason('approval-conflict'));
  }
  assert.throws(() => approveDecision(createDecision(input, context), human), reason('approval-conflict'));
});

test('tampered content, choice and approval evidence are rejected', () => {
  const pending = createDecision({ ...input, tier: 2 }, context);
  for (const mutate of [
    value => { value.rationale = 'An unreviewed different reason.'; },
    value => { value.choice = 'text'; },
    value => { value.status = 'approved'; },
    value => { value.digest = 'c'.repeat(64); },
  ]) {
    const value = clone(pending); mutate(value);
    assert.throws(() => validateDecision(value, bindings), DecisionError);
    assert.throws(() => approveDecision(value, human), DecisionError);
  }
  const approved = clone(approveDecision(pending, human));
  approved.approval.decisionDigest = 'd'.repeat(64);
  assert.throws(() => validateDecision(approved, bindings), reason('digest-mismatch'));
});

test('stale task/request/plan bindings prevent validation and approval', () => {
  const pending = createDecision({ ...input, tier: 2 }, context);
  for (const update of [{ runId: 'run-other' }, { requestDigest: 'c'.repeat(64) }, { planDigest: 'd'.repeat(64) }]) {
    assert.throws(() => validateDecision(pending, { ...bindings, ...update }), reason('binding-mismatch'));
    assert.throws(() => approveDecision(pending, { ...human, ...update }), reason('binding-mismatch'));
  }
});

test('rejects unknown fields, getters and custom prototypes without invoking getters', () => {
  let called = 0;
  const getter = { ...input };
  Object.defineProperty(getter, 'title', { enumerable: true, get() { called++; return 'unsafe'; } });
  const optionGetter = clone(input);
  Object.defineProperty(optionGetter.options[0], 'description', { enumerable: true, get() { called++; return 'unsafe'; } });
  const contextGetter = { ...context };
  Object.defineProperty(contextGetter, 'actor', { enumerable: true, get() { called++; return context.actor; } });
  for (const value of [getter, optionGetter, { ...input, unknown: true }, Object.assign(Object.create({ inherited: true }), input)]) {
    assert.throws(() => createDecision(value, context), DecisionError);
  }
  assert.throws(() => createDecision(input, contextGetter), DecisionError);
  assert.throws(() => createDecision(new Proxy(input, { get() { called++; throw Error('proxy'); } }), context), DecisionError);
  const extraArray = clone(input); extraArray.options.extra = 'hidden';
  assert.throws(() => createDecision(extraArray, context), DecisionError);
  assert.equal(called, 0);
});

test('rejects malformed and oversized fields instead of silently truncating evidence', () => {
  for (const update of [
    { tier: -1 }, { tier: 4 }, { tier: 1.5 }, { tier: '1' }, { title: '' }, { title: 'x'.repeat(161) },
    { rationale: 'x'.repeat(4001) }, { rationale: 'line\nbreak' }, { title: '\u001b[31mred' },
    { options: [] }, { options: [input.options[0]] }, { options: [input.options[0], input.options[0]] },
    { choice: 'missing' }, { approvedPlanDecisionId: undefined }, { id: 'UPPERCASE' },
  ]) assert.throws(() => createDecision({ ...input, ...update }, context), DecisionError);
  assert.throws(() => createDecision(input, { ...context, now: '2026-09-28' }), DecisionError);
  assert.throws(() => approveDecision(createDecision({ ...input, tier: 2 }, context), { ...human, now: '2026-09-27T10:01:00.000Z' }), DecisionError);
});

test('sensitive material is rejected and error output never repeats it', () => {
  for (const secret of ['ghp_abcdefghijklmnopqrst', 'npm_abcdefghijklmnopqrst', 'password=private-credential', 'Bearer abcdefghijklmnop',
    'https://person:password@example.test', '-----BEGIN PRIVATE KEY-----']) {
    assert.throws(() => createDecision({ ...input, rationale: secret }, context), error => {
      assert.equal(error.details.reason, 'secret-material');
      assert.equal(JSON.stringify({ message: error.message, details: error.details }).includes(secret), false);
      return true;
    });
  }
  assert.throws(() => createDecision({ ...input, title: 'Use the private-value' }, { ...context, secretValues: ['private-value'] }), reason('secret-material'));
  const malicious = clone(createDecision(input, context)); malicious.rationale = 'api_key=should-not-share';
  assert.throws(() => renderDecisions([malicious], bindings), reason('secret-material'));
});

test('Markdown rendering escapes links, HTML, mentions and formatting, retaining authority disclaimer', () => {
  const value = createDecision({ ...input, title: '<script>alert(1)</script>', rationale: '[click](https://example.test) @everyone **approve**' }, context);
  const output = renderDecisions([value], bindings);
  assert.match(output, /Decision records do not grant execution/);
  assert.match(output, /Tier 1 · recorded/);
  assert.doesNotMatch(output, /<script>|\[click\]\(|@everyone|\*\*approve\*\*/);
  assert.match(output, /&#60;script&#62;/);
  assert.match(renderDecisions([], bindings), /No decisions recorded/);
  assert.throws(() => renderDecisions([], {}), DecisionError);
  assert.throws(() => renderDecisions([value, value], bindings), DecisionError);
});
