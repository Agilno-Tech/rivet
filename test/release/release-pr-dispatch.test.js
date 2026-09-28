import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dispatchReleaseWorkflows } from '../../scripts/release-pr-dispatch.mjs';

const env = { GITHUB_REPOSITORY: 'Agilno-Tech/rivet', GITHUB_REF: 'refs/heads/main', RELEASE_PR: '{"number":12}' };
const pr = {
  number: 12, state: 'open', user: { login: 'github-actions[bot]' },
  base: { ref: 'main', repo: { full_name: 'Agilno-Tech/rivet' } },
  head: { ref: 'release-please--branches--main', sha: 'a'.repeat(40), repo: { full_name: 'Agilno-Tech/rivet' } },
  labels: [{ name: 'autorelease: pending' }],
};
function mock({ pullRequest = pr, runs = [], beforeDispatch = pullRequest } = {}) {
  const calls = [];
  let reads = 0;
  return {
    calls,
    request: async (method, resource, body) => {
      calls.push({ method, resource, body });
      if (resource === 'pulls/12') return ++reads === 1 ? pullRequest : beforeDispatch;
      if (resource.startsWith('pulls?')) return [pullRequest];
      if (resource.includes('/runs?')) return { workflow_runs: runs };
      if (method === 'POST' && resource.endsWith('/dispatches')) return null;
      throw new Error(`Unexpected ${method} ${resource}`);
    },
  };
}

test('bot release PR explicitly starts CI and docs without publishing docs', async () => {
  const api = mock();
  assert.deepEqual(await dispatchReleaseWorkflows({ env, request: api.request }), ['ci.yml', 'docs.yml']);
  assert.deepEqual(api.calls.filter(call => call.method === 'POST'), [
    { method: 'POST', resource: 'actions/workflows/ci.yml/dispatches', body: { ref: pr.head.ref } },
    { method: 'POST', resource: 'actions/workflows/docs.yml/dispatches', body: { ref: pr.head.ref, inputs: { publish: 'false' } } },
  ]);
});

test('existing successful or active checks prevent duplicate dispatch', async () => {
  for (const run of [{ status: 'completed', conclusion: 'success' }, { status: 'in_progress' }, { status: 'queued' }]) {
    const api = mock({ runs: [{ ...run, head_sha: pr.head.sha, head_branch: pr.head.ref }] });
    assert.deepEqual(await dispatchReleaseWorkflows({ env, request: api.request }), []);
    assert.equal(api.calls.some(call => call.method === 'POST'), false);
  }
});

test('failed checks or checks against an old SHA do not suppress verification', async () => {
  for (const run of [
    { head_sha: pr.head.sha, head_branch: pr.head.ref, status: 'completed', conclusion: 'failure' },
    { head_sha: 'b'.repeat(40), head_branch: pr.head.ref, status: 'completed', conclusion: 'success' },
  ]) {
    const api = mock({ runs: [run] });
    assert.equal((await dispatchReleaseWorkflows({ env, request: api.request })).length, 2);
  }
});

test('rerunning preparation discovers an existing release PR when action has no new output', async () => {
  const api = mock();
  assert.equal((await dispatchReleaseWorkflows({ env: { ...env, RELEASE_PR: '' }, request: api.request })).length, 2);
  assert.match(api.calls[0].resource, /^pulls\?state=open&base=main&head=Agilno-Tech:/);
});

test('forks, arbitrary branches, wrong author and unlabelled PRs cannot dispatch', async () => {
  const candidates = [
    { ...pr, head: { ...pr.head, repo: { full_name: 'untrusted/rivet' } } },
    { ...pr, head: { ...pr.head, ref: 'feature/foo' } },
    { ...pr, user: { login: 'someone' } },
    { ...pr, labels: [] },
    { ...pr, state: 'closed' },
    { ...pr, base: { ...pr.base, ref: 'other' } },
  ];
  for (const pullRequest of candidates) {
    const api = mock({ pullRequest });
    await assert.rejects(dispatchReleaseWorkflows({ env, request: api.request }), /trusted bot branch/);
    assert.equal(api.calls.some(call => call.method === 'POST'), false);
  }
});

test('head changes during inspection stop dispatch', async () => {
  const api = mock({ beforeDispatch: { ...pr, head: { ...pr.head, sha: 'b'.repeat(40) } } });
  await assert.rejects(dispatchReleaseWorkflows({ env, request: api.request }), /changed before/);
  assert.equal(api.calls.some(call => call.method === 'POST'), false);
});

test('dispatch is restricted to main in the canonical repository', async () => {
  for (const overrides of [{ GITHUB_REPOSITORY: 'fork/rivet' }, { GITHUB_REF: 'refs/heads/topic' }]) {
    const api = mock();
    await assert.rejects(dispatchReleaseWorkflows({ env: { ...env, ...overrides }, request: api.request }), /only runs/);
    assert.equal(api.calls.length, 0);
  }
});

test('release manifest starts from published alpha and uses Node prerelease updates', async () => {
  const config = JSON.parse(await readFile(new URL('../../release-please-config.json', import.meta.url)));
  const manifest = JSON.parse(await readFile(new URL('../../.release-please-manifest.json', import.meta.url)));
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url)));
  const release = config.packages['.'];
  assert.equal(release['package-name'], pkg.name);
  assert.equal(manifest['.'], pkg.version);
  assert.equal(config['bootstrap-sha'], '13f109e9d99e0591a7e0c255df50fd9ba1670cea');
  assert.equal(release['release-type'], 'node');
  assert.equal(release.versioning, 'prerelease');
  assert.equal(release.prerelease, true);
  assert.equal(release['prerelease-type'], 'alpha');
  assert.equal(release['bump-minor-pre-major'], true);
  assert.equal(release['bump-patch-for-minor-pre-major'], true);
  assert.equal(release['include-component-in-tag'], false);
  assert.equal(release['changelog-path'], 'CHANGELOG.md');
});
