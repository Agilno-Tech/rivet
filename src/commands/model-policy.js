import {resolveConfiguredProject} from '../cli/project-discovery.js';
import {defaultIntegrationSetupPrompt} from '../cli/integration-setup-prompt.js';
import {CliError,EXIT_CODES,observeOutputErrors} from '../cli/output.js';
import {prepareExecutionPolicyUpdate} from './init.js';
import {translateModelPolicy} from '../models/policy-client.js';
import {POLICY_ROUTES,policyText,validatePolicyTranslation,compileModelPolicy} from '../models/policy-contract.js';
import {SESSION_CAPABILITIES} from '../clients/session-capabilities.js';
const labels={coordination:'Coordination and technical decisions','independent-review':'Independent review',implementation:'Substantial implementation and complex debugging','bounded-fix':'Bounded fixes, focused tests and investigations'};
function fail(message){throw new CliError(message,'INVALID_INPUT');}
const cancelled=()=>fail('Model policy configuration cancelled. No policy was saved.');
export async function configureModelPolicy({operands,flags},dependencies){
 if(operands.length!==1||Object.keys(flags).some(k=>!['project','harness'].includes(k))||!dependencies.terminalIsInteractive?.()||(flags.harness!==undefined&&!['claude','codex'].includes(flags.harness)))fail('Use rivet models configure "policy" [--harness=claude|codex] [--project=<path>] in an interactive terminal.');
 let prose;try{prose=policyText(operands[0]);}catch{fail('Use policy text of at most 16 KiB without secrets or terminal control characters.');}
 const controller=new AbortController(),abort=()=>controller.abort(),external=dependencies.models?.signal;
 if(external?.aborted)abort();external?.addEventListener('abort',abort,{once:true});process.on('SIGINT',abort);process.on('SIGTERM',abort);
 const signal=controller.signal;let saved=false,outputFailed=false;const unobserve=observeOutputErrors(dependencies.output,()=>{outputFailed=true;abort();});
 const check=()=>{if(outputFailed)fail(saved?'Policy was saved, but the final output failed. Inspect .rivet/orchestration.yaml.':'Could not display the complete policy. No policy was saved.');if(signal.aborted){if(saved)fail('Policy was saved before interruption. Inspect .rivet/orchestration.yaml.');cancelled();}};
 const show=message=>{check();try{dependencies.output.log(message);}catch{outputFailed=true;}check();};
 const prompt=async question=>{check();let answer;try{answer=await(dependencies.modelPolicyPrompt??defaultIntegrationSetupPrompt)({...question,signal});}catch{cancelled();}check();if(answer===null||answer===undefined)cancelled();return answer;};
 try{
  check();const project=await resolveConfiguredProject(dependencies.cwd(),flags.project,{env:dependencies.env});
  const update=await prepareExecutionPolicyUpdate(project.root,{beforeCommit:check});const previous=update.config.orchestration.executionPolicy,profiles=previous?.profiles??{};
  const found=await dependencies.harnesses.discover(project.root,{signal});check();const eligible=found.filter(x=>x.executable);
  let kind=flags.harness;if(!kind)kind=eligible.length===1?eligible[0].kind:eligible.length?await prompt({id:'translator',type:'select',message:'Choose the installed harness that will translate this policy:',choices:eligible.map(x=>({value:x.kind,label:x.kind}))}):null;
  if(!eligible.some(x=>x.kind===kind))fail('No compatible selected harness is available. Install and authenticate Claude Code or Codex.');
  const selected=await dependencies.harnesses.select(kind,project.root,{signal});check();
  show(`Translate this policy with ${kind} using a bounded read-only request. Target model availability is not live verified.`);
  const translated=validatePolicyTranslation(await(dependencies.models?.translatePolicy??translateModelPolicy)({selected,prose,profiles,routing:previous?.routing??{},environment:dependencies.env,signal}),prose,profiles);check();
  const cache=new Map(),choices=new Map(),mapping={};
  for(const route of POLICY_ROUTES){const item=translated.routes.find(x=>x.route===route);let candidate=item.candidates[0];
   if(item.candidates.length>1){const key=JSON.stringify(item.candidates);let index=choices.get(key);if(index===undefined){index=await prompt({id:`candidate-${route}`,type:'select',message:`Choose one model for ${labels[route]} (alternatives are not fallbacks):`,choices:item.candidates.map((x,i)=>({value:i,label:`${x.modelReference??'Unspecified model'} / ${x.harness??'harness to clarify'} / ${x.effort??'reasoning to clarify'}`}))});if(!Number.isInteger(index)||!item.candidates[index])fail('Invalid model choice.');choices.set(key,index);}candidate=item.candidates[index];}
   let reference=candidate.modelReference;if(reference===null)reference=await prompt({id:`reference-${route}`,type:'input',message:`Which model should handle ${labels[route]}?`});try{policyText(reference,200);}catch{fail('Invalid model reference.');}
   const key=reference;let identity=cache.get(key);
   if(identity&&candidate.harness&&candidate.harness!==identity.harness)fail('Conflicting harnesses for a shared model reference.');
   if(!identity){const matches=Object.entries(profiles).filter(([id,p])=>(id===reference||p.model===reference)&&(!candidate.harness||candidate.harness===p.harness));
    const identities=[...new Map(matches.map(([,p])=>[`${p.harness}:${p.model}`,{harness:p.harness,model:p.model}])).values()];
    if(identities.length===1)identity=identities[0];
    else{const model=await prompt({id:`model-${route}`,reference,type:'input',message:`Exact installed-provider model ID for "${reference}" (Rivet will not guess aliases):`});
     if(typeof model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model))fail('Invalid model ID.');try{policyText(model,200);}catch{fail('Invalid model ID.');}
     const harness=await prompt({id:`harness-${route}`,reference,type:'select',message:`Which harness runs ${model}?`,choices:['codex','claude'].map(value=>({value,label:value}))});if(!SESSION_CAPABILITIES[harness])fail('Invalid target harness.');if(candidate.harness&&candidate.harness!==harness)fail('Target harness differs from the translated policy. Revise the policy and retry.');identity={model,harness};}
    cache.set(key,identity);
   }
   let effort=candidate.effort;if(effort===null)effort=await prompt({id:`effort-${route}`,type:'select',message:`Requested reasoning for ${labels[route]}:`,choices:SESSION_CAPABILITIES[identity.harness].effort.map(value=>({value,label:value}))});
   if(!SESSION_CAPABILITIES[identity.harness].effort.includes(effort))fail(`The ${identity.harness} harness does not support that reasoning setting.`);
   mapping[route]={...identity,effort};
  }
  const policy=compileModelPolicy(mapping,previous),proposal=update.propose(policy);
  show(`Review the exact model routing to save in ${project.root}/.rivet/orchestration.yaml:`);
  for(const route of POLICY_ROUTES){const item=translated.routes.find(x=>x.route===route),selection=policy.profiles[policy.routing[route]];show(`${labels[route]}: ${selection.model} | ${selection.harness} | Requested reasoning: ${selection.effort}\n  Why: ${item.rationale}\n  Source: ${item.source}`);const old=previous?.profiles[previous.routing[route]];show(`  Previously: ${old?`${old.model} | ${old.harness} | ${old.effort}`:'not configured'}`);}
  for(const assumption of translated.assumptions)show(`Translator assumption: ${assumption}`);
  show(`${previous?'Preserved':'Default'} capacity limits: ${JSON.stringify(policy.limits)}\n${previous?'Preserved':'Default'} session limits: ${JSON.stringify(policy.sessions)}`);
  show('Read-only coordination/review; implementation/fixes may edit and run approved commands. Model IDs are user supplied or reused from existing profiles, not live verified. Requested reasoning may be rejected or clamped by the provider. Existing approved tasks keep their pinned policy. No task will start.');
  const approved=await prompt({id:'approve-policy',type:'confirm',message:'Save this exact model routing policy?',proposal:policy});check();
  if(approved!==true){show('Policy not saved.');return EXIT_CODES.SUCCESS;}
  await proposal.commit();saved=true;show('Saved model routing. Review and commit .rivet/orchestration.yaml before starting a new task.');return EXIT_CODES.SUCCESS;
 }catch(error){if(error instanceof CliError)throw error;check();throw new CliError('Model policy could not be translated or saved safely. Check the harness and policy, or retry after configuration changes. No task was started.','INVALID_INPUT');}
 finally{unobserve?.();external?.removeEventListener('abort',abort);process.off('SIGINT',abort);process.off('SIGTERM',abort);}
}
