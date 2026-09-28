import { createHash } from 'node:crypto';
import { createHostExecution } from '../feature/host-execution.js';
import { acquireHostRunLock } from '../feature/host-run-lock.js';
import { resolveExistingFeatureRunPaths } from '../state/paths.js';
import { loadProjectConfig } from '../config/load.js';
import { discoverRepositoryRemotes, selectConfiguredRepositoryRemote } from '../repositories/index.js';
import { immutableJson } from '../clients/contract.js';
import { inspectGovernance } from '../feature/governance.js';
import { renderDecisions } from '../feature/decisions.js';
import { hash } from './contract.js';

export class DeliveryPreparationError extends Error {
  constructor(message = 'Delivery requires a verified run and unchanged integration checkout. Inspect work status and verification results.') {
    super(message);
    this.name = 'DeliveryPreparationError';
    this.code = 'ERR_DELIVERY_PREPARATION';
    this.safeMessage = this.message;
  }
}
function fail() {
  throw new DeliveryPreparationError();
}

// Called only with application-observed governance, never a CLI-supplied summary.
export function deliveryGovernanceEvidence(governance, run, checkout) {
  if (!governance || governance.ready !== true || !Array.isArray(governance.blockers) || governance.blockers.length
    || !Array.isArray(governance.decisions) || governance.decisions.some(value => value.status === 'pending')
    || governance.review?.valid !== true || !Array.isArray(governance.review.reports)
    || governance.review.blockers?.length || (governance.scan !== null && governance.scan?.status !== 'passed')) fail();
  const bindings = { runId: run.runId, requestDigest: run.workRequest.digest, planDigest: run.proposalDigest };
  if (governance.subject?.phase !== 'final' || governance.subject.headSha !== checkout.acceptedCommit
    || governance.subject.baseSha !== run.featurePlan.baselineCommit
    || Object.entries(bindings).some(([key, value]) => governance.subject[key] !== value)) fail();
  const decisionSummary = governance.decisions.length ? renderDecisions(governance.decisions, {
    ...bindings, approvedPlanDecisions: governance.decisions.filter(value => value.status === 'approved').map(({ id, choice }) => ({ id, choice })),
  }) : null;
  if (decisionSummary !== null && Buffer.byteLength(decisionSummary) > 30000) {
    throw new DeliveryPreparationError('Decision evidence exceeds the review body limit. Split the task before preparing delivery; evidence is never truncated.');
  }
  const hasEvidence = governance.decisions.length > 0 || governance.policy?.required === true
    || governance.review.reports.length > 0 || governance.scan !== null;
  if (!hasEvidence) return Object.freeze({});
  const governanceDigest = hash({ subject: governance.subject, policy: governance.policy, decisions: governance.decisions,
    review: governance.review, scan: governance.scan });
  return immutableJson({ governanceDigest, ...(decisionSummary === null ? {} : { decisionSummary, decisionSummaryDigest: hash(decisionSummary) }) });
}

// Only the application reads local verification. CLI inputs never stand in for evidence.
export async function loadDeliveryCandidate({ project, runId, remoteName, gitClient, runner }) {
  const paths = await resolveExistingFeatureRunPaths(project, runId, runner ? { runner } : {});
  if (paths === null) fail();
  const lock = await acquireHostRunLock(paths);
  try {
    const execution = createHostExecution({ gitClient });
    const observed = await execution.status({ project, runId });
    const config = await loadProjectConfig(project);
    const { run, verification, checkout } = observed;
    const governance = observed.governance ?? await inspectGovernance({ project, run, gitClient, config, phase: 'final',
      ...(checkout?.acceptedCommit ? { checkout: { path: checkout.path, commitSha: checkout.acceptedCommit, branch: checkout.branch } } : {}) });
    const governanceEvidence = deliveryGovernanceEvidence(governance, run, checkout ?? {});
    const { decisionSummary, ...governanceProof } = governanceEvidence;
    const source = await gitClient.inspectRepository(project);
    if (
      source.dirty ||
      source.detached ||
      source.headSha !== run.featurePlan.baselineCommit ||
      source.branch !== config.project.repository.defaultBranch
    )
      fail();
    if (
      !observed.deliveryReady ||
      verification.failure !== null ||
      verification.checks.some(
        (check) =>
          check.required &&
          (check.status !== 'passed' || check.exitCode !== 0 || check.executionStatus !== 'success')
      ) ||
      !config.quality.commandGates
        .filter((gate) => gate.required)
        .every((gate) =>
          verification.checks.some(
            (check) => check.id === gate.id && check.required && check.status === 'passed'
          )
        ) ||
      !run.evidenceRefs.includes(`commit:${checkout.acceptedCommit}`)
    )
      fail();
    const remotes = await discoverRepositoryRemotes(project, runner ? { runner } : {});
    let selected;
    try { selected = selectConfiguredRepositoryRemote(remotes, config.project.repository.remote, remoteName); }
    catch { throw new DeliveryPreparationError('Repository remote is missing, ambiguous or changed. Review setup --remote=<name> or select --remote=<name> for this delivery operation.'); }
    const { remoteName: _remote, ...repository } = selected;
    const final = await gitClient.inspectRepository(checkout.path);
    if (final.dirty || final.headSha !== checkout.acceptedCommit || final.branch !== checkout.branch) fail();
    return immutableJson({
      runId,
      repository,
      ...(decisionSummary === undefined ? {} : { decisionSummary }),
      sourceBranch: checkout.branch,
      targetBranch: config.project.repository.defaultBranch,
      localVerification: {
        runId,
        status: 'passed',
        ...governanceProof,
        headSha: checkout.acceptedCommit,
        evidenceDigest: createHash('sha256')
          .update(
            JSON.stringify({
              proposalDigest: run.proposalDigest,
              verification,
              ...(governanceEvidence.governanceDigest ? { governanceDigest: governanceEvidence.governanceDigest } : {}),
            })
          )
          .digest('hex'),
        verifiedAt: verification.checkedAt,
      },
    });
  } catch (error) {
    if (error instanceof DeliveryPreparationError) throw error;
    fail();
  } finally {
    await lock.release();
  }
}
