// Branch selection is data in the approved plan, shared by host and CLI execution.
export const WORK_TYPES = Object.freeze(['feature', 'bugfix', 'hotfix', 'chore', 'docs', 'refactor', 'test', 'ci']);
const PREFIXES = Object.freeze({feature:'feature',bugfix:'fix',hotfix:'hotfix',chore:'chore',docs:'docs',refactor:'refactor',test:'test',ci:'ci'});
const ALIASES = Object.freeze({feature:'feature',feat:'feature',bug:'bugfix',bugfix:'bugfix',fix:'bugfix',hotfix:'hotfix',chore:'chore',docs:'docs',refactor:'refactor',test:'test',ci:'ci'});
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const TICKET = /^[A-Z][A-Z0-9]{0,31}-[1-9][0-9]{0,15}$/;
export class BranchNamingError extends Error {
  constructor() {
    super('Branch naming is invalid or needs a ticket ID. Review repository.branchPattern and branchPatterns before approving the plan.');
    this.code = 'ERR_INVALID_BRANCH_NAMING'; this.safeMessage = this.message;
  }
}
function fail() { throw new BranchNamingError(); }
export function normalizeWorkType(value) {
  if (typeof value !== 'string') return undefined;
  const name = value.trim().toLowerCase();
  return Object.hasOwn(ALIASES,name) ? ALIASES[name] : name === 'story' || name === 'new feature' ? 'feature' : undefined;
}
function safeBranch(value) {
  return typeof value === 'string' && value.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
    && !value.includes('..') && value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'));
}
export function validateBranchPattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length > 200 || pattern.split('{slug}').length !== 2
    || pattern.split('{type}').length > 2 || pattern.split('{ticket}').length > 2
    || !safeBranch(pattern.replace('{slug}','task-run').replace('{type}','feature').replace('{ticket}','APP-1'))) fail();
  return pattern;
}
function ticketId(request) {
  const source = request.source;
  if (['jira','linear'].includes(source?.kind) && TICKET.test(source.ref)) return source.ref;
  if (source?.kind === 'host-observation') {
    const primary = request.context?.sources?.[0];
    if (['jira','linear'].includes(primary?.provider) && TICKET.test(primary.resourceId)) return primary.resourceId;
  }
  return undefined;
}
export function selectBranchNaming(repository, request, proposedType) {
  const explicit = request.workType;
  if (explicit !== undefined && !WORK_TYPES.includes(explicit)) fail();
  if (proposedType !== undefined && !WORK_TYPES.includes(proposedType)) fail();
  const titlePrefix = /^\s*(?:\[[A-Z][A-Z0-9]*-[0-9]+\]\s*)?([a-z]+)(?:\([^\n)]+\))?(?=[:\s-]|$)/i.exec(request.title ?? '')?.[1]?.toLowerCase();
  const titleType = Object.hasOwn(ALIASES,titlePrefix ?? '') ? ALIASES[titlePrefix] : undefined;
  const workType = explicit ?? proposedType ?? titleType ?? 'feature';
  let pattern = repository.branchPatterns?.[workType] ?? repository.branchPattern;
  // The original generated template used feature/{slug} for every task.
  // Keep custom universal patterns; migrate only that exact built-in default.
  if (!Object.hasOwn(repository.branchPatterns ?? {},workType) && pattern === 'feature/{slug}') pattern = `${PREFIXES[workType]}/{slug}`;
  validateBranchPattern(pattern);
  pattern = pattern.replace('{type}',PREFIXES[workType]);
  if (pattern.includes('{ticket}')) {
    const ticket = ticketId(request);
    if (!ticket) fail();
    pattern = pattern.replace('{ticket}',ticket);
  }
  return Object.freeze({workType,pattern});
}
export function renderBranchName(naming, slug, runId) {
  if (!ID.test(slug) || !ID.test(runId)) fail();
  validateBranchPattern(naming.pattern);
  const branch = naming.pattern.replace('{slug}',`${slug}-${runId}`);
  if (!safeBranch(branch)) fail();
  return branch;
}
export function inferBranchPatterns(refs) {
  const candidates = new Map();
  for (const ref of refs) {
    const branch = ref.replace(/^refs\/heads\//,'').replace(/^refs\/remotes\/[^/]+\//,'');
    const prefix = branch.split('/')[0];
    const type = Object.hasOwn(ALIASES,prefix) ? ALIASES[prefix] : undefined;
    if (!type || !branch.includes('/') || !safeBranch(branch)) continue;
    const values = candidates.get(type) ?? new Set(); values.add(prefix); candidates.set(type,values);
  }
  return Object.fromEntries([...candidates].filter(([,values])=>values.size===1).map(([type,values])=>[type,`${[...values][0]}/{slug}`]));
}
