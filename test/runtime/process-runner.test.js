import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import test from 'node:test';

import { createProcessRunner } from '../../src/clients/process-runner.js';
import { buildLaunchContract } from '../../src/prompts/launch-contract.js';
import { serializePlanningContract } from '../../src/prompts/planning-contract.js';

async function fixture(t, body) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-client-')));
  const worktree = join(root, 'worktree');
  await mkdir(worktree);
  const executable = join(root, 'provider');
  const interpreter = await realpath('/bin/sh');
  await writeFile(executable, `#!${interpreter}\n${body}\n`, { mode: 0o700 });
  await chmod(executable, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, worktree, executable, interpreter };
}

function envelope(status = 'success') {
  return JSON.stringify({ version: 1, status, output: { summary: 'done', evidence: ['tests'] }, usage: { tokens: 10, costUsd: 0.01 } });
}

async function payload(f, { large = false } = {}) {
  const metadata = await lstat(f.worktree, { bigint: true });
  return buildLaunchContract({
    nodeId: 'worker-one', parentId: 'manager-one', objective: 'Test the provider.',
    ownedPaths: large
      ? Array.from({ length: 200 }, (_, index) => `src/${index}-${'x'.repeat(470)}.js`)
      : ['src/provider.js'],
    authority: { actions: ['code.write'], providers: [] },
    commands: ['test.unit'], evidence: ['test-results'],
    budget: { maxTokens: 1000, maxRuntimeMs: 30000, maxCostUsd: 1 },
    worktree: { path: f.worktree, dev: metadata.dev.toString(), ino: metadata.ino.toString(), reservationId: 'lease-one' },
    contextRefs: ['test-context'], heartbeatInterval: 1000, stopConditions: ['objective-complete'],
  });
}

async function planningPayload(f) {
  const metadata = await lstat(f.worktree, { bigint: true });
  return serializePlanningContract({
    worktree: {
      path: f.worktree,
      dev: metadata.dev.toString(),
      ino: metadata.ino.toString(),
      reservationId: 'planning-read-only',
    },
    contract: {
      schemaVersion: 1,
      baselineCommit: 'a'.repeat(40),
      client: 'claude',
      workRequest: { schemaVersion: 1, digest: 'b'.repeat(64), title: 'Plan feature' },
      policy: { projectId: 'fixture' },
    },
  });
}

test('runs the branded planning protocol through the same pinned process boundary', async t => {
  const planned = JSON.stringify({
    schemaVersion: 1,
    id: 'planned-feature',
    baselineCommit: 'a'.repeat(40),
    workRequestDigest: 'b'.repeat(64),
    client: 'claude',
    providerRefs: [],
    nodes: [],
  });
  const f = await fixture(t, `cat >/dev/null\nprintf '%s\\n' '${planned}'`);
  const runner = await createProcessRunner({
    executable: f.executable,
    interpreter: f.interpreter,
    worktree: f.worktree,
    maxInputBytes: 512 * 1024,
    maxOutputBytes: 512 * 1024,
  });
  const request = { args: [], cwd: '.', payload: await planningPayload(f) };
  const workerPayload = await payload(f);
  const result = await runner.runPlanning(request);

  assert.equal(result.id, 'planned-feature');
  assert.equal(Object.isFrozen(result), true);
  await assert.rejects(() => runner.run({ ...request }), error => error.code === 'ERR_AGENT_INVALID_CONTRACT');
  await assert.rejects(
    () => runner.runPlanning({ ...request, payload: workerPayload }),
    error => error.code === 'ERR_AGENT_INVALID_CONTRACT',
  );
});

test('runs an argv-only provider with bounded env/stdin and returns an immutable envelope', async t => {
  const f = await fixture(t, `cat >/dev/null\nif [ -n "\${API_TOKEN+x}" ]; then printf bad; else printf '%s\\n' '${envelope()}'; fi`);
  const runner = await createProcessRunner({ executable: f.executable, interpreter: f.interpreter, worktree: f.worktree, environment: { LANG: 'C', API_TOKEN: 'must-not-pass' } });
  const result = await runner.run({ args: [], cwd: '.', payload: await payload(f) });
  assert.equal(result.status, 'success');
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.output));
});

test('preserves non-secret home and shell identity needed by local authenticated clients', async t => {
  const f = await fixture(t, `cat >/dev/null
[ "$HOME" = "/Users/fixture" ] || exit 46
[ "$USER" = "fixture-user" ] || exit 47
[ "$LOGNAME" = "fixture-user" ] || exit 48
[ "$SHELL" = "/bin/zsh" ] || exit 49
[ -z "$ANTHROPIC_API_KEY" ] || exit 50
printf '%s\\n' '${envelope()}'`);
  const runner = await createProcessRunner({
    executable: f.executable,
    interpreter: f.interpreter,
    worktree: f.worktree,
    environment: {
      HOME: '/Users/fixture', USER: 'fixture-user', LOGNAME: 'fixture-user', SHELL: '/bin/zsh',
      ANTHROPIC_API_KEY: 'must-not-pass',
    },
  });
  assert.equal((await runner.run({ args: [], cwd: '.', payload: await payload(f) })).status, 'success');
});

test('requires a pinned native interpreter for scripts and rejects env or symlink interpreters', async t => {
  const f = await fixture(t, `cat >/dev/null\nprintf '%s' '${envelope()}'`);
  await assert.rejects(() => createProcessRunner({ executable: f.executable, worktree: f.worktree }), error => error.code === 'ERR_AGENT_EXECUTABLE_UNSAFE');

  const envScript = join(f.root, 'env-provider');
  await writeFile(envScript, `#!/usr/bin/env sh\nprintf '%s' '${envelope()}'\n`, { mode: 0o700 });
  await chmod(envScript, 0o700);
  await assert.rejects(() => createProcessRunner({ executable: envScript, interpreter: f.interpreter, worktree: f.worktree }), error => error.code === 'ERR_AGENT_EXECUTABLE_UNSAFE');

  const interpreterLink = join(f.root, 'linked-interpreter');
  await symlink(f.interpreter, interpreterLink);
  const linkedScript = join(f.root, 'linked-interpreter-provider');
  await writeFile(linkedScript, `#!${interpreterLink}\nprintf '%s' '${envelope()}'\n`, { mode: 0o700 });
  await chmod(linkedScript, 0o700);
  await assert.rejects(() => createProcessRunner({ executable: linkedScript, interpreter: interpreterLink, worktree: f.worktree }), error => error.code === 'ERR_AGENT_EXECUTABLE_UNSAFE');
});

test('accepts only a pinned native node interpreter for an npm-style env node script', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-node-script-')));
  const worktree = join(root, 'worktree');
  await mkdir(worktree);
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'provider.js');
  const interpreter = await realpath(process.execPath);
  const source = `#!/usr/bin/env node\nif (process.argv[2] === '--version') {\n  process.stdout.write('fake-node-provider 1.0.0\\n');\n} else {\n  const chunks = [];\n  process.stdin.on('data', chunk => chunks.push(chunk));\n  process.stdin.on('end', () => process.stdout.write(${JSON.stringify(`${envelope()}\n`)}));\n}\n`;
  await writeFile(executable, source, { mode: 0o700 });
  await chmod(executable, 0o700);
  await assert.rejects(() => createProcessRunner({ executable, worktree }), error => error.code === 'ERR_AGENT_EXECUTABLE_UNSAFE');
  const runner = await createProcessRunner({ executable, interpreter, worktree });
  assert.equal(await runner.probeVersion(), 'fake-node-provider 1.0.0');
  assert.equal((await runner.run({ args: [], cwd: '.', payload: await payload({ worktree }) })).status, 'success');
});

test('captures cancellation before construction awaits and cleans its listener deterministically', async t => {
  const f = await fixture(t, `cat >/dev/null\nprintf '%s' '${envelope()}'`);
  const controller = new AbortController();
  const signal = controller.signal;
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);
  let added = 0;
  let removed = 0;
  signal.addEventListener = (...args) => { added += 1; originalAdd(...args); controller.abort(); };
  signal.removeEventListener = (...args) => { removed += 1; return originalRemove(...args); };
  await assert.rejects(
    () => createProcessRunner({ executable: f.executable, interpreter: f.interpreter, worktree: f.worktree, signal }),
    error => error.code === 'ERR_AGENT_ABORTED',
  );
  assert.equal(added, 1);
  assert.equal(removed, 1);
});

test('rejects canonical sensitive-label assignments in provider result envelopes', async t => {
  for (const secret of [
    '{"token":"secret-value"}', 'token\u200b=supersecret', '“password”\u2060:\u2060“private-value”',
    'API KEY: private-value', 'auth.token=private-value', '\\"token\\":\\"private-value\\"', 'access - token = private-value',
  ]) {
    const secretEnvelope = JSON.stringify({
      version: 1, status: 'success', output: { summary: secret, evidence: ['tests'] }, usage: { tokens: 1, costUsd: 0 },
    });
    const f = await fixture(t, `cat >/dev/null\nprintf '%s' '${secretEnvelope}'`);
    const runner = await createProcessRunner({ executable: f.executable, interpreter: f.interpreter, worktree: f.worktree });
    const launchPayload = await payload(f);
    await assert.rejects(() => runner.run({ args: [], cwd: '.', payload: launchPayload }), error => (
      error.code === 'ERR_AGENT_OUTPUT_INVALID' && !error.message.includes('supersecret')
    ));
  }
  const ordinary = await fixture(t, `cat >/dev/null\nprintf '%s' '${JSON.stringify({
    version: 1, status: 'success', output: { summary: 'Use a token bucket and document API key rotation.', evidence: ['tests'] }, usage: { tokens: 1, costUsd: 0 },
  })}'`);
  const runner = await createProcessRunner({ executable: ordinary.executable, interpreter: ordinary.interpreter, worktree: ordinary.worktree });
  assert.equal((await runner.run({ args: [], cwd: '.', payload: await payload(ordinary) })).status, 'success');
});

test('detects executable and worktree identity replacement before launch', async t => {
  const executableCase = await fixture(t, `cat >/dev/null\nprintf '%s' '${envelope()}'`);
  const runner = await createProcessRunner({ executable: executableCase.executable, interpreter: executableCase.interpreter, worktree: executableCase.worktree });
  const launchPayload = await payload(executableCase);
  await rename(executableCase.executable, `${executableCase.executable}-old`);
  await writeFile(executableCase.executable, `#!/bin/sh\nprintf '%s' '${envelope()}'\n`, { mode: 0o700 });
  await chmod(executableCase.executable, 0o700);
  await assert.rejects(() => runner.run({ args: [], cwd: '.', payload: launchPayload }), error => error.code === 'ERR_AGENT_EXECUTABLE_UNSAFE');

  const mutationCase = await fixture(t, `cat >/dev/null\nprintf '%s' '${envelope()}'`);
  const mutationRunner = await createProcessRunner({ executable: mutationCase.executable, interpreter: mutationCase.interpreter, worktree: mutationCase.worktree });
  const mutationPayload = await payload(mutationCase);
  await writeFile(mutationCase.executable, '#!/bin/sh\nprintf changed\n', { mode: 0o700 });
  await assert.rejects(() => mutationRunner.run({ args: [], cwd: '.', payload: mutationPayload }), error => error.code === 'ERR_AGENT_EXECUTABLE_UNSAFE');

  const worktreeCase = await fixture(t, `cat >/dev/null\nprintf '%s' '${envelope()}'`);
  const worktreeRunner = await createProcessRunner({ executable: worktreeCase.executable, interpreter: worktreeCase.interpreter, worktree: worktreeCase.worktree });
  const worktreePayload = await payload(worktreeCase);
  await rename(worktreeCase.worktree, `${worktreeCase.worktree}-old`);
  await mkdir(worktreeCase.worktree);
  await assert.rejects(() => worktreeRunner.run({ args: [], cwd: '.', payload: worktreePayload }), error => error.code === 'ERR_AGENT_CWD_UNSAFE');
});

test('classifies malformed, multiple, oversized and non-UTF8 provider output safely', async t => {
  const cases = [
    ['printf not-json', 'ERR_AGENT_OUTPUT_INVALID'],
    [`printf '%s\\n%s' '${envelope()}' '${envelope()}'`, 'ERR_AGENT_OUTPUT_INVALID'],
    ["head -c 4096 /dev/zero | tr '\\000' x", 'ERR_AGENT_OUTPUT_OVERFLOW'],
    ["printf '\\377'", 'ERR_AGENT_OUTPUT_INVALID'],
  ];
  for (const [body, code] of cases) {
    // Output classification requires a provider that first accepts its input.
    const f = await fixture(t, `cat >/dev/null\n${body}`);
    const runner = await createProcessRunner({ executable: f.executable, interpreter: f.interpreter, worktree: f.worktree, maxOutputBytes: 1024 });
    const launchPayload = await payload(f);
    await assert.rejects(() => runner.run({ args: [], cwd: '.', payload: launchPayload }), error => error.code === code);
  }
});

test('bounds runtime, handles abort and spawn/identity failures without leaking raw details', async t => {
  const slow = await fixture(t, 'sleep 5');
  const timed = await createProcessRunner({ executable: slow.executable, interpreter: slow.interpreter, worktree: slow.worktree, timeoutMs: 30, termGraceMs: 20, killGraceMs: 100 });
  const slowPayload = await payload(slow);
  await assert.rejects(() => timed.run({ args: [], cwd: '.', payload: slowPayload }), error => error.code === 'ERR_AGENT_TIMEOUT' && !error.message.includes(slow.root));

  const controller = new AbortController();
  const aborted = timed.run({ args: [], cwd: '.', payload: slowPayload, signal: controller.signal });
  controller.abort();
  await assert.rejects(() => aborted, error => error.code === 'ERR_AGENT_ABORTED');

  const linkPath = join(slow.root, 'linked-provider');
  await symlink(slow.executable, linkPath);
  await assert.rejects(() => createProcessRunner({ executable: linkPath, interpreter: slow.interpreter, worktree: slow.worktree }), error => error.code === 'ERR_AGENT_EXECUTABLE_UNSAFE');
  const cwdLink = join(slow.worktree, 'linked');
  await symlink(tmpdir(), cwdLink);
  await assert.rejects(() => timed.run({ args: [], cwd: 'linked', payload: slowPayload }), error => error.code === 'ERR_AGENT_CWD_UNSAFE');
  const hardlinkPath = join(slow.root, 'hardlinked-provider');
  await link(slow.executable, hardlinkPath);
  await createProcessRunner({ executable: hardlinkPath, interpreter: slow.interpreter, worktree: slow.worktree });
  await rm(hardlinkPath);
  // Close stdin first so the parent observes EPIPE before the already-spawned
  // provider exits. That race must still be classified as provider execution.
  const exitCase = await fixture(t, 'exec 0<&-\nsleep 0.05\nexit 23');
  const exitRunner = await createProcessRunner({ executable: exitCase.executable, interpreter: exitCase.interpreter, worktree: exitCase.worktree });
  const exitPayload = await payload(exitCase, { large: true });
  await assert.rejects(() => exitRunner.run({ args: [], cwd: '.', payload: exitPayload }), error => (
    error.code === 'ERR_AGENT_PROVIDER_UNAVAILABLE' && !error.message.includes(exitCase.root)
  ));
});

test('snapshots hostile request getters once and rejects option/traversal inputs', async t => {
  // Read the complete request before exiting; otherwise this success fixture races stdin delivery.
  const f = await fixture(t, `cat >/dev/null\nprintf '%s' '${envelope()}'`);
  const runner = await createProcessRunner({ executable: f.executable, interpreter: f.interpreter, worktree: f.worktree });
  let reads = 0;
  const launchPayload = await payload(f, { large: true });
  const request = { args: [], cwd: '.', payload: launchPayload };
  Object.defineProperty(request, 'payload', { enumerable: true, get() { reads += 1; return launchPayload; } });
  await runner.run(request);
  assert.equal(reads, 1);
  await assert.rejects(() => runner.run({ args: ['--evil'], cwd: '.', payload: launchPayload }), /argument/i);
  await assert.rejects(() => runner.run({ args: [], cwd: '../outside', payload: launchPayload }), error => error.code === 'ERR_AGENT_CWD_UNSAFE');

  let executableReads = 0;
  const config = { interpreter: f.interpreter, worktree: f.worktree };
  Object.defineProperty(config, 'executable', { enumerable: true, get() { executableReads += 1; return f.executable; } });
  await createProcessRunner(config);
  assert.equal(executableReads, 1);
});

function nativeClaudeResult({tokens = 500000, cost = 0.15, nativeTokens = 100, nativeCost = 0.17} = {}) {
  return {
    type: 'result', subtype: 'success', is_error: false,
    structured_output: {...JSON.parse(envelope()), usage: {tokens, costUsd: cost}},
    total_cost_usd: nativeCost,
    usage: {input_tokens: 999999}, // Aggregate must not be added to whole-tree totals.
    modelUsage: {model: {inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 30, cacheReadInputTokens: nativeTokens - 60}},
  };
}

async function runClaudeResult(t, native, exitCode = 0) {
  const f = await fixture(t, `cat >/dev/null\nprintf '%s\\n' '${JSON.stringify(native)}'\nexit ${exitCode}`);
  const runner = await createProcessRunner({executable: f.executable, interpreter: f.interpreter, worktree: f.worktree, resultFormat: 'claude-json'});
  return runner.run({args: [], cwd: '.', payload: await payload(f)});
}

test('Claude native telemetry replaces model-invented usage and counts cache tokens once', async t => {
  const result = await runClaudeResult(t, nativeClaudeResult());
  assert.equal(result.status, 'success');
  assert.deepEqual({...result.usage}, {tokens: 100, costUsd: 0.17});
});

test('Claude measured token and estimated cost overruns cannot report success', async t => {
  for (const input of [{nativeTokens: 1100}, {nativeCost: 1.1}]) {
    const result = await runClaudeResult(t, nativeClaudeResult({...input, tokens: 1, cost: 0}));
    assert.equal(result.status, 'budget-exhausted');
    assert.equal(result.usage.tokens, input.nativeTokens ?? 100);
    assert.equal(result.usage.costUsd, input.nativeCost ?? 0.17);
  }
});

test('Claude requires valid whole-tree native telemetry and a successful native envelope', async t => {
  for (const mutate of [
    v => {delete v.modelUsage;}, v => {v.modelUsage = {};},
    v => {v.modelUsage.model.cacheReadInputTokens = -1;},
    v => {v.modelUsage.model.inputTokens = 1.5;},
    v => {v.modelUsage.model.outputTokens = Number.MAX_SAFE_INTEGER;},
    v => {v.total_cost_usd = '0.17';}, v => {delete v.total_cost_usd;},
    v => {v.is_error = true;}, v => {v.subtype = 'error_max_turns';},
  ]) {
    const value = nativeClaudeResult(); mutate(value);
    await assert.rejects(runClaudeResult(t, value), error => error.code === 'ERR_AGENT_OUTPUT_INVALID');
  }
});

test('Claude counts each model once including nested-agent tokens', async t => {
  const native = nativeClaudeResult();
  native.modelUsage.nested = {inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 3, cacheReadInputTokens: 4};
  const result = await runClaudeResult(t, native);
  assert.equal(result.usage.tokens, 110);
});

test('generic results retain their declared usage and overbudget success is rejected', async t => {
  for (const tokens of [10, 1100]) {
    const value = {...JSON.parse(envelope()), usage: {tokens, costUsd: 0.01}};
    const f = await fixture(t, `cat >/dev/null\nprintf '%s\\n' '${JSON.stringify(value)}'`);
    const runner = await createProcessRunner({executable: f.executable, interpreter: f.interpreter, worktree: f.worktree});
    const result = runner.run({args: [], cwd: '.', payload: await payload(f)});
    if (tokens > 1000) await assert.rejects(result, error => error.code === 'ERR_AGENT_OUTPUT_INVALID');
    else assert.equal((await result).usage.tokens, tokens);
  }
});


test('Claude native cost-cap stop preserves telemetry on nonzero exit without accepting model evidence', async t => {
  const native = nativeClaudeResult({nativeCost: 1.1});
  native.subtype = 'error_max_budget_usd';
  native.is_error = true;
  delete native.structured_output;
  for (const exitCode of [0, 1]) {
    const result = await runClaudeResult(t, native, exitCode);
    assert.equal(result.status, 'budget-exhausted');
    assert.equal(result.usage.costUsd, 1.1);
    assert.equal(result.usage.tokens, 100);
    assert.deepEqual([...result.output.evidence], []);
  }
});

test('a nonzero Claude exit cannot present a success envelope as successful work', async t => {
  await assert.rejects(runClaudeResult(t, nativeClaudeResult({tokens: 1}), 1));
});

test('telemetry persistence honors abort and deadline without signalling a closed process',async t=>{
 for(const mode of ['abort','timeout','hung','reject','success']) await t.test(mode,async t=>{
  const f=await fixture(t,`cat >/dev/null\nprintf '%s\\n' '${envelope()}'`);
  const controller=new AbortController();let persisting=false;const signals=[];
  const originalKill=process.kill;
  t.mock.method(process,'kill',function(pid,signal){if(persisting)signals.push(signal);return originalKill.call(process,pid,signal);});
  const runner=await createProcessRunner({executable:f.executable,interpreter:f.interpreter,worktree:f.worktree,signal:controller.signal,timeoutMs:['timeout','hung'].includes(mode)?100:2000,termGraceMs:10,killGraceMs:10,telemetryProvider:'codex',onTelemetry:async()=>{
   persisting=true;
   if(mode==='abort')controller.abort();
   if(mode==='hung')await new Promise(()=>{});
   await new Promise(resolve=>setTimeout(resolve,mode==='timeout'?150:10));
   if(mode==='reject')throw new Error('persistence failed');
  }});
  const running=runner.run({args:[],cwd:'.',payload:await payload(f)});
  if(mode==='success')assert.equal((await running).status,'success');
  else await assert.rejects(running,error=>error.code===({abort:'ERR_AGENT_ABORTED',timeout:'ERR_AGENT_TIMEOUT',hung:'ERR_AGENT_TIMEOUT',reject:'ERR_AGENT_OUTPUT_INVALID'})[mode]);
  assert.equal(persisting,true);
  assert.deepEqual(signals,[]);
 });
});

test('managed checkpoint result records owned start before stdin and stopped proof before resolving',async t=>{
 const f=await fixture(t,`cat >/dev/null\nprintf '%s' '${envelope('checkpoint')}'`);
 const source=JSON.parse(await payload(f));const {version,...contract}=source.contract;
 contract.session={id:'session-one',generation:1,maxActions:2,maxMinutes:1,checkpoint:null};
 const receipts=[];
 const runner=await createProcessRunner({executable:f.executable,interpreter:f.interpreter,worktree:f.worktree,onExecution:async receipt=>{receipts.push(receipt);}});
 const result=await runner.run({args:[],cwd:'.',payload:buildLaunchContract(contract)});
 assert.equal(result.status,'checkpoint');assert.deepEqual(receipts.map(r=>r.status),['started','stopped']);
 assert.equal(receipts[0].executionId,receipts[1].executionId);assert.equal(receipts[1].source,'owned-process');
 const legacy=await createProcessRunner({executable:f.executable,interpreter:f.interpreter,worktree:f.worktree});
 const legacyPayload=await payload(f);await assert.rejects(()=>legacy.run({args:[],cwd:'.',payload:legacyPayload}),error=>error.code==='ERR_AGENT_OUTPUT_INVALID');
});

test('owned successful output with a surviving descendant reports unknown stopped proof',async t=>{
 const f=await fixture(t,`cat >/dev/null\nsleep 30 </dev/null >/dev/null 2>&1 &\nprintf '%s' '${envelope()}'`);
 const receipts=[];t.after(()=>{const pid=receipts[0]?.processGroupId;if(pid)try{process.kill(-pid,'SIGKILL');}catch{}});
 const runner=await createProcessRunner({executable:f.executable,interpreter:f.interpreter,worktree:f.worktree,onExecution:receipt=>receipts.push(receipt)});
 await runner.run({args:[],cwd:'.',payload:await payload(f)});
 assert.equal(receipts.at(-1).status,'unknown');
});
test('hanging startup ownership receipt is bounded and never dispatches stdin',async t=>{
 const f=await fixture(t,'cat >/dev/null\nexit 0');
 const runner=await createProcessRunner({executable:f.executable,interpreter:f.interpreter,worktree:f.worktree,timeoutMs:100,termGraceMs:10,killGraceMs:10,onExecution:()=>new Promise(()=>{})});
 const input=await payload(f);await assert.rejects(()=>runner.run({args:[],cwd:'.',payload:input}),error=>['ERR_AGENT_TIMEOUT','ERR_AGENT_OUTPUT_INVALID'].includes(error.code));
});

test('managed watch cancellation awaits real owned process settlement before capacity release',async t=>{
 const {createManagedOrchestration}=await import('../../src/runtime/managed-orchestration.js');
 const {withMachineContext,taskAdmission,admitted}=await import('../../src/runtime/machine-admission.js');
 const f=await fixture(t,'cat >/dev/null\nsleep 30');const receipts=[];let service;
 const controller=new AbortController();t.after(()=>controller.abort());
 let started;const startup=new Promise(resolve=>{started=resolve;});
 const workflow={status:async()=>({status:'approved',version:1}),resume:async(request,{signal})=>withMachineContext(service.coordinator,f.worktree,'cancel-run',()=>taskAdmission(()=>admitted('agentExecutions','cancel-worker',{signal},async options=>{
  const runner=await createProcessRunner({executable:f.executable,interpreter:f.interpreter,worktree:f.worktree,signal:options.signal,termGraceMs:20,killGraceMs:1000,onExecution:async r=>{receipts.push(r);await options.onExecution(r);if(r.status==='started')started();}});
  await runner.run({args:[],cwd:'.',payload:await payload(f)});return {status:'completed'};
 })),{signal})};
 service=createManagedOrchestration({root:join(f.root,'machine'),gitClient:async()=>null,workflow});
 const r=await service.coordinator.register({projectRoot:f.worktree,runId:'cancel-run',deadlineMs:Date.now()+30000});
 const watching=service.watch(r.id,{deadlineMs:Date.now()+30000,signal:controller.signal});
 await Promise.race([startup,watching.then(()=>{throw new Error('Watch settled before startup');})]);
 controller.abort();
 const result=await watching;assert.equal(result.terminal,'cancelled');assert.equal(receipts[0].status,'started');assert.ok(['stopped','unknown'].includes(receipts.at(-1).status));
 const claims=(await service.coordinator.inspect()).claims;
 const agent=claims.find(c=>c.resource==='agentExecutions');assert.equal(agent.status,receipts.at(-1).status==='stopped'?'released':'held');
 if(agent.status==='released')assert.throws(()=>process.kill(-receipts[0].processGroupId,0),error=>error.code==='ESRCH');
});

test('managed successful provider with surviving descendant retains unknown machine capacity',async t=>{
 const {createResourceCoordinator}=await import('../../src/runtime/resource-coordinator.js');
 const {withMachineContext,admitted}=await import('../../src/runtime/machine-admission.js');
 const f=await fixture(t,`cat >/dev/null\nsleep 30 </dev/null >/dev/null 2>&1 &\nprintf '%s' '${envelope()}'`);
 const coordinator=createResourceCoordinator({root:join(f.root,'machine')});await coordinator.register({projectRoot:f.worktree,runId:'unknown-run',deadlineMs:Date.now()+30000});let group;
 t.after(()=>{if(group)try{process.kill(-group,'SIGKILL');}catch{}});
 await withMachineContext(coordinator,f.worktree,'unknown-run',()=>admitted('agentExecutions','unknown-worker',{},async options=>{
  const runner=await createProcessRunner({executable:f.executable,interpreter:f.interpreter,worktree:f.worktree,onExecution:async r=>{group=r.processGroupId;await options.onExecution(r);}});return runner.run({args:[],cwd:'.',payload:await payload(f)});
 }));
 const claim=(await coordinator.inspect()).claims[0];assert.equal(claim.status,'held');assert.equal(claim.execution.status,'unknown');
});

test('actual Codex preflight without a child releases only its current machine attempt', async t => {
 const {createCodexClient,CODEX_ADAPTER_SYNTAX}=await import('../../src/clients/codex.js');
 const {createResourceCoordinator}=await import('../../src/runtime/resource-coordinator.js');
 const {withMachineContext,admitted}=await import('../../src/runtime/machine-admission.js');
 const {validateLaunchPayload}=await import('../../src/prompts/launch-contract.js');
 const f=await fixture(t,'exit 0');
 const coordinator=createResourceCoordinator({root:join(f.root,'machine')});
 await coordinator.register({projectRoot:f.worktree,runId:'preflight-run',deadlineMs:Date.now()+30000});
 const client=createCodexClient({executable:join(f.root,'missing'),args:CODEX_ADAPTER_SYNTAX.args});
 const {version,...contract}=validateLaunchPayload(await payload(f));
 await assert.rejects(withMachineContext(coordinator,f.worktree,'preflight-run',()=>admitted('agentExecutions','preflight',{},options=>client.launch(contract,options))), e => e.code === 'ERR_AGENT_PROVIDER_UNAVAILABLE');
 assert.equal((await coordinator.inspect()).claims[0].status,'released');
 await assert.rejects(withMachineContext(coordinator,f.worktree,'preflight-run',()=>admitted('agentExecutions','unproven',{},()=>{throw new Error('no proof');})));
 assert.equal((await coordinator.inspect()).claims[1].status,'held');
});

test('surviving compatibility probe blocks main execution and retains machine capacity', async t => {
  const {readFile}=await import('node:fs/promises');
  const {createResourceCoordinator}=await import('../../src/runtime/resource-coordinator.js');
  const {withMachineContext,admitted}=await import('../../src/runtime/machine-admission.js');
  const f=await fixture(t,`if [ "$1" = --version ]; then echo $$ > probe-pid; sleep 30 </dev/null >/dev/null 2>&1 & printf version; exit 0; fi\necho started > main-started\ncat >/dev/null\nprintf '%s' '${envelope()}'`);
  let probeGroup;
  t.after(()=>{if(probeGroup)try{process.kill(-probeGroup,'SIGKILL');}catch{}});
  const c=createResourceCoordinator({root:join(f.root,'machine')});
  await c.register({projectRoot:f.worktree,runId:'probe-run',deadlineMs:Date.now()+30000});
  await withMachineContext(c,f.worktree,'probe-run',()=>admitted('agentExecutions','probe',{},async options=>{
    const runner=await createProcessRunner({executable:f.executable,interpreter:f.interpreter,worktree:f.worktree,onExecution:options.onExecution});
    try { await assert.rejects(runner.probeVersion(),{code:'ERR_AGENT_PROVIDER_UNAVAILABLE'}); }
    finally { probeGroup=Number(await readFile(join(f.worktree,'probe-pid'),'utf8')); }
    // Even a caller that handles the probe error cannot start the main child.
    await assert.rejects(runner.run({args:[],cwd:'.',payload:await payload(f)}),{code:'ERR_AGENT_PROVIDER_UNAVAILABLE'});
  }));
  assert.equal((await c.inspect()).claims[0].status,'held');
  await assert.rejects(readFile(join(f.worktree,'main-started')),{code:'ENOENT'});
});

test('stopped compatibility probe permits the admitted main execution', async t => {
  const {createResourceCoordinator}=await import('../../src/runtime/resource-coordinator.js');
  const {withMachineContext,admitted}=await import('../../src/runtime/machine-admission.js');
  const f=await fixture(t,`if [ "$1" = --version ]; then printf version; exit 0; fi\ncat >/dev/null\nprintf '%s' '${envelope()}'`);
  const c=createResourceCoordinator({root:join(f.root,'machine')});
  await c.register({projectRoot:f.worktree,runId:'clean-probe',deadlineMs:Date.now()+30000});
  await withMachineContext(c,f.worktree,'clean-probe',()=>admitted('agentExecutions','probe',{},async options=>{
    const runner=await createProcessRunner({executable:f.executable,interpreter:f.interpreter,worktree:f.worktree,onExecution:options.onExecution});
    assert.equal(await runner.probeVersion(),'version');
    await runner.run({args:[],cwd:'.',payload:await payload(f)});
  }));
  assert.equal((await c.inspect()).claims[0].status,'released');
});

test('settled execution scope fences saved runners and opaque success retains capacity', async t => {
 const {createResourceCoordinator}=await import('../../src/runtime/resource-coordinator.js');
 const {withMachineContext,admitted}=await import('../../src/runtime/machine-admission.js');
 const f=await fixture(t,`echo started > late-started\ncat >/dev/null\nprintf '%s' '${envelope()}'`);
 const c=createResourceCoordinator({root:join(f.root,'machine')});
 await c.register({projectRoot:f.worktree,runId:'late-runner',deadlineMs:Date.now()+30000});
 let runner;
 await withMachineContext(c,f.worktree,'late-runner',()=>admitted('agentExecutions','construction',{},async options=>{
  runner=await createProcessRunner({executable:f.executable,interpreter:f.interpreter,worktree:f.worktree,onExecution:options.onExecution});
 }));
 assert.equal((await c.inspect()).claims[0].status,'released');
 const request={args:[],cwd:'.',payload:await payload(f)};
 await assert.rejects(runner.run(request));
 await assert.rejects(withMachineContext(c,f.worktree,'late-runner',()=>admitted('agentExecutions','reuse',{},()=>runner.run(request))));
 await assert.rejects(lstat(join(f.worktree,'late-started')),{code:'ENOENT'});
 await withMachineContext(c,f.worktree,'late-runner',()=>admitted('agentExecutions','opaque',{},()=>({status:'aborted'})));
 const claims=(await c.inspect()).claims;
 assert.equal(claims[1].status,'held');assert.equal(claims[2].status,'held');
});

test('hard-linked provider executes and mutations through its alias are rejected', async t => {
  const f = await fixture(t, `cat >/dev/null; printf '%s\\n' '${envelope()}'`);
  const alias = join(f.root, 'npm-linked-provider');
  await link(f.executable, alias);
  const runner = await createProcessRunner({executable: alias, interpreter: f.interpreter, worktree: f.worktree});
  const request = {args: [], cwd: '.', payload: await payload(f)};
  assert.equal((await runner.run(request)).status, 'success');
  await writeFile(f.executable, '#!/bin/sh\nexit 99\n');
  await assert.rejects(runner.run(request), error => error.code === 'ERR_AGENT_EXECUTABLE_UNSAFE');
});

for (const protocol of ['planning', 'launch']) {
  for (const [native, reason] of [
    [{type: 'result', subtype: 'error_max_budget_usd', is_error: true}, 'BUDGET_EXHAUSTED'],
    [{type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['OAuth token has expired. Please run /login. CANARY-PRIVATE']}, 'AUTHENTICATION_REQUIRED'],
  ]) {
    if (protocol === 'launch' && reason === 'BUDGET_EXHAUSTED') continue; // Existing measured-usage coverage.
    test(`Claude ${protocol} classifies ${reason} without exposing provider text`, async t => {
      const f = await fixture(t, `cat >/dev/null; printf '%s\\n' '${JSON.stringify(native)}'; exit 1`);
      const runner = await createProcessRunner({executable: f.executable, interpreter: f.interpreter, worktree: f.worktree, resultFormat: 'claude-json'});
      const request = {args: [], cwd: '.', payload: protocol === 'planning' ? await planningPayload(f) : await payload(f)};
      await assert.rejects(protocol === 'planning' ? runner.runPlanning(request) : runner.run(request), error => error.code === `ERR_AGENT_${reason}` && !error.message.includes('CANARY-PRIVATE'));
    });
  }
}

test('Claude reports an expired login in an is_error result even with a success subtype and zero exit', async t => {
  const native = {type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login'};
  const f = await fixture(t, `cat >/dev/null; printf '%s\\n' '${JSON.stringify(native)}'`);
  const runner = await createProcessRunner({executable: f.executable, interpreter: f.interpreter, worktree: f.worktree, resultFormat: 'claude-json'});
  await assert.rejects(runner.runPlanning({args: [], cwd: '.', payload: await planningPayload(f)}), error => error.code === 'ERR_AGENT_AUTHENTICATION_REQUIRED');
});
