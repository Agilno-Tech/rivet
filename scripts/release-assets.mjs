import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { deepStrictEqual } from 'node:assert';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyReleaseArtifact } from './release-artifact.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// A rerun can use a newer Node/npm builder while producing identical package bytes.
// Keep the original manifest and its matching checksums instead of rewriting evidence.
export async function reconcilePackageAssets({ candidateDirectory, stagingDirectory, tag,
  sourceSha, artifactSha256, assets, download }) {
  const identity = { tag, expectedSourceSha: sourceSha, expectedArtifactSha256: artifactSha256 };
  const candidate = await verifyReleaseArtifact({ directory: candidateDirectory, ...identity });
  const names = ['release-manifest.json', candidate.artifact.filename, 'SHA256SUMS'];
  const selected = new Map();
  for (const name of names.slice(0, 2)) {
    const existing = assets.find(asset => asset.name === name);
    selected.set(name, existing ? await download(existing) : await readFile(join(candidateDirectory, name)));
  }
  const existingSums = assets.find(asset => asset.name === 'SHA256SUMS');
  selected.set('SHA256SUMS', existingSums ? await download(existingSums) : Buffer.from(
    `${artifactSha256}  ${candidate.artifact.filename}\n${hash(selected.get('release-manifest.json'))}  release-manifest.json\n`));
  for (const [name, bytes] of selected) await writeFile(join(stagingDirectory, name), bytes, { flag: 'wx', mode: 0o600 });
  const original = await verifyReleaseArtifact({ directory: stagingDirectory, ...identity });
  // Only build-tool observations may differ. Source and package metadata must agree.
  const { build: originalBuild, ...originalIdentity } = original;
  const { build: candidateBuild, ...candidateIdentity } = candidate;
  deepStrictEqual(originalIdentity, candidateIdentity, 'Existing release metadata does not match this candidate.');
  return names.filter(name => !assets.some(asset => asset.name === name))
    .map(name => ({ name, path: join(stagingDirectory, name) }));
}

export async function attachReleaseAssets({ env = process.env, gh = args => execFileSync('gh', args, { maxBuffer: 80 * 1024 * 1024 }) } = {}) {
  const { GITHUB_REPOSITORY: repo, CANDIDATE_TAG: tag, CANDIDATE_SHA: sourceSha,
    CANDIDATE_CHECKSUM: artifactSha256, RUNNER_TEMP: temp, RELEASE_MODE: mode } = env;
  if (repo !== 'Agilno-Tech/rivet' || !['draft', 'publish'].includes(mode)
    || !/^\d+$/.test(env.GITHUB_RUN_ID ?? '') || !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? '')) throw new Error('Invalid release attachment context.');
  const candidateDirectory = join(temp, 'rivet-candidate');
  await verifyReleaseArtifact({ directory: candidateDirectory, tag, expectedSourceSha: sourceSha, expectedArtifactSha256: artifactSha256 });
  const releases = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`])).flat();
  let release = releases.find(item => item.tag_name === tag);
  if (mode === 'draft' && release && !release.draft) throw new Error('Refusing to modify a published release from draft mode.');
  if (!release) {
    gh(['release', 'create', tag, '--repo', repo, '--verify-tag', '--draft', '--prerelease', '--title', `Rivet ${tag}`, '--notes', `Verified Rivet alpha candidate. Workflow: ${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`]);
    release = JSON.parse(gh(['api', `repos/${repo}/releases/tags/${tag}`]));
  }
  const download = asset => gh(['api', '-H', 'Accept: application/octet-stream', `repos/${repo}/releases/assets/${asset.id}`]);
  const stagingDirectory = await mkdtemp(join(temp, 'rivet-release-assets-'));
  try {
    const files = await reconcilePackageAssets({ candidateDirectory, stagingDirectory, tag, sourceSha, artifactSha256, assets: release.assets, download });
    // Manifest goes first: interrupted uploads retain original builder evidence for retries.
    for (const file of files) gh(['release', 'upload', tag, file.path, '--repo', repo]);
    const evidence = [];
    for (const name of await readdir(join(temp, 'rivet-install-evidence'))) {
      if (!/^install-evidence-(ubuntu|macos)-latest-node(22|24)$/.test(name)) throw new Error('Unexpected installation evidence directory.');
      const filename = `${name}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}.json`;
      const path = join(temp, filename);
      await copyFile(join(temp, 'rivet-install-evidence', name, 'install-evidence.json'), path);
      evidence.push({ name: filename, path });
    }
    if (mode === 'publish') {
      const name = `registry-install-evidence-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}.json`;
      const path = join(temp, name);
      await copyFile(join(temp, 'registry-install-evidence.json'), path);
      evidence.push({ name, path });
    }
    for (const file of evidence) {
      const existing = release.assets.find(asset => asset.name === file.name);
      if (existing) {
        if (hash(await download(existing)) !== hash(await readFile(file.path))) throw new Error(`Release evidence differs: ${file.name}; refusing to replace it.`);
      } else gh(['release', 'upload', tag, file.path, '--repo', repo]);
    }
    if (mode === 'publish' && release.draft) gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--prerelease']);
  } finally { await rm(stagingDirectory, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  attachReleaseAssets().catch(error => { console.error(error.message); process.exitCode = 1; });
}
