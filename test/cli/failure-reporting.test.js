import assert from 'node:assert/strict';
import test from 'node:test';
import { main } from '../../src/cli/main.js';
import { CliError } from '../../src/cli/output.js';

function capture(extra={}) {
  const lines=[],json=[],reports=[];
  return {lines,json,reports,options:{output:{log:v=>lines.push(v),error:v=>lines.push(v),json:(v,stream)=>json.push({v,stream})},reportFailure:async value=>{reports.push(value);return {path:'/tmp/private/report.json'};},...extra}};
}
test('human failures print actionable guidance and save only structured diagnostic inputs',async()=>{
  const f=capture({commands:{doctor:async()=>{throw new CliError('safe explanation','REPOSITORY_CONFLICT',{cause:{code:'ERR_GIT_REPOSITORY_CHANGED',message:'SECRET'}});}}});
  assert.equal(await main(['doctor','--project=/private/customer'],f.options),6);
  assert.deepEqual(f.reports,[{command:'doctor',subcommand:null,code:'REPOSITORY_CONFLICT',exitCode:6,causeCode:'ERR_GIT_REPOSITORY_CHANGED'}]);
  assert.match(f.lines.join('\n'),/Next:/);assert.match(f.lines.join('\n'),/Diagnostic report: \/tmp\/private\/report.json/);
  assert.doesNotMatch(JSON.stringify(f.reports),/SECRET|customer/);
});
test('returned failures also get reports, and unavailable storage does not change exit status',async()=>{
  for(const fail of [false,true]) {
    const f=capture({commands:{doctor:async()=>4},reportFailure:async()=>{if(fail)throw new Error('storage problem');return null;}});
    assert.equal(await main(['doctor'],f.options),4);
    assert.match(f.lines.join('\n'),/could not be saved/i);
  }
});
test('JSON errors preserve their one-object contract and do not create automatic reports',async()=>{
  const f=capture({commands:{doctor:async()=>{throw new CliError('missing','MISSING_CONFIGURATION');}}});
  assert.equal(await main(['doctor','--json'],f.options),2);
  assert.equal(f.json.length,1);assert.equal(f.lines.length,0);assert.equal(f.reports.length,0);
  assert.equal(f.json[0].v.error.code,'MISSING_CONFIGURATION');
});
test('success never creates a failure report',async()=>{
  const f=capture({commands:{doctor:async()=>0}});assert.equal(await main(['doctor'],f.options),0);assert.equal(f.reports.length,0);
});
test('everyday help is short and advanced commands remain accessible',async()=>{
  const f=capture();assert.equal(await main(['--help'],f.options),0);
  assert.match(f.lines.join('\n'),/task resume/);assert.doesNotMatch(f.lines.join('\n'),/feature start <run-id>/);
  f.lines.length=0;assert.equal(await main(['--help','--advanced'],f.options),0);assert.match(f.lines.join('\n'),/feature start <run-id>/);
});

test('installed CLI failure produces an actual private shareable report',async t=>{
  const {execFile}=await import('node:child_process');
  const {promisify}=await import('node:util');
  const {readFile,lstat,rm}=await import('node:fs/promises');
  const {dirname}=await import('node:path');
  const run=promisify(execFile);
  let failure;
  try {await run(process.execPath,['bin/cli.js','unknown-sensitive-task-description'],{cwd:new URL('../../',import.meta.url),env:{...process.env,DEMO_SECRET:'sensitive-value-not-for-reports'}});} catch(error){failure=error;}
  assert.equal(failure?.code,1);
  const path=failure.stderr.match(/Diagnostic report: ([^\n]+)/)?.[1];assert.ok(path,failure.stderr);
  t.after(()=>rm(dirname(path),{recursive:true,force:true}));
  assert.equal((await lstat(path)).mode&0o777,0o600);
  const text=await readFile(path,'utf8'),report=JSON.parse(text);
  assert.equal(report.failure.code,'INVALID_INPUT');assert.equal(report.command.name,'unknown');
  assert.doesNotMatch(text,/sensitive-value|unknown-sensitive-task-description/);
});
