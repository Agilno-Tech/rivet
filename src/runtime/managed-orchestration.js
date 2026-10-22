import { setTimeout as delay } from 'node:timers/promises';
import { createResourceCoordinator } from './resource-coordinator.js';
import { loadProjectConfig } from '../config/load.js';
export function createManagedOrchestration({
  root,
  gitClient,
  workflow,
  work,
  now = Date.now,
}) {
  const coordinator = createResourceCoordinator({
    root,
    now,
  });
  async function register(input) {
    const git = await gitClient();
    const repo = await git.inspectRepository(input.projectRoot);
    if (repo.root !== input.projectRoot)
      throw new Error('Register the canonical repository root.');
    const config = await loadProjectConfig(repo.root);
    if (input.runId)
      await workflow.status({
        project: repo.root,
        runId: input.runId,
      });
    const approved = config.orchestration.executionPolicy?.limits ?? {};
    const scoped = { ...approved };
    for (const [key, value] of Object.entries(input.limits ?? {}))
      scoped[key] = Math.min(value, approved[key] ?? 64);
    return coordinator.register({ ...input, limits: scoped });
  }
  async function status(id) {
    const state = await coordinator.inspect();
    if (!id) return state;
    const registration = await coordinator.getRegistration({ registrationId: id });
    if (!registration) throw new Error('Unknown orchestration registration.');
    let task = null;
    if (registration.runId)
      task = await workflow.status({
        project: registration.projectRoot,
        runId: registration.runId,
      });
    const execution =
      registration.runId && work?.status
        ? await work.status({
            project: registration.projectRoot,
            runId: registration.runId,
          })
        : null;
    return {
      registration,
      task,
      execution,
      claims: state.claims.filter((c) => c.registrationId === id),
      limits: state.limits,
    };
  }
  async function watch(
    id,
    { deadlineMs, maxTicks = 1, intervalMs = 1000, signal } = {},
  ) {
    if (
      !Number.isSafeInteger(deadlineMs) ||
      !Number.isSafeInteger(maxTicks) ||
      maxTicks < 1 ||
      maxTicks > 10000 ||
      !Number.isSafeInteger(intervalMs) ||
      intervalMs < 1 ||
      intervalMs > 60000
    )
      throw new Error('A bounded watch requires deadline, ticks and interval.');
    const view = await status(id);
    const r = view.registration;
    if (!r.runId)
      throw new Error('Watch requires an explicit run registration.');
    const deadline = Math.min(deadlineMs, r.deadlineMs);
    const controller = new AbortController();
    const abort = () => controller.abort();
    const cutoff = () => controller.signal.aborted || now() >= deadline;
    const stopped = (ticks) => ({
      terminal: now() >= deadline ? 'deadline' : 'cancelled',
      ticks,
    });
    signal?.addEventListener('abort', abort, {
      once: true,
    });
    if (signal?.aborted) abort();
    let timer;
    try {
      if (deadline <= now())
        return {
          terminal: 'deadline',
          ticks: 0,
        };
      timer = setTimeout(abort, Math.min(deadline - now(), 2147483647));
      for (let ticks = 1; ticks <= maxTicks; ticks++) {
        const current = await status(id);
        if (current.registration.paused)
          return {
            terminal: 'paused',
            ticks: ticks - 1,
          };
        if (cutoff())
          return {
            terminal: now() >= deadline ? 'deadline' : 'cancelled',
            ticks: ticks - 1,
          };
        const task = current.task;
        if (['proposed', 'awaiting-final-approval'].includes(task.status))
          return {
            terminal: 'decision-required',
            ticks,
            task,
          };
        if (['completed', 'cancelled'].includes(task.status))
          return {
            terminal: task.status,
            ticks,
            task,
          };
        if (task.featurePlan?.client === 'host') {
          try {
            let version = current.execution?.runtime?.version;
            if (task.status === 'approved')
              version = (
                await work.prepare(
                  {
                    project: r.projectRoot,
                    runId: r.runId,
                    expectedRunVersion: task.version,
                  },
                  { signal: controller.signal, deadlineMs: deadline },
                )
              ).runtimeVersion;
            if (cutoff()) return stopped(ticks);
            if (!Number.isSafeInteger(version))
              return { terminal: 'decision-required', ticks, task };
            const action = await work.nextAction(
              {
                project: r.projectRoot,
                runId: r.runId,
                expectedRuntimeVersion: version,
              },
              { signal: controller.signal, deadlineMs: deadline },
            );
            if (cutoff()) return stopped(ticks);
            if (action.status === 'queued' && ticks < maxTicks) {
              await delay(
                Math.min(intervalMs, Math.max(1, deadline - now())),
                undefined,
                { signal: controller.signal },
              );
              continue;
            }
            return {
              terminal: action.status === 'queued' ? 'queued' : 'host-action',
              ticks,
              action,
            };
          } catch (error) {
            if (cutoff()) return stopped(ticks);
            throw error;
          }
        }
        if (!['approved', 'blocked'].includes(task.status))
          return {
            terminal: 'ownership-unknown',
            ticks,
            task,
          };
        try {
          const result = await workflow.resume(
            {
              project: r.projectRoot,
              runId: r.runId,
              expectedVersion: task.version,
            },
            {
              signal: controller.signal,
            },
          );
          return {
            terminal: result.status,
            ticks,
            task: result,
          };
        } catch (error) {
          if (cutoff())
            return {
              terminal: now() >= deadline ? 'deadline' : 'cancelled',
              ticks,
            };
          throw error;
        }
      }
      return {
        terminal: 'max-ticks',
        ticks: maxTicks,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  return Object.freeze({
    coordinator,
    register,
    status,
    watch,
    pause: coordinator.pause,
    resume: coordinator.resume,
    limits: coordinator.configure,
    renew: coordinator.renew,
  });
}
