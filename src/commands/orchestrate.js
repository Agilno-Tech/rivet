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
  const allowed = {status:['json'],limits:['limits-json','json']};
  if(!allowed[subcommand] || operands.length || Object.keys(flags).some(key=>!allowed[subcommand].includes(key)))
    cliFailure('Use task start, status, pause or resume. Advanced machine commands are orchestrate status and limits.');
  let result;
  if(subcommand==='limits') {
    let limits;
    try { limits=JSON.parse(flags['limits-json']); } catch {cliFailure('Invalid limits-json.');}
    result=await service.limits(limits);
  } else {
    const state=await service.coordinator.inspect();
    result={configured:state.configured,limits:state.limits,tasks:state.registrations.filter(r=>r.runId).map(r=>({
      project:r.projectRoot,runId:r.runId,paused:r.paused,deadlineMs:r.deadlineMs,
      waiting:[...new Set(state.claims.filter(c=>c.registrationId===r.id&&c.status==='queued').map(c=>c.reason??c.resource))],
    })),capacity:Object.fromEntries(Object.entries(state.limits??{}).map(([resource,limit])=>[resource,{held:state.claims.filter(c=>c.resource===resource&&c.status==='held').length,limit}]))};
  }
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
