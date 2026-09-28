import test from 'node:test';
import assert from 'node:assert/strict';
import { candidate, hash, validateCandidate } from '../../src/delivery/contract.js';
import { deliveryGovernanceEvidence } from '../../src/delivery/prepare.js';
import { reviewRequestPayload, reviewRequestContent } from '../../src/delivery/review-request.js';
import { createDecision, approveDecision, renderDecisions } from '../../src/feature/decisions.js';

const now = '2026-09-28T10:00:00.000Z';
const run = { runId: 'run-example', workRequest: { digest: 'a'.repeat(64) }, proposalDigest: 'b'.repeat(64), featurePlan: { baselineCommit: 'c'.repeat(40) } };
const checkout = { acceptedCommit: 'd'.repeat(40) };
const bindings = { runId: run.runId, requestDigest: run.workRequest.digest, planDigest: run.proposalDigest };
const context = { ...bindings, now, actor: { kind: 'agent', id: 'coding-agent' } };
const input = { id: 'response-format', tier: 1, title: 'Response format', options: [{ id: 'json', description: 'Return a JSON status object' }, { id: 'text', description: 'Return plain text' }], choice: 'json', rationale: 'Keep the existing API convention.' };
const base = { runId: run.runId,
  repository: { provider: 'github', host: 'github.com', namespace: 'team', name: 'repo', fullName: 'team/repo', url: 'https://github.com/team/repo' },
  sourceBranch: 'feature/health', targetBranch: 'main',
  localVerification: { runId: run.runId, headSha: checkout.acceptedCommit, evidenceDigest: 'e'.repeat(64), verifiedAt: now, status: 'passed' } };
function governance(decisions = [createDecision(input, context)]) {
  return { ready: true, blockers: [], decisions, decisionMarkdown: 'Caller-supplied text is not trusted.',
    subject: { ...bindings, phase: 'final', headSha: checkout.acceptedCommit, baseSha: run.featurePlan.baselineCommit },
    policy: { required: false }, review: { valid: true, reports: [], blockers: [] }, scan: null };
}
function governedCandidate(observed = governance()) {
  const { decisionSummary, ...proof } = deliveryGovernanceEvidence(observed, run, checkout);
  return candidate({ ...base, ...(decisionSummary ? { decisionSummary } : {}), localVerification: { ...base.localVerification, ...proof } });
}

test('PR body includes validated recorded and human-approved decisions from the journal', () => {
  const pending = createDecision({ ...input, id: 'breaking-contract', tier: 2 }, context);
  const approved = approveDecision(pending, { ...context, actor: { kind: 'human', id: 'reviewer' }, humanConfirmed: true });
  const decisions = [createDecision(input, context), approved];
  const target = governedCandidate(governance(decisions));
  const payload = reviewRequestPayload(target);
  assert.match(payload.body, /## Decisions/);
  assert.match(payload.body, /Tier 1 · recorded/);
  assert.match(payload.body, /Tier 2 · approved/);
  assert.match(payload.body, /Confirmed by: reviewer/);
  assert.doesNotMatch(payload.body, /Caller-supplied text/);
  assert.equal(target.decisionSummary, renderDecisions(decisions, bindings));
  assert.equal(target.localVerification.decisionSummaryDigest, hash(target.decisionSummary));
  assert.match(target.localVerification.governanceDigest, /^[a-f0-9]{64}$/);
  const content = reviewRequestContent({ action: 'review-request', digest: 'f'.repeat(64), candidate: target, payload });
  assert.match(content.body, /<!-- rivet-review-operation:/);
});

test('empty optional governance preserves legacy candidate shape and body', () => {
  assert.deepEqual(deliveryGovernanceEvidence(governance([]), run, checkout), {});
  const legacy = candidate(base), current = governedCandidate(governance([]));
  assert.deepEqual(current, legacy);
  assert.deepEqual(reviewRequestPayload(current), reviewRequestPayload(legacy));
  assert.equal('decisionSummary' in legacy, false);
  assert.equal(validateCandidate(legacy), legacy);
});

test('review or scan evidence binds candidate even when decision journal is empty', () => {
  for (const extension of [{ policy: { required: true } }, { review: { valid: true, reports: [{ digest: 'f'.repeat(64) }], blockers: [] } }, { scan: { status: 'passed', digest: 'a'.repeat(64) } }]) {
    const target = governedCandidate({ ...governance([]), ...extension });
    assert.match(target.localVerification.governanceDigest, /^[a-f0-9]{64}$/);
    assert.equal(target.decisionSummary, undefined);
  }
});

test('pending decisions and missing required reviews prevent delivery preparation', () => {
  for (const extension of [
    { ready: false }, { blockers: [{ code: 'missing-review' }] },
    { review: { valid: false, reports: [], blockers: [{ code: 'missing-review' }] } },
    { decisions: [createDecision({ ...input, tier: 2 }, context)] },
    { scan: { status: 'failed' } },
  ]) assert.throws(() => deliveryGovernanceEvidence({ ...governance(), ...extension }, run, checkout), { code: 'ERR_DELIVERY_PREPARATION' });
});

test('governance binding and approved journal tampering cannot produce a delivery summary', () => {
  for (const changes of [{ headSha: 'f'.repeat(40) }, { baseSha: 'f'.repeat(40) }, { planDigest: 'f'.repeat(64) }, { requestDigest: 'f'.repeat(64) }, { runId: 'different-run' }, { phase: 'plan' }]) {
    const original = governance();
    assert.throws(() => deliveryGovernanceEvidence({ ...original, subject: { ...original.subject, ...changes } }, run, checkout), { code: 'ERR_DELIVERY_PREPARATION' });
  }
  const changed = structuredClone(governance()); changed.decisions[0].choice = 'text';
  assert.throws(() => deliveryGovernanceEvidence(changed, run, checkout), { code: 'ERR_INVALID_DECISION' });
});

test('changed decision or review evidence changes the local governance proof', () => {
  const before = governedCandidate();
  const changedDecision = governedCandidate(governance([createDecision({ ...input, choice: 'text' }, context)]));
  assert.notEqual(before.localVerification.governanceDigest, changedDecision.localVerification.governanceDigest);
  assert.notEqual(before.localVerification.decisionSummaryDigest, changedDecision.localVerification.decisionSummaryDigest);
  const changedReview = governedCandidate({ ...governance(), review: { valid: true, reports: [{ digest: 'f'.repeat(64) }], blockers: [] } });
  assert.notEqual(before.localVerification.governanceDigest, changedReview.localVerification.governanceDigest);
});

test('summary modification or replacing generated PR content fails before dispatch', () => {
  const target = governedCandidate();
  const altered = structuredClone(target); altered.decisionSummary += '\nUnreviewed content.';
  assert.throws(() => validateCandidate(altered), { code: 'ERR_DELIVERY_DECISION_SUMMARY_MISMATCH' });
  const payload = reviewRequestPayload(target);
  assert.throws(() => reviewRequestContent({ action: 'review-request', digest: 'f'.repeat(64), candidate: target,
    payload: { ...payload, body: payload.body.replace(target.decisionSummary, 'Journal omitted.') } }), { code: 'ERR_DELIVERY_DECISION_SUMMARY_MISMATCH' });
  const { decisionSummaryDigest, ...withoutSummaryDigest } = target.localVerification;
  assert.throws(() => candidate({ ...base, decisionSummary: target.decisionSummary, localVerification: withoutSummaryDigest }));
  assert.throws(() => candidate({ ...base, localVerification: { ...base.localVerification, decisionSummaryDigest } }));
});

test('journal summaries cannot inject HTML, links or mentions into generated PR content', () => {
  const target = governedCandidate(governance([createDecision({ ...input, title: '<img src=x>', rationale: '[external](https://example.test) @reviewer' }, context)]));
  const payload = reviewRequestPayload(target);
  assert.doesNotMatch(payload.body, /<img|\[external\]\(|@reviewer/);
  const summary = '## Decisions\n\n<img src=x>';
  assert.throws(() => candidate({ ...base, decisionSummary: summary,
    localVerification: { ...base.localVerification, governanceDigest: 'a'.repeat(64), decisionSummaryDigest: hash(summary) } }), { code: 'ERR_DELIVERY_INVALID_DECISION_SUMMARY' });
});

test('oversized decision evidence and final PR body stop instead of truncating', () => {
  const decisions = Array.from({ length: 8 }, (_, index) => createDecision({ ...input, id: `decision-${index}`, rationale: 'x'.repeat(4000) }, context));
  assert.throws(() => deliveryGovernanceEvidence(governance(decisions), run, checkout), /never truncated/);
  const summary = '## Decisions\n\n' + 'x'.repeat(31700);
  const target = candidate({ ...base, decisionSummary: summary,
    localVerification: { ...base.localVerification, governanceDigest: 'a'.repeat(64), decisionSummaryDigest: hash(summary) } });
  assert.throws(() => reviewRequestPayload(target), { code: 'ERR_DELIVERY_REVIEW_CONTENT_TOO_LARGE' });
});
