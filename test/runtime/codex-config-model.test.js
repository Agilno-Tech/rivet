import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {resolveConfiguredCodexModel} from '../../src/models/codex-config-model.js';
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'rivet-codex-model-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('Codex model detection resolves custom and default homes with TOML syntax',async t=>{
 const root=await fixture(t);await mkdir(join(root,'.codex'));await mkdir(join(root,'custom'));
 await writeFile(join(root,'.codex/config.toml'),'# model = "wrong"\n"model" = "saved-model" # comment\n[unrelated]\nmodel="nested-wrong"\n');
 await writeFile(join(root,'custom/config.toml'),"model = 'custom-model'\n");
 assert.deepEqual(await resolveConfiguredCodexModel({environment:{HOME:root},cwd:root}),{model:'saved-model',source:'Codex user config'});
 assert.equal((await resolveConfiguredCodexModel({environment:{HOME:root,CODEX_HOME:'custom'},cwd:root})).model,'custom-model');
 assert.equal((await resolveConfiguredCodexModel({environment:{CODEX_HOME:join(root,'custom')},cwd:root})).model,'custom-model');
 assert.equal((await resolveConfiguredCodexModel({environment:{},cwd:root})).model,undefined);
});
test('Codex model detection uses explicit override before config and selected legacy profile before root model',async t=>{
 const root=await fixture(t),file=join(root,'config.toml'),input={environment:{CODEX_HOME:root},cwd:root};
 await writeFile(file,'model="base"\nprofile="chosen"\n[profiles.other]\nmodel="other"\n[profiles.chosen]\nmodel="selected"\n');
 assert.deepEqual(await resolveConfiguredCodexModel(input),{model:'selected',source:'Codex user config (selected profile)'});
 assert.deepEqual(await resolveConfiguredCodexModel({...input,environment:{...input.environment,RIVET_CODEX_MODEL:'override'}}),{model:'override',source:'RIVET_CODEX_MODEL'});
 await writeFile(file,'model="base"\nprofile="chosen"\n[profiles.chosen]\nmodel_reasoning_effort="low"\n');
 assert.equal((await resolveConfiguredCodexModel(input)).model,'base');
 for(const source of ['model="base"\nprofile="missing"','model="base"\nprofile=23','model="base"\nprofile="chosen"\n[profiles]\nchosen=2026-10-13','[profiles.other]\nmodel="other"']){await writeFile(file,source);assert.equal((await resolveConfiguredCodexModel(input)).model,undefined);}
});
test('Codex model detection fails closed for missing malformed unsafe oversized nonregular and invalid UTF8 config',async t=>{
 const root=await fixture(t),home=join(root,'home'),file=join(home,'config.toml');await mkdir(home);const input={environment:{CODEX_HOME:home},cwd:root};
 assert.equal((await resolveConfiguredCodexModel(input)).model,undefined);
 for(const content of ['model="first"\nmodel="duplicate"','model="safe"\n[invalid','model=42','model="sk-ant-api03-'+ 'x'.repeat(100)+'"','#'.repeat(65537),Buffer.from([0xff,0xfe]),'[other]\nmodel="wrong"']){await writeFile(file,content);const result=await resolveConfiguredCodexModel(input);assert.equal(result.model,undefined);assert.doesNotMatch(JSON.stringify(result),/sk-ant|duplicate|invalid/);}
 await rm(file);await mkdir(file);assert.equal((await resolveConfiguredCodexModel(input)).model,undefined);await rm(file,{recursive:true});
 await writeFile(join(root,'target'),'model="symlink-model"');await symlink(join(root,'target'),file);assert.equal((await resolveConfiguredCodexModel(input)).model,undefined);
});
