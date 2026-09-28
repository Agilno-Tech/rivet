import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

const source = await readFile(new URL('../../.github/workflows/publish.yml', import.meta.url), 'utf8');
const workflow = parse(source);
const { jobs } = workflow;
const scripts = job => job.steps.map(step => step.run ?? '').join('\n');

test('one main-only workflow prepares release PRs and defaults manual runs to no publishing', () => {
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.equal(workflow.on.workflow_dispatch.inputs.publish.default, false);
  assert.equal(workflow.on.workflow_dispatch.inputs.tag.required, false);
  assert.match(jobs['release-please'].if, /github\.ref == 'refs\/heads\/main'/);
  assert.match(jobs['release-please'].if, /!inputs.tag/);
  assert.match(jobs.candidate.if, /needs.release-please.result == 'skipped'/);
  assert.match(jobs.candidate.if, /release_created == 'true'/);
  assert.match(jobs.draft.if, /inputs.tag != '' && !inputs.publish/);
  assert.match(jobs['release-please'].steps.find(step => step.id === 'release').uses, /@[a-f0-9]{40}$/);
});

test('candidate validates tag ancestry and builds once before four platform installations', () => {
  assert.match(scripts(jobs.candidate), /git merge-base --is-ancestor "\$candidate_sha" "\$GITHUB_SHA"/);
  assert.match(scripts(jobs.candidate), /test "\$candidate_sha" = "\$RELEASE_SHA"/);
  assert.match(scripts(jobs.candidate), /npm run check/);
  assert.match(scripts(jobs.candidate), /npm run evals -- --mode=fixture/);
  assert.equal(source.match(/release-artifact\.mjs build /g).length, 1);
  assert.deepEqual(jobs['installed-artifact'].strategy.matrix, { os: ['ubuntu-latest', 'macos-latest'], node: [22, 24] });
  assert.match(scripts(jobs['installed-artifact']), /--artifact-sha256="\$CANDIDATE_CHECKSUM"/);
});

test('publishing requires verified candidate, complete installation matrix and npm environment OIDC', () => {
  assert.deepEqual(jobs.publish.needs, ['release-please', 'candidate', 'installed-artifact']);
  assert.match(jobs.publish.if, /needs.candidate.result == 'success'/);
  assert.match(jobs.publish.if, /needs.installed-artifact.result == 'success'/);
  assert.match(jobs.publish.if, /inputs.publish/);
  assert.equal(jobs.publish.environment, 'npm');
  assert.equal(jobs.publish['timeout-minutes'], 25);
  assert.equal(jobs.publish.permissions['id-token'], 'write');
  assert.equal(jobs.publish.steps.find(step => step.uses?.startsWith('actions/setup-node@')).with['node-version'], 24);
  assert.doesNotMatch(source, /secrets\.(NPM_TOKEN|NODE_AUTH_TOKEN|PAT)/);
  const script = scripts(jobs.publish);
  assert.match(script, /npm 11\.5\.1 or newer/);
  assert.match(script, /publish-release\.mjs.*--download-directory="\$RUNNER_TEMP\/rivet-registry"/);
  assert.match(script, /package-smoke\.mjs --artifact-dir="\$RUNNER_TEMP\/rivet-registry"/);
  assert.match(script, /gh workflow run docs.yml.*--ref main -f publish=true/);
});

test('both delivery paths use the shared immutable asset reconciler', () => {
  for (const job of [jobs.publish, jobs.draft]) {
    assert.match(scripts(job), /node scripts\/release-assets\.mjs/);
    assert.doesNotMatch(scripts(job), /--clobber/);
  }
  assert.doesNotMatch(scripts(jobs.draft), /publish-release\.mjs|gh workflow run docs/);
});
