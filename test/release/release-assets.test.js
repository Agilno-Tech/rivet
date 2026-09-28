import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcilePackageAssets, attachReleaseAssets } from '../../scripts/release-assets.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'rivet-release-assets-test-')));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const candidateDirectory = join(temp, 'rivet-candidate'), stagingDirectory = join(temp, 'staging');
  await mkdir(candidateDirectory); await mkdir(stagingDirectory);
  const bytes = Buffer.from('fixed-package-content');
  const artifactSha256 = hash(bytes), sourceSha = 'a'.repeat(40), tag = 'v0.1.0-alpha.1';
  const manifest = {
    schemaVersion: 1, package: { name: '@agilno-tech/rivet', version: '0.1.0-alpha.1', private: false, license: 'Apache-2.0' },
    source: { commit: sourceSha, tag }, artifact: { filename: 'agilno-tech-rivet-0.1.0-alpha.1.tgz', sha256: artifactSha256, bytes: bytes.length },
    packageSha256: 'b'.repeat(64), lockfileSha256: 'c'.repeat(64),
    build: { node: 'v22.22.1', npm: '11.6.0', platform: 'linux', architecture: 'x64' },
    qualification: { candidateChecks: 'external-evidence-required', publishedChannel: 'not-tested', independentPilot: 'not-evaluated' },
  };
  function files(value) {
    const text = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    return { 'release-manifest.json': text, [value.artifact.filename]: bytes,
      SHA256SUMS: Buffer.from(`${artifactSha256}  ${value.artifact.filename}\n${hash(text)}  release-manifest.json\n`) };
  }
  for (const [name, content] of Object.entries(files(manifest))) await writeFile(join(candidateDirectory, name), content);
  const original = structuredClone(manifest);
  original.build = { node: 'v22.21.0', npm: '10.9.0', platform: 'linux', architecture: 'x64' };
  const previous = files(original);
  const assets = Object.keys(previous).map((name, id) => ({ name, id }));
  const options = { candidateDirectory, stagingDirectory, tag, sourceSha, artifactSha256, assets, download: async asset => previous[asset.name] };
  return { temp, options, previous, original, files, manifest };
}

test('rerun with changed Node/npm preserves all original package assets', async t => {
  const { options, previous } = await fixture(t);
  assert.deepEqual(await reconcilePackageAssets(options), []);
  assert.deepEqual(await readFile(join(options.stagingDirectory, 'release-manifest.json')), previous['release-manifest.json']);
  assert.deepEqual(await readFile(join(options.stagingDirectory, 'SHA256SUMS')), previous.SHA256SUMS);
});

test('partial original manifest upload recovers missing tarball and matching checksums', async t => {
  const { options, previous } = await fixture(t);
  options.assets = options.assets.filter(asset => asset.name === 'release-manifest.json');
  const missing = await reconcilePackageAssets(options);
  assert.deepEqual(missing.map(file => file.name), ['agilno-tech-rivet-0.1.0-alpha.1.tgz', 'SHA256SUMS']);
  assert.deepEqual(await readFile(join(options.stagingDirectory, 'SHA256SUMS')), previous.SHA256SUMS);
});

test('new release uploads manifest first so interrupted publication is recoverable', async t => {
  const { options } = await fixture(t);
  options.assets = [];
  assert.deepEqual((await reconcilePackageAssets(options)).map(file => file.name), ['release-manifest.json', 'agilno-tech-rivet-0.1.0-alpha.1.tgz', 'SHA256SUMS']);
});

test('existing changed package bytes cannot be preserved', async t => {
  const { options, previous } = await fixture(t);
  previous['agilno-tech-rivet-0.1.0-alpha.1.tgz'] = Buffer.from('tampered');
  await assert.rejects(reconcilePackageAssets(options), /artifact-checksum-mismatch/);
});

test('non-builder metadata differences fail even when package bytes match', async t => {
  const { options, original, files } = await fixture(t);
  original.lockfileSha256 = 'd'.repeat(64);
  const previous = files(original);
  options.download = async asset => previous[asset.name];
  await assert.rejects(reconcilePackageAssets(options), /metadata does not match/);
});

test('unrecoverable orphaned checksums fail without replacing original evidence', async t => {
  const { options } = await fixture(t);
  options.assets = options.assets.filter(asset => asset.name === 'SHA256SUMS');
  await assert.rejects(reconcilePackageAssets(options), /checksum-manifest-mismatch/);
});

test('completed package assets do not block new evidence or finalization on retry', async t => {
  const { options, previous, temp } = await fixture(t);
  const evidenceDirectory = join(temp, 'rivet-install-evidence', 'install-evidence-ubuntu-latest-node22');
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(join(evidenceDirectory, 'install-evidence.json'), '{}');
  await writeFile(join(temp, 'registry-install-evidence.json'), '{}');
  const calls = [];
  const release = { tag_name: options.tag, draft: true, assets: options.assets };
  const gh = args => {
    calls.push(args);
    if (args.includes('--slurp')) return Buffer.from(JSON.stringify([[release]]));
    if (args.includes('Accept: application/octet-stream')) {
      const id = Number(args.at(-1).split('/').at(-1));
      return previous[release.assets.find(asset => asset.id === id).name];
    }
    return Buffer.alloc(0);
  };
  await attachReleaseAssets({ gh, env: {
    GITHUB_REPOSITORY: 'Agilno-Tech/rivet', CANDIDATE_TAG: options.tag, CANDIDATE_SHA: options.sourceSha,
    CANDIDATE_CHECKSUM: options.artifactSha256, RUNNER_TEMP: temp, RELEASE_MODE: 'publish',
    GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2',
  } });
  const uploads = calls.filter(args => args[0] === 'release' && args[1] === 'upload');
  assert.equal(uploads.length, 2);
  assert.ok(uploads.every(args => args[3].endsWith('-123-2.json')));
  assert.ok(calls.some(args => args.includes('--draft=false')));
});
