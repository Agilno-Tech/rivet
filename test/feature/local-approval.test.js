import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile as execute } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';
import {main} from '../../src/cli/main.js';
import {recoverHostRunLocks} from '../../src/feature/host-lock-recovery.js';
import {loadProjectConfig} from '../../src/config/load.js';
import {createFeaturePlan, featurePlanDigest} from '../../src/feature/plan-contract.js';
import {hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import {bodyDigest} from '../../src/protocols/project.js';
import {resolveExistingFeatureRunPaths} from '../../src/state/paths.js';
import {applyVerifiedTask} from '../../src/feature/local-approval.js';
import { createFeatureWorkflow } from '../../src/feature/workflow.js';
import { createHostExecution } from '../../src/feature/host-execution.js';
import { createGitClient } from '../../src/git/client.js';
import { createRivetApplication } from '../../src/runtime/application.js';

const execFile = promisify(execute);
const NOW = '2026-01-01T00:00:00.000Z';
const CONFIG = new URL('../fixtures/config/valid/.rivet', import.meta.url);

async function tools(t) {
  let gitPath;
  try {
    gitPath = (await execFile('which', ['git'])).stdout.trim();
    await execFile('python3', ['--version']);
  } catch (error) {
    if (error.code === 'ENOENT' || (!gitPath && error.code === 1)) {
      t.skip('Git and Python 3 are required for this real local workflow test.');
      return null;
    }
    throw error;
  }
  return { git: await realpath(gitPath) };
}

async function pythonHost(t, {localConfig=false,protocolChange=false,ignoredCollision=false}={}) {
  const available = await tools(t);
  if (!available) return null;
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'rivet-python-host-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'python project');
  await mkdir(join(root, 'tests'), { recursive: true });
  await cp(CONFIG, join(root, '.rivet'), { recursive: true });
  const projectFile = join(root, '.rivet/project.yaml');
  const project = YAML.parse(await readFile(projectFile, 'utf8'));
  project.schemaVersion = 3;
  project.stack = { framework: 'other', language: 'python', packageManager: 'pip' };
  project.commands = { test: { steps: [{ cwd: '.', argv: ['python3', '-B', '-m', 'unittest', 'discover', '-s', 'tests', '-v'] }] } };
  await writeFile(projectFile, YAML.stringify(project));
  const qualityFile = join(root, '.rivet/quality.yaml');
  const quality = YAML.parse(await readFile(qualityFile, 'utf8'));
  quality.commandGates = [{ id: 'python-tests', command: 'test', required: true }];
  await writeFile(qualityFile, YAML.stringify(quality));
  await writeFile(join(root, 'calculator.py'), 'def add(left, right):\n    return 0\n');
  await writeFile(join(root, 'tests/test_calculator.py'), [
    'import unittest',
    'from calculator import add',
    'class Calculator(unittest.TestCase):',
    '    def test_add(self):',
    '        self.assertEqual(add(2, 3), 5)',
    '',
  ].join('\n'));
  if(protocolChange){
    const body='# Testing procedure\n\nUse the configured checks.\n';
    const meta={schemaVersion:1,id:'testing',title:'Testing',status:'active',revision:1,updatedAt:NOW};
    meta.digest=bodyDigest(meta,body);
    await mkdir(join(root,'.rivet/protocols'),{recursive:true});
    await writeFile(join(root,'.rivet/protocols/testing.md'),'---\n'+YAML.stringify(meta)+'---\n'+body);
  }
  const git = async (...args) => (await execFile(available.git, ['-C', root, ...args])).stdout.trim();
  await execFile(available.git, ['init', '--quiet', '--initial-branch=main', root]);
  if(localConfig)await writeFile(join(root,'.gitignore'),'.rivet/\n');
  if(ignoredCollision){
    await writeFile(join(root,'.gitignore'),'local.txt\n');
    await writeFile(join(root,'local.txt'),'USER LOCAL\n');
  }
  await git('add', '.');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'Python fixture');
  const gitClient = await createGitClient({ gitExecutable: available.git });
  const workflow = createFeatureWorkflow({
    gitClient, now: () => NOW,
    planningClientFor: async () => { throw new Error('Host workflow must not invoke a planning model.'); },
    executeFeature: async () => { throw new Error('Host workflow must not spawn a model.'); },
  });
  const proposed = await workflow.propose({
    project: root, client: 'host',
    source: { kind: 'inline', value: '# Fix addition\n\n## Acceptance criteria\n- add returns the sum of its arguments.\n' },
    decomposition: { schemaVersion: 1, kind: 'agilno.feature-decomposition', workItems: [{
      objective: 'Fix Python addition.', ownedPaths: ignoredCollision ? ['calculator.py','.gitignore','local.txt'] : ['calculator.py'], acceptanceCriterionIndexes: [1],
    }] },
  });
  const approved = await workflow.start({ project: root, runId: proposed.runId, expectedVersion: proposed.version, proposalDigest: proposed.proposalDigest });
  // Poison Node package-manager discovery so accidental bootstrap cannot pass silently.
  const poison = join(parent, 'forbidden-tools');
  const marker = join(parent, 'node-bootstrap-called');
  await mkdir(poison);
  for (const command of ['npm', 'pnpm', 'yarn', 'bun']) {
    await writeFile(join(poison, command), '#!/bin/sh\nprintf forbidden > "$RIVET_BOOTSTRAP_MARKER"\nexit 91\n', { mode: 0o700 });
  }
  const environment = { PATH: `${poison}:${process.env.PATH}`, RIVET_BOOTSTRAP_MARKER: marker };
  const application = createRivetApplication({ env: environment });
  const resolved = [];
  const execution = createHostExecution({ gitClient, now: () => NOW, environment,
    resolveCommandExecutable: async (command, options) => {
      resolved.push(command);
      assert.equal(command, 'python3', 'Python-only verification must not resolve a Node package manager.');
      return application.resolveCommandExecutable(command, options);
    },
  });
  const prepared = await execution.prepare({ project: root, runId: approved.runId, expectedRunVersion: approved.version });
  const next = await execution.nextAction({ project: root, runId: approved.runId, expectedRuntimeVersion: prepared.runtimeVersion });
  const payload = JSON.parse(next.action.payload).contract;
  return { root, marker, resolved, approved, prepared, next, payload, execution, gitClient };
}

async function verified(t, options) {
  const f = await pythonHost(t, options); if (!f) return null;
  await writeFile(join(f.payload.worktree.path, 'calculator.py'), 'def add(left, right):\n    return left + right\n');
  if(options?.ignoredCollision){
    await writeFile(join(f.payload.worktree.path,'.gitignore'),'# no generated local files\n');
    await writeFile(join(f.payload.worktree.path,'local.txt'),'CANDIDATE\n');
  }
  const submitted = await f.execution.submitResult({project:f.root, runId:f.approved.runId,
    expectedRuntimeVersion:f.next.runtimeVersion, action:f.next.action,
    result:{version:1,status:'success',output:{summary:'Corrected addition.', evidence:f.payload.evidence},usage:{tokens:0,costUsd:0}}});
  await f.execution.verify({project:f.root,runId:f.approved.runId,expectedRunVersion:f.prepared.run.version,expectedRuntimeVersion:submitted.runtimeVersion});
  f.status = await f.execution.status({project:f.root,runId:f.approved.runId});
  f.apply = confirm => applyVerifiedTask({project:f.root,runId:f.approved.runId,gitClient:f.gitClient,confirm});
  return f;
}

test('local application applies only verified commit, records local acceptance, and repeats without confirmation', async t => {
  const f=await verified(t); if(!f)return;
  let preview;
  const result=await f.apply(async value=>{preview=value;return true;});
  assert.equal(result.status,'completed');
  assert.deepEqual(preview.changedPaths,['calculator.py']);
  assert.equal(preview.commitSha,f.status.verification.commitSha);
  assert.equal((await f.gitClient.inspectRepository(f.root)).headSha,preview.commitSha);
  assert.equal((await f.execution.status({project:f.root,runId:f.approved.runId})).runtime.nodes.find(n=>n.id==='final-delivery').status,'ready');
  assert.equal((await f.apply(()=>{throw Error('repeat must not ask');})).status,'completed');
});

test('decline leaves source and run unchanged with no approval files', async t => {
  const f=await verified(t);if(!f)return;
  assert.equal((await f.apply(()=>false)).status,'declined');
  assert.equal((await f.gitClient.inspectRepository(f.root)).headSha,f.approved.featurePlan.baselineCommit);
  assert.equal((await f.execution.status({project:f.root,runId:f.approved.runId})).run.status,'awaiting-final-approval');
});

for(const where of ['source','integration']) test(`changed ${where} during confirmation cannot be applied`,async t=>{
 const f=await verified(t);if(!f)return;
 await assert.rejects(f.apply(async()=>{await writeFile(join(where==='source'?f.root:f.status.checkout.path,'calculator.py'),'changed');return true;}),{code:'ERR_LOCAL_APPROVAL_CONFLICT'});
 assert.equal((await f.gitClient.inspectRepository(f.root)).headSha,f.approved.featurePlan.baselineCommit);
});

for(const side of ['source','integration']) test(`moved ${side} tip during approval is rejected`,async t=>{
 const f=await verified(t);if(!f)return;
 await assert.rejects(f.apply(async()=>{
  const cwd=side==='source'?f.root:f.status.checkout.path;
  await execFile('/usr/bin/git',['-C',cwd,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','Moved']);
  return true;
 }),{code:'ERR_LOCAL_APPROVAL_CONFLICT'});
});

test('assume-unchanged configuration drift is rejected before requesting approval',async t=>{
 const f=await verified(t);if(!f)return;
 await execFile('/usr/bin/git',['-C',f.root,'update-index','--assume-unchanged','.rivet/project.yaml']);
 const path=join(f.root,'.rivet/project.yaml');
 await writeFile(path,(await readFile(path,'utf8')).replace('Conference Planner','Changed project'));
 await assert.rejects(f.apply(()=>{throw Error('must not confirm');}),error=>error.code==='ERR_LOCAL_APPROVAL_CONFIGURATION' && /Commit intended configuration changes/.test(error.safeMessage));
});

test('verification changed across confirmation is rejected',async t=>{
 const f=await verified(t);if(!f)return;
 const paths=await resolveExistingFeatureRunPaths(f.root,f.approved.runId);
 await assert.rejects(f.apply(async()=>{
   const path=join(paths.runDir,'verification.json');const data=JSON.parse(await readFile(path,'utf8'));
   data.data.checkedAt='2026-01-02T00:00:00.000Z';await writeFile(path,JSON.stringify(data)+'\n');return true;
 }),{code:'ERR_LOCAL_APPROVAL_CONFLICT'});
});

for(const point of ['before-git','after-git','after-receipt']) test(`interruption ${point} never repeats a merge`,async t=>{
 const f=await verified(t);if(!f)return;
 const paths=await resolveExistingFeatureRunPaths(f.root,f.approved.runId);
 const before=await readFile(paths.snapshotPath,'utf8');
 await f.apply(()=>true);
 // Reconstruct the durable prefix present at a crash, retaining the exact
 // authentic intent emitted by the successful operation.
 await writeFile(paths.snapshotPath,before);
 if(point!=='after-receipt')await unlink(join(paths.runDir,'local-approval-receipt.json'));
 if(point==='before-git')await execFile('/usr/bin/git',['-C',f.root,'reset','--hard',f.approved.featurePlan.baselineCommit]);
 if(point==='before-git'){
  await assert.rejects(f.apply(()=>{throw Error('old approval cannot authorize another merge');}),{code:'ERR_LOCAL_APPROVAL_INTERRUPTED'});
  assert.equal((await f.gitClient.inspectRepository(f.root)).headSha,f.approved.featurePlan.baselineCommit);
 }else{
  assert.equal((await f.apply(()=>{throw Error('receipt reconciliation needs no new merge approval');})).status,'completed');
  assert.equal((await f.gitClient.inspectRepository(f.root)).headSha,f.status.verification.commitSha);
 }
});

test('corrupt completion receipt cannot authorize repeated acceptance',async t=>{
 const f=await verified(t);if(!f)return;
 await f.apply(()=>true);
 const paths=await resolveExistingFeatureRunPaths(f.root,f.approved.runId);
 await writeFile(join(paths.runDir,'local-approval-receipt.json'),'{}');
 await assert.rejects(f.apply(()=>true),{code:'ERR_LOCAL_APPROVAL_CONFLICT'});
});

test('cancellation at approval does not write intent or update Git',async t=>{
 const f=await verified(t);if(!f)return;
 const controller=new AbortController();
 await assert.rejects(applyVerifiedTask({project:f.root,runId:f.approved.runId,gitClient:f.gitClient,signal:controller.signal,
  confirm:()=>{controller.abort();return true;}}),{code:'ERR_LOCAL_APPROVAL_CANCELLED'});
 const paths=await resolveExistingFeatureRunPaths(f.root,f.approved.runId);
 await assert.rejects(access(join(paths.runDir,'local-approval-intent.json')),{code:'ENOENT'});
 assert.equal((await f.gitClient.inspectRepository(f.root)).headSha,f.approved.featurePlan.baselineCommit);
});


test('local-only untracked configuration gives a commit-and-reverify remedy',async t=>{
 const f=await verified(t,{localConfig:true});if(!f)return;
 await assert.rejects(f.apply(()=>{throw Error('must not confirm');}),
  error=>error.code==='ERR_LOCAL_APPROVAL_CONFIGURATION' && /Commit intended configuration changes/.test(error.safeMessage));
});

test('selected protocol change cannot move the source before reporting drift',async t=>{
 const f=await verified(t,{protocolChange:true});if(!f)return;
 assert.equal(f.status.deliveryReady,true);
 await assert.rejects(f.apply(async()=>{
  await writeFile(join(f.root,'.rivet/protocols/testing.md'),'changed selected protocol\n');return true;
 }),{code:'ERR_LOCAL_APPROVAL_CONFLICT'});
 assert.equal((await f.gitClient.inspectRepository(f.root)).headSha,f.approved.featurePlan.baselineCommit);
});

test('actual task approve CLI applies verified work after local choice and confirmation',async t=>{
 const f=await verified(t);if(!f)return;
 const lines=[];let confirmations=0;
 const code=await main(['task','approve'],{cwd:()=>f.root,work:f.execution,terminalIsInteractive:()=>true,
  taskApprovalPrompt:async()=> 'local',confirmTaskApplication:async()=>{confirmations++;return true;},
  resolveCommandExecutable:async()=>'/usr/bin/git',
  output:{log:value=>lines.push(value),error:value=>lines.push(value)}});
 assert.equal(code,0,lines.join('\n'));
 assert.equal(confirmations,1);
 assert.equal((await f.gitClient.inspectRepository(f.root)).headSha,f.status.verification.commitSha);
 assert.equal((await f.execution.status({project:f.root,runId:f.approved.runId})).run.status,'completed');
});

test('ignored user file collision preserves source content and cannot complete',async t=>{
 const f=await verified(t,{ignoredCollision:true});if(!f)return;
 assert.equal((await f.gitClient.inspectRepository(f.root)).dirty,false);
 await assert.rejects(f.apply(()=>true),{code:'ERR_LOCAL_APPROVAL_CONFLICT'});
 assert.equal(await readFile(join(f.root,'local.txt'),'utf8'),'USER LOCAL\n');
 assert.equal((await f.gitClient.inspectRepository(f.root)).headSha,f.approved.featurePlan.baselineCommit);
 assert.equal((await f.execution.status({project:f.root,runId:f.approved.runId})).run.status,'awaiting-final-approval');
});

for(const [live,active] of [[false,false],[true,false],[false,true]]) test(`finalized spawned lock recovery ${active?'rejects active spawned state':live?'preserves live owner':'clears only dead aged locks without restarting work'}`,async t=>{
 const f=await verified(t);if(!f)return;
 const paths=await resolveExistingFeatureRunPaths(f.root,f.approved.runId);
 // The identical completed graph/evidence is valid for a spawned plan. Persist
 // that transport choice with its matching digest to isolate lock recovery from
 // any model process; no fake recovery or filesystem calls are injected.
 const saved=JSON.parse(await readFile(paths.snapshotPath,'utf8'));
 saved.data.featurePlan.client='codex';
 saved.data.featurePlan=createFeaturePlan({proposal:saved.data.featurePlan,config:await loadProjectConfig(f.root),
  workRequest:saved.data.workRequest,baselineCommit:saved.data.featurePlan.baselineCommit,client:'codex'});
 saved.data.proposalDigest=featurePlanDigest(saved.data.featurePlan);
 saved.data.activation.proposalDigest=saved.data.proposalDigest;
 if(active)saved.data.status='running';
 await writeFile(paths.snapshotPath,JSON.stringify(saved)+'\n');
 const before=await readFile(paths.snapshotPath,'utf8');
 const path=join(paths.runDir,'host-operation.lock');
 await writeFile(path,JSON.stringify({pid:live?process.pid:2147483647,host:hostname(),timestamp:'2000-01-01T00:00:00.000Z',ownerId:randomUUID()}),{mode:0o600});
 if(active){
  await assert.rejects(recoverHostRunLocks(f.root,f.approved.runId),{code:'ERR_HOST_RUN_RECOVERY_STATE'});
  await access(path);assert.equal(await readFile(paths.snapshotPath,'utf8'),before);return;
 }
 if(!live)await assert.rejects(f.apply(()=>true),error=>error.code==='ERR_LOCAL_APPROVAL_INTERRUPTED' && error.safeMessage.includes(`task recover --run=${f.approved.runId}`));
 const recovered=await recoverHostRunLocks(f.root,f.approved.runId);
 assert.equal(recovered.status,live?'blocked':'recovered');
 assert.deepEqual(recovered.recoveredLocks,live?[]:['host-operation']);
 assert.equal(await readFile(paths.snapshotPath,'utf8'),before);
 assert.equal((await f.gitClient.inspectRepository(f.root)).headSha,f.approved.featurePlan.baselineCommit);
 if(live)await access(path);else await assert.rejects(access(path),{code:'ENOENT'});
});

test('actual task approve pull-request choice prepares delivery without moving source or writing remotely',async t=>{
 const f=await verified(t);if(!f)return;
 await execFile('/usr/bin/git',['-C',f.root,'remote','add','origin','https://github.com/example/project.git']);
 const lines=[];
 const code=await main(['task','approve'],{cwd:()=>f.root,work:f.execution,terminalIsInteractive:()=>true,
  taskApprovalPrompt:async()=> 'pull-request',resolveCommandExecutable:async()=>'/usr/bin/git',
  fetch:async()=>{throw Error('remote calls forbidden');},
  output:{log:value=>lines.push(value),error:value=>lines.push(value)}});
 assert.equal(code,0,lines.join('\n'));
 assert.match(lines.join('\n'),/Delivery prepared locally/);
 assert.equal((await f.gitClient.inspectRepository(f.root)).headSha,f.approved.featurePlan.baselineCommit);
 assert.equal((await f.execution.status({project:f.root,runId:f.approved.runId})).run.status,'awaiting-final-approval');
 const paths=await resolveExistingFeatureRunPaths(f.root,f.approved.runId);
 const delivery=JSON.parse(await readFile(join(paths.runDir,'delivery.json'),'utf8'));
 assert.equal(delivery.data.candidate.headSha,f.status.verification.commitSha);
});

test('guided final review shows the exact diff and leaving preserves the source and task',async t=>{
 const f=await verified(t);if(!f)return;
 const lines=[];let choices=0;
 const code=await main(['task','resume'],{cwd:()=>f.root,work:f.execution,terminalIsInteractive:()=>true,
  taskApprovalPrompt:async()=>++choices===1?'review':'leave',
  confirmTaskApplication:async()=>assert.fail('review is not approval'),
  resolveCommandExecutable:async()=>'/usr/bin/git',
  output:{log:value=>lines.push(value),error:value=>lines.push(value)}});
 assert.equal(code,0,lines.join('\n'));assert.equal(choices,2);
 assert.match(lines.join('\n'),/\+    return left \+ right/);
 assert.equal((await f.gitClient.inspectRepository(f.root)).headSha,f.approved.featurePlan.baselineCommit);
 assert.equal((await f.execution.status({project:f.root,runId:f.approved.runId})).run.status,'awaiting-final-approval');
});
