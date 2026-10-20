import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverTests, parseShard, assignShards, selectedTests } from '../../scripts/test-shards.cjs';
import { catalog } from '../../evals/catalog.mjs';

test('shard selectors reject invalid and ambiguous partitions',()=>{
 assert.equal(parseShard([]),null);
 assert.deepEqual(parseShard(['--shard=2/4']),{index:2,count:4});
 for(const args of [['--shard=0/4'],['--shard=5/4'],['--shard=1/0'],['--shard=1/99'],['--shard=1/2','--shard=2/2'],['--other'],['--shard=1.5/4']])assert.throws(()=>parseShard(args));
});
test('balanced shards are deterministic, disjoint and include unknown files',()=>{
 const files=['a','b','c','d','new-file'];const weights={a:100,b:80,c:30,d:20};
 const shards=assignShards(files,2,weights);
 assert.deepEqual(assignShards([...files].reverse(),2,weights),shards);
 assert.deepEqual(shards.flat().sort(),[...files].sort());
 assert.ok(shards.every(shard=>shard.length>0));
 const costs=shards.map(shard=>shard.reduce((sum,file)=>sum+(weights[file]??5),0));
 assert.ok(Math.max(...costs)-Math.min(...costs)<=20);
 assert.throws(()=>assignShards(['a','a'],2,{}));
});
test('all repository tests and evaluation scenarios have exactly one shard owner',()=>{
 const files=discoverTests();const shards=Array.from({length:4},(_,i)=>selectedTests({index:i+1,count:4}));
 assert.deepEqual(shards.flat().sort(),files);
 assert.equal(new Set(shards.flat()).size,files.length);
 for(const scenario of catalog.scenarios)assert.equal(shards.filter(files=>files.includes(scenario.file)).length,1,scenario.id);
 assert.ok(shards.every(files=>catalog.scenarios.some(s=>files.includes(s.file))));
});
