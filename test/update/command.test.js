import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import {join} from 'node:path';
import { createHash } from 'node:crypto';
import {parseArgs} from '../../src/cli/parse-args.js';
import {updateCommand} from '../../src/commands/update.js';
import {launcher,runtimeSkill} from '../../src/install/project-reference.js';
const NAME='@agilno-tech/rivet';
function fixture(t,{project=false,pinned=false,manager='npm'}={}){
 const root=fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(),'rivet-update-command-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const packageRoot=join(root,'global','node_modules','@agilno-tech','rivet'),home=join(root,'home'),cwd=join(root,'project');
 for(const directory of [packageRoot,home,cwd,join(packageRoot,'templates','harness')])fs.mkdirSync(directory,{recursive:true});
 const pkg=version=>JSON.stringify({name:NAME,version});fs.writeFileSync(join(packageRoot,'package.json'),pkg('0.1.0-alpha.3'));
 fs.writeFileSync(join(packageRoot,'templates','harness','SKILL.md'),'rivet instructions');
 if(project){fs.mkdirSync(join(cwd,'.git'));fs.cpSync(new URL('../fixtures/config/valid/.rivet/',import.meta.url),join(cwd,'.rivet'),{recursive:true});}
 const writes=[],output=[];let failFollowup=false;
 const own=(where,target='claude')=>{const path=join(where,target==='claude'?'.claude':'.agents','skills','rivet');fs.mkdirSync(path,{recursive:true});const source=Buffer.from('rivet instructions');const skill=pinned&&where===cwd?runtimeSkill(source,'a'.repeat(64)):source;fs.writeFileSync(join(path,'SKILL.md'),skill);fs.writeFileSync(join(path,'.rivet-install.json'),JSON.stringify({schemaVersion:1,package:{name:NAME,version:'0.1.0-alpha.3'},target,files:[{path:'SKILL.md',sha256:createHash('sha256').update(skill).digest('hex')}]}));return path;};
 if(pinned)fs.writeFileSync(join(cwd,'.rivet.cjs'),launcher('a'.repeat(64)));
 const runner=async(cmd,args,opts)=>{
   assert.equal(opts.shell,false);
   if(args[0]==='rev-parse')return {code:0,stdout:args.includes('--git-common-dir')?join(cwd,'.git'):cwd};
   if(cmd==='yarn'&&args[0]==='--version')return {code:0,stdout:'1.22.22'};
   if(args[0]==='root'||args[1]==='dir')return {code:0,stdout:cmd===manager?(cmd==='yarn'?join(root,'global'):join(root,'global','node_modules')):join(root,'absent',cmd)};
   writes.push({cmd,args,opts});
   if(cmd===process.execPath){const parsed=parseArgs(args.slice(1));assert.equal(parsed.command,'install');assert.equal(parsed.flags.minimal,true);return {code:failFollowup?1:0,stdout:''};}
   if(args.includes('--prefix')){const dest=join(args[args.indexOf('--prefix')+1],'node_modules','@agilno-tech','rivet');fs.mkdirSync(dest,{recursive:true});fs.writeFileSync(join(dest,'package.json'),pkg('0.1.0-alpha.4'));}
   else fs.writeFileSync(join(packageRoot,'package.json'),pkg('0.1.0-alpha.4'));
   return {code:0,stdout:''};
 };
 const deps={fs,packageRoot,home:()=>home,cwd:()=>cwd,env:process.env,output:{json:value=>output.push(value),log:value=>output.push(value)},update:{runner,fetch:async()=>new Response(JSON.stringify({name:NAME,version:'0.1.0-alpha.4'}))}};
 const run=flags=>updateCommand({command:'update',operands:[],flags:{json:true,...flags}},deps);
 return {root,packageRoot,home,cwd,writes,output,deps,own,run,fail:()=>{failFollowup=true;}};
}
for(const manager of ['npm','yarn','pnpm'])test(`${manager} updates exact package without lifecycle scripts`,async t=>{
 const f=fixture(t,{manager});await f.run({});assert.equal(f.writes[0].cmd,manager);assert.ok(f.writes[0].args.includes('--ignore-scripts'));assert.ok(f.writes[0].args.includes(NAME+'@0.1.0-alpha.4'));assert.equal(f.output[0].result.global.status,'updated');
});
test('check reports both scopes without package, cache, or instruction writes',async t=>{
 const f=fixture(t,{project:true});f.own(f.cwd);const before=fs.readdirSync(f.home);await f.run({check:true});assert.deepEqual(f.writes,[]);assert.deepEqual(fs.readdirSync(f.home),before);assert.ok(f.output[0].result.project);
});
test('default refreshes only existing project and global targets in fresh processes',async t=>{
 const f=fixture(t,{project:true});f.own(f.cwd,'codex');f.own(f.home,'claude');await f.run({});assert.equal(f.writes.length,3);assert.equal(f.writes[1].cmd,process.execPath);assert.ok(f.writes[1].args.includes('--global'));assert.ok(f.writes[2].args.includes('--target=codex'));assert.ok(f.writes[2].args.includes('--project='+f.cwd));
});
test('edited managed instructions block before global update',async t=>{
 const f=fixture(t,{project:true});const skill=f.own(f.cwd);fs.writeFileSync(join(skill,'SKILL.md'),'my custom instructions');await assert.rejects(f.run({}),/edited/);assert.deepEqual(f.writes,[]);
});
test('project-only stages latest without changing the global package and preserves pin',async t=>{
 const f=fixture(t,{project:true,pinned:true});f.own(f.cwd);await f.run({project:true});assert.ok(f.writes[0].args.includes('--prefix'));assert.ok(!f.writes[0].args.includes('--global'));assert.ok(f.writes[1].args.includes('--project-runtime'));assert.equal(JSON.parse(fs.readFileSync(join(f.packageRoot,'package.json'))).version,'0.1.0-alpha.3');
});
test('partial failure identifies completed global phase and preserves project policy',async t=>{
 const f=fixture(t,{project:true});f.own(f.cwd);const before=fs.readFileSync(join(f.cwd,'.rivet','project.yaml'),'utf8');f.fail();assert.notEqual(await f.run({}),0);assert.match(f.output[0].error.message,/Completed: global CLI/);assert.deepEqual(f.output[0].result.completed,['global CLI']);assert.equal(fs.readFileSync(join(f.cwd,'.rivet','project.yaml'),'utf8'),before);
});
test('invalid flags, missing project, unowned pin stop before commands',async t=>{
 const f=fixture(t);await assert.rejects(f.run({global:true,project:true}),/Use rivet update/);await assert.rejects(f.run({project:true}),/configured project/);assert.deepEqual(f.writes,[]);
 const g=fixture(t,{project:true});fs.writeFileSync(join(g.cwd,'.rivet.cjs'),'custom launcher');await assert.rejects(g.run({}),/unowned or edited/);assert.deepEqual(g.writes,[]);
});
test('an already-current global version still refreshes project runtime and instructions',async t=>{
 const f=fixture(t,{project:true,pinned:true});f.own(f.cwd);fs.writeFileSync(join(f.packageRoot,'package.json'),JSON.stringify({name:NAME,version:'0.1.0-alpha.4'}));await f.run({});assert.equal(f.writes.length,1);assert.equal(f.writes[0].cmd,process.execPath);assert.ok(f.writes[0].args.includes('--project-runtime'));assert.equal(f.output[0].result.global.status,'current');
});
test('edits arriving during registry lookup block all package-manager mutations',async t=>{
 const f=fixture(t,{project:true});const skill=f.own(f.cwd);
 f.deps.update.fetch=async()=>{fs.writeFileSync(join(skill,'SKILL.md'),'concurrent user edit');return new Response(JSON.stringify({name:NAME,version:'0.1.0-alpha.4'}));};
 await assert.rejects(f.run({}),/edited/);assert.deepEqual(f.writes,[]);
});
test('global-only leaves configured project instructions and runtime untouched',async t=>{
 const f=fixture(t,{project:true,pinned:true});f.own(f.cwd);const before=fs.readFileSync(join(f.cwd,'.rivet.cjs'),'utf8');await f.run({global:true});assert.equal(f.writes.length,1);assert.equal(f.output[0].result.project,null);assert.equal(fs.readFileSync(join(f.cwd,'.rivet.cjs'),'utf8'),before);
});
for(const change of ['pin removed','pin changed','target removed','target added'])test(`changes after global mutation stop followup: ${change}`,async t=>{
 const f=fixture(t,{project:true,pinned:true});const skill=f.own(f.cwd);const original=f.deps.update.runner;
 f.deps.update.runner=async(cmd,args,options)=>{
   const result=await original(cmd,args,options);
   if(cmd==='npm'&&args[0]==='install'){
     if(change==='pin removed')fs.unlinkSync(join(f.cwd,'.rivet.cjs'));
     if(change==='pin changed')fs.writeFileSync(join(f.cwd,'.rivet.cjs'),launcher('b'.repeat(64)));
     if(change==='target removed')fs.rmSync(skill,{recursive:true});
     if(change==='target added')f.own(f.cwd,'codex');
   }
   return result;
 };
 assert.notEqual(await f.run({}),0);assert.match(f.output[0].error.message,/changed during the update/);assert.equal(f.writes.length,1);
});
test('human check shows project instruction and pin versions and empty projects have no refresh',async t=>{
 const f=fixture(t,{project:true,pinned:true});f.own(f.cwd);await updateCommand({command:'update',operands:[],flags:{check:true}},f.deps);
 assert.ok(f.output.some(line=>line.includes('Project runtime: unavailable → 0.1.0-alpha.4')));
 assert.ok(f.output.some(line=>line.includes('Project claude instructions: 0.1.0-alpha.3 → 0.1.0-alpha.4')));
 const empty=fixture(t,{project:true});await empty.run({check:true});assert.equal(empty.output[0].result.project.status,'no managed instructions');
});

test('global Yarn discovery and update ignore conflicting project Corepack manager without changing project metadata',async t=>{
 const f=fixture(t,{project:true,manager:'yarn'});
 const file=join(f.cwd,'package.json'),before=JSON.stringify({name:'customer',packageManager:'pnpm@10.0.0'});fs.writeFileSync(file,before);
 const original=f.deps.update.runner;
 f.deps.update.runner=async(command,args,options)=>{
   if(command==='yarn'){
     assert.equal(options.env.COREPACK_ENABLE_PROJECT_SPEC,'0');
     assert.equal(options.env.COREPACK_ENABLE_AUTO_PIN,'0');
     assert.equal(options.env.COREPACK_ENABLE_NETWORK,'0');
   }
   return original(command,args,options);
 };
 await f.run({});assert.equal(f.output[0].result.global.manager,'yarn');assert.equal(fs.readFileSync(file,'utf8'),before);
});
