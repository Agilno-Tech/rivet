import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';

test('CI retains the complete platform matrix and fails aggregates on any incomplete shard',async()=>{
 const ci=YAML.parse(await readFile(new URL('../../.github/workflows/ci.yml',import.meta.url),'utf8'));
 assert.deepEqual(ci.jobs.test.strategy.matrix,{os:['macos-latest','ubuntu-latest'],node:[22,24],shard:[1,2,3,4]});
 assert.deepEqual(ci.jobs.check.strategy.matrix,{os:['ubuntu-latest','macos-latest'],node:[22,24]});
 assert.equal(ci.jobs.check.needs,'test');assert.match(ci.jobs.check.if,/always\(\)/);
 assert.equal(ci.jobs.check.steps[0].run,'test "${{ needs.test.result }}" = success');
 const steps=ci.jobs.test.steps;
 assert.ok(steps.some(s=>s.run==='node scripts/verify-tests.mjs --shard=${{ matrix.shard }}/4'));
 assert.equal(steps.some(s=>s.run?.startsWith('npm test') || s.run?.startsWith('npm run evals')),false);
 assert.equal(steps.find(s=>s.run==='npm run package:smoke').if,'matrix.shard == 1');
 assert.ok(steps.some(s=>s.run==='git diff --exit-code -- dist'));
});
test('docs have one PR/main owner and remain covered for explicit CI dispatch',async()=>{
 const read=async name=>YAML.parse(await readFile(new URL(`../../.github/workflows/${name}.yml`,import.meta.url),'utf8'));
 const ci=await read('ci'),docs=await read('docs');
 assert.equal(ci.jobs.test.steps.some(s=>s.run==='npm run docs:build'),false);
 assert.ok(Object.hasOwn(docs.on,'pull_request'));assert.deepEqual(docs.on.push.branches,['main']);
 assert.equal(ci.jobs['docs-dispatch'].if,"github.event_name == 'workflow_dispatch'");
 assert.ok(ci.jobs['docs-dispatch'].steps.some(s=>s.run==='npm run docs:build'));
 assert.match(docs.jobs.deploy.if,/github.event_name == 'workflow_dispatch'/);
});
