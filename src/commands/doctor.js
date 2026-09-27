import { createIntegrationRegistry } from '../integrations/registry.js';
import { resolve } from 'node:path';

import { EXIT_CODES } from '../cli/output.js';
import { inspectCommandReadiness } from '../config/command-readiness.js';
import { commandToolKey, compileProjectDependencies, compileQualitySteps } from '../config/commands.js';
import { loadProjectConfig, providerCredentialStatus } from '../config/load.js';
import { discoverTools } from '../discovery/tools.js';
import { verifyCommandExecutable } from '../policy/commands.js';

function emit(output, json, payload, exitCode) {
  if (json) {
    output.json(payload, exitCode === EXIT_CODES.SUCCESS ? 'stdout' : 'stderr');
  } else if (exitCode === EXIT_CODES.SUCCESS) {
    output.log(`Doctor: ${payload.status}. ${payload.summary}`);
  } else {
    output.error(`Doctor: ${payload.status}. ${payload.summary}`);
    for(const step of payload.checks?.commands?.steps??[]) {
      if(!step.available) output.error(`  ${step.id}: ${step.status}; command ${JSON.stringify(step.argv)} in ${JSON.stringify(step.cwd)}. Check the executable on PATH and the configured project command.`);
    }
  }
  return exitCode;
}

function requiredToolReady(tool) {
  return tool?.present === true
    && typeof tool.version === 'string'
    && tool.version.length > 0
    && tool.supported === true;
}

async function boundedProbe(probe, provider, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      probe(provider),
      new Promise(resolvePromise => {
        timer = setTimeout(() => resolvePromise({ status: 'timeout' }), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function providerChecks(config, probe, timeoutMs = 3_000) {
  const checks = [];
  for (const provider of config.providers.providers) {
    if (provider.projectIds?.length && !provider.projectIds.includes(config.project.id)) {
      checks.push({ id: provider.id, readiness: 'out-of-scope', connectivity: 'not_checked' });
      continue;
    }
    if (provider.transport && provider.transport !== 'direct-api') {
      checks.push({ id: provider.id, readiness: 'host-or-local', connectivity: 'not_checked' });
      continue;
    }
    if (provider.mode === 'disabled') {
      checks.push({ id: provider.id, readiness: 'disabled', connectivity: 'not_checked' });
      continue;
    }
    if (typeof probe !== 'function') {
      checks.push({ id: provider.id, readiness: 'configured', connectivity: 'not_checked' });
      continue;
    }
    try {
      const result = await boundedProbe(probe, {
        id: provider.id,
        kind: provider.kind,
        endpoint: provider.endpoint,
      }, timeoutMs);
      const connectivity = result?.status === 'available' ? 'available'
        : result?.status === 'timeout' ? 'timeout' : 'unavailable';
      checks.push({ id: provider.id, readiness: connectivity === 'available' ? 'ready' : 'unavailable', connectivity });
    } catch {
      checks.push({ id: provider.id, readiness: 'unavailable', connectivity: 'error' });
    }
  }
  return checks;
}

export async function diagnoseDoctor(projectRoot, dependencies = {}) {
  let config;
  try {
    config = await (dependencies.configLoader ?? loadProjectConfig)(projectRoot, { fs: dependencies.fs });
  } catch {
    return {
      ok: false,
      status: 'fail',
      exitCode: EXIT_CODES.MISSING_CONFIGURATION,
      error: {
        code: 'MISSING_CONFIGURATION',
        exitCode: EXIT_CODES.MISSING_CONFIGURATION,
        message: 'Project configuration is missing or invalid.',
      },
      checks: { configuration: { status: 'fail' } },
      summary: 'Project configuration is missing or invalid.',
    };
  }
  const environment = dependencies.env ?? process.env;
  const packageManager = config.project.stack.packageManager;
  const direct=config.project.schemaVersion===3;
  const commandSteps = compileQualitySteps(config);
  const dependencyPlan = compileProjectDependencies(config.project);
  const executableSteps = [...commandSteps, ...(dependencyPlan?.steps ?? [])];
  const managers = [...new Set([
    ...(direct ? [] : [packageManager]),
    ...executableSteps.map(step => direct ? step.argv[0] : step.argv[0].toLowerCase().replace(/\.(?:cmd|exe)$/, '')),
  ])];
  const toolDiscovery = dependencies.toolDiscovery ?? discoverTools;
  const reports = direct ? [await toolDiscovery({runtimeOnly:true},{cwd:projectRoot,runner:dependencies.runner})] : await Promise.all(managers.map(manager => toolDiscovery({ packageManager: manager }, {
    cwd: projectRoot,
    runner: dependencies.runner,
  })));
  let tools = Object.freeze({
    ...reports[0],
    ...(!direct ? Object.fromEntries(managers.map((manager, index) => [manager, reports[index]?.[manager] ?? {}])) : {}),
  });
  if (typeof dependencies.resolveCommandExecutable === 'function') {
    const entries = direct ? [...new Map(executableSteps.map(step => [
      commandToolKey(step.argv[0], step.cwd), { runner: step.argv[0], cwd: step.cwd },
    ])).entries()] : managers.map(manager => [manager, { runner: manager, cwd: '.' }]);
    const resolutions = await Promise.all(entries.map(async ([key, step]) => {
      let runtimeResolved = false;
      try {
        const executable = await dependencies.resolveCommandExecutable(step.runner, direct
          ? { execution: 'argv', worktree: projectRoot, cwd: step.cwd } : {});
        await verifyCommandExecutable(executable, direct ? { execution: 'argv' } : {});
        runtimeResolved = true;
      } catch {}
      return [key, Object.freeze({ ...(tools[key] ?? {}), runtimeResolved })];
    }));
    tools = Object.freeze({ ...tools, ...Object.fromEntries(resolutions) });
  }
  const credentials = dependencies.hostReadiness === true ? [] : providerCredentialStatus(config, environment);
  const providers = dependencies.hostReadiness === true ? [] : await providerChecks(
    config,
    dependencies.providerProbe,
    dependencies.providerProbeTimeoutMs,
  );
  const commands = inspectCommandReadiness(projectRoot, config, { fs: dependencies.fs, tools });
  const missingCredentials = credentials.filter(item => item.required && !item.present);
  const unavailableProviders = providers.filter(item => ['unavailable', 'timeout', 'error'].includes(item.connectivity));
  const toolsReady = requiredToolReady(tools.node)
    && (direct || managers.every(manager => requiredToolReady(tools[manager]) && tools[manager].runtimeResolved !== false))
    && requiredToolReady(tools.git);
  const otherFailure = missingCredentials.length > 0 || unavailableProviders.length > 0 || !toolsReady;
  const preparationReady = !otherFailure && commands.preparationReady === true;
  const preparationRequired = preparationReady && !commands.ready;
  const failed = otherFailure || (!commands.ready && !preparationReady)
    || commands.dependencies?.preparationReady === false;
  const exitCode = missingCredentials.length > 0 || unavailableProviders.length > 0
    ? EXIT_CODES.PROVIDER_UNAVAILABLE
    : failed ? EXIT_CODES.FAILED_GATE : EXIT_CODES.SUCCESS;
  return {
    ok: !failed,
    preparationReady,
    status: failed ? 'fail' : preparationRequired ? 'preparation-required' : providers.some(item => item.connectivity === 'not_checked') ? 'warn' : 'pass',
    exitCode,
    checks: {
      configuration: { status: 'pass' },
      tools,
      credentials,
      providers,
      commands,
      integrations: createIntegrationRegistry({config,projectId:config.project.id,environment,host:dependencies.integrationHost}).check(),
    },
    summary: failed ? 'One or more readiness checks failed.' : preparationRequired
      ? 'Configured dependencies require installation in the isolated checkout after approval. Quality commands have not run; use rivet task deps once the checkout exists.'
      : 'Configuration and local readiness checks completed.',
  };
}

export async function doctor(parsed, dependencies = {}) {
  const json = parsed.flags.json === true;
  const projectRoot = resolve(parsed.flags.project ?? dependencies.cwd?.() ?? process.cwd());
  try {
    const result = await diagnoseDoctor(projectRoot, dependencies);
    return emit(dependencies.output, json, result, result.exitCode);
  } catch {
    return emit(dependencies.output, json, {
      ok: false,
      status: 'fail',
      summary: 'Doctor could not complete safely.',
      error: {
        code: 'INTERNAL_ERROR',
        exitCode: EXIT_CODES.INTERNAL_ERROR,
        message: 'Doctor could not complete safely.',
      },
    }, EXIT_CODES.INTERNAL_ERROR);
  }
}
