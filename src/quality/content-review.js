const IDENTITY = ['phase', 'runId', 'requestDigest', 'planDigest', 'baseSha', 'headSha', 'diffDigest'];
const DIGEST = /^(?:sha256:)?[a-f0-9]{64}$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export class ContentReviewError extends Error {
  constructor(reason) {
    super(`Content review is invalid: ${reason}.`);
    this.name = 'ContentReviewError';
    this.code = 'ERR_CONTENT_REVIEW';
    this.safeMessage = this.message;
    this.details = Object.freeze({ reason });
  }
}
const fail = reason => { throw new ContentReviewError(reason); };
function object(value, keys, required = keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-object');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !keys.includes(key)
      || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))
      || required.some(key => !Object.hasOwn(descriptors, key))) fail('invalid-fields');
  return Object.fromEntries(Object.entries(descriptors).map(([key, d]) => [key, d.value]));
}
function text(value, maximum = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail('invalid-text');
  return value;
}
function id(value) { if (typeof value !== 'string' || !ID.test(value)) fail('invalid-id'); return value; }
function boolean(value) { if (typeof value !== 'boolean') fail('invalid-boolean'); return value; }
function integer(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail('invalid-integer');
  return value;
}
function array(value, limit, convert) {
  if (!Array.isArray(value) || value.length > limit || Reflect.ownKeys(value).length !== value.length + 1) fail('invalid-array');
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('invalid-array');
    return convert(descriptor.value);
  });
}
function unique(values) { if (new Set(values).size !== values.length) fail('duplicate-values'); return values; }
function path(value, glob = false) {
  text(value, 512);
  if (/[\\:\x00-\x1f\x7f]/.test(value) || value.startsWith('/') || value.endsWith('/')
      || value.split('/').some(part => !part || part === '.' || part === '..')
      || (glob && value.split('/').some(part => part.includes('**') && part !== '**'))) fail('invalid-path');
  return value;
}
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function identity(value) {
  const result = {};
  if (!['plan', 'final'].includes(value.phase)) fail('invalid-phase');
  result.phase = value.phase; result.runId = id(value.runId);
  for (const key of ['requestDigest', 'planDigest', 'diffDigest']) {
    if (typeof value[key] !== 'string' || !DIGEST.test(value[key])) fail('invalid-digest'); result[key] = value[key];
  }
  for (const key of ['baseSha', 'headSha']) {
    if (typeof value[key] !== 'string' || !SHA.test(value[key])) fail('invalid-sha'); result[key] = value[key];
  }
  return result;
}
function captureSubject(input) {
  const required = [...IDENTITY, 'acceptanceCriteria', 'planNodeIds', 'changedPaths', 'workerActorIds'];
  const value = object(input, [...required, 'criterionPlanNodeIds'], required);
  const criteria = array(value.acceptanceCriteria, 256, value => text(value));
  if (!criteria.length) fail('missing-criteria');
  const planNodeIds = unique(array(value.planNodeIds, 512, id));
  let criterionPlanNodeIds;
  if (value.criterionPlanNodeIds !== undefined) {
    criterionPlanNodeIds = array(value.criterionPlanNodeIds, 256, entries => {
      const nodes = unique(array(entries, 512, id));
      if (!nodes.length || nodes.some(node => !planNodeIds.includes(node))) fail('invalid-criterion-plan-map');
      return nodes;
    });
    if (criterionPlanNodeIds.length !== criteria.length) fail('invalid-criterion-plan-map');
  }
  return { ...identity(value), acceptanceCriteria: criteria, planNodeIds,
    ...(criterionPlanNodeIds === undefined ? {} : { criterionPlanNodeIds }),
    changedPaths: unique(array(value.changedPaths, 2048, value => path(value))),
    workerActorIds: unique(array(value.workerActorIds, 512, id)) };
}
export function normalizeReviewPolicy(input) {
  const value = input === undefined ? {} : object(input, ['required', 'maxRounds', 'reviewers', 'strictCoverage'], []);
  const reviewers = array(value.reviewers ?? [], 64, item => {
    const reviewer = object(item, ['id', 'paths', 'required']);
    const paths = unique(array(reviewer.paths, 128, value => path(value, true)));
    if (!paths.length) fail('empty-reviewer-paths');
    return { id: id(reviewer.id), paths, required: boolean(reviewer.required) };
  });
  unique(reviewers.map(reviewer => reviewer.id));
  return freeze({ required: boolean(value.required ?? false), maxRounds: integer(value.maxRounds ?? 3, 1, 10),
    reviewers, strictCoverage: boolean(value.strictCoverage ?? false) });
}
// Segment matching avoids compiling project-controlled globs into backtracking regular expressions.
function matchSegment(pattern, value) {
  let previous = new Array(value.length + 1).fill(false); previous[0] = true;
  for (const token of pattern) {
    const next = new Array(value.length + 1).fill(false);
    if (token === '*') next[0] = previous[0];
    for (let index = 1; index <= value.length; index += 1) {
      next[index] = token === '*' ? previous[index] || next[index - 1]
        : previous[index - 1] && (token === '?' || token === value[index - 1]);
    }
    previous = next;
  }
  return previous[value.length];
}
function matches(pattern, value) {
  const segments = value.split('/');
  let previous = new Array(segments.length + 1).fill(false); previous[0] = true;
  for (const token of pattern.split('/')) {
    const next = new Array(segments.length + 1).fill(false);
    if (token === '**') next[0] = previous[0];
    for (let index = 1; index <= segments.length; index += 1) {
      next[index] = token === '**' ? previous[index] || next[index - 1]
        : previous[index - 1] && matchSegment(token, segments[index - 1]);
    }
    previous = next;
  }
  return previous[segments.length];
}
function captureReport(subject, input, nowMs, requiredPaths) {
  const value = object(input, [...IDENTITY, 'reviewerId', 'actorId', 'round', 'status', 'blocking', 'coverage',
    'findings', 'filesReviewed', 'commandsExecuted', 'checkedAt']);
  const boundIdentity = identity(value);
  if (IDENTITY.some(key => boundIdentity[key] !== subject[key])) fail('stale-review');
  const actorId = id(value.actorId);
  if (subject.workerActorIds.includes(actorId)) fail('self-review');
  if (!['PASS', 'FAIL'].includes(value.status) || boolean(value.blocking) !== (value.status === 'FAIL')) fail('inconsistent-verdict');
  const paths = entries => unique(array(entries, 2048, value => {
    const result = path(value); if (!subject.changedPaths.includes(result)) fail('unknown-reviewed-path'); return result;
  }));
  const criterionIndex = index => integer(index, 1, subject.acceptanceCriteria.length);
  const coverage = array(value.coverage, 256, entry => {
    const item = object(entry, ['criterionIndex', 'planNodeIds', 'paths', 'evidence']);
    const nodes = unique(array(item.planNodeIds, 512, value => {
      const node = id(value); if (!subject.planNodeIds.includes(node)) fail('unknown-plan-node'); return node;
    }));
    const evidence = array(item.evidence, 64, entry => {
      const item = object(entry, ['kind', 'reference', 'summary']);
      if (!['test', 'manual'].includes(item.kind)) fail('invalid-evidence-kind');
      return { kind: item.kind, reference: text(item.reference, 1024), summary: text(item.summary) };
    });
    if (!nodes.length || !evidence.length) fail('missing-coverage-evidence');
    const mappedNodes = subject.criterionPlanNodeIds?.[criterionIndex(item.criterionIndex) - 1];
    if (mappedNodes && nodes.some(node => !mappedNodes.includes(node))) fail('criterion-plan-node-mismatch');
    return { criterionIndex: criterionIndex(item.criterionIndex), planNodeIds: nodes, paths: paths(item.paths), evidence };
  });
  unique(coverage.map(item => item.criterionIndex));
  const findings = array(value.findings, 256, entry => {
    const item = object(entry, ['kind', 'summary', 'blocking', 'criterionIndexes', 'paths'], ['kind', 'summary', 'blocking']);
    if (!['missing', 'unrequested', 'general'].includes(item.kind)) fail('invalid-finding-kind');
    return { kind: item.kind, summary: text(item.summary), blocking: boolean(item.blocking),
      ...(item.criterionIndexes === undefined ? {} : { criterionIndexes: unique(array(item.criterionIndexes, 256, criterionIndex)) }),
      ...(item.paths === undefined ? {} : { paths: paths(item.paths) }) };
  });
  const filesReviewed = paths(value.filesReviewed);
  if (coverage.some(item => item.paths.some(path => !filesReviewed.includes(path)))) fail('coverage-file-not-reviewed');
  if (value.status === 'PASS' && (coverage.length !== subject.acceptanceCriteria.length
      || requiredPaths.some(path => !filesReviewed.includes(path)) || findings.some(item => item.blocking))) fail('incomplete-pass');
  const checkedAt = text(value.checkedAt, 32), checkedTime = Date.parse(checkedAt);
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isFinite(checkedTime)
      || new Date(checkedTime).toISOString() !== checkedAt || checkedTime > nowMs) fail('invalid-review-time');
  const result = { ...boundIdentity, reviewerId: id(value.reviewerId), actorId, round: integer(value.round, 1, 10),
    status: value.status, blocking: value.blocking, coverage, findings, filesReviewed,
    commandsExecuted: array(value.commandsExecuted, 128, value => text(value)), checkedAt };
  if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) fail('review-too-large');
  return result;
}
// These contracts authenticate supplied identity and structure, not semantic truth or command execution.
export function validateReviewReport(subjectInput, report, { nowMs = Date.now() } = {}) {
  const subject = captureSubject(subjectInput);
  return freeze(captureReport(subject, report, nowMs, subject.changedPaths));
}
export function evaluateReviewReports(policyInput, subjectInput, reportInputs, { nowMs = Date.now() } = {}) {
  const policy = normalizeReviewPolicy(policyInput), subject = captureSubject(subjectInput);
  const selected = new Map(), uncovered = [];
  for (const changedPath of subject.changedPaths) {
    const matchesPath = policy.reviewers.filter(reviewer => reviewer.paths.some(pattern => matches(pattern, changedPath)));
    if (!matchesPath.length) {
      if (policy.strictCoverage) uncovered.push(changedPath);
      else {
        if (!selected.has('general')) selected.set('general', { required: true, paths: [] });
        selected.get('general').required = true;
        selected.get('general').paths.push(changedPath);
      }
    }
    for (const reviewer of matchesPath) {
      if (!selected.has(reviewer.id)) selected.set(reviewer.id, { required: reviewer.required, paths: [] });
      selected.get(reviewer.id).paths.push(changedPath);
    }
  }
  if (!subject.changedPaths.length) selected.set('general', { required: true, paths: [] });
  const requiredReviewerIds = policy.required ? [...selected].filter(([, value]) => value.required).map(([key]) => key).sort() : [];
  const reports = array(reportInputs, 650, value => {
    const reviewerId = Object.getOwnPropertyDescriptor(value ?? {}, 'reviewerId')?.value;
    if (!selected.has(reviewerId)) fail('unknown-reviewer');
    const report = captureReport(subject, value, nowMs, selected.get(reviewerId).paths);
    if (report.round > policy.maxRounds) fail('round-limit');
    return report;
  });
  unique(reports.map(report => `${report.reviewerId}:${report.round}`));
  const rounds = Math.max(0, ...reports.map(report => report.round));
  const latest = new Map();
  for (const report of reports) if (!latest.has(report.reviewerId) || latest.get(report.reviewerId).round < report.round) latest.set(report.reviewerId, report);
  const blockers = policy.required ? uncovered.map(path => ({ code: 'uncovered-path', path })) : [];
  for (const reviewerId of requiredReviewerIds) {
    const report = latest.get(reviewerId);
    if (!report) blockers.push({ code: 'missing-review', reviewerId });
    else if (report.blocking) blockers.push({ code: 'blocking-review', reviewerId, round: report.round });
  }
  if (policy.required) {
    const reviewed = new Set([...latest.values()].filter(report => report.status === 'PASS').flatMap(report => report.filesReviewed));
    for (const path of subject.changedPaths) if (!reviewed.has(path)) blockers.push({ code: 'unreviewed-path', path });
  }
  // An explicitly submitted blocking finding is never erased by marking its reviewer optional.
  for (const [reviewerId, report] of latest) if (report.blocking && !requiredReviewerIds.includes(reviewerId)) blockers.push({ code: 'blocking-review', reviewerId, round: report.round });
  return freeze({ valid: blockers.length === 0, requiredReviewerIds,
    reviewerPaths: Object.fromEntries([...selected].map(([key, value]) => [key, unique(value.paths).sort()])), rounds,
    humanEscalation: blockers.length > 0 && rounds >= policy.maxRounds, blockers, reports });
}
