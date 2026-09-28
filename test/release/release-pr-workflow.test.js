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

test('privileged publishing never restores package-manager caches', () => {
  const setup = jobs.publish.steps.find(step => step.uses?.startsWith('actions/setup-node@'));
  assert.equal(setup.with['package-manager-cache'], false);
  assert.equal(setup.with.cache, undefined);
  assert.equal(jobs.publish.permissions['id-token'], 'write');
  assert.equal(jobs.publish.environment, 'npm');
});

test('release artifacts retain archived layout and fail on transport digest mismatches', () => {
  for (const job of Object.values(jobs)) for (const step of job.steps ?? []) {
    if (step.uses?.startsWith('actions/upload-artifact@')) assert.equal(step.with.archive, true);
    if (step.uses?.startsWith('actions/download-artifact@')) {
      assert.equal(step.with['skip-decompress'], false);
      assert.equal(step.with['digest-mismatch'], 'error');
      assert.equal(step.with['merge-multiple'], false);
    }
  }
  assert.deepEqual(jobs['installed-artifact'].strategy.matrix, { os: ['ubuntu-latest', 'macos-latest'], node: [22, 24] });
});

test('repository workflows and deployment template pin verified Node 24 action releases', async () => {
  const supported = new Map([
    ['actions/checkout', '3d3c42e5aac5ba805825da76410c181273ba90b1'],
    ['actions/setup-node', '820762786026740c76f36085b0efc47a31fe5020'],
    ['actions/upload-artifact', '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a'],
    ['actions/download-artifact', '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c'],
    ['actions/upload-pages-artifact', 'fc324d3547104276b827a68afc52ff2a11cc49c9'],
    ['actions/deploy-pages', '368f82528645a54fb793d4d04e342629a3f51346'],
    ['actions/github-script', '3a2844b7e9c422d3c10d287c895573f7108da1b3'],
    ['googleapis/release-please-action', '45996ed1f6d02564a971a2fa1b5860e934307cf7'],
  ]);
  for (const path of ['.github/workflows/ci.yml', '.github/workflows/docs.yml', '.github/workflows/publish.yml', 'templates/github-actions/rivet-deploy.yml']) {
    const content = await readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
    const parsed = parse(content);
    for (const job of Object.values(parsed.jobs)) for (const step of job.steps ?? []) if (step.uses) {
      const [action, revision] = step.uses.split('@');
      assert.equal(revision, supported.get(action), `${path}: ${action}`);
      assert.match(content, new RegExp(`${revision} # v\\d+\\.\\d+\\.\\d+`));
      if (action === 'actions/github-script') {
        assert.doesNotMatch(step.with.script, /require\(['"]@actions\/github['"]\)|(?:const|let) getOctokit\b/);
      }
    }
  }
});
