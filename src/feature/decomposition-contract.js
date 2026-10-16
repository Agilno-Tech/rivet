import { readFileSync } from 'node:fs';

import Ajv from 'ajv';

import { immutableJson } from '../clients/contract.js';

export const FEATURE_DECOMPOSITION_KIND = 'agilno.feature-decomposition';

const schema = JSON.parse(readFileSync(
  new URL('../../schemas/feature-decomposition.schema.json', import.meta.url),
  'utf8',
));
const validateSchema = new Ajv({ allErrors: true, strict: true }).compile(schema);

export class FeatureDecompositionError extends Error {
  constructor() {
    super('Feature decomposition is invalid.');
    this.name = 'FeatureDecompositionError';
    this.code = 'ERR_INVALID_FEATURE_DECOMPOSITION';
    this.safeMessage = this.message;
  }
}

function fail() { throw new FeatureDecompositionError(); }

export function featureDecompositionResultContract() {
  return immutableJson({
    version: 1,
    kind: FEATURE_DECOMPOSITION_KIND,
    framing: 'Emit exactly one JSON object matching this result schema on stdout. Emit no Markdown or commentary.',
    instructions: [
      'Classify the request with workType (feature, bugfix, hotfix, chore, docs, refactor, test or ci) before branch creation. Preserve explicit tracker/request workType. Read repository contribution instructions and configured branch patterns; do not create a feature branch for a bugfix or plan to rename it later. If configured naming conflicts with repository instructions, ask for the configuration to be corrected before activation.',
      'When executionPolicy is supplied, optionally classify each work item with executionClass bounded-fix or implementation. Omitted classification means implementation. Classification and selected profile are reviewed in the compiled plan; do not infer a model from task text.',
      'Inspect the repository read-only and propose between one and sixteen implementation work items.',
      'Use only normalized repository-relative owned paths; never use .git, .rivet, or configured sensitive paths.',
      'Owned path components must not end in a dot or space or use Windows reserved names. Paths within each work item must be unique ignoring case.',
      'If contract.repair is present, a prior proposal was rejected for its reason code. Reinspect the repository and return a complete corrected decomposition under the same policy; do not omit required implementation work to avoid validation.',
      'List only files the work item is expected to change, including adjacent style modules, configuration, fixtures, and tests when they will be modified; do not include files that are merely read or reused, and never rely on an unlisted support file.',
      'Allocate every request acceptance criterion at least once using one-based acceptance-criterion indexes; criteria may support multiple work items.',
      'For a dependency graph, give every work item a stable lowercase id and an explicit dependencies array of work-item IDs (empty for independent items). Never mix graph items with legacy items. Dependencies must be acyclic. Omit both fields on every item to preserve sequential execution.',
      'List sharedResources as stable lowercase identifiers when work items contend for a shared resource; this requires graph IDs and dependencies. Rivet serializes shared resources and overlapping owned paths conservatively.',
      'Do not emit roles, providers, authority, budgets, commands, evidence, approval gates, or other policy fields.',
    ],
    schema,
  });
}

export function createFeatureDecomposition(value, acceptanceCriterionCount) {
  let result;
  try { result = immutableJson(value); } catch { fail(); }
  if (!Number.isSafeInteger(acceptanceCriterionCount) || acceptanceCriterionCount < 1 || acceptanceCriterionCount > 256
    || !validateSchema(result)) fail();
  const explicit = result.workItems.some(item => item.id !== undefined || item.dependencies !== undefined || item.sharedResources !== undefined);
  if (explicit) {
    const items = new Map();
    for (const item of result.workItems) {
      if (item.id === undefined || item.dependencies === undefined || items.has(item.id)
        || ['activation', 'management', 'final-delivery'].includes(item.id)) fail();
      items.set(item.id, item);
    }
    const visited = new Set();
    const visiting = new Set();
    function visit(id) {
      if (visited.has(id)) return;
      if (visiting.has(id) || !items.has(id)) fail();
      visiting.add(id);
      for (const dependency of items.get(id).dependencies) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    }
    for (const id of items.keys()) visit(id);
  }
  const allocated = new Set();
  for (const item of result.workItems) {
    for (const index of item.acceptanceCriterionIndexes) {
      if (index > acceptanceCriterionCount) fail();
      allocated.add(index);
    }
  }
  if (allocated.size !== acceptanceCriterionCount) fail();
  return result;
}
