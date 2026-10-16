import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveLegacyDependencyPaths } from '../state/paths.js';
import { createSnapshotStore, readSnapshotWithoutLock } from '../state/snapshot-store.js';
import { acquireLock } from '../state/lock.js';

const identity = stat => `${stat.dev}:${stat.ino}`;
const fail = () => { throw new Error('Managed node_modules directory is unsafe.'); };
const key = root => createHash('sha256').update(root).digest('hex');
const owners = new WeakSet();
async function directory(path) {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) fail();
  return identity(stat);
}
async function dependencyIdentity(root) {
  try { return await directory(join(root, 'node_modules')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function matches(record, root, rootIdentity, directoryIdentity) {
  return record?.kind === 'rivet-node-dependencies' && record.version === 1
    && record.root === root && record.rootIdentity === rootIdentity
    && record.directoryIdentity === directoryIdentity;
}
export async function inspectLegacyDependencyDirectory(root) {
  const rootIdentity = await directory(root), directoryIdentity = await dependencyIdentity(root);
  const paths = await resolveLegacyDependencyPaths(root, key(root), {existing: true});
  const saved = paths ? await readSnapshotWithoutLock(paths) : null;
  if (saved?.data.status === 'pending') fail();
  if (directoryIdentity === null) return null;
  if (!paths) fail();
  if (!matches(saved?.data, root, rootIdentity, directoryIdentity) || saved.data.status !== 'complete') fail();
  if (await directory(root) !== rootIdentity || await dependencyIdentity(root) !== directoryIdentity) fail();
  return Object.freeze({rootIdentity, directoryIdentity});
}
// Only an explicitly approved invocation can create the durable install intent.
// A pending intent is never reclaimed using elapsed time or process liveness.
export async function beginLegacyDependencyInstall(root) {
  const rootIdentity = await directory(root), directoryIdentity = await dependencyIdentity(root);
  const paths = await resolveLegacyDependencyPaths(root, key(root));
  const lock = await acquireLock(paths.runtimeLockPath);
  try {
    const store = createSnapshotStore(paths), saved = await store.read();
    if (saved && (saved.data.status === 'pending' || !matches(saved.data, root, rootIdentity, directoryIdentity))) fail();
    if (directoryIdentity !== null && !saved) fail();
    if (saved && !['failed', 'complete'].includes(saved.data.status)) fail();
    const receipt = {version: 1, kind: 'rivet-node-dependencies', root, rootIdentity, directoryIdentity,
      status: 'pending', token: randomUUID()};
    const pending = await store.write(receipt, {expectedVersion: saved?.version ?? 0});
    const owner = Object.freeze({root, rootIdentity, store, lock, receipt, version: pending.version});
    owners.add(owner);
    return owner;
  } catch (error) { await lock.release(); throw error; }
}
export async function finishLegacyDependencyInstall(owner, successful = true) {
  if (!owners.has(owner)) fail();
  owners.delete(owner);
  try {
    if (await directory(owner.root) !== owner.rootIdentity) fail();
    const directoryIdentity = await dependencyIdentity(owner.root);
    await owner.store.write({...owner.receipt, directoryIdentity, status: successful ? 'complete' : 'failed'},
      {expectedVersion: owner.version});
  } finally { await owner.lock.release(); }
}

// Releasing this local operation lock is not proof that the installer stopped.
// The durable pending receipt continues to fence inspection and future installs.
export async function abandonLegacyDependencyInstall(owner) {
  if (!owners.has(owner)) fail();
  owners.delete(owner);
  await owner.lock.release();
}
