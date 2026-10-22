import {createModelRegistry} from './registry.js';
import {buildModelRequest} from './protocols.js';
import {policyText} from './policy-contract.js';

const credentials={anthropic:['ANTHROPIC_API_KEY'],openai:['OPENAI_API_KEY'],gemini:['GEMINI_API_KEY','GOOGLE_API_KEY']};
const endpoints={ollama:'OLLAMA_HOST','openai-compatible':'OPENAI_BASE_URL'};
export const CLAUDE_POLICY_MODELS=Object.freeze({coordination:'opus','independent-review':'opus',implementation:'sonnet','bounded-fix':'haiku'});
export function exactPolicyModel(value){
 if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value))throw new TypeError('Invalid model ID.');
 return policyText(value,200);
}
export function configuredCodexModel(environment){
 const value=environment.RIVET_CODEX_MODEL;
 return value===undefined?undefined:exactPolicyModel(value);
}

// Evidence is local and deliberately contains names only, never credential or endpoint values.
export function detectModelProviders({environment={},harnesses=[]},registry=createModelRegistry()){
 return registry.list().map(provider=>{
  const evidence=[];
  if(provider.kind==='harness'){
   const kind=provider.id==='claude-code'?'claude':provider.id;
   if(harnesses.some(item=>item.kind===kind&&item.executable))evidence.push('compatible-executable');
  }else{
   for(const name of credentials[provider.id]??[])if(typeof environment[name]==='string'&&environment[name].trim())evidence.push(`${name}:credential-variable-present`);
   const name=endpoints[provider.id];
   if(name&&typeof environment[name]==='string'&&environment[name].trim()){
    try{const {profile}=registry.resolve({provider:provider.id,model:'configuration-check',endpoint:environment[name],timeoutMs:1,maxOutputTokens:1});buildModelRequest(profile,'configuration-check','unused');evidence.push(`${name}:endpoint-configured`);}catch{/* Invalid endpoint values are never evidence or display data. */}
   }
  }
  return {...provider,taskExecution:provider.kind==='harness',textDelegation:provider.kind!=='harness',detection:{status:evidence.length?(provider.kind==='harness'?'installed':'configured'):'not-detected',evidence,authentication:'not-verified',modelAccess:'not-verified'}};
 });
}
export function providerDetectionSummary(providers){
 return providers.map(p=>`${p.id}: ${p.label}: ${p.detection.status} (${p.taskExecution?'task execution':'text delegation only'}${p.detection.evidence.length?`; ${p.detection.evidence.join(', ')}`:''}; authentication and model access not verified)`).join('\n');
}
