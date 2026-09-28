import test from 'node:test';
import assert from 'node:assert/strict';
import { scanChangedContent, validateContentScanPolicy } from '../../src/quality/content-scan.js';
const scan = (content, policy, path = 'src/example.ts') => scanChangedContent({ files: [{ path, content }], policy });
test('secrets fail without including sensitive contents in findings', () => {
  for (const content of ['-----BEGIN PRIVATE KEY-----', `ghp_${'a'.repeat(36)}`, `npm_${'B'.repeat(36)}`, `AKIA${'A'.repeat(16)}`]) {
    const result = scan(`line\n${content}`);
    assert.equal(result.status, 'failed'); assert.equal(result.findings[0].line, 2);
    assert.equal(JSON.stringify(result).includes(content), false);
    assert.deepEqual(Object.keys(result.findings[0]), ['path', 'line', 'ruleId', 'severity', 'message']);
  }
});
test('unicode flags warn by default and required policy blocks', () => {
  const text = 'const pаypal = 1; // \u202e'; // Cyrillic a
  assert.equal(scan(text).findings.length, 2);
  assert.equal(scan(text).status, 'passed');
  assert.equal(scan(text, { unicode: 'required' }).status, 'failed');
  assert.equal(scan(text, { unicode: 'off' }).findings.length, 0);
});
test('ordinary multilingual content strings comments math and joiners are accepted', () => {
  const text = 'const привет = "pаypal Ελληνικά 😀 👩‍💻";\nconst κόσμος = 1; // pаypal\n/* pаypal */\nconst text = `pаypal`;';
  assert.deepEqual(scan(text).findings, []);
  assert.deepEqual(scan('Hello мир Ελληνικά pаypal $xα$ 👩‍💻', {}, 'README.md').findings, []);
  assert.deepEqual(scan('x = """pаypal"""\n# pаypal', {}, 'app.py').findings, []);
});
test('allowlists require exact path rule and explanation and do not suppress other files', () => {
  const policy = { allowlist: [{ ruleId: 'private-key', path: 'fixtures/key.txt', reason: 'Test fixture marker only' }] };
  const content = '-----BEGIN PRIVATE KEY-----';
  assert.equal(scan(content, policy, 'fixtures/key.txt').findings.length, 0);
  assert.equal(scan(content, policy, 'src/key.txt').status, 'failed');
  for (const entry of [{ruleId:'private-key',path:'*',reason:'fixture'}, {ruleId:'all',path:'a',reason:'fixture'}, {ruleId:'private-key',path:'a'}, {ruleId:'private-key',path:'../a',reason:'fixture'}, {ruleId:'private-key',path:'a',reason:'  '}]) assert.throws(() => validateContentScanPolicy({allowlist:[entry]}), {code:'ERR_CONTENT_SCAN_POLICY'});
});
test('bounded input fails closed without sensitive error messages', () => {
  assert.throws(() => scan('secret', {maxBytes:1}), {code:'ERR_CONTENT_SCAN_LIMIT'});
  assert.throws(() => scanChangedContent({ files: [{path:'a',content:''},{path:'b',content:''}], policy:{maxFiles:1} }), {code:'ERR_CONTENT_SCAN_LIMIT'});
  for (const files of [[{path:'../a',content:''}],[{path:'a',content:Buffer.from('x')}],[{path:'a',content:''},{path:'a',content:''}]]) assert.throws(() => scanChangedContent({files}), {code:'ERR_CONTENT_SCAN_INPUT'});
  assert.throws(() => scan('x',{maxBytes:2097153}), {code:'ERR_CONTENT_SCAN_POLICY'});
  assert.throws(() => scan('\u202e'.repeat(1001)), {code:'ERR_CONTENT_SCAN_LIMIT'});
});
test('explicit known project suppression rule scopes paths and severity', () => {
  const policy={shortcutRules:[{ruleId:'type-suppression',paths:['src/example.ts'],reason:'Require checked code',required:true}]};
  assert.equal(scan('// @ts-ignore',policy).status,'failed');
  assert.equal(scan('// @ts-ignore',policy,'other.ts').status,'passed');
  assert.throws(()=>validateContentScanPolicy({shortcutRules:[{ruleId:'custom-regex',paths:['a'],reason:'rule'}]}),{code:'ERR_CONTENT_SCAN_POLICY'});
});
test('disabled secrets are explicit; bytes reflect utf8 and reported paths escape bidi', () => {
  assert.equal(scan('-----BEGIN PRIVATE KEY-----',{secrets:false}).status,'passed');
  assert.equal(scan('😀').bytes,4);
  assert.equal(scan('\u202e',{},'src/a\u202eb.ts').findings[0].path,'src/a\\u202eb.ts');
});
test('contract capture rejects getters custom prototypes symbols hidden properties and sparse arrays', () => {
  let invoked = false;
  const accessor = Object.defineProperty({}, 'secrets', { enumerable:true, get(){invoked=true; return true;} });
  const hidden = Object.defineProperty({}, 'secrets', {value:true});
  for (const input of [accessor,hidden,Object.create({secrets:true}),{[Symbol('hidden')]:true}]) assert.throws(()=>validateContentScanPolicy(input),{code:'ERR_CONTENT_SCAN_POLICY'});
  const files = new Array(1_000_000_000);
  assert.throws(()=>scanChangedContent({files}),{code:'ERR_CONTENT_SCAN_INPUT'});
  const nested = [{path:'a',get content(){invoked=true;return 'x';}}];
  assert.throws(()=>scanChangedContent({files:nested}),{code:'ERR_CONTENT_SCAN_INPUT'});
  assert.throws(()=>scanChangedContent({get files(){invoked=true;return [];}}),{code:'ERR_CONTENT_SCAN_INPUT'});
  const proxy = new Proxy({}, { ownKeys(){invoked=true;return [];} });
  assert.throws(()=>validateContentScanPolicy(proxy),{code:'ERR_CONTENT_SCAN_POLICY'});
  assert.equal(invoked,false);
});
test('immutable capture detaches arrays and rejects unsafe exception reasons', () => {
  const input={allowlist:[{ruleId:'private-key',path:'fixture.txt',reason:'Fixture only'}]};
  const policy=validateContentScanPolicy(input);
  input.allowlist[0].path='other.txt';
  assert.equal(policy.allowlist[0].path,'fixture.txt');
  assert.equal(Object.isFrozen(policy.allowlist[0]),true);
  assert.equal(Object.isFrozen(scan('safe').findings),true);
  for(const reason of ['line\ncontrol','bidi\u202e',`npm_${'a'.repeat(36)}`,'password=examplevalue']) assert.throws(()=>validateContentScanPolicy({allowlist:[{ruleId:'private-key',path:'fixture.txt',reason}]}),{code:'ERR_CONTENT_SCAN_POLICY'});
});

test('literal route brackets and braces are exact paths rather than suppression patterns', () => {
  const content = '-----BEGIN PRIVATE KEY-----';
  for (const path of ['app/users/[id]/page.tsx', 'fixtures/{sample}.txt']) {
    const policy = { allowlist: [{ ruleId: 'private-key', path, reason: 'Reviewed marker fixture' }] };
    assert.equal(scan(content, policy, path).status, 'passed');
    assert.equal(scan(content, policy, path.replace('[id]', 'actual-id').replace('{sample}', 'sample')).status, 'failed');
    assert.equal(scan(`npm_${'a'.repeat(36)}`, policy, path).status, 'failed');
  }
});
