import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from '../helpers/run-cli.js';

test('models list exposes providers and their actual execution status without network calls', async () => {
  const result = (await runCli(['models', 'list', '--json'])).assertSuccess();
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.result.providers.find(p => p.id === 'gemini').execution, 'adapter-available');
  assert.ok(payload.result.providers.some(p => p.id === 'ollama'));
});

test('models check validates a profile but does not claim readiness or use credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rivet-model-profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, 'profile.json');
  await writeFile(profile, JSON.stringify({ provider: 'ollama', model: 'custom-local-model', endpoint: 'http://localhost:11434', timeoutMs: 1000, maxOutputTokens: 100 }));
  const result = (await runCli(['models', 'check', `--profile=${profile}`, '--json'])).assertSuccess();
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result.ready, false);
  assert.equal(payload.result.profile.model, 'custom-local-model');
  await writeFile(profile, JSON.stringify({ apiKey: 'do-not-echo-this-value' }));
  const invalid = await runCli(['models', 'check', `--profile=${profile}`, '--json']);
  assert.notEqual(invalid.code, 0);
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /do-not-echo-this-value/);
});

test('models rejects unknown options and commands', async () => {
  for (const args of [['models', 'run'], ['models', 'list', '--unexpected'], ['models', 'check']]) {
    const result = await runCli(args);
    assert.notEqual(result.code, 0);
  }
});

test('models list detects every supported provider from local evidence without leaking credentials',async()=>{
 const {main}=await import('../../src/cli/main.js');let payload;
 const result=await main(['models','list','--json'],{reportFailure:false,cwd:()=>'/tmp',env:{ANTHROPIC_API_KEY:'anthropic-secret',OPENAI_API_KEY:'openai-secret',GOOGLE_API_KEY:'google-secret',OLLAMA_HOST:'http://localhost:11434',OPENAI_BASE_URL:'https://provider.example/v1'},harnesses:{discover:async()=>[{kind:'claude',executable:'/opt/claude'},{kind:'codex',available:false}]},output:{json:v=>payload=v,error(){},log(){}}});
 assert.equal(result,0);const providers=payload.result.providers;assert.equal(providers.length,7);
 for(const id of ['anthropic','openai','gemini','ollama','openai-compatible']){const p=providers.find(p=>p.id===id);assert.equal(p.detection.status,'configured');assert.equal(p.taskExecution,false);assert.equal(p.textDelegation,true);assert.equal(p.liveVerified,false);}
 assert.equal(providers.find(p=>p.id==='claude-code').detection.status,'installed');assert.equal(providers.find(p=>p.id==='codex').detection.status,'not-detected');
 assert.doesNotMatch(JSON.stringify(payload),/anthropic-secret|openai-secret|google-secret|provider\.example/);
});
test('models list rejects blank and unsafe endpoint evidence without claiming authentication',async()=>{
 const {main}=await import('../../src/cli/main.js');let payload;
 await main(['models','list','--json'],{reportFailure:false,cwd:()=>'/tmp',env:{ANTHROPIC_API_KEY:' ',OLLAMA_HOST:'http://user:secret@localhost:11434',OPENAI_BASE_URL:'not-an-endpoint'},harnesses:{discover:async()=>[]},output:{json:v=>payload=v,error(){},log(){}}});
 assert.ok(payload.result.providers.every(p=>p.detection.status==='not-detected'));
 assert.ok(payload.result.providers.every(p=>p.detection.authentication==='not-verified'&&p.detection.modelAccess==='not-verified'));
});

test('models list does not detect Ollama endpoints the protocol cannot use and retains provider IDs in text',async()=>{
 const {main}=await import('../../src/cli/main.js');
 for(const endpoint of ['https://remote.example','http://localhost:11434/nested']){let payload;await main(['models','list','--json'],{reportFailure:false,cwd:()=>'/tmp',env:{OLLAMA_HOST:endpoint},harnesses:{discover:async()=>[]},output:{json:v=>payload=v,error(){},log(){}}});assert.equal(payload.result.providers.find(p=>p.id==='ollama').detection.status,'not-detected');}
 const lines=[];await main(['models','list'],{reportFailure:false,cwd:()=>'/tmp',env:{},harnesses:{discover:async()=>[]},output:{error(){},log:v=>lines.push(v)}});assert.match(lines.join('\n'),/openai-compatible:/);assert.match(lines.join('\n'),/text delegation only/);
});
