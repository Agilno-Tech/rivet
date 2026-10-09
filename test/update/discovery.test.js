import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import {join} from 'node:path';
import { discoverInstallation, fetchLatestVersion, packageMetadata } from '../../src/update/discovery.js';
const fixture=()=>fs.mkdtempSync(join(os.tmpdir(),'rivet-update-'));
test('identifies exactly the manager that owns the running package',async()=>{
 const dir=fixture();try{const root=join(dir,'npm','@agilno-tech','rivet');fs.mkdirSync(root,{recursive:true});
 const runner=async(cmd,args)=>({code:0,stdout:cmd==='npm'?join(dir,'npm'):cmd==='pnpm'?join(dir,'pnpm'):args[0]==='--version'?'1.22.22':join(dir,'yarn')});
 assert.equal((await discoverInstallation(root,{fs,runner,cwd:dir})).manager,'npm');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('does not guess a manager for source or ambiguous installation',async()=>{
 const dir=fixture();try{const root=join(dir,'@agilno-tech','rivet');fs.mkdirSync(root,{recursive:true});
 const runner=async(cmd,args)=>({code:0,stdout:args[0]==='--version'?'1.22.22':dir});
 await assert.rejects(discoverInstallation(root,{fs,runner,cwd:dir}),/identify/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('registry lookup checks package identity and exact semver',async()=>{
 const response=data=>async()=>new Response(JSON.stringify(data));
 assert.equal(await fetchLatestVersion(response({name:'@agilno-tech/rivet',version:'0.1.0-alpha.4'})),'0.1.0-alpha.4');
 await assert.rejects(fetchLatestVersion(response({name:'other',version:'1.0.0'})),/registry/);
 await assert.rejects(fetchLatestVersion(response({name:'@agilno-tech/rivet',version:'latest;bad'})),/registry/);
 await assert.rejects(fetchLatestVersion(async()=>new Response('x'.repeat(70000))),/registry/);
});
test('rejects globally linked source packages instead of overwriting them',async()=>{
 const dir=fixture();try{
 const source=join(dir,'source'),modules=join(dir,'global','node_modules');fs.mkdirSync(source);fs.mkdirSync(join(modules,'@agilno-tech'),{recursive:true});fs.symlinkSync(source,join(modules,'@agilno-tech','rivet'));
 const runner=async(cmd)=>({code:0,stdout:cmd==='npm'?modules:'unavailable'});
 await assert.rejects(discoverInstallation(source,{fs,runner,cwd:dir}),/identify/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
