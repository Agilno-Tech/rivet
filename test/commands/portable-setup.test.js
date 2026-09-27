import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,rm,readFile,access,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {discoverProject} from '../../src/discovery/project.js';
import {init} from '../../src/commands/init.js';
import {loadProjectConfig} from '../../src/config/load.js';
import {parseArgs} from '../../src/cli/parse-args.js';
import {setupCommand} from '../../src/commands/setup.js';
import {diagnoseDoctor} from '../../src/commands/doctor.js';
import {realpath} from 'node:fs/promises';
import {discoverTools} from '../../src/discovery/tools.js';
import {parseCheckCommand} from '../../src/discovery/portable.js';
import {preflight} from '../../src/commands/preflight.js';

async function fixture(t, files={}) {
  const root=await mkdtemp(join(tmpdir(),'rivet-portable-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  for(const [name,body] of Object.entries(files)) await writeFile(join(root,name),body);
  return root;
}
test('mixed schema3 executors preserve Node and Git runtime readiness regardless of order',async t=>{
  const root=await realpath(await fixture(t));
  const config=structuredClone(await loadProjectConfig(new URL('../fixtures/config/valid/',import.meta.url).pathname));
  config.project.schemaVersion=3;
  config.project.stack={framework:'other',language:'other',packageManager:'other'};
  config.quality.commandGates=[{id:'test',command:'test',required:true}];
  for(const names of [['custom-tool','node','git'],['git','custom-tool','node']]) {
    config.project.commands={test:{steps:names.map(name=>({cwd:'.',argv:[name,'verify']}))}};
    const report=await diagnoseDoctor(root,{
      hostReadiness:true,configLoader:async()=>config,
      toolDiscovery:async()=>({node:{present:true,supported:true,version:'22.0.0'},git:{present:true,supported:true,version:'2.0.0'}}),
      resolveCommandExecutable:async()=>realpath(process.execPath),
    });
    assert.equal(report.ok,true,JSON.stringify(report));
  }
});
for (const [manager, executable] of [['other','custom-tool'],['pip','python3']]) {
  test(`schema3 host preflight needs configured ${executable}, not metadata manager ${manager}`,async t=>{
    const root=await realpath(await fixture(t));
    const config=structuredClone(await loadProjectConfig(new URL('../fixtures/config/valid/',import.meta.url).pathname));
    config.project.schemaVersion=3;
    config.project.stack={framework:'other',language:manager==='pip'?'python':'other',packageManager:manager};
    config.project.commands={test:{steps:[{cwd:'.',argv:[executable,'test']}]}};
    config.quality.commandGates=[{id:'test',command:'test',required:true}];
    let payload;
    const probes=[];
    const code=await preflight({flags:{project:root,mode:'host',json:true}},{
      output:{json:value=>{payload=value;}},configLoader:async()=>config,
      toolDiscovery:async context=>{probes.push(context);return {node:{present:true,supported:true,version:'22.0.0'},git:{present:true,supported:true,version:'2.0.0'}};},
      resolveCommandExecutable:async name=>{assert.equal(name,executable);return realpath(process.execPath);},
      gitDiscovery:async()=>({repository:true,dirty:false,detached:false,defaultBranch:config.project.repository.defaultBranch,currentBranch:config.project.repository.defaultBranch,baseFreshness:'fresh',worktreeCheck:{checked:true}}),
    });
    assert.equal(payload.checks.find(check=>check.id==='doctor').status,'pass');
    assert.equal(payload.checks.find(check=>check.id==='quality-commands').status,'pass');
    assert.equal(code,0,JSON.stringify(payload));
    assert.ok(probes.every(context=>context.runtimeOnly===true),JSON.stringify(probes));
  });
}
test('Django discovery proposes real Python checks without a Node manifest',async t=>{
  const root=await fixture(t,{'manage.py':'from django.core.management import execute_from_command_line\n','requirements.txt':'Django>=5\n'});
  const result=await discoverProject(root);
  assert.equal(result.proposal.schemaVersion,3);
  assert.equal(result.proposal.stack.framework,'django');
  assert.deepEqual(result.proposal.commands.check.steps[0].argv,['python3','manage.py','check']);
  assert.deepEqual(result.proposal.commands.test.steps[0].argv,['python3','manage.py','test']);
  assert.equal(result.proposal.commands.build,undefined);
  await assert.rejects(access(join(root,'package.json')));
});
test('Go and Rust discovery use their own commands',async t=>{
  for(const [file,content,runner] of [['go.mod','module example.invalid/app\n','go'],['Cargo.toml','[package]\nname="demo"\nversion="0.1.0"\n','cargo']]){
    const root=await fixture(t,{[file]:content});
    const result=await discoverProject(root);
    assert.equal(result.proposal.schemaVersion,3);
    assert.equal(result.proposal.commands.test.steps[0].argv[0],runner);
  }
});
test('portable setup bounds generated IDs even when a long directory starts with a number',async t=>{
  const parent=await fixture(t),root=join(parent,'123-'+ 'a'.repeat(80));
  await mkdir(root);
  let payload;
  const code=await init({flags:{project:root,write:true,json:true,'checks-json':'{"test":["custom-tool","check"]}'}},{output:{json:value=>{payload=value;}},gitDiscovery:async()=>({repository:false}),toolDiscovery:async()=>({})});
  assert.equal(code,0,JSON.stringify(payload));
  assert.ok((await loadProjectConfig(root)).project.id.length<=64);
});
test('unknown stacks accept explicit checks without creating a package.json',async t=>{
  const root=await fixture(t,{'README.md':'Custom toolchain\n'});
  const result=await discoverProject(root,{checks:{test:['custom-tool','verify','--literal=$VALUE']}});
  assert.equal(result.proposal.schemaVersion,3);
  assert.deepEqual(result.proposal.commands.test.steps[0].argv,['custom-tool','verify','--literal=$VALUE']);
  assert.equal(result.proposal.stack.packageManager,'other');
  await assert.rejects(access(join(root,'package.json')));
});
test('unknown check discovery gives an actionable configuration error, not a Git conflict',async t=>{
  const root=await fixture(t,{'pyproject.toml':'[project]\nname="unknown"\nversion="0.1.0"\n'});
  let payload;
  const code=await init({flags:{project:root,json:true}}, {output:{json:value=>{payload=value;}}});
  assert.equal(code,2);
  assert.equal(payload.error.code,'MISSING_CONFIGURATION');
  assert.match(payload.error.message,/checks-json/);
  await assert.rejects(access(join(root,'.rivet')));
});
test('init writes a valid Python configuration with explicitly reviewed checks',async t=>{
  const root=await fixture(t,{'pyproject.toml':'[project]\nname="sample-api"\nversion="0.1.0"\n'});
  const before=await readFile(join(root,'pyproject.toml'),'utf8');
  let payload;
  const parsed=parseArgs(['init',`--project=${root}`,'--write','--json','--checks-json={"test":["python3","-m","unittest","discover"]}']);
  const code=await init(parsed,{output:{json:value=>{payload=value;}},gitDiscovery:async()=>({repository:false}),toolDiscovery:async()=>({})});
  assert.equal(code,0,JSON.stringify(payload));
  const config=await loadProjectConfig(root);
  assert.equal(config.project.schemaVersion,3);
  assert.deepEqual(config.quality.commandGates,[{id:'test',command:'test',required:true}]);
  assert.equal(await readFile(join(root,'pyproject.toml'),'utf8'),before);
  await assert.rejects(access(join(root,'package.json')));
  const probes=[];
  const doctor=await diagnoseDoctor(root,{
    hostReadiness:true,
    toolDiscovery:async context=>{probes.push(context);return {node:{present:true,supported:true,version:'22.0.0'},git:{present:true,supported:true,version:'2.0.0'}};},
    resolveCommandExecutable:async name=>{assert.equal(name,'python3');return realpath(process.execPath);},
  });
  assert.equal(doctor.ok,true,JSON.stringify(doctor));
  assert.deepEqual(probes,[{runtimeOnly:true}]);
});
test('portable discovery rejects unsafe metadata and invalid explicit checks',async t=>{
  const root=await fixture(t,{'source.txt':'[project]\n'});
  await symlink(join(root,'source.txt'),join(root,'pyproject.toml'));
  await assert.rejects(discoverProject(root));
  const other=await fixture(t);
  await assert.rejects(discoverProject(other,{checks:{test:['sh','-c','echo ok']}}));
});
test('interactive setup asks for an unknown project check before writing valid configuration',async t=>{
  const root=await fixture(t,{'README.md':'Unknown build system\n'});
  const calls=[];
  const code=await setupCommand(parseArgs(['setup','--write']),{
    cwd:()=>root,output:{log(){},error(){}},terminalIsInteractive:()=>true,
    projectChecksPrompt:async()=>{calls.push('prompt');await assert.rejects(access(join(root,'.rivet')));return 'custom-tool verify "a b"';},
    gitDiscovery:async()=>({repository:false}),
    toolDiscovery:async()=>({node:{present:true,version:'22.0.0'},git:{present:true,version:'2.0.0'}}),
    setup:{inspectInstall:async()=>({targets:[]}),install:async(parsed,deps)=>{calls.push('install');deps.output.json({ok:true});return 0;}},
  });
  assert.equal(code,0);
  assert.deepEqual(calls,['prompt','install']);
  assert.deepEqual((await loadProjectConfig(root)).project.commands.test.steps[0].argv,['custom-tool','verify','a b']);
});
test('cancelled unknown-project setup writes nothing and starts no installation',async t=>{
  const root=await fixture(t);let installed=false;
  const code=await setupCommand(parseArgs(['setup','--write']),{
    cwd:()=>root,output:{log(){},error(){}},terminalIsInteractive:()=>true,projectChecksPrompt:async()=>null,
    gitDiscovery:async()=>({repository:false}),setup:{inspectInstall:async()=>({targets:[]}),install:async()=>{installed=true;return 0;}},
  });
  assert.equal(code,2);assert.equal(installed,false);await assert.rejects(access(join(root,'.rivet')));
});

test('portable tool discovery probes only the CLI runtime and Git, never arbitrary project commands',async()=>{
  const calls=[];
  await discoverTools({runtimeOnly:true,packageManager:'custom-tool'}, {runner:async(command,args)=>{
    calls.push([command,args]);return {code:0,stdout:command==='node'?'v22.0.0':'git version 2.0.0'};
  }});
  assert.deepEqual(calls,[['node',['--version']],['git',['--version']]]);
});

test('interactive checks preserve quoted arguments and reject shell operators or unfinished input',()=>{
  assert.deepEqual(parseCheckCommand('python3 -m pytest -k "health endpoint"'),['python3','-m','pytest','-k','health endpoint']);
  assert.deepEqual(parseCheckCommand("custom-tool 'literal;$VALUE' ''"),['custom-tool','literal;$VALUE','']);
  for(const input of ['pytest && make check','pytest | cat','pytest > result','pytest "unfinished','python3\n-m pytest']) assert.throws(()=>parseCheckCommand(input));
});
