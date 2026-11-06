import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, writeFile, mkdir, symlink, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {discoverProject, MAX_DISCOVERY_FILE_BYTES as limit} from '../../src/discovery/project.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'rivet-size-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  await writeFile(join(root, 'package.json'), JSON.stringify({name:'size-test', scripts:{build:'echo build', test:'echo test'}}));
  return root;
}

test('optional documentation is accepted at the limit and skipped with a useful warning above it', async t => {
  const root = await fixture(t);
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'README.md', '.github/copilot-instructions.md']) {
    await mkdir(dirname(join(root,name)), {recursive:true});
    await writeFile(join(root,name), 'a'.repeat(limit));
    assert.ok((await discoverProject(root)).inspectedFiles.includes(name));
    await writeFile(join(root,name), 'a'.repeat(limit+1));
    const result = await discoverProject(root);
    assert.ok(!result.inspectedFiles.includes(name));
    const warning = result.warnings.find(item => item.path === name);
    assert.equal(warning.code, 'discovery-file-too-large');
    assert.equal(warning.sizeBytes, limit+1);
    assert.equal(warning.limitBytes, limit);
    assert.ok(warning.message.includes(name));
    assert.match(warning.message, /262145.*262144/);
  }
});

test('portable discovery also skips oversized AGENTS.md', async t => {
  const root = await fixture(t);
  await writeFile(join(root,'AGENTS.md'), 'a'.repeat(limit+1));
  const result = await discoverProject(root, {checks:{test:['echo','test']}});
  assert.ok(result.warnings.some(item => item.code === 'discovery-file-too-large'));
  assert.deepEqual(result.architectureHints, []);
});

test('optional document symlinks and directories remain rejected', async t => {
  const root = await fixture(t);
  await symlink(join(root,'package.json'), join(root,'AGENTS.md'));
  await assert.rejects(discoverProject(root), /regular bounded file/);
  await rm(join(root,'AGENTS.md'));
  await mkdir(join(root,'AGENTS.md'));
  await assert.rejects(discoverProject(root), /regular bounded file/);
});

test('oversized manifests and config files fail with a structured size error', async t => {
  for (const name of ['package.json', 'next.config.js']) {
    const root = await fixture(t);
    await writeFile(join(root,name), 'a'.repeat(limit+1));
    await assert.rejects(discoverProject(root), error => {
      assert.equal(error.code, 'ERR_DISCOVERY_FILE_TOO_LARGE');
      assert.equal(error.details.path, name);
      assert.match(error.message, /262145.*262144/);
      return true;
    });
  }
});

test('init and setup preserve actionable size errors and diagnostic cause codes', async t => {
  const root = await fixture(t);
  await writeFile(join(root,'package.json'), 'a'.repeat(limit+1));
  for (const command of ['init','setup']) {
    for (const json of [false,true]) {
      const result = spawnSync(process.execPath, ['bin/cli.js',command,'--project',root,...(json?['--json']:[])], {encoding:'utf8'});
      assert.equal(result.status,6,result.stderr);
      assert.match(result.stderr, /package.json.*262145.*262144/);
      if(json) {
        const value=JSON.parse(result.stderr);
        assert.equal((value.configuration ?? value).discovery.code,'ERR_DISCOVERY_FILE_TOO_LARGE');
      } else {
        const reportPath=result.stderr.match(/Diagnostic report: ([^\n]+)/)?.[1];
        assert.ok(reportPath,result.stderr);
        t.after(()=>rm(dirname(reportPath),{recursive:true,force:true}));
        assert.equal(JSON.parse(await readFile(reportPath,'utf8')).failure.causeCode,'ERR_DISCOVERY_FILE_TOO_LARGE');
      }
    }
  }
});

test('init and setup expose optional-file warnings in human and JSON previews without changing the file', async t => {
  const root = await fixture(t);
  const content = 'a'.repeat(300000);
  await writeFile(join(root,'AGENTS.md'), content);
  for (const command of ['init','setup']) {
    for (const json of [false,true]) {
      const result = spawnSync(process.execPath, ['bin/cli.js',command,'--project',root,...(json?['--json']:[])], {encoding:'utf8'});
      assert.equal(result.status,0,result.stderr);
      assert.match(result.stdout, /Skipped optional documentation.*AGENTS.md.*300000.*262144/);
      if(json) {
        const value=JSON.parse(result.stdout);
        assert.ok((value.configuration ?? value).discovery.warnings.some(item=>item.code==='discovery-file-too-large'));
      }
    }
  }
  assert.equal(await readFile(join(root,'AGENTS.md'),'utf8'),content);
});
