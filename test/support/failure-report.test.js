import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, lstat, rm, symlink, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as reports from '../../src/support/failure-report.js';
const secret='private-token-/Users/person/project-secret';
async function fixture(t) { const directory=await mkdtemp(join(tmpdir(),'rivet-report-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));return directory; }
test('failure reports are bounded private files containing only public diagnostic fields', async t=>{
 const root=await fixture(t);
 const saved=await reports.saveFailureReport({command:'task',subcommand:'approve',code:'REPOSITORY_CONFLICT',exitCode:6,message:secret,stack:secret,argv:[secret],environment:{TOKEN:secret}}, {temporaryDirectory:root});
 assert.ok(saved);const content=await readFile(saved.path,'utf8');assert.ok(content.length<8192);assert.ok(!content.includes(secret));
 assert.equal(saved.report.failure.code,'REPOSITORY_CONFLICT');assert.equal(saved.report.failure.exitCode,6);assert.equal(saved.report.command.name,'task');
 assert.match(saved.report.versions.rivet,/^0\./);assert.match(saved.report.runtimeFingerprint,/^[a-f0-9]{64}$/);
 assert.equal((await lstat(saved.path)).mode&0o777,0o600);assert.equal((await lstat(dirname(saved.path))).mode&0o777,0o700);
 assert.equal((await lstat(saved.path)).nlink,1);assert.equal(saved.report.format,'rivet-failure-report');
});
test('unrecognized command values and errors are never copied into reports',async t=>{
 const root=await fixture(t);const saved=await reports.saveFailureReport({command:secret,subcommand:secret,code:secret,exitCode:99},{temporaryDirectory:root});
 assert.ok(saved);assert.equal(saved.report.command.name,'unknown');assert.equal(saved.report.command.subcommand,null);assert.equal(saved.report.failure.code,'INTERNAL_ERROR');assert.equal(saved.report.failure.exitCode,7);
 assert.ok(!JSON.stringify(saved.report).includes(secret));
});
test('failed storage is nonthrowing and symlink storage parents are refused',async t=>{
 const root=await fixture(t),link=join(root,'link');await symlink(root,link);
 assert.equal(await reports.saveFailureReport({code:'FAILED_GATE'},{temporaryDirectory:link}),null);
 assert.equal(await reports.saveFailureReport({code:'FAILED_GATE'},{temporaryDirectory:join(root,'absent')}),null);
 assert.deepEqual(await readdir(root),['link']);
});
test('reports create distinct files without overwriting existing contents',async t=>{
 const root=await fixture(t);await writeFile(join(root,'report.json'),secret);
 const first=await reports.saveFailureReport({code:'FAILED_GATE'},{temporaryDirectory:root});
 const second=await reports.saveFailureReport({code:'FAILED_GATE'},{temporaryDirectory:root});
 assert.notEqual(first.path,second.path);assert.equal(await readFile(join(root,'report.json'),'utf8'),secret);
});
test('explicit support saving uses existing sanitized collection and fixed failure messages',async t=>{
 const root=await fixture(t);const saved=await reports.saveSupportReport(root,{environment:{TOKEN:secret},diagnose:async()=>{throw new Error(secret)}},{temporaryDirectory:root});
 assert.equal(saved.report.collection.status,'incomplete');assert.equal(saved.report.format,'rivet-support-report');assert.match(saved.report.runtimeFingerprint,/^[a-f0-9]{64}$/);assert.match(saved.report.versions.rivet,/alpha/);assert.ok(!(await readFile(saved.path,'utf8')).includes(secret));
 await assert.rejects(reports.saveSupportReport(root,{environment:{}},{temporaryDirectory:join(root,'absent')}),error=>error.message==='Support report could not be saved.');
});

test('failure cause codes use a closed production allowlist and never retain arbitrary codes',async t=>{
 const root=await fixture(t);
 for(const [input,expected] of [['ERR_HOST_RUN_BUSY','ERR_HOST_RUN_BUSY'],['ERR_GIT_NON_FAST_FORWARD','ERR_GIT_NON_FAST_FORWARD'],[secret,null],['ERR_'+secret,null]]) {
  const saved=await reports.saveFailureReport({command:'task',subcommand:'approve',code:'REPOSITORY_CONFLICT',causeCode:input},{temporaryDirectory:root});
  assert.equal(saved.report.failure.causeCode,expected);assert.ok(!(await readFile(saved.path,'utf8')).includes(secret));
 }
});
