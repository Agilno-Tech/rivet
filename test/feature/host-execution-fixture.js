import { fixtureGit } from '../helpers/git-executable.js';
import {managedPolicy} from '../fixtures/execution-policy.js';
import {bodyDigest} from '../../src/protocols/project.js';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import YAML from 'yaml';
import { createWorkAction, validateWorkAction } from '../../src/feature/actions.js';
import { main } from '../../src/cli/main.js';
import { EXIT_CODES } from '../../src/cli/output.js';
import { createHostExecution } from '../../src/feature/host-execution.js';
import { createFeatureWorkflow } from '../../src/feature/workflow.js';
import { createGitClient } from '../../src/git/client.js';
import { createReservationStore } from '../../src/git/reservations.js';
import { createReservedWorktree } from '../../src/git/worktrees.js';
import { resolveFeatureRunPaths, resolveStatePaths } from '../../src/state/paths.js';
import { acquireLock } from '../../src/state/lock.js';
import { verificationReportPaths } from '../../src/state/paths.js';
import { createVerificationReportStore } from '../../src/feature/verification-report.js';

const execFile = promisify(execFileCallback);

const CONFIG = new URL('../fixtures/config/valid/.rivet/', import.meta.url);

const NOW = '2029-01-01T00:00:00.000Z';

const PROTOCOL_BODY = '# Database changes\n\nExisting reviewed procedure.\n';

const PROTOCOL_METADATA = {schemaVersion: 1, id: 'database-changes', title: 'Database changes', status: 'active', revision: 3, updatedAt: '2026-09-26T00:00:00.000Z'};

PROTOCOL_METADATA.digest = bodyDigest(PROTOCOL_METADATA, PROTOCOL_BODY);

const PROTOCOL_REF = `protocol:database-changes:3:${PROTOCOL_METADATA.digest}`;

async function git(root, ...args) {
  return (await execFile(fixtureGit, ['-C', root, ...args])).stdout.trim();
}

async function npmExecutable() {
  const { stdout } = await execFile('which', ['npm']);
  return realpath(stdout.trim());
}

async function fixture(t, { now = NOW, schemaV2 = false, ownedPaths = ['app/agenda.js'], lockedDependencies = false, hostContext = false, repositoryRemote, workType, managed = false, verificationReuse = false, workItems, portableDependencies = false, verificationBatch = false, argvScripts = false } = {}) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'rivet-host-execution-')));
  const root = join(parent, 'project');
  await mkdir(root);
  t.after(() => rm(parent, { recursive: true, force: true }));
  await cp(CONFIG, join(root, '.rivet'), { recursive: true });
  if(managed) { const path=join(root,'.rivet','orchestration.yaml'); const config=YAML.parse(await readFile(path,'utf8'));config.executionPolicy=managedPolicy();if(typeof managed==='object')Object.assign(config.executionPolicy.sessions,managed);await writeFile(path,YAML.stringify(config)); }
  if(workItems) {
    const path=join(root,'.rivet','orchestration.yaml');const config=YAML.parse(await readFile(path,'utf8'));
    for(const role of config.roles)if(role.kind==='worker'||role.kind==='manager')role.capacity=2;
    await writeFile(path,YAML.stringify(config));
  }
  await writeFile(join(root, 'README.md'), '# Host execution fixture\n');
  if (lockedDependencies) {
    await writeFile(join(root, '.gitignore'), 'node_modules/\n');
    await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  }
  if (schemaV2) {
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'host-v2-root',
      scripts: {
        build: 'node -e "require(\'node:fs\').writeFileSync(\'fallback-ran\', \'ran\');process.exit(71)"',
        test: 'node -e "require(\'node:fs\').writeFileSync(\'fallback-ran\', \'ran\');process.exit(72)"',
      },
    }));
    for (const name of ['backend', 'frontend']) await mkdir(join(root, name));
    await writeFile(join(root, 'backend', 'package.json'), JSON.stringify({
      name: 'host-v2-backend',
      scripts: {
        build: 'node -e "process.exit(require(\'./package.json\').name === \'host-v2-backend\' ? 0 : 81)"',
        test: 'node -e "process.exit(require(\'./package.json\').name === \'host-v2-backend\' ? 0 : 82)"',
      },
    }));
    await writeFile(join(root, 'frontend', 'package.json'), JSON.stringify({
      name: 'host-v2-frontend',
      scripts: {
        build: 'node -e "process.exit(require(\'./package.json\').name === \'host-v2-frontend\' ? 0 : 83)"',
      },
    }));
    await writeFile(join(root, '.rivet', 'project.yaml'), [
      'schemaVersion: 2',
      'id: host-v2-project',
      'name: Host V2 Project',
      'stack:',
      '  framework: other',
      '  language: javascript',
      '  packageManager: npm',
      'repository:',
      '  defaultBranch: main',
      '  branchPattern: feature/{slug}',
      '  sensitivePaths: [.env]',
      'commands:',
      '  build:',
      '    steps:',
      '      - {cwd: backend, argv: [npm, run, build]}',
      '      - {cwd: frontend, argv: [npm, run, build]}',
      '  test:',
      '    steps:',
      '      - {cwd: backend, argv: [npm, run, test]}',
      '',
    ].join('\n'));
    await writeFile(join(root, '.rivet', 'quality.yaml'), [
      'schemaVersion: 1',
      'providerRefs: [figma-main, git-ci-main]',
      'completionProfileRefs: [engineering, delivery]',
      'commandGates:',
      '  - {id: build, command: build, required: true}',
      '  - {id: test, command: test, required: true}',
      'expectations:',
      '  storybook: optional',
      '  playwright: optional',
      '  accessibility: wcag-aa',
      '  security: required',
      '  visual: none',
      'evidence:',
      '  requiredTypes: [commit, test, review, human-approval]',
      '  requireHumanBaseline: false',
      '  requireHumanFinal: true',
      '',
    ].join('\n'));
  } else {
    await writeFile(join(root, 'package.json'), JSON.stringify({
      scripts: { build: 'x', test: 'x', lint: 'x', typecheck: 'x', dev: 'x' },
    }));
  }
  if(portableDependencies) {
    const path=join(root,'.rivet','project.yaml');const config=YAML.parse(await readFile(path,'utf8'));
    config.schemaVersion=3;
    config.dependencies={inputs:['package.json'],provides:[],steps:[{cwd:'.',argv:['node','install.js']}]};
    config.commands=Object.fromEntries(Object.keys(config.commands).filter(name=>name!=='dev').map(name=>[name,{steps:[{cwd:'.',argv:['node','gate.js']}]}]));
    await writeFile(path,YAML.stringify(config));
    await writeFile(join(root,'install.js'),"require('node:fs').writeFileSync('.rivet-deps/ready','ready');\n");
    await writeFile(join(root,'gate.js'),"process.exit(require('node:fs').existsSync('.rivet-deps/ready') ? 0 : 1);\n");
  }
  if(argvScripts) {
    const path=join(root,'.rivet','project.yaml');const project=YAML.parse(await readFile(path,'utf8'));
    project.schemaVersion=3;project.commands=Object.fromEntries(Object.keys(project.commands).filter(k=>k!=='dev').map(k=>[k,{steps:[{cwd:'.',argv:['./scripts/check']}]}]));
    await writeFile(path,YAML.stringify(project));await mkdir(join(root,'scripts'));
    await writeFile(join(root,'scripts','check'),'#!/bin/sh\nexit 0\n');await chmod(join(root,'scripts','check'),0o700);
  }
  if(verificationBatch) {
    const path=join(root,'.rivet','quality.yaml');const quality=YAML.parse(await readFile(path,'utf8'));
    quality.verificationBatch={enabled:true,maxTasks:3,waitMs:1,maxIsolationTasks:2};
    await writeFile(path,YAML.stringify(quality));
  }
  if (repositoryRemote) {
    const path = join(root, '.rivet', 'project.yaml');
    const config = YAML.parse(await readFile(path, 'utf8'));
    config.repository.remote = repositoryRemote;
    await writeFile(path, YAML.stringify(config));
  }
  let hostSource;
  if (hostContext) {
    const providerPath = join(root, '.rivet', 'providers.yaml');
    const providers = YAML.parse(await readFile(providerPath, 'utf8'));
    const jira = providers.providers.find(p => p.kind === 'jira');
    Object.assign(jira, { transport: 'harness-mcp', tools: ['get_issue'], endpoint: 'https://jira.example.test', resourceIds: ['DEMO-1'] });
    await writeFile(providerPath, YAML.stringify(providers));
    const project = YAML.parse(await readFile(join(root, '.rivet', 'project.yaml'), 'utf8'));
    hostSource = { kind: 'host-observation', value: { schemaVersion: 1, projectId: project.id,
      host: { projectId: project.id, providers: [{ id: jira.id, authenticated: true, tools: ['get_issue'] }] },
      request: { providerId: jira.id, resourceId: 'DEMO-1' },
      observations: [{ schemaVersion: 1, projectId: project.id, providerId: jira.id, tool: 'get_issue',
        resourceId: 'DEMO-1', sourceUrl: 'https://jira.example.test/browse/DEMO-1', revision: '1', capturedAt: NOW,
        content: { title: 'Add agenda', description: 'Add the agenda implementation.', acceptanceCriteria: ['Add the agenda implementation.'] } }],
    } };
  }
  if (verificationReuse) {
    const path=join(root,'.rivet','quality.yaml');
    const quality=YAML.parse(await readFile(path,'utf8'));
    quality.verificationReuse={enabled:true,reproducible:true,dependencyRoots:['inputs'],toolchainRoots:['tools']};
    await writeFile(path,YAML.stringify(quality));
    for(const directory of ['inputs','tools']) {
      await mkdir(join(root,directory));
      await writeFile(join(root,directory,'.keep'),'fixture\n');
    }
  }
  await mkdir(join(root, '.rivet', 'protocols'), {recursive: true});
  await writeFile(join(root, '.rivet', 'protocols', 'database-changes.md'), '---\n' + YAML.stringify(PROTOCOL_METADATA) + '---\n\n' + PROTOCOL_BODY);
  await execFile(fixtureGit, ['init', '--quiet', '--initial-branch=main', root]);
  await git(root, 'add', '.');
  await git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  const { stdout: gitPath } = await execFile('which', ['git']);
  const gitClient = await createGitClient({ gitExecutable: await realpath(gitPath.trim()) });
  const workflow = createFeatureWorkflow({
    gitClient,
    now: () => now,
    protocolsFor: async () => [PROTOCOL_REF],
    planningClientFor: async () => { throw new Error('host execution must not resolve a planning client'); },
    executeFeature: async () => { throw new Error('host execution must not use the spawned executor'); },
  });
  const proposal = await workflow.propose({
    project: root,
    source: hostSource ?? { kind: 'inline', value: '# Add agenda\n\n## Acceptance criteria\n\n- Add the agenda implementation.\n' },
    client: 'host',
    decomposition: {
      schemaVersion: 1,
      kind: 'agilno.feature-decomposition',
      ...(workType ? {workType} : {}),
      workItems: workItems ?? [{
        objective: 'Add the agenda implementation.',
        ownedPaths,
        acceptanceCriterionIndexes: [1],
      }],
    },
  });
  const approved = await workflow.start({
    project: root,
    runId: proposal.runId,
    expectedVersion: proposal.version,
    proposalDigest: proposal.proposalDigest,
  });
  const gate = join(parent, 'gate');
  await writeFile(gate, '#!/bin/sh\nexit 0\n');
  await chmod(gate, 0o700);
  return { root, gitClient, approved, gate, workflow };
}

function resultFor(action, overrides = {}) {
  const payload = JSON.parse(action.payload);
  return {
    version: 1,
    status: 'success',
    output: { summary: 'Implemented the bounded host action.', evidence: payload.contract.evidence },
    usage: { tokens: 10, costUsd: 0 },
    ...overrides,
  };
}

async function completedWorker(t, options = {}) {
  const fixtureValue = await fixture(t, options);
  const { root, gitClient, approved, gate } = fixtureValue;
  const execution = createHostExecution({
    gitClient, now: () => NOW,
    resolveCommandExecutable: async () => gate,
    environment: { PATH: process.env.PATH },
  });
  const prepared = await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  const next = await execution.nextAction({
    project: root, runId: approved.runId, expectedRuntimeVersion: prepared.runtimeVersion,
  });
  const worktree = JSON.parse(next.action.payload).contract.worktree.path;
  await mkdir(join(worktree, 'app'), { recursive: true });
  await writeFile(join(worktree, 'app', 'agenda.js'), 'export const agenda = true;\n');
  const submitted = await execution.submitResult({
    project: root, runId: approved.runId,
    expectedRuntimeVersion: next.runtimeVersion,
    action: next.action, result: resultFor(next.action),
  });
  assert.equal(submitted.status, 'accepted');
  const verifyInput = {
    project: root, runId: approved.runId,
    expectedRunVersion: prepared.run.version,
    expectedRuntimeVersion: submitted.runtimeVersion,
  };
  return { ...fixtureValue, execution, verifyInput };
}

async function waitForFile(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await access(path); return; } catch {}
    await delay(25);
  }
  throw new Error('Gate start marker was not written');
}

async function directoryBytes(root) {
  const files = {};
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files[path] = (await readFile(path)).toString('base64');
    }
  }
  await visit(root);
  return files;
}

async function abandonedHostLock(path, overrides = {}) {
  const { hostname } = await import('node:os');
  const { randomUUID } = await import('node:crypto');
  await writeFile(path, JSON.stringify({ pid: 2147483647, host: hostname(), timestamp: '2000-01-01T00:00:00.000Z', ownerId: randomUUID(), ...overrides }), { mode: 0o600 });
}

async function managedWorker(t,options={}) {
 const context=await fixture(t,{managed:options.policy??true});
 const clock={now:Date.parse(NOW)};
 const execution=createHostExecution({gitClient:context.gitClient,now:()=>new Date(clock.now).toISOString()});
 const prepared=await execution.prepare({project:context.root,runId:context.approved.runId,expectedRunVersion:context.approved.version});
 const next=await execution.nextAction({project:context.root,runId:context.approved.runId,expectedRuntimeVersion:prepared.runtimeVersion});
 const worktree=JSON.parse(next.action.payload).contract.worktree.path;
 await mkdir(join(worktree,'app'),{recursive:true});await writeFile(join(worktree,'app','agenda.js'),'export const agenda = true;\n');
 return {...context,execution,next,worktree,clock};
}

async function readyBatchGroup(t,options={}) {
 const f=await completedWorker(t,{verificationBatch:true,...options});const ids=[f.approved.runId];
 for(const name of ['second','third']) {
  const proposal=await f.workflow.propose({project:f.root,client:'host',source:{kind:'inline',value:`# Add ${name}\n\n## Acceptance criteria\n\n- Add ${name}.\n`},decomposition:{schemaVersion:1,kind:'agilno.feature-decomposition',workItems:[{objective:`Add ${name}.`,ownedPaths:[`app/${name}.js`],acceptanceCriterionIndexes:[1]}]}});
  const approved=await f.workflow.start({project:f.root,runId:proposal.runId,expectedVersion:proposal.version,proposalDigest:proposal.proposalDigest});
  const prepared=await f.execution.prepare({project:f.root,runId:approved.runId,expectedRunVersion:approved.version});
  const next=await f.execution.nextAction({project:f.root,runId:approved.runId,expectedRuntimeVersion:prepared.runtimeVersion});
  const path=JSON.parse(next.action.payload).contract.worktree.path;
  await mkdir(join(path,'app'),{recursive:true});await writeFile(join(path,'app',`${name}.js`),`export const ${name}=true;\n`);
  await f.execution.submitResult({project:f.root,runId:approved.runId,expectedRuntimeVersion:next.runtimeVersion,action:next.action,result:resultFor(next.action)});ids.push(approved.runId);
 }
 return {...f,ids};
}

export { execFile, CONFIG, NOW, PROTOCOL_BODY, PROTOCOL_METADATA, PROTOCOL_REF, git, npmExecutable, fixture, resultFor, completedWorker, waitForFile, directoryBytes, abandonedHostLock, managedWorker, readyBatchGroup };
