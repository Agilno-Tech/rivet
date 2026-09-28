import assert from 'node:assert/strict';
import {execFile as callback} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm,access,symlink,cp,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import YAML from 'yaml';
import {loadProjectConfig} from '../../src/config/load.js';
import {createFeaturePlanner} from '../../src/feature/planner.js';
import {createFeatureRunStore} from '../../src/feature/run-store.js';
import {resolveFeatureRunPaths} from '../../src/state/paths.js';
import {createFeatureExecutor} from '../../src/feature/runtime-bridge.js';
import {createWorkRequest} from '../../src/work-request/contract.js';
import {promisify} from 'node:util';
import test from 'node:test';
import {inspectDependencyDirectory} from '../../src/runtime/dependency-directory.js';
import {createGitClient} from '../../src/git/client.js';
import {createRivetApplication} from '../../src/runtime/application.js';
import {bootstrapWorktreeDependencies,inspectWorktreeDependencies} from '../../src/runtime/worktree-bootstrap.js';
const execFile=promisify(callback);
test('dependency metadata and inputs reject FIFOs without blocking the process',async t=>{
 const root=await mkdtemp(join(tmpdir(),'rivet-dependency-fifo-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const fifo=join(root,'input');await execFile('mkfifo',[fifo]);
 const url=new URL('../../src/runtime/dependency-directory.js',import.meta.url).href;
 const script=`import {readDependencyFile} from ${JSON.stringify(url)}; try {await readDependencyFile(process.argv[1],4096);process.exitCode=2;} catch {process.exitCode=0;}`;
 const result=await execFile(process.execPath,['--input-type=module','-e',script,fifo],{timeout:2000});
 assert.equal(result.stderr,'');
});
async function fixture(t,steps=[{cwd:'.',argv:['python3','-m','venv','--without-pip','.rivet-deps/venv']}]) {
 const parent=await realpath(await mkdtemp(join(tmpdir(),'rivet-portable-deps-')));t.after(()=>rm(parent,{recursive:true,force:true}));
 const projectRoot=join(parent,'source'),worktreePath=join(parent,'worker');await mkdir(projectRoot);
 await writeFile(join(projectRoot,'requirements.txt'),'# frozen local dependencies\n');
 await execFile('git',['init','--quiet','--initial-branch=main',projectRoot]);
 await execFile('git',['-C',projectRoot,'add','.']);
 await execFile('git',['-C',projectRoot,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--quiet','-m','fixture']);
 const gitClient=await createGitClient({gitExecutable:await realpath('/usr/bin/git')});
 const expectedCommit=(await gitClient.inspectRepository(projectRoot)).headSha;
 await execFile('git',['-C',projectRoot,'worktree','add','--quiet','-b','feature/deps',worktreePath,expectedCommit]);
 const dependencies={inputs:['requirements.txt'],provides:['./.rivet-deps/venv/bin/python'],steps};
 const input={projectRoot,worktreePath,expectedCommit,expectedBranch:'feature/deps',dependencies};
 const app=createRivetApplication({env:process.env});
 return {input,gitClient,parent,options:{gitClient,resolveCommandExecutable:app.resolveCommandExecutable,confirm:async()=>true}};
}
test('portable dependencies bind committed inputs and decline without creating private files',async t=>{
 const f=await fixture(t);const plan=await inspectWorktreeDependencies(f.input,f.options);
 assert.equal(plan.kind,'portable');assert.match(plan.inputs[0].sha256,/^[a-f0-9]{64}$/);assert.deepEqual(plan.steps[0].argv,f.input.dependencies.steps[0].argv);
 assert.deepEqual(await bootstrapWorktreeDependencies(f.input,{...f.options,confirm:async()=>false}),{status:'declined'});
 await assert.rejects(access(join(f.input.worktreePath,'.rivet-deps')));
});
test('portable dependencies create a real isolated venv with clean Git and verify declared executables',async t=>{
 const f=await fixture(t);const result=await bootstrapWorktreeDependencies(f.input,f.options);
 assert.equal(result.status,'ready',JSON.stringify(result));
 const python=join(f.input.worktreePath,'.rivet-deps/venv/bin/python');
 const output=await execFile(python,['-c','import sys; print(sys.prefix)']);assert.equal(output.stdout.trim(),join(f.input.worktreePath,'.rivet-deps/venv'));
 assert.equal((await f.gitClient.inspectRepository(f.input.worktreePath)).dirty,false);
 await assert.rejects(access(join(f.input.projectRoot,'.rivet-deps')));
});
test('approval cannot hide mutated dependency input with assume-unchanged',async t=>{
 const f=await fixture(t);
 await assert.rejects(bootstrapWorktreeDependencies(f.input,{...f.options,confirm:async()=>{
  await execFile('git',['-C',f.input.worktreePath,'update-index','--assume-unchanged','requirements.txt']);
  await writeFile(join(f.input.worktreePath,'requirements.txt'),'malicious change\n');return true;
 }}),/changed|unsafe/i);
 await assert.rejects(access(join(f.input.worktreePath,'.rivet-deps')));
});
test('foreign or symlink dependency directories are never adopted',async t=>{
 for(const kind of ['foreign','symlink']) {
  const f=await fixture(t);const directory=join(f.input.worktreePath,'.rivet-deps');
  if(kind==='foreign'){await mkdir(directory);await writeFile(join(directory,'.gitignore'),'*\n');}else await symlink(f.parent,directory);
  let prompts=0;await assert.rejects(bootstrapWorktreeDependencies(f.input,{...f.options,confirm:async()=>{prompts++;return true;}}));assert.equal(prompts,0);
 }
});
test('configured venv and pip install a committed local wheel without network or global writes',async t=>{
 const f=await fixture(t);
 const wheel='demo_local-1.0-py3-none-any.whl';
 const script=`import zipfile,sys\np=sys.argv[1]\nwith zipfile.ZipFile(p,'w') as z:\n z.writestr('demo_local.py','VALUE = 42\\n')\n z.writestr('demo_local-1.0.dist-info/METADATA','Metadata-Version: 2.1\\nName: demo-local\\nVersion: 1.0\\n')\n z.writestr('demo_local-1.0.dist-info/WHEEL','Wheel-Version: 1.0\\nGenerator: rivet-test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')\n z.writestr('demo_local-1.0.dist-info/RECORD','')\n`;
 await execFile('python3',['-c',script,join(f.input.worktreePath,wheel)]);
 await execFile('git',['-C',f.input.worktreePath,'add',wheel]);
 await execFile('git',['-C',f.input.worktreePath,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--quiet','-m','local wheel']);
 f.input.expectedCommit=(await f.gitClient.inspectRepository(f.input.worktreePath)).headSha;
 f.input.dependencies={inputs:['requirements.txt',wheel],provides:['./.rivet-deps/venv/bin/python'],steps:[
  {cwd:'.',argv:['python3','-m','venv','.rivet-deps/venv']},
  {cwd:'.',argv:['./.rivet-deps/venv/bin/python','-m','pip','--isolated','install','--require-virtualenv','--no-user','--no-index','--no-deps','--no-cache-dir',wheel]},
 ]};
 const result=await bootstrapWorktreeDependencies(f.input,f.options);assert.equal(result.status,'ready',JSON.stringify(result));
 const output=await execFile(join(f.input.worktreePath,'.rivet-deps/venv/bin/python'),['-c','import demo_local; print(demo_local.VALUE)']);assert.equal(output.stdout.trim(),'42');
 assert.equal((await f.gitClient.inspectRepository(f.input.worktreePath)).dirty,false);
});
test('cancelled approval creates no directory and cancellation during installation stops later steps',async t=>{
 const f=await fixture(t);const before=new AbortController();
 await assert.rejects(bootstrapWorktreeDependencies(f.input,{...f.options,signal:before.signal,confirm:async()=>{before.abort();return true;}}));
 await assert.rejects(access(join(f.input.worktreePath,'.rivet-deps')));
 const during=new AbortController();let timer;
 f.input.dependencies={inputs:['requirements.txt'],provides:[],steps:[{cwd:'.',argv:['python3','-c','import time; time.sleep(30)']},{cwd:'.',argv:['python3','-c',"open('.rivet-deps/later','w').write('bad')"]}]};
 await assert.rejects(bootstrapWorktreeDependencies(f.input,{...f.options,signal:during.signal,confirm:async()=>{timer=setTimeout(()=>during.abort(),400);return true;}}));
 clearTimeout(timer);await assert.rejects(access(join(f.input.worktreePath,'.rivet-deps/later')));
});
test('input or ownership drift between steps refuses continuation',async t=>{
 for(const target of ['requirements.txt','.rivet-deps/.rivet-owner.json']) {
  const f=await fixture(t,[{cwd:'.',argv:['python3','-c',`open(${JSON.stringify(target)},'w').write('changed')`]},{cwd:'.',argv:['python3','-c',"open('.rivet-deps/later','w').write('bad')"]}]);
  f.input.dependencies.provides=[];
  await assert.rejects(bootstrapWorktreeDependencies(f.input,f.options));
  await assert.rejects(access(join(f.input.worktreePath,'.rivet-deps/later')));
 }
});

test('spawned portable workflow separately approves and prepares Worker and accepted integration checkouts',async t=>{
 const f=await fixture(t),root=f.input.projectRoot;
 await cp(new URL('../fixtures/config/valid/.rivet/',import.meta.url),join(root,'.rivet'),{recursive:true});
 const projectFile=join(root,'.rivet/project.yaml'),qualityFile=join(root,'.rivet/quality.yaml');
 const project=YAML.parse(await readFile(projectFile,'utf8'));project.schemaVersion=3;project.stack={framework:'other',language:'python',packageManager:'pip'};
 project.dependencies=f.input.dependencies;
 project.commands={test:{steps:[{cwd:'.',argv:['./.rivet-deps/venv/bin/python','-c',"from pathlib import Path; assert Path('result.txt').read_text() == 'implemented' "]}]}};
 await writeFile(projectFile,YAML.stringify(project));
 const quality=YAML.parse(await readFile(qualityFile,'utf8'));quality.commandGates=[{id:'test',command:'test',required:true}];await writeFile(qualityFile,YAML.stringify(quality));
 await execFile('git',['-C',root,'add','.']);await execFile('git',['-C',root,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--quiet','-m','portable policy']);
 const baselineCommit=(await f.gitClient.inspectRepository(root)).headSha,config=await loadProjectConfig(root),now='2029-01-01T00:00:00.000Z';
 const request=createWorkRequest({source:{kind:'inline',ref:'inline'},title:'Portable fixture',description:'Write result.',acceptanceCriteria:['Result exists'],contextRefs:[],capturedAt:now});
 const planner=createFeaturePlanner({planningClient:{propose:async()=>({schemaVersion:1,kind:'agilno.feature-decomposition',workItems:[{objective:'Write result',ownedPaths:['result.txt'],acceptanceCriterionIndexes:[1]}]})}});
 const featurePlan=await planner.propose({config,workRequest:request,baselineCommit,client:'codex'});
 const store=createFeatureRunStore(await resolveFeatureRunPaths(root,'portable-deps-run'));
 const proposed=await store.create({workRequest:request,featurePlan,createdAt:now});
 const approved=await store.update({status:'approved',updatedAt:now,activation:{approverId:'human-cli-operator',approvedAt:now,requestDigest:request.digest,proposalDigest:proposed.proposalDigest},runtimeRefs:[],evidenceRefs:['approval:activation']},{expectedVersion:proposed.version});
 const run=await store.update({status:'running',updatedAt:now,runtimeRefs:approved.runtimeRefs,evidenceRefs:approved.evidenceRefs},{expectedVersion:approved.version});
 const approvals=[],launches=[];
 const executor=createFeatureExecutor({gitClient:f.gitClient,now:()=>now,environment:{PATH:process.env.PATH},resolveCommandExecutable:f.options.resolveCommandExecutable,clientFor:kind=>({provider:kind,launch:async contract=>{
  await access(join(contract.worktree.path,'.rivet-deps/venv/bin/python'));launches.push(contract.worktree.path);
  await writeFile(join(contract.worktree.path,'result.txt'),'implemented');
  return {version:1,status:'success',output:{summary:'Wrote result.',evidence:[...contract.evidence]},usage:{tokens:0,costUsd:0}};
 }})});
 const result=await executor({project:root,run},{confirmDependencyInstall:async plan=>{assert.equal(plan.kind,'portable');approvals.push(plan.worktreePath);return true;}});
 assert.equal(result.status,'awaiting-final-approval',JSON.stringify(result));assert.equal(launches.length,1);assert.equal(approvals.length,2);
 assert.equal(approvals[0],launches[0]);assert.notEqual(approvals[1],launches[0]);assert.match(approvals[1],/integration$/);
 for(const path of approvals)assert.equal((await f.gitClient.inspectRepository(path)).dirty,false);
 await assert.rejects(access(join(root,'.rivet-deps')));
});
test('managed ignored filtering preserves foreign, tampered, untracked, and tracked dependency evidence',async t=>{
 const f=await fixture(t);await bootstrapWorktreeDependencies(f.input,f.options);
 const root=f.input.worktreePath,directory=join(root,'.rivet-deps');
 assert.deepEqual(await f.gitClient.statusPaths(root),[]);
 const marker=await readFile(join(directory,'.rivet-owner.json'));
 await writeFile(join(directory,'.rivet-owner.json'),marker.toString().replace(root,f.input.projectRoot));
 assert.ok((await f.gitClient.statusPaths(root)).includes('.rivet-deps/.rivet-owner.json'));
 await writeFile(join(directory,'.rivet-owner.json'),marker);
 await writeFile(join(directory,'.gitignore'),'*\n!untracked\n');await writeFile(join(directory,'untracked'),'evidence');
 assert.ok((await f.gitClient.statusPaths(root)).includes('.rivet-deps/untracked'));
 await writeFile(join(directory,'.gitignore'),'*\n');await execFile('git',['-C',root,'add','-f','.rivet-deps/untracked']);
 assert.ok((await f.gitClient.statusPaths(root)).includes('.rivet-deps/untracked'));
});

test('copied ownership cannot hide dependency files after directory or same-path checkout replacement',async t=>{
 for(const replaceRoot of [false,true]) {
  const f=await fixture(t);await bootstrapWorktreeDependencies(f.input,f.options);
  const root=f.input.worktreePath,target=replaceRoot?root:join(root,'.rivet-deps'),old=target+'-previous';
  await rename(target,old);
  if(replaceRoot) {await mkdir(root);await cp(join(old,'.rivet-deps'),join(root,'.rivet-deps'),{recursive:true});}
  else await cp(old,target,{recursive:true});
  await assert.rejects(inspectDependencyDirectory(root),/unsafe/);
 }
});
