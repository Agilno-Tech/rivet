import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cp,mkdir,mkdtemp,realpath,rm,readFile,writeFile,chmod,symlink,link,rename,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import {createOutput} from '../../src/cli/output.js';
import {EventEmitter} from 'node:events';
import {prepareExecutionPolicyUpdate} from '../../src/commands/init.js';
import {main} from '../../src/cli/main.js';
import {validatePolicyTranslation,compileModelPolicy} from '../../src/models/policy-contract.js';
const prose='Use high reasoning: Astra/Opus for coordination and independent review; Sol for implementation; Luna for bounded fixes.';
const routes=['coordination','independent-review','implementation','bounded-fix'];
function translation(){return {routes:routes.map((route,i)=>({route,candidates:(i<2?['Astra','Opus']:[i===2?'Sol':'Luna']).map(modelReference=>({modelReference,harness:null,effort:'high'})),source:prose,rationale:'Requested work category.'})),assumptions:[]};}
async function fixture(t){const root=await realpath(await mkdtemp(join(tmpdir(),'rivet-policy-test-')));t.after(()=>rm(root,{recursive:true,force:true}));execFileSync('/usr/bin/git',['init','-q',root]);await cp(new URL('../fixtures/config/valid/.rivet/',import.meta.url),join(root,'.rivet'),{recursive:true});return root;}
function services(root){const messages=[],questions=[];let calls=0;return {messages,questions,get calls(){return calls;},overrides:{env:{HOME:root},cwd:()=>root,reportFailure:false,terminalIsInteractive:()=>true,output:{log:s=>messages.push(s),error:s=>messages.push(s)},harnesses:{discover:async()=>[{kind:'codex',executable:'/opt/codex',version:'1'}],select:async()=>({kind:'codex',executable:'/opt/codex',version:'1'})},models:{translatePolicy:async()=>{calls++;return translation();}},modelPolicyPrompt:async q=>{questions.push(q);if(q.type==='confirm')return true;if(q.id.startsWith('candidate'))return 0;if(q.id.startsWith('harness'))return 'codex';if(q.id.startsWith('model'))return `exact-${q.reference.toLowerCase()}`;throw Error(q.id);}}};}

test('plain policy rejects missing duplicate unsafe and authority-bearing translations',()=>{for(const mutate of [x=>x.routes.pop(),x=>x.routes[1].route='coordination',x=>x.limits={},x=>x.routes[0].candidates[0].effort='turbo',x=>x.assumptions.push('\x1b[31m')]){const value=translation();mutate(value);assert.throws(()=>validatePolicyTranslation(value,prose));}assert.equal(validatePolicyTranslation(translation(),prose).routes.length,4);});
test('plain policy compiles fixed capabilities while preserving existing limits and sessions',()=>{const mapped=Object.fromEntries(routes.map(route=>[route,{harness:'codex',model:'exact-model',effort:'high'}]));const policy=compileModelPolicy(mapped);assert.deepEqual(policy.profiles[policy.routing.coordination].capabilities,['read']);assert.deepEqual(policy.profiles[policy.routing.implementation].capabilities,['read','edit','commands']);const previous={...policy,limits:{...policy.limits,agentExecutions:1},sessions:{...policy.sessions,maxReplacements:0}};assert.equal(JSON.stringify(compileModelPolicy(mapped,previous).limits),JSON.stringify(previous.limits));assert.equal(JSON.stringify(compileModelPolicy(mapped,previous).sessions),JSON.stringify(previous.sessions));});
test('models configure translates prose once clarifies shared aliases and approves exact mapping',async t=>{const root=await fixture(t),s=services(root);assert.equal(await main(['models','configure',prose],s.overrides),0);assert.equal(s.calls,1);assert.equal(s.questions.filter(q=>q.id.startsWith('model')).length,3);const policy=YAML.parse(await readFile(join(root,'.rivet/orchestration.yaml'),'utf8')).executionPolicy;assert.equal(policy.profiles[policy.routing.coordination].model,'exact-astra');assert.match(s.messages.join('\n'),/Requested reasoning|Reasoning/);assert.match(s.messages.join('\n'),/not live verified/);});
test('models configure decline and changed config cannot publish',async t=>{for(const changed of [false,true]){const root=await fixture(t),s=services(root),path=join(root,'.rivet/orchestration.yaml'),before=await readFile(path,'utf8');const prompt=s.overrides.modelPolicyPrompt;s.overrides.modelPolicyPrompt=async q=>{if(q.type==='confirm'){if(changed)await writeFile(path,before+'\n# external edit\n');return changed;}return prompt(q);};await main(['models','configure',prose],s.overrides);assert.equal(await readFile(path,'utf8'),before+(changed?'\n# external edit\n':''));}});

test('models configure output failure EOF interruption and invalid translator output leave config unchanged',async t=>{for(const mode of ['output','eof','interrupt','invalid','effort']){const root=await fixture(t),s=services(root),path=join(root,'.rivet/orchestration.yaml'),before=await readFile(path,'utf8');const prompt=s.overrides.modelPolicyPrompt;const controller=new AbortController();s.overrides.models.signal=controller.signal;s.overrides.modelPolicyPrompt=async q=>{if(q.type==='confirm'){if(mode==='eof')throw Error('EOF');if(mode==='interrupt')controller.abort();}if(mode==='effort'&&q.id.startsWith('harness'))return 'claude';return prompt(q);};if(mode==='output')s.overrides.output.log=()=>{throw Error('EPIPE');};if(['invalid','effort'].includes(mode))s.overrides.models.translatePolicy=async()=>{const v=translation();if(mode==='invalid')v.permissions={deploy:true};else v.routes[0].candidates[0].effort='ultra';return v;};assert.notEqual(await main(['models','configure',prose],s.overrides),0);assert.equal(await readFile(path,'utf8'),before);}});
test('models configure bounds unsafe input before any harness call',async t=>{const root=await fixture(t);for(const bad of ['', 'x'.repeat(16001),'hello\u001b[0m','Use sk-ant-api03-'+ 'x'.repeat(100)]){const s=services(root);assert.notEqual(await main(['models','configure',bad],s.overrides),0);assert.equal(s.calls,0);}const s=services(root);s.overrides.terminalIsInteractive=()=>false;assert.notEqual(await main(['models','configure',prose],s.overrides),0);assert.equal(s.calls,0);});
test('models configure reuses configured exact profiles and retains unrelated profiles comments and permissions',async t=>{const root=await fixture(t),s=services(root),path=join(root,'.rivet/orchestration.yaml'),source=await readFile(path,'utf8');const mapped=Object.fromEntries(routes.map(route=>[route,{harness:'codex',model:'Astra',effort:'high'}]));const previous=JSON.parse(JSON.stringify(compileModelPolicy(mapped)));previous.limits.agentExecutions=1;previous.sessions.maxReplacements=0;previous.profiles.unused={harness:'claude',model:'retained',effort:'low',capabilities:['read']};const doc=YAML.parseDocument(source);doc.set('executionPolicy',previous);await writeFile(path,'# keep this comment\n'+String(doc),{mode:0o640});s.overrides.models.translatePolicy=async()=>{const v=translation();for(const r of v.routes)r.candidates=[{modelReference:'Astra',harness:'codex',effort:'high'}];return v;};assert.equal(await main(['models','configure',prose],s.overrides),0);assert.equal(s.questions.filter(q=>q.id.startsWith('model')).length,0);const after=await readFile(path,'utf8');assert.match(after,/# keep this comment/);const result=YAML.parse(after).executionPolicy;assert.deepEqual(result.limits,previous.limits);assert.deepEqual(result.sessions,previous.sessions);assert.deepEqual(result.profiles.unused,previous.profiles.unused);assert.equal(YAML.parse(after).enabled,false);});
test('plain policy profile collisions cannot overwrite any selected or unrelated profile',()=>{const mapped=Object.fromEntries(routes.map((route,i)=>[route,{harness:'codex',model:`model-${i}`,effort:'high'}]));const base=JSON.parse(JSON.stringify(compileModelPolicy(mapped)));base.profiles['coordination-2']={harness:'claude',model:'retained',effort:'low',capabilities:['read']};mapped.coordination.model='new-model';const next=compileModelPolicy(mapped,base);assert.equal(next.profiles[next.routing.coordination].model,'new-model');assert.equal(next.profiles['coordination-2'].model,'retained');assert.equal(next.profiles[next.routing['independent-review']].model,'model-1');});

test('model policy safe writer refuses readonly symlink hardlink and changed topology',async t=>{for(const mode of ['readonly','symlink','hardlink','topology']){const root=await fixture(t),s=services(root),path=join(root,'.rivet/orchestration.yaml'),before=await readFile(path,'utf8');if(mode==='readonly')await chmod(path,0o444);if(['symlink','hardlink'].includes(mode)){await rename(path,join(root,'original'));await(mode==='symlink'?symlink:link)(join(root,'original'),path);}if(mode==='topology'){const prompt=s.overrides.modelPolicyPrompt;s.overrides.modelPolicyPrompt=async q=>{if(q.type==='confirm')await writeFile(join(root,'.rivet/extra.yaml'),'new topology');return prompt(q);};}assert.notEqual(await main(['models','configure',prose],s.overrides),0);assert.equal(await readFile(path,'utf8'),before);}});
test('model policy writer checks cancellation at final commit boundary',async t=>{const root=await fixture(t),path=join(root,'.rivet/orchestration.yaml'),before=await readFile(path,'utf8');const update=await prepareExecutionPolicyUpdate(root,{beforeCommit(){throw Error('cancelled');}});const policy=compileModelPolicy(Object.fromEntries(routes.map(route=>[route,{model:'exact',harness:'codex',effort:'high'}])));await assert.rejects(update.propose(policy).commit());assert.equal(await readFile(path,'utf8'),before);});
test('models configure asynchronous output error during approval refuses save',async t=>{const root=await fixture(t),s=services(root),path=join(root,'.rivet/orchestration.yaml'),before=await readFile(path,'utf8');const stream=new EventEmitter();stream.write=()=>true;s.overrides.output=createOutput({stdout:stream,stderr:{write(){}}});const prompt=s.overrides.modelPolicyPrompt;s.overrides.modelPolicyPrompt=async q=>{if(q.type==='confirm')stream.emit('error',Object.assign(Error('pipe'),{code:'EPIPE'}));return prompt(q);};assert.notEqual(await main(['models','configure',prose],s.overrides),0);assert.equal(await readFile(path,'utf8'),before);});
test('models configure missing model and reasoning are clarified rather than defaulted silently',async t=>{const root=await fixture(t),s=services(root),prompt=s.overrides.modelPolicyPrompt;s.overrides.models.translatePolicy=async()=>{const v=translation();v.routes[0].candidates=[{modelReference:null,harness:null,effort:null}];return v;};s.overrides.modelPolicyPrompt=async q=>q.id.startsWith('reference')?'Astra':q.id.startsWith('effort')?'high':prompt(q);assert.equal(await main(['models','configure',prose],s.overrides),0);});

test('model policy update preserves exact file permissions despite process umask',async t=>{
 const root=await fixture(t),s=services(root),path=join(root,'.rivet/orchestration.yaml');
 await chmod(path,0o660);assert.equal((await lstat(path)).mode&0o7777,0o660);
 const oldMask=process.umask(0o022);
 try{assert.equal(await main(['models','configure',prose],s.overrides),0);assert.equal((await lstat(path)).mode&0o7777,0o660);}
 finally{process.umask(oldMask);}
});
test('model policy keeps case-sensitive existing model identities distinct',async t=>{
 const root=await fixture(t),s=services(root),path=join(root,'.rivet/orchestration.yaml');
 const exactProse='Use ModelX for coordination, modelx for implementation, high reasoning for all work.';
 const mapped=Object.fromEntries(routes.map(route=>[route,{harness:'codex',model:route==='coordination'?'ModelX':'modelx',effort:'high'}]));
 const document=YAML.parseDocument(await readFile(path,'utf8'));document.set('executionPolicy',compileModelPolicy(mapped));await writeFile(path,String(document));
 s.overrides.models.translatePolicy=async()=>({routes:routes.map(route=>({route,candidates:[{modelReference:route==='coordination'?'ModelX':'modelx',harness:'codex',effort:'high'}],source:exactProse,rationale:'Exact requested model.'})),assumptions:[]});
 assert.equal(await main(['models','configure',exactProse],s.overrides),0);
 const policy=YAML.parse(await readFile(path,'utf8')).executionPolicy;
 assert.equal(policy.profiles[policy.routing.coordination].model,'ModelX');assert.equal(policy.profiles[policy.routing.implementation].model,'modelx');
});

test('models configure partial policy translation receives existing exact routing',async t=>{
 const root=await fixture(t),s=services(root),path=join(root,'.rivet/orchestration.yaml');
 const previous=compileModelPolicy(Object.fromEntries(routes.map(route=>[route,{harness:'codex',model:'existing-model',effort:'high'}])));
 const document=YAML.parseDocument(await readFile(path,'utf8'));document.set('executionPolicy',previous);await writeFile(path,String(document));
 const partial='Keep the other choices and use high reasoning for bounded fixes.';
 s.overrides.models.translatePolicy=async input=>{assert.equal(JSON.stringify(input.routing),JSON.stringify(previous.routing));assert.equal(input.profiles[input.routing.coordination].model,'existing-model');return {routes:routes.map(route=>({route,candidates:[{modelReference:previous.routing[route],harness:'codex',effort:'high'}],source:partial,rationale:'Preserve existing routed profile.'})),assumptions:[]};};
 assert.equal(await main(['models','configure',partial],s.overrides),0);
});

test('models configure without prose proposes detected Claude defaults without translation and requires approval',async t=>{
 const root=await fixture(t),s=services(root);s.overrides.env={};s.overrides.harnesses.discover=async()=>[{kind:'claude',executable:'/opt/claude'}];
 s.overrides.modelPolicyPrompt=async q=>{s.questions.push(q);if(q.id==='default-action')return 'keep';if(q.id==='approve-policy')return true;throw Error(q.id);};
 assert.equal(await main(['models','configure'],s.overrides),0);assert.equal(s.calls,0);
 const policy=YAML.parse(await readFile(join(root,'.rivet/orchestration.yaml'),'utf8')).executionPolicy;
 assert.deepEqual(routes.map(r=>policy.profiles[policy.routing[r]].model),['opus','opus','sonnet','haiku']);
 assert.ok(routes.every(r=>policy.profiles[policy.routing[r]].effort==='high'));
 assert.match(s.messages.join('\n'),/provider-resolved aliases/);assert.ok(s.questions.some(q=>q.id==='approve-policy'));
});
test('models configure without prose reuses existing routes and limits even without installed harnesses',async t=>{
 const root=await fixture(t),s=services(root),path=join(root,'.rivet/orchestration.yaml');
 const previous=compileModelPolicy(Object.fromEntries(routes.map(route=>[route,{harness:'codex',model:'existing-model',effort:'medium'}])));
 const document=YAML.parseDocument(await readFile(path,'utf8'));document.set('executionPolicy',previous);await writeFile(path,String(document));
 s.overrides.harnesses.discover=async()=>[];s.overrides.modelPolicyPrompt=async q=>q.id==='default-action'?'keep':q.id==='approve-policy'?true:null;
 assert.equal(await main(['models','configure'],s.overrides),0);assert.equal(s.calls,0);assert.deepEqual(YAML.parse(await readFile(path,'utf8')).executionPolicy,JSON.parse(JSON.stringify(previous)));
});
test('models configure Codex defaults request one exact model or use explicit Rivet model setting',async t=>{
 for(const configured of [false,true]){const root=await fixture(t),s=services(root);s.overrides.env=configured?{RIVET_CODEX_MODEL:'configured-exact',OPENAI_MODEL:'wrong-provider'}:{};
 s.overrides.modelPolicyPrompt=async q=>{s.questions.push(q);return q.id==='default-codex-model'?'entered-exact':q.id==='default-action'?'keep':q.id==='approve-policy'?true:null;};
 assert.equal(await main(['models','configure'],s.overrides),0);assert.equal(s.calls,0);assert.equal(s.questions.filter(q=>q.id==='default-codex-model').length,configured?0:1);
 const policy=YAML.parse(await readFile(join(root,'.rivet/orchestration.yaml'),'utf8')).executionPolicy;assert.ok(routes.every(r=>policy.profiles[policy.routing[r]].model===(configured?'configured-exact':'entered-exact')));
 }
});
test('models configure default proposal can be edited or declined without translating',async t=>{
 for(const approve of [false,true]){const root=await fixture(t),s=services(root),path=join(root,'.rivet/orchestration.yaml'),before=await readFile(path,'utf8');s.overrides.env={RIVET_CODEX_MODEL:'initial-exact'};
 let editing=false;s.overrides.modelPolicyPrompt=async q=>{if(q.id==='default-action')return 'edit';if(q.id==='edit-route'){if(editing)return 'done';editing=true;return 'bounded-fix';}if(q.id==='edit-harness')return 'codex';if(q.id==='edit-model')return 'changed-exact';if(q.id==='edit-effort')return 'low';if(q.id==='approve-policy')return approve;throw Error(q.id);};
 assert.equal(await main(['models','configure'],s.overrides),0);assert.equal(s.calls,0);
 if(!approve)assert.equal(await readFile(path,'utf8'),before);else{const policy=YAML.parse(await readFile(path,'utf8')).executionPolicy;assert.equal(policy.profiles[policy.routing['bounded-fix']].model,'changed-exact');assert.equal(policy.profiles[policy.routing['bounded-fix']].effort,'low');}
 }
});
test('models configure defaults refuse absent harnesses invalid model settings and interrupted approval',async t=>{
 for(const mode of ['absent','invalid','interrupt']){const root=await fixture(t),s=services(root),path=join(root,'.rivet/orchestration.yaml'),before=await readFile(path,'utf8'),controller=new AbortController();s.overrides.env={RIVET_CODEX_MODEL:mode==='invalid'?'sk-ant-api03-'+ 'x'.repeat(100):'exact-model'};
 if(mode==='absent')s.overrides.harnesses.discover=async()=>[];s.overrides.models.signal=controller.signal;
 s.overrides.modelPolicyPrompt=async q=>{if(q.id==='default-action')return 'keep';if(q.id==='approve-policy'){controller.abort();return true;}return null;};
 assert.notEqual(await main(['models','configure'],s.overrides),0);assert.equal(s.calls,0);assert.equal(await readFile(path,'utf8'),before);assert.doesNotMatch(s.messages.join('\n'),/sk-ant-api03-/);
 }
});

test('models configure prose offers defaults only for unspecified models and high reasoning first',async t=>{
 const root=await fixture(t),s=services(root),policyText='Use sensible defaults for all work.';
 s.overrides.env={};s.overrides.harnesses.discover=async()=>[{kind:'claude',executable:'/opt/claude'}];s.overrides.harnesses.select=async()=>({kind:'claude',executable:'/opt/claude'});
 s.overrides.models.translatePolicy=async()=>({routes:routes.map(route=>({route,candidates:[{modelReference:null,harness:null,effort:null}],source:policyText,rationale:'User requests defaults.'})),assumptions:[]});
 s.overrides.modelPolicyPrompt=async q=>{if(q.id.startsWith('reference')){assert.equal(q.defaultValue,{'reference-coordination':'opus','reference-independent-review':'opus','reference-implementation':'sonnet','reference-bounded-fix':'haiku'}[q.id]);return q.defaultValue;}if(q.id.startsWith('effort')){assert.equal(q.choices[0].value,'high');return 'high';}if(q.id==='approve-policy')return true;throw Error(q.id);};
 assert.equal(await main(['models','configure',policyText],s.overrides),0);
});
test('models configure prose never suggests an unrelated default for an explicit unknown alias',async t=>{
 const root=await fixture(t),s=services(root);s.overrides.env={RIVET_CODEX_MODEL:'unrelated-default'};const prompt=s.overrides.modelPolicyPrompt;
 s.overrides.modelPolicyPrompt=async q=>{if(q.id.startsWith('model'))assert.equal(q.defaultValue,undefined);return prompt(q);};
 assert.equal(await main(['models','configure',prose],s.overrides),0);
});
test('models configure resolves recognized installed Claude aliases and preserves exact configured identity first',async t=>{
 const root=await fixture(t),s=services(root),policyText='Use Opus with high reasoning for all work.';
 s.overrides.env={};s.overrides.harnesses.discover=async()=>[{kind:'claude',executable:'/opt/claude'}];s.overrides.harnesses.select=async()=>({kind:'claude',executable:'/opt/claude'});
 s.overrides.models.translatePolicy=async()=>({routes:routes.map(route=>({route,candidates:[{modelReference:'Opus',harness:'claude',effort:'high'}],source:policyText,rationale:'Requested Claude alias.'})),assumptions:[]});
 s.overrides.modelPolicyPrompt=async q=>{assert.equal(q.id,'approve-policy');return true;};
 assert.equal(await main(['models','configure',policyText],s.overrides),0);
 const policy=YAML.parse(await readFile(join(root,'.rivet/orchestration.yaml'),'utf8')).executionPolicy;assert.ok(routes.every(r=>policy.profiles[policy.routing[r]].model==='opus'));
});
test('models configure both installed harnesses require a default choice unless explicitly selected',async t=>{
 for(const flag of [false,true]){const root=await fixture(t),s=services(root);s.overrides.env={RIVET_CODEX_MODEL:'codex-exact'};s.overrides.harnesses.discover=async()=>[{kind:'claude',executable:'/opt/claude'},{kind:'codex',executable:'/opt/codex'}];
 s.overrides.modelPolicyPrompt=async q=>{s.questions.push(q);return q.id==='default-harness'?'codex':q.id==='default-action'?'keep':q.id==='approve-policy'?true:null;};
 assert.equal(await main(['models','configure',...(flag?['--harness=codex']:[])],s.overrides),0);assert.equal(s.questions.filter(q=>q.id==='default-harness').length,flag?0:1);assert.equal(s.calls,0);
 const policy=YAML.parse(await readFile(join(root,'.rivet/orchestration.yaml'),'utf8')).executionPolicy;assert.ok(routes.every(r=>policy.profiles[policy.routing[r]].harness==='codex'));
 }
});
test('models configure defaults preserve approval fencing for changed files and failed output',async t=>{
 for(const mode of ['changed','output','eof']){const root=await fixture(t),s=services(root),path=join(root,'.rivet/orchestration.yaml'),before=await readFile(path,'utf8');s.overrides.env={RIVET_CODEX_MODEL:'codex-exact'};
 s.overrides.modelPolicyPrompt=async q=>{if(q.id==='default-action')return 'keep';if(q.id==='approve-policy'){if(mode==='eof')return null;if(mode==='changed')await writeFile(path,before+'\n# concurrent edit\n');return true;}throw Error(q.id);};
 if(mode==='output')s.overrides.output.log=()=>{throw Error('EPIPE');};
 assert.notEqual(await main(['models','configure'],s.overrides),0);assert.equal(await readFile(path,'utf8'),before+(mode==='changed'?'\n# concurrent edit\n':''));
 }
});

test('models configure recognized alias does not replace ambiguous configured identities',async t=>{
 const root=await fixture(t),s=services(root),path=join(root,'.rivet/orchestration.yaml'),policyText='Use opus with high reasoning for all work.';
 const previous=JSON.parse(JSON.stringify(compileModelPolicy(Object.fromEntries(routes.map(route=>[route,{harness:'claude',model:'opus',effort:'high'}])))));
 previous.profiles.opus={harness:'claude',model:'another-exact-model',effort:'high',capabilities:['read']};
 const document=YAML.parseDocument(await readFile(path,'utf8'));document.set('executionPolicy',previous);await writeFile(path,String(document));
 s.overrides.env={};s.overrides.harnesses.discover=async()=>[{kind:'claude',executable:'/opt/claude'}];s.overrides.harnesses.select=async()=>({kind:'claude',executable:'/opt/claude'});
 s.overrides.models.translatePolicy=async()=>({routes:routes.map(route=>({route,candidates:[{modelReference:'opus',harness:'claude',effort:'high'}],source:policyText,rationale:'Explicit ambiguous reference.'})),assumptions:[]});
 s.overrides.modelPolicyPrompt=async q=>{s.questions.push(q);if(q.id.startsWith('model'))return 'chosen-exact';if(q.id.startsWith('harness'))return 'claude';if(q.id==='approve-policy')return true;throw Error(q.id);};
 assert.equal(await main(['models','configure',policyText],s.overrides),0,s.messages.join('\n'));assert.equal(s.questions.filter(q=>q.id.startsWith('model')).length,1);
 const policy=YAML.parse(await readFile(path,'utf8')).executionPolicy;assert.ok(routes.every(r=>policy.profiles[policy.routing[r]].model==='chosen-exact'));
});

test('models configure detects saved Codex user model without manual entry and retains approval',async t=>{
 for(const approve of [false,true]){const root=await fixture(t),s=services(root),path=join(root,'.rivet/orchestration.yaml'),before=await readFile(path,'utf8');
 await mkdir(join(root,'.codex'));await writeFile(join(root,'.codex/config.toml'),'model="saved-codex-model"\nmodel_reasoning_effort="low"\n');
 s.overrides.modelPolicyPrompt=async q=>{s.questions.push(q);if(q.id==='default-action')return 'keep';if(q.id==='approve-policy')return approve;throw Error(q.id);};
 assert.equal(await main(['models','configure'],s.overrides),0,s.messages.join('\n'));assert.equal(s.calls,0);assert.equal(s.questions.some(q=>q.id==='default-codex-model'),false);assert.match(s.messages.join('\n'),/Codex user config/);
 if(!approve)assert.equal(await readFile(path,'utf8'),before);else{const policy=YAML.parse(await readFile(path,'utf8')).executionPolicy;assert.ok(routes.every(r=>policy.profiles[policy.routing[r]].model==='saved-codex-model'&&policy.profiles[policy.routing[r]].effort==='high'));}
 }
});
test('models configure uses saved Codex model in prose suggestions and harness route edits',async t=>{
 for(const mode of ['prose','edit']){const root=await fixture(t),s=services(root),policyText='Use defaults with high reasoning.';await mkdir(join(root,'.codex'));await writeFile(join(root,'.codex/config.toml'),'model="saved-codex-model"');
 if(mode==='prose')s.overrides.models.translatePolicy=async()=>({routes:routes.map(route=>({route,candidates:[{modelReference:null,harness:'codex',effort:'high'}],source:policyText,rationale:'Requested defaults.'})),assumptions:[]});
 else s.overrides.harnesses.discover=async()=>[{kind:'claude',executable:'/opt/claude'}];
 let edited=false;s.overrides.modelPolicyPrompt=async q=>{if(q.id.startsWith('reference')||q.id==='edit-model'){assert.equal(q.defaultValue,'saved-codex-model');return q.defaultValue;}if(q.id==='default-action')return 'edit';if(q.id==='edit-route'){if(edited)return 'done';edited=true;return 'bounded-fix';}if(q.id==='edit-harness')return 'codex';if(q.id==='edit-effort')return 'high';if(q.id==='approve-policy')return true;throw Error(q.id);};
 assert.equal(await main(['models','configure',...(mode==='prose'?[policyText]:[])],s.overrides),0,s.messages.join('\n'));
 }
});
test('models configure saved Rivet mapping wins over Codex user config and unresolved config asks safely',async t=>{
 for(const mode of ['saved','malformed']){const root=await fixture(t),s=services(root),path=join(root,'.rivet/orchestration.yaml');await mkdir(join(root,'.codex'));await writeFile(join(root,'.codex/config.toml'),'model="sk-ant-api03-'+ 'x'.repeat(100)+'"\n[bad');
 if(mode==='saved'){const doc=YAML.parseDocument(await readFile(path,'utf8'));doc.set('executionPolicy',compileModelPolicy(Object.fromEntries(routes.map(r=>[r,{harness:'codex',model:'saved-rivet',effort:'medium'}]))));await writeFile(path,String(doc));}
 s.overrides.modelPolicyPrompt=async q=>{s.questions.push(q);if(q.id==='default-codex-model')return 'manual-model';if(q.id==='default-action')return 'keep';if(q.id==='approve-policy')return true;throw Error(q.id);};
 assert.equal(await main(['models','configure'],s.overrides),0);assert.equal(s.questions.some(q=>q.id==='default-codex-model'),mode==='malformed');assert.doesNotMatch(s.messages.join('\n'),/sk-ant|\[bad/);
 const policy=YAML.parse(await readFile(path,'utf8')).executionPolicy;assert.ok(routes.every(r=>policy.profiles[policy.routing[r]].model===(mode==='saved'?'saved-rivet':'manual-model')));
 }
});

async function setupCatalog(root){await mkdir(join(root,'.codex'),{recursive:true});await writeFile(join(root,'.codex/models_cache.json'),JSON.stringify({fetched_at:'2026-10-01T10:00:00Z',identity:'PRIVATE-ID',models:['astra','sol','luna'].map((family,i)=>({slug:`gpt-6-${family}`,visibility:'list',priority:i,default_reasoning_level:'medium',supported_reasoning_levels:(family==='luna'?['medium']:['high','medium']).map(effort=>({effort,description:'PRIVATE-DESCRIPTION'}))}))}));}
test('models configure recommends cached Codex role mapping and requires exact final approval',async t=>{const root=await fixture(t),s=services(root);await setupCatalog(root);s.overrides.modelPolicyPrompt=async q=>{s.questions.push(q);if(q.id==='default-action'){assert.deepEqual(q.choices.map(x=>x.label),['Accept recommendations','Customize']);return 'keep';}if(q.id==='approve-policy')return true;throw Error(q.id);};assert.equal(await main(['models','configure'],s.overrides),0);const p=YAML.parse(await readFile(join(root,'.rivet/orchestration.yaml'),'utf8')).executionPolicy;assert.deepEqual(routes.map(r=>p.profiles[p.routing[r]].model),['gpt-6-astra','gpt-6-astra','gpt-6-sol','gpt-6-luna']);assert.equal(p.profiles[p.routing['bounded-fix']].effort,'medium');assert.match(s.messages.join('\n'),/cached, not live verified/);assert.match(s.messages.join('\n'),/2026-10-01/);assert.doesNotMatch(s.messages.join('\n'),/PRIVATE/);assert.equal(s.calls,0);});
test('models configure customizes detected models with advertised reasoning and rejects stale approval',async t=>{for(const stale of [false,true]){const root=await fixture(t),s=services(root),path=join(root,'.rivet/orchestration.yaml'),before=await readFile(path,'utf8');await setupCatalog(root);let edited=false;s.overrides.modelPolicyPrompt=async q=>{if(q.id==='default-action')return 'edit';if(q.id==='edit-route'){if(edited)return 'done';edited=true;return 'coordination';}if(q.id==='edit-harness')return 'codex';if(q.id==='edit-codex-model'){assert.ok(q.choices.some(x=>x.value==='__custom__'));return 'gpt-6-luna';}if(q.id==='edit-effort'){assert.deepEqual(q.choices.map(x=>x.value),['medium']);return 'medium';}if(q.id==='approve-policy'){if(stale)await writeFile(path,before+'\n# concurrent edit\n');return true;}throw Error(q.id);};assert.equal(await main(['models','configure'],s.overrides),stale?1:0);if(stale)assert.equal(await readFile(path,'utf8'),before+'\n# concurrent edit\n');else{const p=YAML.parse(await readFile(path,'utf8')).executionPolicy;assert.equal(p.profiles[p.routing.coordination].model,'gpt-6-luna');}}});
test('models configure cached recommendations preserve saved routes and explicit override',async t=>{for(const saved of [false,true]){const root=await fixture(t),s=services(root),path=join(root,'.rivet/orchestration.yaml');await setupCatalog(root);s.overrides.env.RIVET_CODEX_MODEL='gpt-6-luna';if(saved){const doc=YAML.parseDocument(await readFile(path,'utf8'));doc.set('executionPolicy',compileModelPolicy(Object.fromEntries(routes.map(route=>[route,{harness:'codex',model:'saved-exact',effort:'low'}]))));await writeFile(path,String(doc));}s.overrides.modelPolicyPrompt=async q=>q.id==='default-action'?'keep':q.id==='approve-policy'?true:null;assert.equal(await main(['models','configure'],s.overrides),0);const p=YAML.parse(await readFile(path,'utf8')).executionPolicy;assert.ok(routes.every(r=>p.profiles[p.routing[r]].model===(saved?'saved-exact':'gpt-6-luna')));assert.ok(routes.every(r=>p.profiles[p.routing[r]].effort===(saved?'low':'medium')));}});
test('models configure cached customization permits custom IDs and refuses unsupported known efforts',async t=>{for(const custom of [false,true]){const root=await fixture(t),s=services(root),path=join(root,'.rivet/orchestration.yaml'),before=await readFile(path,'utf8');await setupCatalog(root);let edited=false;s.overrides.modelPolicyPrompt=async q=>{if(q.id==='default-action')return 'edit';if(q.id==='edit-route'){if(edited)return 'done';edited=true;return 'bounded-fix';}if(q.id==='edit-harness')return 'codex';if(q.id==='edit-codex-model')return custom?'__custom__':'gpt-6-luna';if(q.id==='edit-model')return 'my-custom';if(q.id==='edit-effort')return 'high';if(q.id==='approve-policy')return true;throw Error(q.id);};assert.equal(await main(['models','configure'],s.overrides),custom?0:1);if(!custom)assert.equal(await readFile(path,'utf8'),before);else assert.match(s.messages.join('\n'),/model-specific reasoning support unverified/);}});
