import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveLegacyDependencyPaths } from '../state/paths.js';
import { createSnapshotStore, readSnapshotWithoutLock } from '../state/snapshot-store.js';
import { acquireLock } from '../state/lock.js';

const identity = stat => `${stat.dev}:${stat.ino}`;
const fail = () => { throw new Error('Managed node_modules directory is unsafe.'); };
export const dependencyKinds = Object.freeze(['node_modules','.rivet-deps']);
const kindCheck = kind => {if (!dependencyKinds.includes(kind)) fail();return kind;};
const key = (root, kind='node_modules') => createHash('sha256').update(kindCheck(kind)==='node_modules'?root:root+'/'+kind).digest('hex');
const owners = new WeakSet();
const pinnedDirectories=new WeakMap();
async function directory(path) {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) fail();
  return identity(stat);
}
async function dependencyIdentity(root, kind='node_modules') {
  try { return await directory(join(root, kindCheck(kind))); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function matches(record, root, rootIdentity, directoryIdentity, kind='node_modules') {
  return record?.kind === (kind==='node_modules'?'rivet-node-dependencies':'rivet-portable-dependencies') && record.version === 1
    && record.root === root && record.rootIdentity === rootIdentity
    && record.directoryIdentity === directoryIdentity;
}
export async function inspectLegacyDependencyDirectory(root, kind='node_modules') {
  const rootIdentity = await directory(root), directoryIdentity = await dependencyIdentity(root,kind);
  const paths = await resolveLegacyDependencyPaths(root, key(root,kind), {existing: true});
  const saved = paths ? await readSnapshotWithoutLock(paths) : null;
  if (saved?.data.status === 'pending') fail();
  if (directoryIdentity === null) return null;
  if (!paths) fail();
  if (!matches(saved?.data, root, rootIdentity, directoryIdentity, kind) || saved.data.status !== 'complete') fail();
  if (await directory(root) !== rootIdentity || await dependencyIdentity(root,kind) !== directoryIdentity) fail();
  return Object.freeze({rootIdentity, directoryIdentity});
}
// Only an explicitly approved invocation can create the durable install intent.
// A pending intent is never reclaimed using elapsed time or process liveness.
export async function beginLegacyDependencyInstall(root, kind='node_modules', {allowUnowned=false}={}) {
  const rootIdentity = await directory(root), directoryIdentity = await dependencyIdentity(root,kind);
  const paths = await resolveLegacyDependencyPaths(root, key(root,kind));
  const lock = await acquireLock(paths.runtimeLockPath);
  try {
    const store = createSnapshotStore(paths), saved = await store.read();
    if (saved && (saved.data.status === 'pending' || !matches(saved.data, root, rootIdentity, directoryIdentity, kind))) fail();
    if (directoryIdentity !== null && !saved && !(allowUnowned&&kind==='.rivet-deps')) fail();
    if (saved && !['failed', 'complete'].includes(saved.data.status)) fail();
    const receipt = {version: 1, kind: kind==='node_modules'?'rivet-node-dependencies':'rivet-portable-dependencies', root, rootIdentity, directoryIdentity,
      status: 'pending', ...(kind==='.rivet-deps'?{cleanupEligible:saved?saved.data.cleanupEligible!==false:directoryIdentity===null}:{}), token: randomUUID()};
    const pending = await store.write(receipt, {expectedVersion: saved?.version ?? 0});
    const owner = Object.freeze({root, kind, rootIdentity, store, lock, receipt, version: pending.version});
    owners.add(owner);
    return owner;
  } catch (error) { await lock.release(); throw error; }
}
export async function pinDependencyInstallDirectory(owner,expectedIdentity) {
 if(!owners.has(owner)||await dependencyIdentity(owner.root,owner.kind)!==expectedIdentity)fail();
 pinnedDirectories.set(owner,expectedIdentity);
}
export async function finishLegacyDependencyInstall(owner, successful = true) {
  if (!owners.has(owner)) fail();
  owners.delete(owner);
  try {
    if (await directory(owner.root) !== owner.rootIdentity) fail();
    const directoryIdentity = await dependencyIdentity(owner.root,owner.kind);
    if(pinnedDirectories.has(owner)&&pinnedDirectories.get(owner)!==directoryIdentity)fail();
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

// The cleanup operation holds both installer locks, including absent roots.
export async function lockDependencyCleanup(root) {
 const locks=[];
 try {for(const kind of dependencyKinds) {const paths=await resolveLegacyDependencyPaths(root,key(root,kind));locks.push(await acquireLock(paths.runtimeLockPath));}
 return {release:async()=>{for(const lock of locks.reverse())await lock.release();}};
 }catch(error){for(const lock of locks.reverse())await lock.release();throw error;}
}
export async function inspectCleanupDependency(root,kind,expected=null) {
 kindCheck(kind);
 const rootIdentity=await directory(root),directoryIdentity=await dependencyIdentity(root,kind);
 const paths=await resolveLegacyDependencyPaths(root,key(root,kind),{existing:true});
 const saved=paths?await readSnapshotWithoutLock(paths):null;
 const record=saved?.data;
 if(record?.status==='pending')fail();
 if(directoryIdentity!==null && record?.cleanupEligible===false)fail();
 if(directoryIdentity===null) {
  if(expected && record && ['removing','retired'].includes(record.status) && record.token===expected.token && matches(record,root,rootIdentity,expected.directoryIdentity,kind))return expected;
  if(expected)fail();return null;
 }
 if(!matches(record,root,rootIdentity,directoryIdentity,kind) || !['complete',...(expected?['removing']:[])].includes(record.status))fail();
 const result={name:kind,rootIdentity,directoryIdentity,token:record.token};
 if(expected&&JSON.stringify(result)!==JSON.stringify(expected))fail();
 return result;
}
export async function removeCleanupDependency(root,expected) {
 await inspectCleanupDependency(root,expected.name,expected);
 const paths=await resolveLegacyDependencyPaths(root,key(root,expected.name),{existing:true});
 const store=createSnapshotStore(paths);let saved=await store.read();
 if(saved.data.status==='retired')return;
 saved=await store.write({...saved.data,status:'removing'},{expectedVersion:saved.version});
 await inspectCleanupDependency(root,expected.name,expected);
 await rm(join(root,expected.name),{recursive:true,force:true});
 await store.write({...saved.data,status:'retired'},{expectedVersion:saved.version});
}
