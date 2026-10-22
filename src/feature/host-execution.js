import {hostReconciliationStore} from './host-reconciliation.js';
import {currentMachineContext,assertMachineAdmissionOpen} from '../runtime/machine-admission.js';
import {stopReceipt as validatedStopReceipt} from './sessions.js';
import {captureCheckpoint,verifyCheckpoint} from './checkpoints.js';
import {requireSession,turnoverReason} from './sessions.js';
import { inspectGovernance, requireGovernance } from './governance.js';
import {assertSelectedProtocolRefs, selectedProtocolStatus} from '../protocols/project.js';
import {createProtocolPresentation, protocolLookupContext} from '../protocols/presentation.js';
import { lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { basename, dirname, join } from 'node:path';

import { immutableJson } from '../clients/contract.js';
import { loadProjectConfig } from '../config/load.js';
import { assertGitClient } from '../git/client.js';
import { prepareIntegrationWorktree } from '../git/integration-worktree.js';
import { reconcileWorktree } from '../git/reconcile.js';
import { integrateFeatureWorker } from './worker-integration.js';
import { createReservationStore } from '../git/reservations.js';
import { createReservedWorktree, verifyReservedWorktree } from '../git/worktrees.js';
import { buildLaunchContract } from '../prompts/launch-contract.js';
import { runQualityGates } from '../quality/runner.js';
import { configuredVerificationReuse } from '../quality/configuration.js';
import { createRuntimeInstance } from '../runtime/instance-store.js';
import { createOrchestrator, validateRuntimeSnapshot, captureRuntimeResult } from '../runtime/orchestrator.js';
import {
  acceptedIntegrationPaths,
  resolveExistingFeatureRunPaths,
  resolveExistingStatePaths,
  resolveFeatureRunPaths,
  resolveStatePaths,
  verificationReportPaths,
} from '../state/paths.js';
import { readSnapshotWithoutLock } from '../state/snapshot-store.js';
import { createWorkAction, validateWorkAction } from './actions.js';
import { createAcceptedIntegrationStore } from './accepted-integration.js';
import { recoverHostRunLocks } from './host-lock-recovery.js';
import { acquireHostRunLock } from './host-run-lock.js';
import { createFeatureRunStore } from './run-store.js';
import { createVerificationReportStore, verificationReport } from './verification-report.js';
import {
  createFeatureLaunchInput,
  createFeatureRuntimeControls,
  createFeatureRuntimeState,
  configuredFeatureGates,
  featureBranchFor,
  featureNowMilliseconds,
  featureQualityAuthority,
  finalizeFeatureWorkerCommit,
  inspectFeatureRuntime,
  prepareFeatureWorkerParent,
  reusableWorkerCheckout,
} from './runtime-bridge.js';

const RUN_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export class HostExecutionError extends Error {
  constructor(reason = 'invalid-input') {
    const messages = {
      'invalid-input': 'Host execution input is invalid.',
      'run-missing': 'Feature run was not found.',
      'state-conflict': 'Host execution state changed or does not permit this operation.',
      repository: 'Host execution requires the exact clean approved repository baseline.',
      'verification-failed': 'Configured verification failed. Read work status for the recorded checks and recovery guidance.',
    };
    super(messages[reason] ?? messages['invalid-input']);
    this.name = 'HostExecutionError';
    this.code = `ERR_HOST_EXECUTION_${reason.replaceAll('-', '_').toUpperCase()}`;
    this.safeMessage = this.message;
    this.details = Object.freeze({ reason });
  }
}

function fail(reason) { throw new HostExecutionError(reason); }

function capture(input, allowed, required = allowed) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('invalid-input');
    const keys = Reflect.ownKeys(input);
    if (keys.length > allowed.size || keys.some(key => typeof key !== 'string' || !allowed.has(key))
      || [...required].some(key => !keys.includes(key))) fail('invalid-input');
    const result = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('invalid-input');
      result[key] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (error instanceof HostExecutionError) throw error;
    fail('invalid-input');
  }
}

function request(input, versionName = null) {
  const allowed = new Set(['project', 'runId', ...(versionName ? [versionName] : [])]);
  const value = capture(input, allowed);
  if (typeof value.project !== 'string' || !value.project.startsWith('/') || value.project.length > 4096
    || typeof value.runId !== 'string' || value.runId.length > 64 || !RUN_ID.test(value.runId)
    || (versionName && (!Number.isSafeInteger(value[versionName]) || value[versionName] < 1))) fail('invalid-input');
  return value;
}

export { request as captureHostExecutionRequest };

function runtimeSummary(state) {
  return immutableJson({
    version: state.version,
    terminal: state.terminal,
    activated: state.activated,
    graphStatus: state.graph.status,
    nodes: state.graph.nodes.map(node => ({ id: node.id, status: node.status, owner: node.owner })),
    usage: state.usage,
  });
}

function exactStrings(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const first = [...left].sort();
  const second = [...right].sort();
  return first.every((value, index) => value === second[index]);
}

export function createHostExecution(input) {
  const configured = capture(
    input,
    new Set(['gitClient', 'now', 'resolveCommandExecutable', 'environment','machine']),
    new Set(['gitClient']),
  );
  try { assertGitClient(configured.gitClient); } catch { fail('invalid-input'); }
  const gitClient = configured.gitClient;
  const now = configured.now ?? (() => new Date().toISOString());
  const resolveCommandExecutable = configured.resolveCommandExecutable;
  const environment = configured.environment === undefined ? Object.freeze(Object.create(null)) : immutableJson(configured.environment);
  if (typeof now !== 'function'
    || (resolveCommandExecutable !== undefined && typeof resolveCommandExecutable !== 'function')) fail('invalid-input');

  async function runRecord(project, runId) {
    const paths = await resolveFeatureRunPaths(project, runId);
    const store = createFeatureRunStore(paths);
    const run = await store.read();
    if (run === null) fail('run-missing');
    if (run.featurePlan.client !== 'host') fail('state-conflict');
    return { paths, store, run };
  }

  async function runtimeContext(project, run) {
    assertSelectedProtocolRefs(project, run.workRequest.contextRefs);
    const [repository, config] = await Promise.all([
      gitClient.inspectRepository(project),
      loadProjectConfig(project),
    ]).catch(() => fail('repository'));
    if (repository.root !== project || repository.detached || repository.dirty
      || repository.branch !== config.project.repository.defaultBranch
      || repository.headSha !== run.featurePlan.baselineCommit) fail('repository');
    assertSelectedProtocolRefs(project, run.workRequest.contextRefs);
    if (currentMachineContext() &&
      (!run.featurePlan.executionPolicy || !config.orchestration.executionPolicy)) {
      const error = new Error('Enrolled host execution requires an approved execution policy. Create and approve a managed plan before preparing this run.');
      error.code = 'ERR_HOST_MANAGED_POLICY_REQUIRED';
      error.safeMessage = error.message;
      throw error;
    }
    const initialState = createFeatureRuntimeState({ config, run });
    const statePaths = await resolveStatePaths(project, run.runId);
    const integrationBranch = featureBranchFor(config, run.featurePlan, run.runId);
    const worktreeRunRoot = join(dirname(project), '.rivet-worktrees', repository.repositoryId, basename(statePaths.instanceDir));
    const integration = await prepareIntegrationWorktree({
      projectRoot: project,
      statePaths,
      branch: integrationBranch,
      worktreePath: join(worktreeRunRoot, 'integration'),
      baseSha: run.featurePlan.baselineCommit,
    }, { gitClient });
    const parent = await prepareFeatureWorkerParent(worktreeRunRoot);
    const instance = createRuntimeInstance({ id: run.runId, paths: statePaths, initialState });
    const planNodes = new Map(run.featurePlan.nodes.map(node => [node.id, node]));
    const candidatePolicyDigest=createHash('sha256').update(JSON.stringify({proposal:run.proposalDigest,config})).digest('hex');
    const nowMs = () => featureNowMilliseconds(now);
    const runtime = createOrchestrator({
      ...(config.orchestration.executionPolicy ? {sessionPolicy:config.orchestration.executionPolicy.sessions} : {}),
      client: Object.freeze({ async launch() { fail('state-conflict'); } }),
      now: nowMs,
      async prepareWorktree(node, intent) {
        const planNode = planNodes.get(node.id);
        if (!planNode || planNode.role !== 'worker' || intent.attempt !== 1) fail('state-conflict');
        const current = await gitClient.inspectRepository(integration.path);
        if (current.branch !== integration.branch || current.dirty) fail('repository');
        const branch = `worker/${run.runId}/${node.id}`;
        const worktreePath = join(parent, node.id);
        const reservations = await createReservationStore(statePaths).list();
        const existing = reservations.reservations.filter(item => item.nodeId === node.id
          && item.ownerId === node.owner.id && item.status === 'active');
        if (existing.length > 1) fail('state-conflict');
        if (existing.length === 1) {
          const reused = await reusableWorkerCheckout({
            gitClient,
            projectRoot: integration.path,
            statePaths,
            node,
            planNode,
            branch,
            worktreePath,
            baseSha: current.headSha,
            nowMs: nowMs(),
          });
          return Object.freeze({
            path: reused.worker.root,
            dev: reused.worker.rootIdentity.dev,
            ino: reused.worker.rootIdentity.ino,
            reservationId: intent.reservationId,
          });
        }
        const created = await createReservedWorktree({
          projectRoot: integration.path,
          statePaths,
          nodeId: node.id,
          branch,
          worktreePath,
          ownerId: node.owner.id,
          baseSha: current.headSha,
          responsibilities: planNode.ownedPaths,
          intendedPaths: planNode.ownedPaths,
          expiresAt: new Date(nowMs() + 24 * 60 * 60 * 1000).toISOString(),
        }, { gitClient, nowMs: nowMs() });
        const worker = await gitClient.inspectRepository(created.reservation.worktreePath);
        return Object.freeze({
          path: worker.root,
          dev: worker.rootIdentity.dev,
          ino: worker.rootIdentity.ino,
          reservationId: intent.reservationId,
        });
      },
      launchFor(node, intent) {
        assertSelectedProtocolRefs(project, run.workRequest.contextRefs);
        const planNode = planNodes.get(node.id);
        if (!planNode) fail('state-conflict');
        return createFeatureLaunchInput(node, intent, planNode, run);
      },
      async reconcile(node, intent, result) {
        assertSelectedProtocolRefs(project, run.workRequest.contextRefs);
        const reservations = await createReservationStore(statePaths).list();
        const matches = reservations.reservations.filter(item => item.nodeId === node.id
          && item.ownerId === node.owner.id && item.status === 'active');
        if (matches.length !== 1) fail('state-conflict');
        const leaseId = matches[0].leaseId;
        const evidenceMatches = result.status !== 'success' || exactStrings(result.output?.evidence, node.evidenceRefs);
        if (result.status === 'success' && run.featurePlan.maxParallelWorkers === undefined) {
          await finalizeFeatureWorkerCommit({
            gitClient,
            projectRoot: integration.path,
            statePaths,
            node,
            planNode: planNodes.get(node.id),
            leaseId,
            nowMs: nowMs(),
          });
        }
        const reconciliation = {
          projectRoot: integration.path,
          statePaths,
          nodeId: node.id,
          ownerId: node.owner.id,
          leaseId,
          integrationBranch: integration.branch,
          integrate: evidenceMatches,
        };
        let report;
        if(run.featurePlan.maxParallelWorkers !== undefined && evidenceMatches) {
          const state=await inspectFeatureRuntime(instance);
          const acceptedStore=createAcceptedIntegrationStore(await acceptedIntegrationPaths(await resolveFeatureRunPaths(project,run.runId)));
          report=await integrateFeatureWorker({...reconciliation,runId:run.runId,
            baselineCommit:run.featurePlan.baselineCommit,runtimeVersion:state.version,
            intentId:intent.id,...(intent.session?{sessionId:intent.session.id,generation:intent.session.generation}:{}),
            policyDigest:candidatePolicyDigest,verificationOutputs:config.quality.verificationOutputs??[],
          },{gitClient,acceptedStore,nowMs,
            validateOwner:async()=>{
              const current=(await runRecord(project,run.runId)).run;
              if(current.status!=='running'||current.version!==run.version||current.proposalDigest!==run.proposalDigest)fail('state-conflict');
              const currentConfig=await loadProjectConfig(project);
              if(JSON.stringify(currentConfig)!==JSON.stringify(config))fail('state-conflict');
              createFeatureRuntimeState({config:currentConfig,run:current});
              const source=await gitClient.inspectRepository(project);
              if(source.root!==project||source.dirty||source.headSha!==run.featurePlan.baselineCommit
                ||source.branch!==config.project.repository.defaultBranch)fail('repository');
              assertSelectedProtocolRefs(project,run.workRequest.contextRefs);
              const observed=await inspectFeatureRuntime(instance);
              const active=observed.launchIntents[node.id];
              if(observed.terminal || observed.graph.nodes.find(item=>item.id===node.id)?.status!=='running'
                ||active?.status!=='started'||active.id!==intent.id||active.attempt!==intent.attempt
                ||active.reservationId!==intent.reservationId)fail('state-conflict');
              if(intent.session) {
                const session=observed.sessions[node.id];
                if(session?.id!==intent.session.id||session.generation!==intent.session.generation||session.phase!=='reconciling'
                  ||(session.writer&&session.stopReceipt?.status!=='stopped'))fail('state-conflict');
              }
              await verifyReservedWorktree({projectRoot:integration.path,statePaths,nodeId:node.id,ownerId:node.owner.id,leaseId},{gitClient,nowMs:nowMs()});
            },
            verify:async manifest=>{
              await (await hostReconciliationStore(statePaths,node.id)).candidate(manifest);
              return runQualityGates({...configuredVerificationReuse(config),projectRoot:manifest.path,
              commitSha:manifest.commitSha,authority:featureQualityAuthority(config),
              gates:await configuredFeatureGates(config,resolveCommandExecutable,manifest.path),environment,
            },{gitClient,now:nowMs});
            },
          });
        } else report=await reconcileWorktree(reconciliation,{gitClient,nowMs:nowMs()});
        return evidenceMatches ? report : Object.freeze({
          ...report,
          status: 'blocked',
          reason: 'result-evidence-mismatch',
        });
      },
    });
    return { instance, runtime, integration, config, planNodes };
  }

  async function prepareLocked(inputValue) {
    const value = request(inputValue, 'expectedRunVersion');
    const { store, run } = await runRecord(value.project, value.runId);
    if (!['approved', 'running'].includes(run.status) || run.version !== value.expectedRunVersion) fail('state-conflict');
    await requireGovernance({project:value.project,run,gitClient,phase:'plan'});
    assertMachineAdmissionOpen();
    const preparedContext = await runtimeContext(value.project, run);
    assertMachineAdmissionOpen();
    const running = run.status === 'running' ? run : await store.update({
      status: 'running',
      updatedAt: now(),
      runtimeRefs: [...new Set([...run.runtimeRefs, `runtime:${run.runId}`])],
      evidenceRefs: run.evidenceRefs,
    }, { expectedVersion: run.version });
    const context = run.status === 'running' ? preparedContext : await runtimeContext(value.project, running);
    let state = await inspectFeatureRuntime(context.instance);
    if (!state.activated) {
      state = await context.runtime.activate(context.instance, {
        expectedVersion: state.version,
        ...createFeatureRuntimeControls({ run: running, nowMs: featureNowMilliseconds(now) }),
      });
    }
    return immutableJson({ status: 'ready', run: running, runtimeVersion: state.version });
  }

  async function prepare(inputValue) {
    const value = request(inputValue, 'expectedRunVersion');
    const paths = await resolveExistingFeatureRunPaths(value.project, value.runId);
    if (paths === null) fail('run-missing');
    const lock = await acquireHostRunLock(paths);
    try { return await prepareLocked(inputValue); }
    finally { await lock.release(); }
  }

  async function recover(inputValue) {
    const value = request(inputValue);
    return recoverHostRunLocks(value.project, value.runId);
  }

  async function nextAction(inputValue) {
    const value = request(inputValue, 'expectedRuntimeVersion');
    const hostPaths = await resolveFeatureRunPaths(value.project, value.runId);
    const hostLock = await acquireHostRunLock(hostPaths);
    const machine = currentMachineContext();
    const pendingClaims=[];
    let pendingTask;
    let closedClaims;
    try {
      const { run } = await runRecord(value.project, value.runId);
      if (run.status !== 'running') fail('state-conflict');
      await requireGovernance({
        project: value.project,
        run,
        gitClient,
        phase: 'plan',
      });
      const { instance, runtime, config } = await runtimeContext(value.project, run);
      if (!machine?.admissionClosed) assertMachineAdmissionOpen();
      if(machine?.admissionClosed){
        const current=await inspectFeatureRuntime(instance);
        if(current.version!==value.expectedRuntimeVersion)fail('state-conflict');
        closedClaims=(await Promise.all(Object.values(current.sessions??{}).map(session=>machine.coordinator.getClaim({
          registrationId:machine.registration.id,resource:'agentExecutions',idempotencyKey:session.id,generation:session.generation,
        })))).filter(claim=>claim?.dispatched===true && ['held','released'].includes(claim.status));
        const stopped=current.graph.nodes.filter(node=>node.status==='running').some(node=>{
          const session=current.sessions?.[node.id];
          return session && closedClaims.some(claim=>claim.idempotencyKey===session.id && claim.generation===session.generation && claim.status==='released');
        });
        if(!stopped)return immutableJson({status:'deadline',runtimeVersion:current.version,action:null});
      }
      if (machine&&!machine.admissionClosed) {
        const task = await machine.coordinator.request({
          registrationId: machine.registration.id,
          resource: 'activeTasks',
          idempotencyKey: `host-task-${run.version}`,
          generation: 1,
        });
        pendingTask = task;
        assertMachineAdmissionOpen();
        if (task.status !== 'held')
          return immutableJson({
            status: 'queued',
            reason: task.reason,
            runtimeVersion: value.expectedRuntimeVersion,
            action: null,
          });
      }
      if (!machine?.admissionClosed) assertMachineAdmissionOpen();
      const parallel = run.featurePlan.maxParallelWorkers !== undefined;
      const capacityByOwner=Object.fromEntries(config.orchestration.roles.filter(role=>run.featurePlan.nodes.some(node=>node.roleId===role.id)).map(role=>[role.id,role.capacity]));
      const childCapacityByParent=Object.fromEntries(run.featurePlan.nodes.filter(node=>run.featurePlan.nodes.some(child=>child.parentId===node.id)).map(node=>[node.id,capacityByOwner[node.roleId]]));
      const beforePreparation=await inspectFeatureRuntime(instance);
      if(parallel && Object.values(beforePreparation.sessions??{}).some(session=>session.phase==='reconciling')) {
        if(beforePreparation.version!==value.expectedRuntimeVersion)fail('state-conflict');
        return immutableJson({status:'reconciliation-pending',runtimeVersion:beforePreparation.version,action:null,
          nextAction:'Use rivet task deps if candidate dependencies are missing, then retry the exact submitted action and result in the owning harness. No replacement Worker was launched.'});
      }
      const existingIntents=new Set(Object.values(beforePreparation.launchIntents).filter(intent=>intent.status==='started').map(intent=>intent.id));
      let prepared = machine?.admissionClosed
        ? await runtime.prepareActions(instance,{expectedVersion:value.expectedRuntimeVersion,existingOnly:true})
        : parallel
        ? await runtime.prepareActions(instance,{expectedVersion:value.expectedRuntimeVersion,maxActiveNodes:run.featurePlan.maxParallelWorkers,capacityByOwner,childCapacityByParent})
        : await runtime.prepareAction(instance,{expectedVersion:value.expectedRuntimeVersion});
      const preparedActions=(prepared.actions??(prepared.action?[prepared.action]:[])).filter(item=>!machine?.admissionClosed
        || closedClaims.some(claim=>claim.idempotencyKey===item.intent.session?.id && claim.generation===item.intent.session?.generation));
      if (!machine?.admissionClosed) assertMachineAdmissionOpen();
      if (preparedActions.length === 0) {
        return immutableJson({
          status: 'idle',
          runtimeVersion: prepared.version,
          action: null,
        });
      }
      const protocolContext = run.workRequest.contextRefs.some((ref) =>
        ref.startsWith('protocol:'),
      )
        ? protocolLookupContext(
            createProtocolPresentation({
              sourceRoot: value.project,
              refs: run.workRequest.contextRefs,
            }),
          )
        : null;
      const offers=[];
      for(const preparedAction of preparedActions) {
      prepared={...prepared,action:preparedAction};
      let action = createWorkAction({
        runId: run.runId,
        runtimeVersion: prepared.version,
        nodeId: prepared.action.node.id,
        intentId: prepared.action.intent.id,
        idempotencyKey: prepared.action.intent.idempotencyKey,
        reservationId: prepared.action.intent.reservationId,
        attempt: prepared.action.intent.attempt,
        ...(prepared.action.intent.session
          ? {
              sessionId: prepared.action.intent.session.id,
              generation: prepared.action.intent.session.generation,
            }
          : {}),
        payload: buildLaunchContract(prepared.action.launch),
      });
      let newlyDispatched=false;
      if (machine) {
        if (!action.sessionId) fail('state-conflict');
        const claim = machine.admissionClosed?closedClaims.find(c=>c.idempotencyKey===action.sessionId&&c.generation===action.generation):await machine.coordinator.request({
          registrationId: machine.registration.id,
          resource: 'agentExecutions',
          retryUndispatched: true,
          idempotencyKey: action.sessionId,
          generation: action.generation,
        });
        if(!claim)fail('state-conflict');
        if(!machine.admissionClosed)pendingClaims.push(claim);
        if (!machine.admissionClosed) assertMachineAdmissionOpen();
        if (claim.status === 'released') {
          offers.push(immutableJson({
            status: 'result-required',
            runtimeVersion: prepared.version,
            action,
            nextAction:
              'The labelled writer has stopped. Submit its result; do not execute this action again.',
          }));
          continue;
        }
        if (claim.status !== 'held') {
          offers.push(immutableJson({
            status: 'queued',
            reason: claim.reason,
            runtimeVersion: prepared.version,
            action: null,
            ...(parallel?{nodeId:action.nodeId}:{}),
          }));
          continue;
        }
        if (!claim.dispatched) {
          const admitted = await runtime.sessionOperation(instance, {
            expectedVersion: prepared.version,
            nodeId: action.nodeId,
            identity: {id: action.sessionId, generation: action.generation},
            operation: 'admit',
          });
          prepared = {...prepared, version: admitted.version};
          action = createWorkAction({...action, runtimeVersion: admitted.version});
          assertMachineAdmissionOpen();
          await machine.coordinator.dispatch({
            signal: machine.signal,
            deadlineMs: machine.deadlineMs,
            claimId: claim.id,
            generation: action.generation,
          });
          newlyDispatched = true;
        }
      }
      const wasAlreadyStarted =
        machine?!newlyDispatched:parallel?existingIntents.has(action.intentId):value.expectedRuntimeVersion === prepared.version;
      const observed = await inspectFeatureRuntime(instance);
      const session = observed.sessions?.[prepared.action.node.id];
      const turnover = session
        ? turnoverReason(session, featureNowMilliseconds(now))
        : null;
      offers.push(immutableJson({
        status: turnover
          ? 'checkpoint-required'
          : wasAlreadyStarted
            ? 'waiting-for-result'
            : 'action',
        ...(turnover
          ? {
              turnoverReason: turnover,
              nextAction:
                'Request a cooperative checkpoint from the existing writer. Do not launch another writer.',
            }
          : {}),
        ...(protocolContext ? { protocolContext } : {}),
        runtimeVersion: prepared.version,
        action,
      }));
      }
      if(!parallel)return offers[0];
      return immutableJson({status:'actions',runtimeVersion:prepared.version,actions:offers});
    } catch (error) {
      for(const pendingClaim of pendingClaims.filter(claim=>!claim.dispatched)) {
        // The coordinator refuses release if another invocation dispatched it.
        await machine.coordinator.release({
          claimId: pendingClaim.id,
          generation: pendingClaim.generation,
          completed: true,
        }).catch(() => {});
      }
      if (pendingTask) {
        await machine.coordinator.release({
          claimId: pendingTask.id,
          generation: pendingTask.generation,
          completed: true,
        }).catch(() => {});
      }
      throw error;
    } finally {
      await hostLock.release();
    }
  }

  async function submitResult(inputValue) {
    const value = capture(inputValue, new Set([
      'project', 'runId', 'expectedRuntimeVersion', 'action', 'result',
    ]));
    request({
      project: value.project,
      runId: value.runId,
      expectedRuntimeVersion: value.expectedRuntimeVersion,
    }, 'expectedRuntimeVersion');
    value.result=captureRuntimeResult(value.result);
    const action = validateWorkAction(value.action);
    if (action.runId !== value.runId || action.runtimeVersion !== value.expectedRuntimeVersion) fail('state-conflict');
    const hostPaths = await resolveFeatureRunPaths(value.project, value.runId);
    const hostLock = await acquireHostRunLock(hostPaths);
    try {
      const { store, run } = await runRecord(value.project, value.runId);
      if (run.status !== 'running') fail('state-conflict');
      const { instance, runtime, planNodes, integration } = await runtimeContext(value.project, run);
      const state = await inspectFeatureRuntime(instance);
      const parallel=run.featurePlan.maxParallelWorkers !== undefined;
      if (parallel?value.expectedRuntimeVersion>state.version:state.version!==value.expectedRuntimeVersion) fail('state-conflict');
      const node = state.graph.nodes.find(item => item.id === action.nodeId && item.status === 'running');
      const intent = state.launchIntents[action.nodeId];
      const planNode = planNodes.get(action.nodeId);
      if (!node || intent?.status !== 'started' || !planNode) fail('state-conflict');
      const expectedAction = createWorkAction({
        runId: run.runId,
        runtimeVersion: parallel?action.runtimeVersion:state.version,
        nodeId: node.id,
        intentId: intent.id,
        idempotencyKey: intent.idempotencyKey,
        reservationId: intent.reservationId,
        attempt: intent.attempt,
        ...(intent.session ? {sessionId:intent.session.id,generation:intent.session.generation} : {}),
        payload: buildLaunchContract(createFeatureLaunchInput(node, intent, planNode, run)),
      });
      if (JSON.stringify(action) !== JSON.stringify(expectedAction)) fail('state-conflict');
      const machine=currentMachineContext();
      if(machine){const claim=await machine.coordinator.getClaim({registrationId:machine.registration.id,resource:'agentExecutions',idempotencyKey:action.sessionId,generation:action.generation});if(!claim||claim.status!=='released')fail('state-conflict');}
      if(parallel && value.result?.status==='success') {
        const statePaths=await resolveStatePaths(value.project,run.runId);
        const reservations=await createReservationStore(statePaths).list();
        const matches=reservations.reservations.filter(item=>item.nodeId===node.id && item.ownerId===node.owner.id && item.status==='active');
        if(matches.length!==1)fail('state-conflict');
        const pin=await hostReconciliationStore(statePaths,node.id);
        const existing=await pin.read();
        const session=intent.session?requireSession(state,node.id,intent.session,['active','reconciling']):null;
        if(session?.writer && session.stopReceipt?.status!=='stopped')fail('state-conflict');
        if(session?.phase==='reconciling' && !existing)fail('state-conflict');
        if(!existing) await finalizeFeatureWorkerCommit({gitClient,projectRoot:integration.path,statePaths,node,
          planNode,leaseId:matches[0].leaseId,nowMs:featureNowMilliseconds(now)});
        const verified=await verifyReservedWorktree({projectRoot:integration.path,statePaths,nodeId:node.id,
          ownerId:node.owner.id,leaseId:matches[0].leaseId},{gitClient,nowMs:featureNowMilliseconds(now)});
        if(verified.worker.dirty)fail('state-conflict');
        await pin.pin({action,result:value.result,worker:verified.worker,reservation:verified.reservation});
      } else if(parallel && state.sessions?.[node.id]?.phase==='reconciling') fail('state-conflict');
      const submitted = await runtime.submitAction(instance, {
        expectedVersion: state.version,
        ...(parallel?{retryReconciliation:true}:{}),
        nodeId: action.nodeId,
        intentId: action.intentId,
        idempotencyKey: action.idempotencyKey,
        reservationId: action.reservationId,
        result: value.result,
        ...(action.sessionId ? {sessionId:action.sessionId,generation:action.generation} : {}),
      });
      if (!parallel && submitted.nodeStatus === 'completed' && submitted.report?.status === 'integrated') {
        const integrated = await gitClient.inspectRepository(integration.path);
        if (integrated.dirty || integrated.branch !== integration.branch
          || integrated.headSha !== submitted.report.integrationTip) fail('repository');
        const accepted = createAcceptedIntegrationStore(await acceptedIntegrationPaths(hostPaths));
        await accepted.write({
          schemaVersion: 1,
          runId: run.runId,
          baselineCommit: run.featurePlan.baselineCommit,
          commitSha: submitted.report.integrationTip,
          runtimeVersion: submitted.version,
          path: integration.path,
          branch: integration.branch,
        });
      }
      if (submitted.nodeStatus === 'blocked' || ['blocked', 'failed', 'budget-exhausted'].includes(submitted.terminal)) {
        await store.update({
          status: 'blocked',
          updatedAt: now(),
          runtimeRefs: run.runtimeRefs,
          evidenceRefs: run.evidenceRefs,
        }, { expectedVersion: run.version });
      }
      return immutableJson({
        status: submitted.nodeStatus === 'completed' ? 'accepted' : 'blocked',
        runtimeVersion: submitted.version,
        nodeId: submitted.nodeId,
        nodeStatus: submitted.nodeStatus,
        terminal: submitted.terminal,
        reconciliation: submitted.report,
      });
    } finally { await hostLock.release(); }
  }

  async function checkpoint(inputValue) {
    const value=capture(inputValue,new Set(['project','runId','expectedRuntimeVersion','action','input']));
    request(valueWithoutExtras(value),'expectedRuntimeVersion');
    const action=validateWorkAction(value.action);
    const paths=await resolveFeatureRunPaths(value.project,value.runId);const lock=await acquireHostRunLock(paths);
    try {
      const {run}=await runRecord(value.project,value.runId);
      if(run.status!=='running'||action.runId!==run.runId||action.runtimeVersion>value.expectedRuntimeVersion)fail('state-conflict');
      await requireGovernance({project:value.project,run,gitClient,phase:'plan'});
      const {instance,runtime}=await runtimeContext(value.project,run);
      let state=await inspectFeatureRuntime(instance);
      if(state.version!==value.expectedRuntimeVersion)fail('state-conflict');
      const session=requireSession(state,action.nodeId,{id:action.sessionId,generation:action.generation},['active','checkpoint-requested']);
      const intent=state.launchIntents[action.nodeId];const node=state.graph.nodes.find(n=>n.id===action.nodeId);
      if(action.intentId!==intent.id||action.reservationId!==intent.reservationId)fail('state-conflict');
      const content=capture(value.input,new Set(['summary','usage','nativeHandle','actorId','observedAtMs']),new Set(['summary','usage','nativeHandle','actorId','observedAtMs']));
      const machine = currentMachineContext();
      if (machine) {
        const claim = await machine.coordinator.getClaim({registrationId:machine.registration.id,resource:'agentExecutions',idempotencyKey:session.id,generation:session.generation});
        if (!claim || claim.status !== 'held') fail('state-conflict');
      }
      // Persist the fence before reading dirty work. Recovery can repeat observation.
      state=await runtime.sessionOperation(instance,{expectedVersion:state.version,nodeId:node.id,identity:session,operation:'request'});
      const captured=await captureCheckpoint({gitClient,run,node,intent,session,...content,nowMs:featureNowMilliseconds(now)});
      state=await runtime.sessionOperation(instance,{expectedVersion:state.version,nodeId:node.id,identity:session,operation:'checkpoint',checkpoint:captured,writer:{nativeHandle:content.nativeHandle,actorId:content.actorId,observedAtMs:content.observedAtMs,source:'host-observation',assurance:'host-reported'}});
      return immutableJson({status:'checkpoint-ready',runtimeVersion:state.version,sessionId:session.id,generation:session.generation,checkpointDigest:captured.digest,nextAction:'Fence the current writer with handoff operation fence.'});
    } finally {await lock.release();}
  }
  function valueWithoutExtras(value) {return {project:value.project,runId:value.runId,expectedRuntimeVersion:value.expectedRuntimeVersion};}
  async function handoff(inputValue) {
    const value = capture(
      inputValue,
      new Set(['project', 'runId', 'expectedRuntimeVersion', 'input']),
    );
    request(valueWithoutExtras(value), 'expectedRuntimeVersion');
    const operation = capture(
      value.input,
      new Set(['operation', 'receipt', 'sessionId', 'generation']),
      new Set(['operation']),
    );
    if (
      !['fence', 'stop', 'transfer', 'observe', 'release'].includes(
        operation.operation,
      )
    )
      fail('invalid-input');
    const paths = await resolveFeatureRunPaths(value.project, value.runId);
    const lock = await acquireHostRunLock(paths);
    try {
      const { run } = await runRecord(value.project, value.runId);
      if (run.status !== 'running') fail('state-conflict');
      await requireGovernance({
        project: value.project,
        run,
        gitClient,
        phase: 'plan',
      });
      const { instance, runtime } = await runtimeContext(value.project, run);
      const current = await inspectFeatureRuntime(instance);
      if (current.version !== value.expectedRuntimeVersion)
        fail('state-conflict');
      if((operation.sessionId===undefined)!==(operation.generation===undefined))fail('invalid-input');
      if(operation.sessionId!==undefined && (typeof operation.sessionId!=='string'||!Number.isSafeInteger(operation.generation)||operation.generation<1))fail('invalid-input');
      if(operation.sessionId!==undefined && operation.receipt
        && (operation.receipt.sessionId!==operation.sessionId||operation.receipt.generation!==operation.generation))fail('state-conflict');
      const selectedSession=operation.sessionId??operation.receipt?.sessionId;
      const selectedGeneration=operation.generation??operation.receipt?.generation;
      const sessions = Object.values(current.sessions ?? {}).filter((s) =>
        (selectedSession===undefined || (s.id===selectedSession&&s.generation===selectedGeneration)) &&
        (['observe', 'release'].includes(operation.operation)
          ? ['active']
          : ['checkpoint-ready', 'stopping', 'stopped']
        ).includes(s.phase),
      );
      if (sessions.length !== 1) fail('state-conflict');
      const session = sessions[0];
      if (operation.operation === 'release') {
        const machine = currentMachineContext();
        if (!machine) fail('state-conflict');
        const receipt = validatedStopReceipt(operation.receipt, session);
        if (receipt.status !== 'stopped') fail('state-conflict');
        const claim = await machine.coordinator.getClaim({registrationId:machine.registration.id,resource:'agentExecutions',idempotencyKey:session.id,generation:session.generation});
        if (!claim) fail('state-conflict');
        if (claim.status === 'released') {
          if (!isDeepStrictEqual(immutableJson(claim.execution), receipt)) fail('state-conflict');
        } else await machine.coordinator.hostStop({
          claimId: claim.id,
          generation: session.generation,
          receipt,
          sessionId: session.id,
        });
        // Machine persistence comes first. An exact retry repairs an interrupted
        // runtime write without stopping or dispatching the writer a second time.
        const released = await runtime.sessionOperation(instance, {
          expectedVersion: current.version, nodeId: session.nodeId,
          identity: session, operation: 'release', receipt,
        });
        return immutableJson({
          status: 'resource-released',
          runtimeVersion: released.version,
          sessionId: session.id,
          generation: session.generation,
        });
      }
      if (operation.operation === 'observe') {
        const machine = currentMachineContext();
        if (machine) {
          const claim = await machine.coordinator.getClaim({registrationId:machine.registration.id,resource:'agentExecutions',idempotencyKey:session.id,generation:session.generation});
          if (!claim || claim.status !== 'held') fail('state-conflict');
        }
      }
      if (operation.operation === 'transfer')
        await verifyCheckpoint(
          gitClient,
          session.checkpoint,
          run,
          featureNowMilliseconds(now),
        );
      const state = await runtime.sessionOperation(instance, {
        expectedVersion: current.version,
        nodeId: session.nodeId,
        identity: session,
        ...operation,
      });
      const updated = state.sessions[session.nodeId];
      if (
        operation.operation === 'stop' &&
        updated.stopReceipt?.status === 'stopped'
      ) {
        const machine = currentMachineContext();
        if (machine) {
          const claim = await machine.coordinator.getClaim({registrationId:machine.registration.id,resource:'agentExecutions',idempotencyKey:session.id,generation:session.generation});
          if (claim)
            await machine.coordinator.hostStop({
              claimId: claim.id,
              generation: session.generation,
              receipt: updated.stopReceipt,
              sessionId: session.id,
            });
        }
      }

      return immutableJson({
        status:
          turnoverReason(updated, featureNowMilliseconds(now)) &&
          updated.phase === 'active'
            ? 'checkpoint-required'
            : updated.phase,
        turnoverReason: turnoverReason(updated, featureNowMilliseconds(now)),
        runtimeVersion: state.version,
        sessionId: updated.id,
        generation: updated.generation,
        nextAction:
          updated.phase === 'active' &&
          turnoverReason(updated, featureNowMilliseconds(now))
            ? 'Request a cooperative checkpoint from the owning host, then submit work checkpoint.'
            : updated.phase === 'stopping'
              ? 'Stop the exact native writer with its owning harness and submit the labelled stop receipt. Unknown ownership retains the checkout.'
              : updated.phase === 'stopped'
                ? 'Use handoff operation transfer to revalidate and transfer the checkout.'
                : 'Use work next for the fresh successor action; do not resume the old writer.',
      });
    } finally {
      await lock.release();
    }
  }

  async function verify(inputValue) {
    const value = capture(inputValue, new Set([
      'project', 'runId', 'expectedRunVersion', 'expectedRuntimeVersion',
    ]));
    request({
      project: value.project,
      runId: value.runId,
      expectedRunVersion: value.expectedRunVersion,
    }, 'expectedRunVersion');
    if (!Number.isSafeInteger(value.expectedRuntimeVersion) || value.expectedRuntimeVersion < 1) fail('invalid-input');
    if (typeof resolveCommandExecutable !== 'function') fail('state-conflict');
    const hostPaths = await resolveFeatureRunPaths(value.project, value.runId);
    const hostLock = await acquireHostRunLock(hostPaths);
    try {
      const { paths, store, run } = await runRecord(value.project, value.runId);
      if (run.status !== 'running' || run.version !== value.expectedRunVersion) fail('state-conflict');
      const { instance, integration, config } = await runtimeContext(value.project, run);
      const state = await inspectFeatureRuntime(instance);
      if (state.version !== value.expectedRuntimeVersion) fail('state-conflict');
      const accepted = await createAcceptedIntegrationStore(await acceptedIntegrationPaths(paths)).readOnly();
      if (accepted === null || accepted.runId !== run.runId
        || accepted.baselineCommit !== run.featurePlan.baselineCommit
        || accepted.runtimeVersion > state.version
        || accepted.path !== integration.path || accepted.branch !== integration.branch) fail('repository');
      const finalNode = state.graph.nodes.find(node => node.approvalGate === 'final-delivery');
      const nonHumanComplete = state.graph.nodes.filter(node => !node.approvalGate)
        .every(node => ['completed', 'archived'].includes(node.status));
      if (!nonHumanComplete || finalNode?.status !== 'ready') fail('state-conflict');
      const integrated = await gitClient.inspectRepository(integration.path);
      if (integrated.dirty || integrated.branch !== integration.branch
        || integrated.headSha !== accepted.commitSha
        || integrated.headSha === run.featurePlan.baselineCommit
        || !(await gitClient.isAncestor(integration.path, run.featurePlan.baselineCommit, integrated.headSha))) {
        fail('repository');
      }
      const changedPaths = await gitClient.changedPaths(integration.path, run.featurePlan.baselineCommit, integrated.headSha);
      if (changedPaths.length === 0) fail('repository');
      const reports = createVerificationReportStore(await verificationReportPaths(paths));
      let quality;
      let failure;
      try {
        quality = await runQualityGates({
          ...configuredVerificationReuse(config),
          projectRoot: integration.path,
          commitSha: integrated.headSha,
          authority: featureQualityAuthority(config),
          gates: await configuredFeatureGates(config, resolveCommandExecutable, integration.path),
          environment,
        }, { gitClient, now: () => featureNowMilliseconds(now) });
        if(quality.status==='pass') await requireGovernance({project:value.project,run,gitClient,config,phase:'final',checkout:{path:integration.path,branch:integration.branch,commitSha:integrated.headSha}});
      } catch (error) {
        if(error?.queued)return immutableJson({status:'queued',reason:error.claim?.reason??error.reason,runtimeVersion:value.expectedRuntimeVersion});
        failure = typeof error?.safeMessage === 'string' ? error.safeMessage : 'Verification could not complete safely.';
      }
      const afterChecks = await gitClient.inspectRepository(integration.path);
      if (afterChecks.dirty || afterChecks.branch !== integration.branch
        || afterChecks.headSha !== accepted.commitSha) fail('repository');
      const currentRun = await store.readOnly();
      if (currentRun?.status !== 'running' || currentRun.version !== run.version) fail('state-conflict');
      await reports.write(verificationReport({
        run, state, integration, commitSha: integrated.headSha, changedPaths,
        quality, failure, checkedAt: now(),
      }));
      if (failure || quality?.status !== 'pass') fail('verification-failed');
      const beforeFinal = await gitClient.inspectRepository(integration.path);
      if (beforeFinal.dirty || beforeFinal.branch !== integration.branch
        || beforeFinal.headSha !== accepted.commitSha) fail('repository');
      return await store.update({
        status: 'awaiting-final-approval',
        updatedAt: now(),
        runtimeRefs: [...new Set([...run.runtimeRefs, `worktree:${run.runId}`])],
        evidenceRefs: [...new Set([
          ...run.evidenceRefs,
          `commit:${integrated.headSha}`,
          ...quality.gates.map(gate => `test:${gate.id}`),
          ...state.evidence.map(item => `evidence:${item.id}`),
        ])],
      }, { expectedVersion: run.version });
    } finally { await hostLock.release(); }
  }

  async function workerCheckoutStatus(project, run, statePaths, snapshot) {
    if (statePaths === null) return [];
    const { reservations } = await createReservationStore(statePaths).readOnly();
    if (reservations.length === 0) return [];
    if (reservations.length > 64 || new Set(reservations.map(item => item.nodeId)).size !== reservations.length) fail('state-conflict');
    if (snapshot === null) fail('state-conflict');
    const repository = await gitClient.inspectRepository(project);
    if (repository.root !== project || repository.gitCommonDir !== statePaths.gitCommonDir) fail('state-conflict');
    const parent = join(dirname(project), '.rivet-worktrees', repository.repositoryId, basename(statePaths.instanceDir), 'workers');
    // Validate every association before inspecting any reservation-selected checkout.
    const associated = reservations.map(reservation => {
      const node = snapshot.data.graph.nodes.find(item => item.id === reservation.nodeId);
      const planned = run.featurePlan.nodes.find(item => item.id === reservation.nodeId);
      if (!node || planned?.role !== 'worker' || node.owner.role !== 'worker'
        || node.owner.id !== reservation.ownerId || reservation.repositoryId !== repository.repositoryId
        || reservation.branch !== `worker/${run.runId}/${node.id}`
        || reservation.worktreePath !== join(parent, node.id)) fail('state-conflict');
      return { reservation, node };
    });
    let topology = null;
    try { topology = await gitClient.listWorktrees(project); } catch {}
    const nowMs = featureNowMilliseconds(now);
    const results = [];
    for (const { reservation, node } of associated) {
      const registered = topology?.filter(item => item.path === reservation.worktreePath) ?? [];
      const branchLocations = topology?.filter(item => item.branch === reservation.branch && item.path !== reservation.worktreePath)
        .map(item => item.path) ?? [];
      let status = 'unavailable';
      let observed = null;
      if (topology !== null) {
        let exists = false;
        try { const metadata = await lstat(reservation.worktreePath); exists = metadata.isDirectory() && !metadata.isSymbolicLink()
          && await realpath(reservation.worktreePath) === reservation.worktreePath; }
        catch (error) { if (error.code === 'ENOENT') status = 'missing'; }
        if (exists) {
          if (registered.length !== 1 || registered[0].branch !== reservation.branch) status = 'mismatched';
          else {
            try {
              const candidate = await gitClient.inspectRepository(reservation.worktreePath);
              if (candidate.root !== reservation.worktreePath || candidate.repositoryId !== repository.repositoryId
                || candidate.gitCommonDir !== repository.gitCommonDir || candidate.branch !== reservation.branch) status = 'mismatched';
              else { observed = candidate; status = candidate.dirty ? 'dirty' : 'clean'; }
            } catch {}
          }
        }
      }
      if ((observed?.dirtyPaths.length ?? 0) > 256 || branchLocations.length > 64) fail('state-conflict');
      const leaseExpired = Date.parse(reservation.expiresAt) <= nowMs;
      const nextAction = status === 'missing' && ['completed', 'archived'].includes(node.status)
        ? 'Worker checkout is absent; inspect cleanup history if needed. Do not restart this completed Worker.'
        : status === 'dirty'
        ? 'Inspect and preserve the Worker edits in the owning harness before continuing. Status does not commit or discard them.'
        : status !== 'clean'
          ? 'Inspect the registered Worker checkout and branch locations before recovery. Do not launch a duplicate Worker.'
          : ['completed', 'archived'].includes(node.status)
            ? 'Review the completed Worker evidence and integration checkout; do not restart this Worker.'
          : leaseExpired
            ? 'Inspect the expired Worker lease and reconcile it explicitly before continuing. Status does not renew leases.'
            : reservation.status === 'reserved'
              ? 'Inspect the interrupted checkout preparation before continuing in the owning harness.'
              : 'Continue the pending Worker action in the owning harness; a clean checkout alone is not completion evidence.';
      results.push({ nodeId: node.id, nodeStatus: node.status, path: reservation.worktreePath,
        expectedBranch: reservation.branch, observedBranch: observed?.branch ?? registered[0]?.branch ?? null,
        reservationStatus: reservation.status, leaseExpired, status, headCommit: observed?.headSha ?? null,
        dirtyPaths: observed?.dirtyPaths ?? [], branchLocations, nextAction });
    }
    if (Buffer.byteLength(JSON.stringify(results)) > 32 * 1024) fail('state-conflict');
    return results;
  }

  async function status(inputValue) {
    const value = request(inputValue);
    const paths = await resolveExistingFeatureRunPaths(value.project, value.runId);
    if (paths === null) fail('run-missing');
    const run = await createFeatureRunStore(paths).readOnly();
    if (run === null) fail('run-missing');
    const reports = createVerificationReportStore(await verificationReportPaths(paths));
    const verification = await reports.readOnly();
    if (verification !== null && (verification.runId !== run.runId
      || verification.baselineCommit !== run.featurePlan.baselineCommit)) fail('state-conflict');
    const accepted = await createAcceptedIntegrationStore(await acceptedIntegrationPaths(paths)).readOnly();
    if (accepted !== null && (accepted.runId !== run.runId
      || accepted.baselineCommit !== run.featurePlan.baselineCommit)) fail('state-conflict');
    let checkout = null;
    if (accepted !== null) {
      let observed = null;
      try {
        const worktrees = await gitClient.listWorktrees(value.project);
        const registered = worktrees.filter(item => item.path === accepted.path && item.branch === accepted.branch);
        if (registered.length === 1) observed = await gitClient.inspectRepository(accepted.path);
      } catch {}
      checkout = {
        status: observed !== null && observed.branch === accepted.branch
          && observed.headSha === accepted.commitSha && !observed.dirty ? 'clean' : 'stale',
        path: accepted.path,
        branch: accepted.branch,
        acceptedCommit: accepted.commitSha,
        observedCommit: observed?.headSha ?? null,
        dirty: observed?.dirty ?? null,
      };
    }
    const statePaths = await resolveExistingStatePaths(value.project, value.runId);
    const snapshot = statePaths === null ? null : await readSnapshotWithoutLock(statePaths);
    if(snapshot!==null)validateRuntimeSnapshot(snapshot.data,run.runId);
    const runtime = snapshot === null ? null : runtimeSummary(snapshot.data);
    const workerCheckouts = await workerCheckoutStatus(value.project, run, statePaths, snapshot);
    const dependencyTargets=[];
    const candidateCheckouts=[];
    if(run.status==='running' && run.featurePlan.maxParallelWorkers!==undefined && statePaths) {
      for(const worker of workerCheckouts.filter(item=>item.nodeStatus==='running' && !item.leaseExpired && item.reservationStatus==='active')) {
        const session=snapshot.data.sessions?.[worker.nodeId];
        if(worker.status==='clean' && (!session || session.phase==='active')) dependencyTargets.push({path:worker.path,commit:worker.headCommit,branch:worker.expectedBranch,kind:'worker'});
        if(session?.phase==='reconciling' && (!session.writer || session.stopReceipt?.status==='stopped')) {
          const record=await (await hostReconciliationStore(statePaths,worker.nodeId)).read();
          if(record?.candidate) {
            let candidateStatus='unavailable';
            if(worker.status==='clean' && record.identity.sourceSha===worker.headCommit && record.identity.sourcePath===worker.path) {
              try {
                const candidate=await gitClient.inspectRepository(record.candidate.path);
                const topology=await gitClient.listWorktrees(value.project);
                candidateStatus=!candidate.dirty && candidate.headSha===record.candidate.commit && candidate.branch===record.candidate.branch
                  && candidate.gitCommonDir===statePaths.gitCommonDir && candidate.root===record.candidate.path
                  && topology.filter(item=>item.path===candidate.root && item.branch===candidate.branch).length===1 ? 'ready' : 'changed';
              } catch { /* Missing checkout or unavailable Git topology remains diagnostic state. */ }
            }
            candidateCheckouts.push({...record.candidate,nodeId:worker.nodeId,status:candidateStatus});
            if(candidateStatus==='ready')dependencyTargets.push(record.candidate);
          }
        }
      }
    }
    const blockedNodes = run.status === 'blocked'
      ? (runtime?.nodes ?? []).filter(node => ['blocked', 'failed'].includes(node.status)).map(node => node.id)
      : [];
    const readyForVerification = (runtime?.nodes ?? [])
      .some(node => node.id === 'final-delivery' && node.status === 'ready')
      && run.featurePlan.nodes.filter(node => !node.approvalGate).every(node =>
        runtime.nodes.some(current => current.id === node.id && ['completed', 'archived'].includes(current.status)));
    const hostRun = run.featurePlan.client === 'host';
    const verificationStale = verification !== null && accepted !== null
      && (verification.commitSha !== accepted.commitSha || checkout?.status !== 'clean');
    const protocols = selectedProtocolStatus(value.project, run.workRequest.contextRefs);
    let governance;
    try { governance = await inspectGovernance({project:value.project,run,gitClient,phase:readyForVerification?'final':'plan'}); }
    catch (error) { governance = {ready:false,decisions:[],review:{humanEscalation:false},blockers:[{code:'governance-unavailable'}],nextAction:error.safeMessage ?? 'Decision or review evidence could not be read safely. Inspect private task state before continuing.'}; }
    const deliverable = governance.ready && protocols.status === 'current' && run.status === 'awaiting-final-approval'
      && runtime !== null && readyForVerification
      && accepted !== null && checkout?.status === 'clean'
      && verification?.status === 'pass'
      && verification.runVersion === run.version - 1
      && verification.runtimeVersion === runtime.version
      && verification.commitSha === accepted.commitSha
      && verification.integration.path === accepted.path
      && verification.integration.branch === accepted.branch;
    const pendingSession=Object.values(snapshot?.data.sessions??{}).find(s=>!['active','completed'].includes(s.phase));
    const blockedCandidate=candidateCheckouts.find(candidate=>candidate.status!=='ready');
    const nextAction = blockedCandidate ? `The pending candidate checkout is ${blockedCandidate.status}. Inspect and restore its recorded path, branch and commit before dependency setup or exact result retry. No replacement checkout will be created automatically.` : pendingSession ? `Session ${pendingSession.id} is ${pendingSession.phase}. ${pendingSession.phase==='checkpoint-requested'?'Repeat checkpoint with the same session action and the current runtime version.':pendingSession.phase==='reconciling'?'Use rivet task deps if candidate dependencies are missing, then retry the exact submitted action and result in the owning harness. The recorded source must be unchanged.':pendingSession.phase==='blocked'?'Inspect checkpoint, usage and stopped-writer proof; no automatic replacement is permitted.':'Continue the recorded handoff phase with the owning native harness; unknown writer retains ownership.'}` : protocols.status === 'changed' ? protocols.message : checkout?.status === 'stale' || verificationStale
      ? 'The integration checkout no longer matches the accepted tested commit. Do not deliver it; create a new reviewed proposal for source changes.'
      : !governance.ready ? governance.nextAction
      : run.status === 'awaiting-final-approval' && !deliverable
      ? 'Final approval evidence is missing or inconsistent. Do not deliver this run; inspect private state and create a new reviewed proposal if it cannot be restored.'
      : deliverable
      ? 'Review the integration diff and executed checks, then make the separate final delivery decision.'
      : run.status === 'blocked'
        ? hostRun
          ? 'Inspect the blocked nodes and last submission response. Source correction requires a new reviewed proposal.'
          : verification?.status === 'fail'
            ? 'For missing locked dependencies, run rivet task deps and approve the shown install, then use rivet task resume. Source changes require a new reviewed proposal.'
            : 'Inspect the blocked spawned run. Use rivet task resume only after its cause is corrected.'
        : readyForVerification && accepted === null
          ? 'Accepted integration identity is missing. Do not verify this run; create a new reviewed proposal.'
        : verification?.status === 'fail' && hostRun
          ? verification.nextAction
          : run.status === 'running' && runtime !== null
            ? hostRun
              ? 'Use work next with runtime.version to continue or recover the pending action.'
              : 'A spawned run is marked running. Inspect its process and private state before recovery; do not launch a duplicate worker.'
            : run.status === 'approved'
              ? hostRun
                ? 'Use work prepare with run.version to create the isolated execution state.'
                : 'Use rivet task resume to continue the approved spawned task.'
              : 'Review the proposal and current run state before proceeding.';
    return immutableJson({ run, runtime, ...(snapshot?.data.sessions ? {sessions:Object.values(snapshot.data.sessions).map(s=>({id:s.id,nodeId:s.nodeId,generation:s.generation,phase:s.phase,predecessor:s.predecessor,checkpointDigest:s.checkpoint?.digest??null,stopStatus:s.stopReceipt?.status??'unknown',telemetry:s.telemetry,turnoverReason:turnoverReason(s,featureNowMilliseconds(now))}))} : {}), protocols, governance, verification, checkout, workerCheckouts, dependencyTargets, candidateCheckouts, deliveryReady: deliverable, blockedNodes, nextAction });
  }

  return Object.freeze({ checkpoint, handoff, prepare, nextAction, submitResult, verify, status, recover });
}
