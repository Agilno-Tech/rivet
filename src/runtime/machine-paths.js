import { constants } from 'node:fs';
import { lstat, realpath, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, basename, join, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  acquireLock,
  LockBusyError,
  recoverAbandonedLock,
} from '../state/lock.js';
const branded = new WeakSet();
const MAX = 2 * 1024 * 1024;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const owned = (s) =>
  typeof process.getuid !== 'function' || s.uid === process.getuid();
const regular = (s) =>
  s.isFile() &&
  !s.isSymbolicLink() &&
  s.nlink === 1 &&
  (s.mode & 0o777) === 0o600 &&
  owned(s);
const directory = (s) =>
  s.isDirectory() &&
  !s.isSymbolicLink() &&
  (s.mode & 0o777) === 0o700 &&
  owned(s);
function fail() {
  throw new Error('Unsafe private machine state.');
}
async function missing(path) {
  try {
    return await lstat(path);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
export async function resolveMachinePaths(root, { create = false } = {}) {
  if (
    typeof root !== 'string' ||
    !isAbsolute(root) ||
    resolve(root) !== root ||
    root.length > 4096
  )
    fail();
  // Create only the explicit private leaf; the application chooses an existing home
  // parent. Canonicalize system aliases such as macOS /var before pinning identities.
  let parent;
  try {
    parent = await realpath(dirname(root));
  } catch (error) {
    if (!create && error.code === 'ENOENT') return null;
    throw error;
  }
  root = join(parent, basename(root));
  for (let p = parent; ; p = dirname(p)) {
    if (await missing(join(p, '.git'))) fail();
    if (dirname(p) === p) break;
  }
  let metadata = await missing(root);
  if (!metadata && !create) return null;
  if (!metadata) {
    try {
      await mkdir(root, {
        mode: 0o700,
      });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    metadata = await lstat(root);
  }
  if (
    !directory(metadata) ||
    (await realpath(root)) !== root ||
    (await missing(join(root, '.git'))) ||
    ((await missing(join(root, 'HEAD'))) &&
      (await missing(join(root, 'objects'))))
  )
    fail();
  const ancestors = [];
  for (let p = root; ; p = dirname(p)) {
    const s = await lstat(p);
    if (!s.isDirectory() || s.isSymbolicLink()) fail();
    ancestors.push({
      path: p,
      dev: s.dev,
      ino: s.ino,
    });
    if (dirname(p) === p) break;
  }
  const paths = Object.freeze({
    root,
    snapshot: join(root, 'machine.json'),
    lock: join(root, 'machine.lock'),
    ancestors,
  });
  branded.add(paths);
  return paths;
}
async function verify(paths) {
  if (!branded.has(paths)) fail();
  for (const a of paths.ancestors) {
    const s = await lstat(a.path);
    if (!s.isDirectory() || s.isSymbolicLink() || !same(a, s)) fail();
  }
  if (!directory(await lstat(paths.root))) fail();
}
export async function readMachineSnapshot(paths) {
  await verify(paths);
  const before = await missing(paths.snapshot);
  if (!before) return null;
  if (!regular(before) || before.size < 1 || before.size > MAX) fail();
  const h = await open(
    paths.snapshot,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const s = await h.stat();
    if (!regular(s) || !same(before, s)) fail();
    const b = Buffer.alloc(MAX + 1);
    let n = 0;
    while (n < b.length) {
      const { bytesRead } = await h.read(b, n, b.length - n, null);
      if (!bytesRead) break;
      n += bytesRead;
    }
    if (n > MAX) fail();
    const after = await lstat(paths.snapshot);
    if (
      !regular(after) ||
      !same(s, after) ||
      s.size !== after.size ||
      s.mtimeMs !== after.mtimeMs
    )
      fail();
    await verify(paths);
    return JSON.parse(
      new TextDecoder('utf-8', {
        fatal: true,
      }).decode(b.subarray(0, n)),
    );
  } finally {
    await h.close();
  }
}
async function write(paths, value) {
  await verify(paths);
  const source = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(source) > MAX) fail();
  const before = await missing(paths.snapshot);
  if (before && !regular(before)) fail();
  const temp = join(paths.root, `.machine-${randomUUID()}.tmp`);
  const dir = await open(
    paths.root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let h;
  let identity;
  try {
    h = await open(
      temp,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    identity = await h.stat();
    if (!regular(identity)) fail();
    await h.writeFile(source);
    await h.sync();
    await h.close();
    h = null;
    await verify(paths);
    if (!same(await dir.stat(), await lstat(paths.root))) fail();
    const current = await missing(paths.snapshot);
    if (
      Boolean(current) !== Boolean(before) ||
      (current && (!regular(current) || !same(current, before)))
    )
      fail();
    if (!same(identity, await lstat(temp))) fail();
    await rename(temp, paths.snapshot);
    await dir.sync();
    if (!same(identity, await lstat(paths.snapshot))) fail();
    await verify(paths);
  } finally {
    await h?.close();
    try {
      const s = await lstat(temp);
      if (identity && same(s, identity)) await unlink(temp);
    } catch {}
    await dir.close();
  }
}
export async function machineTransaction(
  paths,
  operation,
  { now = Date.now } = {},
) {
  if (!branded.has(paths)) fail();
  let lock;
  const until = Date.now() + 2000;
  while (!lock) {
    await verify(paths);
    try {
      lock = await acquireLock(paths.lock);
    } catch (e) {
      if (e.code === 'ERR_STALE_STATE_LOCK') {
        await recoverAbandonedLock(paths.lock);
        continue;
      }
      if (!(e instanceof LockBusyError) || Date.now() >= until) throw e;
      await delay(5);
    }
  }
  try {
    const current = await readMachineSnapshot(paths);
    const result = await operation(current);
    if (result.state !== undefined) await write(paths, result.state);
    return result.value;
  } finally {
    await verify(paths);
    await lock.release();
  }
}
