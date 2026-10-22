import { validExecutionProof } from '../clients/execution-proof.js';
import { createHash, randomUUID } from 'node:crypto';
import { realpath, lstat } from 'node:fs/promises';
import { resolveMachinePaths, machineTransaction, readMachineSnapshot, readMachineArchive, writeMachineArchive } from './machine-paths.js';
const RESOURCES = [
  'activeTasks',
  'agentExecutions',
  'heavyVerification',
  'dependencyInstalls',
];
export const DEFAULT_MACHINE_LIMITS = Object.freeze({
  activeTasks: 4,
  agentExecutions: 4,
  heavyVerification: 1,
  dependencyInstalls: 1,
});
const id = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 256 &&
  !/[\u0000-\u001f]/.test(value);
const hash = (value) =>
  createHash('sha256').update(value).digest('hex').slice(0, 32);
function fail(reason) {
  const e = new Error(`Machine admission requires attention (${reason}).`);
  e.code = 'ERR_MACHINE_ADMISSION';
  e.safeMessage = e.message;
  throw e;
}
function limits(value, partial = false) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (k) => ![...RESOURCES, 'workersPerTask'].includes(k),
    ) ||
    (!partial && RESOURCES.some((k) => value[k] === undefined)) ||
    Object.values(value).some(
      (v) => !Number.isSafeInteger(v) || v < 1 || v > 64,
    )
  )
    fail('limits');
  return structuredClone(value);
}
function validate(s) {
  if (
    !s ||
    s.version !== 1 ||
    !Array.isArray(s.registrations) ||
    s.registrations.length > 512 ||
    !Array.isArray(s.claims) ||
    s.claims.length > 4096 ||
    !Number.isSafeInteger(s.sequence) ||
    (s.revision !== undefined && (!Number.isSafeInteger(s.revision) || s.revision < 0))
  )
    fail('state');
  limits(s.limits);
  const ids = new Set();
  for (const r of s.registrations) {
    if (
      !id(r.id) ||
      ids.has(r.id) ||
      !id(r.projectRoot) ||
      !Number.isSafeInteger(r.deadlineMs) ||
      typeof r.paused !== 'boolean'
    )
      fail('registration');
    ids.add(r.id);
    limits(r.limits, true);
    if (r.projectLimits !== undefined) limits(r.projectLimits, true);
    if (r.operationOwner !== undefined && (!id(r.operationOwner) || r.runId === null)) fail('operation-owner');
  }
  const claims = new Set();
  for (const c of s.claims) {
    if (
      !id(c.id) ||
      claims.has(c.id) ||
      !ids.has(c.registrationId) ||
      !RESOURCES.includes(c.resource) ||
      !id(c.idempotencyKey) ||
      !Number.isSafeInteger(c.generation) ||
      c.generation < 1 ||
      !['queued', 'held', 'released', 'cancelled'].includes(c.status) ||
      !Number.isSafeInteger(c.sequence)
    )
      fail('claim');
    claims.add(c.id);
  }
  return s;
}
function refresh(s, now) {
  for (const task of s.claims.filter(
    (c) => c.resource === 'activeTasks' && c.status === 'held' && c.taskSettled,
  )) {
    if (
      !s.claims.some(
        (c) =>
          c.registrationId === task.registrationId &&
          c.resource !== 'activeTasks' &&
          c.status === 'held',
      )
    )
      task.status = 'released';
  }
  for (const c of s.claims
    .filter((x) => x.status === 'queued')
    .sort((a, b) => a.sequence - b.sequence)) {
    const r = s.registrations.find((x) => x.id === c.registrationId);
    const project = s.registrations.find(
      (x) => x.projectRoot === r.projectRoot && x.runId === null,
    );
    const paused = r.paused || project?.paused;
    if (paused || now >= r.deadlineMs) {
      c.reason = paused ? 'paused' : 'deadline';
      continue;
    }
    const held = s.claims.filter(
      (x) => x.status === 'held' && x.resource === c.resource,
    );
    const sameProject = (x) =>
      s.registrations.find((r) => r.id === x.registrationId).projectRoot ===
      r.projectRoot;
    // Keep every active approval's aggregate ceiling, including expired owners
    // whose execution has not settled. Historical registrations have no effect.
    const activeRegistrationIds = new Set(s.claims.filter(x => x.status === 'held').map(x => x.registrationId));
    const projectCap = Math.min(
      project?.limits[c.resource] ?? 64,
      r.projectLimits?.[c.resource] ?? 64,
      ...s.registrations.filter(x => x.projectRoot === r.projectRoot && activeRegistrationIds.has(x.id))
        .map(x => x.projectLimits?.[c.resource] ?? 64),
    );
    const cap = Math.min(
      r.limits[c.resource] ?? 64,
      c.resource === 'agentExecutions' && r.runId !== null
        ? (r.limits.workersPerTask ?? 64)
        : 64,
    );
    if (held.length >= s.limits[c.resource]) c.reason = `machine-${c.resource}`;
    else if (
      held.filter(sameProject).length >= projectCap
    )
      c.reason = `project-${c.resource}`;
    else if (held.filter((x) => x.registrationId === r.id).length >= cap)
      c.reason = `run-${c.resource}`;
    else {
      c.status = 'held';
      c.reason = null;
      c.admittedAtMs = now;
    }
  }
}
const registrationId = (projectRoot, runId) => `registration-${hash(`${projectRoot}:${runId}`)}`;
const archiveKey = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const registrationKey = (id) => archiveKey('registration', id);
const claimKey = (id) => archiveKey('claim', id);
const requestKey = (c) => archiveKey('request', c.registrationId, c.resource, c.idempotencyKey, c.generation);
const settled = (c) => ['released', 'cancelled'].includes(c.status);
export function createResourceCoordinator({ root, now = Date.now }) {
  let pinnedPaths;
  async function readArchive(s, paths, key) {
    return readMachineArchive(paths, key);
  }
  async function archive(s, paths, key, record) {
    // Only called before the operation, with records from the committed snapshot.
    // A failed operation can therefore never publish an uncommitted mutation.
    await writeMachineArchive(paths, key, record);
  }
  async function loadRegistration(s, paths, idValue, hydrate = false) {
    let r = s?.registrations.find(r => r.id === idValue);
    if (!r && paths) {
      r = await readArchive(s, paths, registrationKey(idValue));
      if (r) {
        validate({version:1,limits:DEFAULT_MACHINE_LIMITS,sequence:0,registrations:[r],claims:[]});
        if (r.id !== idValue || r.runId === null || r.operationOwner !== undefined) fail('archive-registration');
        if (hydrate) {
          if (s.registrations.length >= 512) fail('registration-limit');
          s.registrations.push(r);
        }
      }
    }
    return r ?? undefined;
  }
  async function loadClaim(s, paths, input, hydrate = false) {
    const matches = c => input.claimId ? c.id === input.claimId :
      c.registrationId === input.registrationId && c.resource === input.resource &&
      c.idempotencyKey === input.idempotencyKey && c.generation === input.generation;
    let c = s?.claims.find(matches);
    if (!c && paths) {
      c = await readArchive(s, paths, input.claimId ? claimKey(input.claimId) : requestKey(input));
      if (c) {
        const r = await loadRegistration(s, paths, c.registrationId, hydrate);
        if (!r || !matches(c) || !settled(c)) fail('archive-claim');
        validate({version:1,limits:DEFAULT_MACHINE_LIMITS,sequence:0,registrations:[r],claims:[c]});
        if (hydrate) {
          if (s.claims.length >= 4096) fail('claim-limit');
          s.claims.push(c);
        }
      }
    }
    return c ?? undefined;
  }
  async function compact(s, paths) {
    const large = Buffer.byteLength(JSON.stringify(s)) >= 1024 * 1024;
    if (!large && s.registrations.length < 256 && s.claims.length < 1024) return;
    const hadClaims = new Set(s.claims.map(c => c.registrationId));
    const live = new Set(s.claims.filter(c => !settled(c)).map(c => c.registrationId));
    const removable = new Set(s.registrations.filter(r => r.runId !== null &&
      r.operationOwner === undefined && !live.has(r.id) &&
      (r.cancelled || now() >= r.deadlineMs || hadClaims.has(r.id))).slice(0, 4).map(r => r.id));
    const archivedClaims = new Set();
    const remainingClaims = new Map();
    for (const c of s.claims) remainingClaims.set(c.registrationId, (remainingClaims.get(c.registrationId) ?? 0) + 1);
    for (const c of s.claims) {
      if (archivedClaims.size >= 8) break;
      const r = s.registrations.find(r => r.id === c.registrationId);
      if (!settled(c) || r.operationOwner !== undefined ||
          (!large && s.claims.length < 1024 && !removable.has(r.id))) continue;
      // Preserve settlement evidence until this ordinary registration is itself
      // selected for archival. Otherwise its last claim could disappear outside
      // the bounded registration batch and strand it until its deadline.
      if (r.runId !== null && !live.has(r.id) && !removable.has(r.id) && remainingClaims.get(r.id) === 1) continue;
      await archive(s, paths, claimKey(c.id), c);
      await archive(s, paths, requestKey(c), c);
      archivedClaims.add(c.id);
      remainingClaims.set(r.id, remainingClaims.get(r.id) - 1);
    }
    for (const c of s.claims) {
      if (!archivedClaims.has(c.id)) removable.delete(c.registrationId);
    }
    for (const r of s.registrations) {
      if (removable.has(r.id)) await archive(s, paths, registrationKey(r.id), r);
    }
    // All archive files and directory entries are durable before snapshot removal.
    // Until that atomic snapshot write succeeds, its records remain authoritative.
    s.claims = s.claims.filter(c => !archivedClaims.has(c.id));
    s.registrations = s.registrations.filter(r => !removable.has(r.id));
  }
  async function transaction(fn, { create = false } = {}) {
    const paths = pinnedPaths ?? (await resolveMachinePaths(root, { create }));
    if (paths) pinnedPaths = paths;
    if (!paths) return fn(null, false);
    const retryMaintenance = Symbol('retry-maintenance');
    while (true) {
      const result = await machineTransaction(paths, async (raw) => {
      if (!raw && !create)
        return {
          value: await fn(null, false),
        };
      const priorSerialized = JSON.stringify(raw);
      const state = raw
        ? validate(raw)
        : {
            version: 1,
            limits: {
              ...DEFAULT_MACHINE_LIMITS,
            },
            registrations: [],
            claims: [],
            sequence: 0,
          };
      if (state.registrations.length) state.hasRegistrations = true;
      // Archive only committed input, never state mutated by this operation.
      const beforeCount = state.registrations.length + state.claims.length;
      await compact(state, paths);
      const progressed = state.registrations.length + state.claims.length < beforeCount;
      const maintenance = progressed ? structuredClone(state) : null;
      let value;
      try { value = await fn(state, true, paths); }
      catch (error) {
        if (!maintenance || error.code !== 'ERR_MACHINE_ADMISSION' ||
            !/\((registration|claim)-limit\)/.test(error.message)) throw error;
        // A registration can have more settled claims than one bounded pass.
        // Commit only safe housekeeping, release the lock, and continue; none of
        // the rejected operation's mutations are included in this checkpoint.
        maintenance.revision = (maintenance.revision ?? 0) + 1;
        validate(maintenance);
        return {state:maintenance,value:retryMaintenance};
      }
      if (JSON.stringify(state) !== priorSerialized) state.revision = (state.revision ?? 0) + 1;
      validate(state);
      return {state,value:structuredClone(value)};
      });
      if (result !== retryMaintenance) return result;
    }
  }
  async function register(input) {
    const projectRoot = await realpath(input.projectRoot);
    const stat = await lstat(projectRoot);
    if (
      !stat.isDirectory() ||
      !Number.isSafeInteger(input.deadlineMs) ||
      input.deadlineMs <= now() ||
      (input.runId !== undefined && !id(input.runId)) ||
      (input.operationOwner !== undefined && (!id(input.operationOwner) || input.runId === undefined))
    )
      fail('registration');
    const scoped = limits(input.limits ?? {}, true);
    const projectLimits = input.projectLimits === undefined ? undefined : limits(input.projectLimits, true);
    return transaction(
      async (s, configured, paths) => {
        if (input.machineLimits) {
          const ceiling = limits(input.machineLimits);
          if (
            (s.hasRegistrations || s.registrations.length) &&
            RESOURCES.some((k) => ceiling[k] !== s.limits[k])
          )
            fail('explicit-limits-required');
          s.limits = ceiling;
        }
        const runId = input.runId ?? null;
        s.hasRegistrations = true;
        const existing = await loadRegistration(s, paths, registrationId(projectRoot, runId), true);
        if (existing) {
          if (existing.operationOwner !== input.operationOwner) fail('operation-owner');
          existing.deadlineMs = Math.min(existing.deadlineMs, input.deadlineMs);
          for (const [k, v] of Object.entries(scoped))
            existing.limits[k] = Math.min(existing.limits[k] ?? 64, v);
          if (projectLimits !== undefined) {
            existing.projectLimits ??= {};
            for (const [k, v] of Object.entries(projectLimits))
              existing.projectLimits[k] = Math.min(existing.projectLimits[k] ?? 64, v);
          }
          return existing;
        }
        if (s.registrations.length >= 512) fail('registration-limit');
        const r = {
          id: registrationId(projectRoot, runId),
          projectRoot,
          rootIdentity: {
            dev: stat.dev,
            ino: stat.ino,
          },
          runId,
          ...(input.operationOwner === undefined ? {} : { operationOwner: input.operationOwner }),
          limits: scoped,
          ...(projectLimits === undefined ? {} : { projectLimits }),
          deadlineMs: input.deadlineMs,
          paused: false,
          createdAtMs: now(),
        };
        s.registrations.push(r);
        return r;
      },
      {
        create: true,
      },
    );
  }
  async function request(input) {
    if (
      !id(input.registrationId) ||
      !RESOURCES.includes(input.resource) ||
      !id(input.idempotencyKey) ||
      !Number.isSafeInteger(input.generation) ||
      input.generation < 1
    )
      fail('request');
    return transaction(async (s, configured, paths) => {
      if (!s) fail('unconfigured');
      const registered = await loadRegistration(s, paths, input.registrationId, true);
      if (!registered) fail('unregistered');
      if (registered.cancelled) fail('cancelled');
      const metadata = await lstat(registered.projectRoot);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        metadata.dev !== registered.rootIdentity.dev ||
        metadata.ino !== registered.rootIdentity.ino ||
        (await realpath(registered.projectRoot)) !== registered.projectRoot
      )
        fail('project-identity');
      let c =
        input.resource === 'activeTasks'
          ? s.claims.find(
              (x) =>
                x.registrationId === input.registrationId &&
                x.resource === 'activeTasks' &&
                ['queued', 'held'].includes(x.status),
            )
          : await loadClaim(s, paths, input, true);
      if (c && input.retryUndispatched === true &&
          ['released', 'cancelled'].includes(c.status) &&
          !c.dispatched && c.execution === null) {
        c.status = 'queued';
        c.sequence = ++s.sequence;
        c.reason = null;
      }
      if (!c) {
        if (s.claims.length >= 4096) fail('claim-limit');
        c = {
          id: `claim-${randomUUID()}`,
          registrationId: input.registrationId,
          resource: input.resource,
          idempotencyKey: input.idempotencyKey,
          generation: input.generation,
          sequence: ++s.sequence,
          status: 'queued',
          reason: null,
          owner: {
            pid: process.pid,
            processBirth: null,
            assurance: 'unknown',
          },
          execution: null,
        };
        s.claims.push(c);
      }
      refresh(s, now());
      return c;
    });
  }
  async function mutateClaim(input, fn) {
    return transaction(async (s, configured, paths) => {
      if (!s) fail('unconfigured');
      const c = await loadClaim(s, paths, input, true);
      if (!c || c.generation !== input.generation) fail('generation');
      fn(c, s);
      refresh(s, now());
      return c;
    });
  }
  async function dispatch(input) {
    return mutateClaim(input, (c, s) => {
      const r = s.registrations.find((x) => x.id === c.registrationId);
      const project = s.registrations.find(
        (x) => x.projectRoot === r.projectRoot && x.runId === null,
      );
      if (
        c.status !== 'held' ||
        c.dispatched ||
        r.paused ||
        project?.paused ||
        now() >= r.deadlineMs ||
        input.signal?.aborted ||
        (input.deadlineMs !== undefined && (!Number.isSafeInteger(input.deadlineMs) || now() >= input.deadlineMs))
      )
        fail('dispatch-conflict');
      c.dispatched = true;
      if (input.dispatchId) c.dispatchId = input.dispatchId;
    });
  }
  async function claimTask(input) {
    return mutateClaim(input, (c) => {
      if (
        c.resource !== 'activeTasks' ||
        c.taskSettled ||
        !['queued', 'held'].includes(c.status) ||
        !id(input.ownerId)
      )
        fail('task-owner');
      if (c.taskOwner && c.taskOwner !== input.ownerId)
        fail('task-already-owned');
      c.taskOwner = input.ownerId;
    });
  }
  async function cancelRegistration(registrationId) {
    return transaction(async (s, configured, paths) => {
      const registration = await loadRegistration(s, paths, registrationId, true);
      if (!registration) fail('unregistered');
      registration.cancelled = true;
      registration.paused = true;
      const claims = s.claims.filter(
        (c) => c.registrationId === registrationId,
      );
      for (const claim of claims) {
        if (claim.status === 'queued') claim.status = 'cancelled';
        else if (
          claim.status === 'held' &&
          claim.resource !== 'activeTasks' &&
          !claim.dispatched &&
          claim.execution === null
        )
          claim.status = 'released';
      }
      const childrenHeld = claims.some(
        (c) => c.resource !== 'activeTasks' && c.status === 'held',
      );
      for (const claim of claims)
        if (
          claim.resource === 'activeTasks' &&
          claim.status === 'held' &&
          !claim.taskOwner &&
          !childrenHeld
        )
          claim.status = 'released';
      refresh(s, now());
      return registration;
    });
  }
  async function execution(input) {
    return mutateClaim(input, (c) => {
      const r = input.receipt;
      if (
        c.status !== 'held' ||
        !r ||
        !['started', 'stopped', 'unknown'].includes(r.status) ||
        !id(r.executionId) ||
        r.source !== 'owned-process' ||
        r.assurance !== 'observed' ||
        !Number.isSafeInteger(r.processId) ||
        r.processId < 1 ||
        !Number.isSafeInteger(r.processGroupId) ||
        r.processGroupId < 1 ||
        !Number.isSafeInteger(r.ownerProcessId) ||
        r.ownerProcessId < 1 ||
        r.processBirth !== null ||
        !Number.isSafeInteger(r.observedAtMs) ||
        r.observedAtMs < 0 ||
        Object.keys(r).some(
          (k) =>
            ![
              'version',
              'executionId',
              'processId',
              'processGroupId',
              'ownerProcessId',
              'processBirth',
              'observedAtMs',
              'source',
              'assurance',
              'status',
            ].includes(k),
        ) ||
        r.version !== 1
      )
        fail('receipt');
      if (
        c.execution &&
        ([
          'executionId',
          'processId',
          'processGroupId',
          'ownerProcessId',
          'processBirth',
        ].some((k) => c.execution[k] !== r[k]) ||
          r.observedAtMs < c.execution.observedAtMs)
      )
        fail('owner-changed');
      if (r.status !== 'started' && !c.execution) fail('missing-start');
      c.execution = structuredClone(r);
      if (r.status === 'stopped') c.status = 'released';
    });
  }
  async function hostStop(input) {
    return mutateClaim(input, (c) => {
      const r = input.receipt;
      if (
        c.status !== 'held' ||
        r?.source !== 'host-observation' ||
        r.assurance !== 'host-reported' ||
        r.status !== 'stopped' ||
        r.sessionId !== input.sessionId ||
        r.generation !== input.generation ||
        c.idempotencyKey !== input.sessionId
      )
        fail('host-stop');
      c.execution = structuredClone(r);
      c.status = 'released';
    });
  }
  async function release(input) {
    return mutateClaim(input, (c, s) => {
      if (c.status === 'released' || c.status === 'cancelled') return;
      if (c.taskOwner && c.taskOwner !== input.ownerId) fail('task-owner');
      const noExecution = c.execution === null && c.dispatchId === input.dispatchId && validExecutionProof(input.noExecutionProof, c.dispatchId);
      if (
        !noExecution && c.execution?.status !== 'stopped' &&
        (c.execution !== null || c.dispatched)
      )
        fail('stop-unknown');
      if (
        c.resource === 'activeTasks' &&
        s.claims.some(
          (x) =>
            x.registrationId === c.registrationId &&
            x.id !== c.id &&
            x.status === 'held',
        )
      ) {
        if (
          c.taskOwner === input.ownerId &&
          id(input.ownerId) &&
          input.completed === true
        ) {
          c.taskOwner = null;
          c.taskSettled = true;
          return;
        }
        fail('children-held');
      }
      if (input.completed !== true) fail('completion-required');
      c.status = c.status === 'queued' ? 'cancelled' : 'released';
    });
  }
  async function retireOperation({ registrationId, operationOwner }) {
    return transaction(s => {
      const registration = s?.registrations.find(r => r.id === registrationId);
      if (!registration || !id(operationOwner) || registration.operationOwner !== operationOwner)
        fail('operation-owner');
      const claims = s.claims.filter(c => c.registrationId === registrationId);
      // Only the settled invocation can retire its private ledger. Unknown
      // children retain both their ownership and execution evidence unchanged.
      if (claims.some(c => !['released', 'cancelled'].includes(c.status))) return false;
      s.claims = s.claims.filter(c => c.registrationId !== registrationId);
      s.registrations = s.registrations.filter(r => r.id !== registrationId);
      return true;
    });
  }
  async function lookup(input, claim = false) {
    const paths = pinnedPaths ?? await resolveMachinePaths(root);
    if (!paths) return undefined;
    // Snapshot records take precedence. Archives contain only committed input;
    // retry if a newer snapshot was committed while reading the archive.
    let readError;
    for (let attempt = 0; attempt < 3; attempt++) {
      let raw;
      let after;
      let value;
      let lookupError;
      try {
        raw = await readMachineSnapshot(paths);
        const s = raw ? validate(raw) : null;
        if (!s) return undefined;
        try {
          value = claim ? await loadClaim(s, paths, input) :
            await loadRegistration(s, paths, input.registrationId ?? registrationId(input.projectRoot, input.runId ?? null));
        } catch (error) { lookupError = error; }
        after = await readMachineSnapshot(paths);
      } catch (error) {
        // Atomic rename during a read can invalidate its inode check. A stable
        // unsafe path still fails closed after these bounded read-only retries.
        readError = error;
        continue;
      }
      if (JSON.stringify(raw) !== JSON.stringify(after)) continue;
      if (lookupError) throw lookupError;
      return value ? structuredClone(value) : undefined;
    }
    if (readError) throw readError;
    fail('read-conflict');
  }

  async function inspectReadOnly() {
    const paths=pinnedPaths??await resolveMachinePaths(root);
    const raw=paths?await readMachineSnapshot(paths):null;
    return raw?structuredClone({configured:true,...validate(raw)}):{configured:false,registrations:[],claims:[]};
  }
  async function inspect() {
    return transaction((s) => {
      if (!s)
        return {
          configured: false,
          registrations: [],
          claims: [],
        };
      refresh(s, now());
      return {
        configured: true,
        ...s,
      };
    });
  }
  async function pause(idValue, paused = true) {
    return transaction(async (s, configured, paths) => {
      const r = await loadRegistration(s, paths, idValue, true);
      if (!r) fail('unregistered');
      if (r.cancelled && !paused) fail('cancelled');
      r.paused = paused;
      return r;
    });
  }
  async function configure(value) {
    const next = limits(value);
    return transaction((s) => {
      if (s.claims.some((x) => x.status === 'held')) fail('active-claims');
      s.limits = next;
      refresh(s, now());
      return s.limits;
    }, {create:true});
  }
  async function renew(idValue, deadlineMs) {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= now())
      fail('deadline');
    return transaction(async (s, configured, paths) => {
      const r = await loadRegistration(s, paths, idValue, true);
      if (
        !r ||
        r.runId !== null ||
        s.claims.some(
          (x) =>
            s.registrations.find((entry) => entry.id === x.registrationId)
              .projectRoot === r.projectRoot &&
            ['held', 'queued'].includes(x.status),
        )
      )
        fail('planning-renewal');
      r.priorDeadlines ??= [];
      if (r.priorDeadlines.length >= 32) fail('renewal-limit');
      r.priorDeadlines.push(r.deadlineMs);
      r.deadlineMs = deadlineMs;
      return r;
    });
  }
  return Object.freeze({
    register,
    getRegistration: input => lookup(input),
    getClaim: input => lookup(input, true),
    request,
    dispatch,
    claimTask,
    cancelRegistration,
    execution,
    hostStop,
    release,
    retireOperation,
    inspect,
    inspectReadOnly,
    pause,
    resume: (id) => pause(id, false),
    configure,
    renew,
  });
}
