import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { containsSecretMaterial } from '../clients/contract.js';

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const DIGEST = /^[a-f0-9]{64}$/;
const INPUT = ['id', 'tier', 'title', 'options', 'choice', 'rationale', 'approvedPlanDecisionId'];
const RECORD = ['schemaVersion', ...INPUT, 'runId', 'requestDigest', 'planDigest', 'actor', 'createdAt', 'status', 'approval', 'digest'];
const BINDINGS = ['runId', 'requestDigest', 'planDigest'];
const CONTEXT = [...BINDINGS, 'actor', 'now', 'approvedPlanDecisions', 'secretValues', 'humanConfirmed'];

export class DecisionError extends Error {
  constructor(reason = 'invalid-decision') {
    super({
      'invalid-decision': 'Decision data is invalid.',
      'secret-material': 'Decision data contains sensitive material. Remove credentials before recording it.',
      'binding-mismatch': 'Decision does not match the current task and approved plan.',
      'digest-mismatch': 'Decision content changed after it was recorded.',
      'plan-reference-required': 'Tier 0 requires a matching decision reference from the approved plan.',
      'human-confirmation-required': 'This decision requires explicit human confirmation.',
      'approval-conflict': 'Only a pending decision can be approved. Read the current decision before retrying.',
    }[reason] ?? 'Decision data is invalid.');
    this.name = 'DecisionError';
    this.code = 'ERR_INVALID_DECISION';
    this.safeMessage = this.message;
    this.details = Object.freeze({ reason });
  }
}
const fail = reason => { throw new DecisionError(reason); };

function record(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length > allowed.length || keys.some(key => typeof key !== 'string' || !allowed.includes(key))) fail();
  const copy = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.value === undefined) fail();
    Object.defineProperty(copy, key, { value: descriptor.value, enumerable: true });
  }
  if (required.some(key => !Object.hasOwn(copy, key))) fail();
  return copy;
}
function array(value, max, min = 0) {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) fail();
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (!Number.isInteger(length) || length < min || length > max) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1) fail();
  const result = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.value === undefined) fail();
    result.push(descriptor.value);
  }
  return result;
}
function text(value, max, secrets) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.trim() !== value
    || /[\u0000-\u001f\u007f-\u009f\p{Cf}]/u.test(value)) fail();
  if (containsSecretMaterial(value) || /\b(?:npm_|glpat-|hf_)[A-Za-z0-9_-]{16,}\b/.test(value) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)
    || /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i.test(value)
    || secrets.some(secret => value.includes(secret))) fail('secret-material');
  return value;
}
function id(value, secrets = []) {
  if (typeof value !== 'string' || value.length > 64 || !ID.test(value)) fail();
  return text(value, 64, secrets);
}
function digest(value) { if (typeof value !== 'string' || !DIGEST.test(value)) fail(); return value; }
function instant(value) {
  if (typeof value !== 'string' || value.length !== 24 || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) fail();
  return value;
}
function actor(value, secrets) {
  const result = record(value, ['kind', 'id']);
  if (!['human', 'agent'].includes(result.kind)) fail();
  return { kind: result.kind, id: text(result.id, 128, secrets) };
}
function context(value, mode = 'validate') {
  const result = record(value, CONTEXT, mode === 'validate' ? BINDINGS : [...BINDINGS, 'actor', 'now']);
  id(result.runId); digest(result.requestDigest); digest(result.planDigest);
  const secrets = result.secretValues === undefined ? [] : array(result.secretValues, 64).map(secret => {
    if (typeof secret !== 'string' || !secret || secret.length > 4096) fail();
    return secret;
  });
  const approved = result.approvedPlanDecisions === undefined ? [] : array(result.approvedPlanDecisions, 128).map(item => {
    const reference = record(item, ['id', 'choice']);
    return { id: id(reference.id), choice: id(reference.choice) };
  });
  if (new Set(approved.map(item => item.id)).size !== approved.length) fail();
  return { ...result, secretValues: secrets, approvedPlanDecisions: approved,
    ...(result.actor === undefined ? {} : { actor: actor(result.actor, secrets) }),
    ...(result.now === undefined ? {} : { now: instant(result.now) }),
  };
}
function input(value, ctx, stored = false) {
  const source = record(value, INPUT, stored ? INPUT : INPUT.filter(key => key !== 'approvedPlanDecisionId'));
  if (!Number.isInteger(source.tier) || source.tier < 0 || source.tier > 3) fail();
  const options = array(source.options, 8, 2).map(option => {
    const candidate = record(option, ['id', 'description']);
    return { id: id(candidate.id, ctx.secretValues), description: text(candidate.description, 1000, ctx.secretValues) };
  });
  if (new Set(options.map(option => option.id)).size !== options.length || !options.some(option => option.id === source.choice)) fail();
  if (Object.hasOwn(source, 'approvedPlanDecisionId') && source.approvedPlanDecisionId !== null && typeof source.approvedPlanDecisionId !== 'string') fail();
  const reference = source.approvedPlanDecisionId ?? null;
  if (source.tier === 0) {
    if (!reference || !ctx.approvedPlanDecisions.some(item => item.id === reference && item.choice === source.choice)) fail('plan-reference-required');
    id(reference, ctx.secretValues);
  } else if (reference !== null) fail();
  return { id: id(source.id, ctx.secretValues), tier: source.tier, title: text(source.title, 160, ctx.secretValues), options,
    choice: id(source.choice, ctx.secretValues), rationale: text(source.rationale, 4000, ctx.secretValues), approvedPlanDecisionId: reference };
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function hash(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function sealed(value) { return freeze({ ...value, digest: hash(value) }); }

export function createDecision(value, suppliedContext) {
  const ctx = context(suppliedContext, 'create');
  const fields = input(value, ctx);
  return sealed({ schemaVersion: 1, ...fields, runId: ctx.runId, requestDigest: ctx.requestDigest,
    planDigest: ctx.planDigest, actor: ctx.actor, createdAt: ctx.now,
    status: fields.tier < 2 ? 'recorded' : 'pending', approval: null });
}

export function validateDecision(value, suppliedContext) {
  const ctx = context(suppliedContext);
  const source = record(value, RECORD);
  if (source.schemaVersion !== 1) fail();
  for (const key of BINDINGS) if (source[key] !== ctx[key]) fail('binding-mismatch');
  const fields = input(Object.fromEntries(INPUT.map(key => [key, source[key]])), ctx, true);
  if (!['recorded', 'pending', 'approved'].includes(source.status)
    || (fields.tier < 2 ? source.status !== 'recorded' : source.status === 'recorded')) fail();
  const result = { schemaVersion: 1, ...fields, runId: ctx.runId, requestDigest: ctx.requestDigest,
    planDigest: ctx.planDigest, actor: actor(source.actor, ctx.secretValues), createdAt: instant(source.createdAt),
    status: source.status, approval: null };
  if (source.status === 'approved') {
    const approval = record(source.approval, ['actor', 'approvedAt', 'decisionDigest']);
    const approvedBy = actor(approval.actor, ctx.secretValues);
    if (approvedBy.kind !== 'human' || instant(approval.approvedAt) < result.createdAt) fail();
    if (digest(approval.decisionDigest) !== hash({ ...result, status: 'pending' })) fail('digest-mismatch');
    result.approval = { actor: approvedBy, approvedAt: approval.approvedAt, decisionDigest: approval.decisionDigest };
  } else if (source.approval !== null) fail();
  if (digest(source.digest) !== hash(result)) fail('digest-mismatch');
  return sealed(result);
}

export function approveDecision(value, suppliedContext) {
  const ctx = context(suppliedContext, 'approve');
  if (ctx.humanConfirmed !== true || ctx.actor.kind !== 'human') fail('human-confirmation-required');
  const original = validateDecision(value, ctx);
  if (original.status !== 'pending') fail('approval-conflict');
  if (ctx.now < original.createdAt) fail();
  const { digest: previousDigest, ...fields } = original;
  return sealed({ ...fields, status: 'approved', approval: { actor: ctx.actor, approvedAt: ctx.now, decisionDigest: previousDigest } });
}

function markdown(value) {
  // Encode Markdown punctuation and HTML to prevent links, mentions and injected structure.
  return value.replace(/[&<>"'`*_{}[\]()#+.!|\\@~-]/g, character => `&#${character.codePointAt(0)};`);
}
export function renderDecisions(values, suppliedContext) {
  const ctx = context(suppliedContext);
  const decisions = array(values, 128).map(value => validateDecision(value, ctx));
  if (new Set(decisions.map(item => item.id)).size !== decisions.length) fail();
  const lines = ['## Decisions', '', 'Decision records do not grant execution, file access, merge, deployment, or other permissions.'];
  if (!decisions.length) return `${lines.join('\n')}\n\nNo decisions recorded.\n`;
  for (const decision of decisions) {
    lines.push('', `### ${markdown(decision.title)}`, '', `Tier ${decision.tier} · ${decision.status}`,
      `Decision: ${markdown(decision.id)}`, `Choice: ${markdown(decision.choice)}`, `Rationale: ${markdown(decision.rationale)}`,
      `Recorded by: ${markdown(decision.actor.id)} (${decision.actor.kind}) at ${decision.createdAt}`, '', 'Options:');
    for (const option of decision.options) lines.push(`- ${markdown(option.id)}: ${markdown(option.description)}`);
    if (decision.approvedPlanDecisionId) lines.push('', `Approved plan reference: ${markdown(decision.approvedPlanDecisionId)}`);
    if (decision.approval) lines.push('', `Confirmed by: ${markdown(decision.approval.actor.id)} at ${decision.approval.approvedAt}`);
  }
  return `${lines.join('\n')}\n`;
}
