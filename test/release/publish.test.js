import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {ensurePublished, registryMetadata, registryArtifact} from '../../scripts/publish-release.mjs';
const bytes=Buffer.from('tested tarball'),sha=createHash('sha256').update(bytes).digest('hex');
const manifest={package:{name:'@agilno-tech/rivet',version:'0.1.0-alpha.1'},artifact:{sha256:sha,bytes:bytes.length}};
const metadata=version=>({name:'@agilno-tech/rivet',version,dist:{tarball:`https://registry.npmjs.org/@agilno-tech/rivet/-/rivet-${version}.tgz`}});
test('already published exact bytes are verified without publishing again',async()=>{
 let calls=0;const result=await ensurePublished(manifest,{getMetadata:async()=>metadata(manifest.package.version),getBytes:async()=>bytes,publish:async()=>calls++});
 assert.equal(result.status,'already-published');assert.equal(calls,0);assert.deepEqual(result.bytes,bytes);
});
test('existing version with different bytes stops without publishing',async()=>{
 let called=false;await assert.rejects(()=>ensurePublished(manifest,{getMetadata:async()=>metadata(manifest.package.version),getBytes:async()=>Buffer.from('other'),publish:async()=>called=true}),/registry-artifact-mismatch/);assert.equal(called,false);
});
test('new publication waits for matching registry bytes and returns verified artifact',async()=>{
 let called=0,checks=0;
 const result=await ensurePublished(manifest,{getMetadata:async v=>v==='alpha'?metadata('0.1.0-alpha.0'):++checks<3?null:metadata(v),getBytes:async()=>bytes,publish:async()=>called++,sleep:async()=>{}});
 assert.equal(called,1);assert.equal(result.status,'published');
});
test('uncertain publish response reconciles exact registry bytes without a second publish',async()=>{
 let called=0;const result=await ensurePublished(manifest,{getMetadata:async v=>v==='alpha'?null:called?metadata(v):null,getBytes:async()=>bytes,publish:async()=>{called++;throw Error('lost response');},sleep:async()=>{}});
 assert.equal(result.status,'published');assert.equal(called,1);
});
test('never regresses the alpha channel or treats registry failures as permission to publish',async()=>{
 for(const version of ['0.1.0-alpha.1','0.1.0-alpha.2','0.2.0-alpha.0']){
 let called=false;await assert.rejects(()=>ensurePublished(manifest,{getMetadata:async v=>v==='alpha'?metadata(version):null,publish:async()=>called=true}),/alpha-channel-ahead/);assert.equal(called,false);
 }
 let called=false;await assert.rejects(()=>ensurePublished(manifest,{getMetadata:async()=>{throw Error('registry unavailable');},publish:async()=>called=true}),/registry unavailable/);assert.equal(called,false);
});
test('publishing failure never reports success without registry verification',async()=>{
 let called=0;await assert.rejects(()=>ensurePublished(manifest,{getMetadata:async()=>null,publish:async()=>{called++;throw Error('denied');},sleep:async()=>{}}),/publish-not-confirmed/);assert.equal(called,1);
});
test('registry reads are bounded, fixed-origin, redirect-free and distinguish missing from errors',async()=>{
 const options=[];const fetchImpl=async(url,opts)=>{options.push([url,opts]);return new Response('{}',{status:404});};
 assert.equal(await registryMetadata('0.1.0-alpha.1',{fetchImpl}),null);assert.match(options[0][0],/^https:\/\/registry.npmjs.org\/%40agilno-tech%2Frivet\//);assert.equal(options[0][1].redirect,'error');
 await assert.rejects(()=>registryMetadata('0.1.0-alpha.1',{fetchImpl:async()=>new Response('denied',{status:403})}),/registry-read-failed/);
 await assert.rejects(()=>registryMetadata('../other',{fetchImpl}),/invalid-version/);
 await assert.rejects(()=>registryArtifact({...metadata('0.1.0-alpha.1'),dist:{tarball:'https://example.invalid/private'}},{fetchImpl}),/invalid-tarball-url/);
 await assert.rejects(()=>registryArtifact(metadata('0.1.0-alpha.1'),{fetchImpl:async()=>new Response('x',{headers:{'content-length':String(65*1024*1024)}})}),/registry-response-too-large/);
});
test('publication tolerates metadata after 90 seconds and tarball after 180 seconds',async()=>{
 let elapsed=0,published=0,reads=0;
 const result=await ensurePublished(manifest,{
  getMetadata:async version=>{if(version==='alpha')return metadata('0.1.0-alpha.0');reads++;return elapsed>=90000?metadata(version):null;},
  getBytes:async()=>elapsed>=180000?bytes:null,
  publish:async()=>published++,sleep:async milliseconds=>{elapsed+=milliseconds;},
 });
 assert.equal(result.status,'published');assert.equal(published,1);assert.equal(elapsed,180000);assert.deepEqual(result.bytes,bytes);assert.ok(reads>6);
});
test('bounded propagation timeout polls for ten minutes without another publish',async()=>{
 let elapsed=0,published=0,verificationReads=0;const sleeps=[];
 await assert.rejects(ensurePublished(manifest,{
  getMetadata:async version=>{if(version!=='alpha'&&published)verificationReads++;return null;},
  getBytes:async()=>assert.fail('no tarball before metadata'),publish:async()=>published++,
  sleep:async milliseconds=>{sleeps.push(milliseconds);elapsed+=milliseconds;},
 }),/publish-not-confirmed/);
 assert.equal(published,1);assert.equal(verificationReads,41);assert.equal(elapsed,600000);
 assert.equal(sleeps.length,40);assert.ok(sleeps.every(value=>value===15000));
});
test('existing version waits for delayed tarball without republishing',async()=>{
 let elapsed=0,published=0;
 const result=await ensurePublished(manifest,{
  getMetadata:async version=>{assert.notEqual(version,'alpha');return metadata(version);},
  getBytes:async()=>elapsed>=180000?bytes:null,publish:async()=>published++,sleep:async milliseconds=>{elapsed+=milliseconds;},
 });
 assert.equal(result.status,'already-published');assert.equal(published,0);assert.equal(elapsed,180000);
});
test('tarball 404 is temporary while permission and integrity failures stop immediately',async()=>{
 assert.equal(await registryArtifact(metadata(manifest.package.version),{fetchImpl:async()=>new Response('missing',{status:404})}),null);
 await assert.rejects(registryArtifact(metadata(manifest.package.version),{fetchImpl:async()=>new Response('denied',{status:403})}),/registry-read-failed/);
 let published=0,sleeps=0;
 await assert.rejects(ensurePublished(manifest,{
  getMetadata:async()=>metadata(manifest.package.version),getBytes:async()=>{throw Error('registry-read-failed');},
  publish:async()=>published++,sleep:async()=>sleeps++,
 }),/registry-read-failed/);
 assert.equal(published,0);assert.equal(sleeps,0);
});
