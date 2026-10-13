import {withTerminalInterruption} from '../cli/interrupt.js';
import {resolve} from 'node:path';
import { watchOrchestration } from '../runtime/supervisor.js';
import { CliError, EXIT_CODES } from '../cli/output.js';

export async function orchestrateRun(runtime, instance, options) { return runtime.tick(instance, options); }
export async function orchestrateWatch(runtime, instance, options) { return watchOrchestration(runtime, instance, options); }

function cliFailure(message, code = 'INVALID_INPUT') { throw new CliError(message, code); }
function cliInteger(value, name, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) cliFailure(`Orchestrate option '${name}' is invalid.`);
  return parsed;
}
function cliInput(parsed, dependencies) {
  if (!parsed || parsed.command !== 'orchestrate' || !['run', 'watch'].includes(parsed.subcommand)
    || !Array.isArray(parsed.operands) || parsed.operands.length !== 1
    || typeof parsed.operands[0] !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(parsed.operands[0])
    || parsed.operands[0].length > 64) cliFailure('Orchestrate commands require one explicit private instance ID.');
  const allowed = parsed.subcommand === 'run'
    ? ['json', 'expected-version', 'max-active-nodes']
    : ['json', 'expected-version', 'interval-ms', 'max-ticks', 'deadline-ms'];
  if (!parsed.flags || Object.keys(parsed.flags).some(key => !allowed.includes(key))) cliFailure('Orchestrate command options are invalid.');
  const context = dependencies?.orchestration;
  if (!context || typeof context.resolveInstance !== 'function' || !context.runtime || typeof context.runtime.tick !== 'function') cliFailure('Private orchestration is not configured.', 'MISSING_CONFIGURATION');
  return { context, instanceId: parsed.operands[0] };
}
function emitCliResult(parsed, dependencies, result) {
  const payload = { ok: true, command: 'orchestrate', subcommand: parsed.subcommand, result };
  if (parsed.flags.json) dependencies.output.json(payload);
  else dependencies.output.log(`Orchestration ${parsed.subcommand}: ${result.terminal ?? 'running'}.`);
  return EXIT_CODES.SUCCESS;
}

async function managedCommand(parsed, dependencies) {
  const service = dependencies.orchestration.managed;
  const { subcommand, flags, operands } = parsed;
  const allowed = {
    register: [
      'project',
      'run',
      'deadline-ms',
      'limits-json',
      'machine-limits-json',
      'json',
    ],
    status: ['json'],
    watch: ['deadline-ms', 'max-ticks', 'interval-ms', 'json'],
    pause: ['json'],
    resume: ['json'],
    limits: ['limits-json', 'json'],
    renew: ['deadline-ms', 'json'],
  };
  if (
    !allowed[subcommand] ||
    Object.keys(flags).some((k) => !allowed[subcommand].includes(k))
  )
    cliFailure('Invalid managed orchestration options.');
  const noId = ['register', 'limits'].includes(subcommand);
  if (
    noId
      ? operands.length !== 0
      : subcommand === 'status'
        ? operands.length > 1
        : operands.length !== 1
  )
    cliFailure('Supply exactly one registration ID for this operation.');
  const json = (name) => {
    try {
      return JSON.parse(flags[name]);
    } catch {
      cliFailure(`Invalid ${name}.`);
    }
  };
  let result;
  if (subcommand === 'register')
    result = await service.register({
      projectRoot: resolve(dependencies.cwd(), flags.project ?? '.'),
      ...(flags.run ? { runId: flags.run } : {}),
      deadlineMs: cliInteger(flags['deadline-ms'], 'deadline-ms'),
      ...(flags['limits-json'] ? { limits: json('limits-json') } : {}),
      ...(flags['machine-limits-json']
        ? { machineLimits: json('machine-limits-json') }
        : {}),
    });
  else if (subcommand === 'limits')
    result = await service.limits(json('limits-json'));
  else if (subcommand === 'renew')
    result = await service.renew(
      operands[0],
      cliInteger(flags['deadline-ms'], 'deadline-ms'),
    );
  else if (subcommand === 'watch')
    result = await withTerminalInterruption((signal) =>
      service.watch(operands[0], {
        signal,
        deadlineMs: cliInteger(flags['deadline-ms'], 'deadline-ms'),
        maxTicks: cliInteger(flags['max-ticks'] ?? 1, 'max-ticks', {
          minimum: 1,
          maximum: 10000,
        }),
        intervalMs: cliInteger(flags['interval-ms'] ?? 1000, 'interval-ms', {
          minimum: 1,
          maximum: 60000,
        }),
      }),
    );
  else result = await service[subcommand](operands[0]);
  if (flags.json)
    dependencies.output.json({
      ok: true,
      command: 'orchestrate',
      subcommand,
      result,
    });
  else dependencies.output.log(JSON.stringify(result, null, 2));
  return EXIT_CODES.SUCCESS;
}
export async function orchestrateCommand(parsed, dependencies) {
  if(dependencies.orchestration?.managed && (parsed.subcommand!=='run') && !dependencies.orchestration?.runtime)return managedCommand(parsed,dependencies);
  const { context, instanceId } = cliInput(parsed, dependencies);
  const expectedVersion = cliInteger(parsed.flags['expected-version'], 'expected-version');
  let options;
  if (parsed.subcommand === 'run') {
    options = { expectedVersion };
    if (parsed.flags['max-active-nodes'] !== undefined) options.maxActiveNodes = cliInteger(parsed.flags['max-active-nodes'], 'max-active-nodes', { minimum: 1, maximum: 64 });
  } else {
    if (typeof context.now !== 'function' || typeof context.wait !== 'function') cliFailure('Orchestration watch dependencies are not configured.', 'MISSING_CONFIGURATION');
    options = {
      expectedVersion,
      intervalMs: cliInteger(parsed.flags['interval-ms'], 'interval-ms', { minimum: 1, maximum: 60_000 }),
      maxTicks: cliInteger(parsed.flags['max-ticks'], 'max-ticks', { minimum: 1, maximum: 10_000 }),
      deadlineMs: cliInteger(parsed.flags['deadline-ms'], 'deadline-ms'),
      now: context.now,
      wait: context.wait,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    };
  }
  const instance = await context.resolveInstance(instanceId);
  if (!instance || instance.id !== instanceId) cliFailure('Private orchestration instance is unavailable.', 'MISSING_CONFIGURATION');
  let result;
  if (parsed.subcommand === 'run') {
    result = await orchestrateRun(context.runtime, instance, options);
  } else {
    result = await orchestrateWatch(context.runtime, instance, options);
  }
  return emitCliResult(parsed, dependencies, result);
}
