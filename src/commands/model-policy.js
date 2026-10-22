import {resolveConfiguredProject} from '../cli/project-discovery.js';
import {defaultIntegrationSetupPrompt} from '../cli/integration-setup-prompt.js';
import {CliError,EXIT_CODES,observeOutputErrors} from '../cli/output.js';
import {prepareExecutionPolicyUpdate} from './init.js';
import {translateModelPolicy} from '../models/policy-client.js';
import {POLICY_ROUTES,policyText,validatePolicyTranslation,compileModelPolicy} from '../models/policy-contract.js';
import {detectModelProviders,providerDetectionSummary,CLAUDE_POLICY_MODELS,exactPolicyModel} from '../models/detection.js';
import {readCodexModelCatalog,recommendCodexRoutes,resolveObservedCodexModel} from '../models/codex-model-catalog.js';
import {resolveConfiguredCodexModel} from '../models/codex-config-model.js';
import {SESSION_CAPABILITIES} from '../clients/session-capabilities.js';
const labels={coordination:'Coordination and technical decisions','independent-review':'Independent review',implementation:'Substantial implementation and complex debugging','bounded-fix':'Bounded fixes, focused tests and investigations'};
function fail(message){throw new CliError(message,'INVALID_INPUT');}
const cancelled=()=>fail('Model policy configuration cancelled. No policy was saved.');
export async function configureModelPolicy({operands,flags},dependencies){
 if(operands.length>1||Object.keys(flags).some(k=>!['project','harness'].includes(k))||!dependencies.terminalIsInteractive?.()||(flags.harness!==undefined&&!['claude','codex'].includes(flags.harness)))fail('Use rivet models configure ["policy"] [--harness=claude|codex] [--project=<path>] in an interactive terminal.');
 let prose;try{prose=operands.length?policyText(operands[0]):undefined;}catch{fail('Use policy text of at most 16 KiB without secrets or terminal control characters.');}
 const controller=new AbortController(),abort=()=>controller.abort(),external=dependencies.models?.signal;
 if(external?.aborted)abort();external?.addEventListener('abort',abort,{once:true});process.on('SIGINT',abort);process.on('SIGTERM',abort);
 const signal=controller.signal;let saved=false,outputFailed=false;const unobserve=observeOutputErrors(dependencies.output,()=>{outputFailed=true;abort();});
 const check=()=>{if(outputFailed)fail(saved?'Policy was saved, but the final output failed. Inspect .rivet/orchestration.yaml.':'Could not display the complete policy. No policy was saved.');if(signal.aborted){if(saved)fail('Policy was saved before interruption. Inspect .rivet/orchestration.yaml.');cancelled();}};
 const show=message=>{check();try{dependencies.output.log(message);}catch{outputFailed=true;}check();};
 const prompt=async question=>{check();let answer;try{answer=await(dependencies.modelPolicyPrompt??defaultIntegrationSetupPrompt)({...question,signal});}catch{cancelled();}check();if(answer===null||answer===undefined)cancelled();return answer;};
 try{
  check();const project=await resolveConfiguredProject(dependencies.cwd(),flags.project,{env:dependencies.env});
  const update=await prepareExecutionPolicyUpdate(project.root,{beforeCommit:check});const previous=update.config.orchestration.executionPolicy,profiles=previous?.profiles??{};
  const found=await dependencies.harnesses.discover(project.root,{signal});check();const eligible=found.filter(x=>x.executable&&SESSION_CAPABILITIES[x.kind]);
  show(providerDetectionSummary(detectModelProviders({environment:dependencies.env,harnesses:found})));
  let codexDefault;
  const codexModel=async()=>{if(!codexDefault){codexDefault=await resolveConfiguredCodexModel({environment:dependencies.env,cwd:dependencies.cwd()});check();show(`Codex model suggestion source: ${codexDefault.source}. Saved user configuration only; runtime overrides and model access are not verified.`);}return codexDefault.model;};
  let catalog;const codexCatalog=async()=>{if(!catalog){catalog=await readCodexModelCatalog({environment:dependencies.env,cwd:dependencies.cwd()});check();}return catalog;};
  const worker=update.config.orchestration.roles.find(role=>role.kind==='worker');
  const manager=update.config.orchestration.roles.find(role=>role.kind==='manager'&&role.delegatesTo.includes('worker'));
  if(!worker||!manager)fail('A worker and delegating manager role are required for model routing.');
  const ceiling=Math.min(manager.capacity,previous?.limits.agentExecutions??4,64);
  let concurrency=previous?Math.min(previous.limits.workersPerTask,worker.capacity,ceiling):Math.min(dependencies.modelPolicyFreshSetup?2:worker.capacity,ceiling);
  let changedConcurrency=!previous&&dependencies.modelPolicyFreshSetup===true;
  const concurrencyPreview=()=>show(`Concurrent workers per task: ${concurrency}. Worker role ${worker.id}: ${changedConcurrency?concurrency:worker.capacity}; manager capacity: ${manager.capacity}; agent execution limit: ${previous?.limits.agentExecutions??4}. Machine and parent limits may lower available capacity.`);
  const editConcurrency=async()=>{const value=await prompt({id:'worker-concurrency',type:'select',message:'Maximum concurrent workers per task (manager and execution limits are preserved):',choices:Array.from({length:ceiling},(_,i)=>({value:i+1,label:String(i+1)}))});if(!Number.isSafeInteger(value)||value<1||value>ceiling)fail('Invalid worker concurrency.');concurrency=value;changedConcurrency=true;};
  if(dependencies.modelPolicyAllowSkip&&!previous&&!eligible.length){show('No compatible task harness was detected. Model routing was skipped; run rivet models configure after installing Claude Code or Codex.');return EXIT_CODES.SUCCESS;}
  let translated,mapping;
  if(prose===undefined){
   const defaults=await defaultMapping({previous,eligible,requested:flags.harness,codexModel,codexCatalog,configured:()=>codexDefault,prompt,show,concurrencyPreview,editConcurrency,allowSkip:dependencies.modelPolicyAllowSkip});if(!defaults){show('Model routing skipped. Run rivet models configure when ready.');return EXIT_CODES.SUCCESS;}mapping=defaults.mapping;
   translated={routes:POLICY_ROUTES.map(route=>({route,...defaults.reasons[route]})),assumptions:[]};
  }else{
  let kind=flags.harness;if(!kind)kind=eligible.length===1?eligible[0].kind:eligible.length?await prompt({id:'translator',type:'select',message:'Choose the installed harness that will translate this policy:',choices:eligible.map(x=>({value:x.kind,label:x.kind}))}):null;
  if(!eligible.some(x=>x.kind===kind))fail('No compatible selected harness is available. Install and authenticate Claude Code or Codex.');
  const selected=await dependencies.harnesses.select(kind,project.root,{signal});check();
  show(`Translate this policy with ${kind} using a bounded read-only request. Target model availability is not live verified.`);
  translated=validatePolicyTranslation(await(dependencies.models?.translatePolicy??translateModelPolicy)({selected,prose,profiles,routing:previous?.routing??{},environment:dependencies.env,signal}),prose,profiles);check();
  const cache=new Map(),choices=new Map();mapping={};
  for(const route of POLICY_ROUTES){const item=translated.routes.find(x=>x.route===route);let candidate=item.candidates[0];
   if(item.candidates.length>1){const key=JSON.stringify(item.candidates);let index=choices.get(key);if(index===undefined){index=await prompt({id:`candidate-${route}`,type:'select',message:`Choose one model for ${labels[route]} (alternatives are not fallbacks):`,choices:item.candidates.map((x,i)=>({value:i,label:`${x.modelReference??'Unspecified model'} / ${x.harness??'harness to clarify'} / ${x.effort??'reasoning to clarify'}`}))});if(!Number.isInteger(index)||!item.candidates[index])fail('Invalid model choice.');choices.set(key,index);}candidate=item.candidates[index];}
   let reference=candidate.modelReference;
   if(reference===null){const old=previous?.profiles[previous.routing[route]],available=eligible.map(x=>x.kind);const preferred=candidate.harness??old?.harness??(available.length===1?available[0]:undefined);const suggestion=old&&(!preferred||old.harness===preferred)?old.model:preferred==='claude'?CLAUDE_POLICY_MODELS[route]:preferred==='codex'?await codexModel():undefined;reference=await prompt({id:`reference-${route}`,type:'input',message:`Which model should handle ${labels[route]}?${suggestion?' Suggested default shown; replace it to choose another.':''}`,defaultValue:suggestion});if(suggestion&&reference===suggestion&&preferred)cache.set(reference,{model:reference,harness:preferred});}try{policyText(reference,200);}catch{fail('Invalid model reference.');}
   const key=reference;let identity=cache.get(key);
   if(identity&&candidate.harness&&candidate.harness!==identity.harness)fail('Conflicting harnesses for a shared model reference.');
   if(!identity){const matches=Object.entries(profiles).filter(([id,p])=>(id===reference||p.model===reference)&&(!candidate.harness||candidate.harness===p.harness));
    const identities=[...new Map(matches.map(([,p])=>[`${p.harness}:${p.model}`,{harness:p.harness,model:p.model}])).values()];
    if(identities.length===1)identity=identities[0];
    else if(identities.length===0&&(candidate.harness===null||candidate.harness==='codex')&&eligible.some(x=>x.kind==='codex')&&resolveObservedCodexModel(await codexCatalog(),reference))identity={model:resolveObservedCodexModel(await codexCatalog(),reference),harness:'codex'};
    else if(identities.length===0&&(candidate.harness===null||candidate.harness==='claude')&&eligible.some(x=>x.kind==='claude')&&Object.values(CLAUDE_POLICY_MODELS).includes(reference.toLowerCase()))identity={model:reference.toLowerCase(),harness:'claude'};
    else{const model=await prompt({id:`model-${route}`,reference,type:'input',message:`Exact installed-provider model ID for "${reference}" (Rivet will not guess aliases):`});
     if(typeof model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model))fail('Invalid model ID.');try{policyText(model,200);}catch{fail('Invalid model ID.');}
     const harness=await prompt({id:`harness-${route}`,reference,type:'select',message:`Which harness runs ${model}?`,choices:['codex','claude'].map(value=>({value,label:value}))});if(!SESSION_CAPABILITIES[harness])fail('Invalid target harness.');if(candidate.harness&&candidate.harness!==harness)fail('Target harness differs from the translated policy. Revise the policy and retry.');identity={model,harness};}
    cache.set(key,identity);
   }
   let effort=candidate.effort;if(effort===null)effort=await prompt({id:`effort-${route}`,type:'select',message:`Requested reasoning for ${labels[route]}:`,choices:['high',...SESSION_CAPABILITIES[identity.harness].effort.filter(value=>value!=='high')].map(value=>({value,label:value==='high'?'high (suggested)':value}))});
   if(!SESSION_CAPABILITIES[identity.harness].effort.includes(effort))fail(`The ${identity.harness} harness does not support that reasoning setting.`);
   mapping[route]={...identity,effort};
  }
  }
  const policy=structuredClone(compileModelPolicy(mapping,previous));
  if(!previous||changedConcurrency)policy.limits.workersPerTask=concurrency;
  const proposal=update.propose({policy,...(changedConcurrency?{workerConcurrency:concurrency}:{})});
  show(`Review the exact model routing to save in ${project.root}/.rivet/orchestration.yaml:`);
  for(const route of POLICY_ROUTES){const item=translated.routes.find(x=>x.route===route),selection=policy.profiles[policy.routing[route]];show(`${labels[route]}: ${selection.model} | ${selection.harness} | Requested reasoning: ${selection.effort}\n  Why: ${item.rationale}\n  Source: ${item.source}`);const old=previous?.profiles[previous.routing[route]];show(`  Previously: ${old?`${old.model} | ${old.harness} | ${old.effort}`:'not configured'}`);}
  for(const assumption of translated.assumptions)show(`Translator assumption: ${assumption}`);
  concurrencyPreview();
  show(`${previous&&!changedConcurrency?'Preserved':'Reviewed'} capacity limits: ${JSON.stringify(policy.limits)}\n${previous?'Preserved':'Default'} session limits: ${JSON.stringify(policy.sessions)}`);
  show('Read-only coordination/review; implementation/fixes may edit and run approved commands. Model IDs are user supplied, configured defaults, cached Codex models, existing profiles, or Claude provider-resolved aliases (opus/sonnet/haiku); not live verified. Requested reasoning may be rejected or clamped by the provider. Existing approved tasks keep their pinned policy. No task will start.');
  const approved=await prompt({id:'approve-policy',type:'confirm',message:'Save this exact model routing and worker concurrency policy?',proposal:policy});check();
  if(approved!==true){show('Policy not saved.');return EXIT_CODES.SUCCESS;}
  await proposal.commit();saved=true;show('Saved model routing. Review and commit .rivet/orchestration.yaml before starting a new task.');return EXIT_CODES.SUCCESS;
 }catch(error){if(error instanceof CliError)throw error;check();throw new CliError('Model policy could not be translated or saved safely. Check the harness and policy, or retry after configuration changes. No task was started.','INVALID_INPUT');}
 finally{unobserve?.();external?.removeEventListener('abort',abort);process.off('SIGINT',abort);process.off('SIGTERM',abort);}
}


async function defaultMapping({previous,eligible,requested,codexModel,codexCatalog,configured,prompt,show,concurrencyPreview,editConcurrency,allowSkip}){
 let mapping;const reasons=Object.fromEntries(POLICY_ROUTES.map(route=>[route,{rationale:previous?'Reuse the existing routed policy.':'Suggested Claude role default.',source:previous?'Existing execution policy':'Claude provider-resolved aliases'}]));
 if(previous)mapping=Object.fromEntries(POLICY_ROUTES.map(route=>{const p=previous.profiles[previous.routing[route]];return [route,{harness:p.harness,model:p.model,effort:p.effort}];}));
 else{
  let kind=requested;
  if(!kind)kind=eligible.length===1?eligible[0].kind:eligible.length?await prompt({id:'default-harness',type:'select',message:'Choose the installed harness for the default routing:',choices:[...eligible.map(x=>({value:x.kind,label:x.kind})),...(allowSkip?[{value:'skip',label:'Skip model routing for now'}]:[])]}):null;
  if(kind==='skip'&&allowSkip)return null;
  if(!eligible.some(x=>x.kind===kind))fail('No compatible selected task harness is installed. Install Claude Code or Codex; other providers support text delegation only.');
  let model;
  if(kind==='codex'){
   model=await codexModel();
   const recommendations=recommendCodexRoutes(await codexCatalog(),configured());
   if(recommendations){mapping=Object.fromEntries(POLICY_ROUTES.map(route=>{const {rationale,source,...selection}=recommendations[route];reasons[route]={rationale,source};return [route,selection];}));}
   if(!mapping&&model===undefined&&allowSkip){const action=await prompt({id:'missing-codex-model',type:'select',message:'No configured or cached Codex model was found.',choices:[{value:'enter',label:'Enter a model ID'},{value:'skip',label:'Skip model routing for now'}]});if(action==='skip')return null;if(action!=='enter')fail('Invalid model setup choice.');}
   if(!mapping&&model===undefined)model=exactPolicyModel(await prompt({id:'default-codex-model',type:'input',message:'Exact Codex model ID to use for all four routes (you can edit individual routes next):'}));
  }
  if(!mapping){mapping=Object.fromEntries(POLICY_ROUTES.map(route=>[route,{harness:kind,model:kind==='claude'?CLAUDE_POLICY_MODELS[route]:model,effort:'high'}]));if(kind==='codex')for(const route of POLICY_ROUTES)reasons[route]={rationale:'No usable cached model recommendation; use entered exact model. Reasoning support unverified.',source:'User supplied model'};}
 }
 const preview=()=>{concurrencyPreview();show('Recommended routing (authentication and model access not verified):');for(const route of POLICY_ROUTES){const p=mapping[route];show(`${labels[route]}: ${p.model} | ${p.harness} | Requested reasoning: ${p.effort}\n  Why: ${reasons[route].rationale}\n  Source: ${reasons[route].source}`);}};
 preview();
 show('Claude opus/sonnet/haiku are provider-resolved aliases, not pinned model versions. Reasoning settings are requested; effective provider behavior is not verified.');
 const action=await prompt({id:'default-action',type:'select',message:'Accept recommendations or customize before final approval?',choices:[{value:'keep',label:'Accept recommendations'},{value:'edit',label:'Customize'},...(allowSkip?[{value:'skip',label:'Skip model routing for now'}]:[])]});
 if(action==='skip'&&allowSkip)return null;
 if(!['keep','edit'].includes(action))fail('Invalid routing choice.');
 if(action==='edit')while(true){
  const route=await prompt({id:'edit-route',type:'select',message:'Choose a route to change:',choices:[...POLICY_ROUTES.map(value=>({value,label:labels[value]})),{value:'__concurrency__',label:'Worker concurrency'},{value:'done',label:'Done: review for approval'}]});
  if(route==='done')break;if(route==='__concurrency__'){await editConcurrency();preview();continue;}if(!POLICY_ROUTES.includes(route))fail('Invalid route.');
  const current=mapping[route];
  const harness=await prompt({id:'edit-harness',type:'select',message:`Harness for ${labels[route]} (currently ${current.harness}):`,choices:['claude','codex'].map(value=>({value,label:`${value}${eligible.some(x=>x.kind===value)?' (installed)':' (not detected)'}`}))});
  if(!SESSION_CAPABILITIES[harness])fail('Invalid target harness.');
  const detected=harness==='codex'?await codexCatalog():[];let selectedModel;
  if(detected.length){selectedModel=await prompt({id:'edit-codex-model',type:'select',message:'Choose a cached Codex model or enter a custom model:',choices:[...detected.map(x=>({value:x.model,label:x.model})),{value:'__custom__',label:'Enter a custom model'}]});if(selectedModel!=='__custom__'&&!detected.some(x=>x.model===selectedModel))fail('Invalid model choice.');}
  const model=selectedModel&&selectedModel!=='__custom__'?selectedModel:exactPolicyModel(await prompt({id:'edit-model',type:'input',message:'Exact model ID or Claude provider alias:',defaultValue:harness===current.harness?current.model:harness==='claude'?CLAUDE_POLICY_MODELS[route]:await codexModel()}));
  const allowedEfforts=detected.find(x=>x.model===model)?.efforts??SESSION_CAPABILITIES[harness].effort;
  const effort=await prompt({id:'edit-effort',type:'select',message:`Requested reasoning (currently ${current.effort}):`,choices:allowedEfforts.map(value=>({value,label:value}))});
  if(!allowedEfforts.includes(effort))fail('Invalid reasoning setting.');
  reasons[route]={rationale:'User customized this route.',source:detected.find(x=>x.model===model)?.source??'User supplied model; model-specific reasoning support unverified'};
  mapping[route]={harness,model,effort};preview();
 }
 return {mapping,reasons};
}
