import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {isAbsolute,resolve,join} from 'node:path';
import {exactPolicyModel} from './detection.js';
import {SESSION_CAPABILITIES} from '../clients/session-capabilities.js';
const MAX_BYTES=1024*1024,MAX_MODELS=256;
// Local cache is suggestion evidence only. Never retain provider descriptions,
// identity, endpoints or other cache metadata in prompts or rendered output.
export async function readCodexModelCatalog({environment={},cwd}){
 let home;if(typeof environment.CODEX_HOME==='string'&&environment.CODEX_HOME.trim())home=resolve(cwd,environment.CODEX_HOME);
 else if(typeof environment.HOME==='string'&&isAbsolute(environment.HOME))home=join(environment.HOME,'.codex');
 if(!home)return [];
 let file;
 try{
  file=await open(join(home,'models_cache.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const before=await file.stat();if(!before.isFile()||before.size>MAX_BYTES)return [];
  const bytes=Buffer.alloc(MAX_BYTES+1);let count=0;
  while(count<bytes.length){const {bytesRead}=await file.read(bytes,count,bytes.length-count,null);if(!bytesRead)break;count+=bytesRead;}
  const after=await file.stat();if(count>MAX_BYTES||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)return [];
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,count)));
  if(!value||!Array.isArray(value.models)||value.models.length>MAX_MODELS)return [];
  let source='Codex local model cache (cached, not live verified)';
  if(typeof value.fetched_at==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value.fetched_at)&&Number.isFinite(Date.parse(value.fetched_at)))source+=` fetched ${new Date(value.fetched_at).toISOString()}`;
  const seen=new Set(),models=[];
  for(const item of value.models){
   if(!item||typeof item!=='object')return [];
   const model=exactPolicyModel(item.slug);if(seen.has(model))return [];seen.add(model);
   if(!['hide','list'].includes(item.visibility))return [];if(item.visibility==='hide')continue;
   if(!Number.isSafeInteger(item.priority)||!Array.isArray(item.supported_reasoning_levels)||!item.supported_reasoning_levels.length||item.supported_reasoning_levels.length>16)return [];
   const efforts=item.supported_reasoning_levels.map(x=>x?.effort);
   if(efforts.some(x=>!SESSION_CAPABILITIES.codex.effort.includes(x))||new Set(efforts).size!==efforts.length||!efforts.includes(item.default_reasoning_level))return [];
   models.push({model,priority:item.priority,efforts,defaultEffort:item.default_reasoning_level,source});
  }
  return models.sort((a,b)=>a.priority-b.priority);
 }catch{return [];}finally{await file?.close().catch(()=>{});}
}
export function recommendCodexRoutes(catalog,configured={}){
 const families={coordination:'astra','independent-review':'astra',implementation:'sol','bounded-fix':'luna'},result={};
 for(const [route,family] of Object.entries(families)){
  const explicit=configured.source==='RIVET_CODEX_MODEL';
  const matched=explicit?undefined:catalog.find(x=>new RegExp(`^gpt-[A-Za-z0-9.-]+-${family}$`).test(x.model));
  const model=explicit?configured.model:matched?.model??configured.model??catalog[0]?.model;
  if(!model)return undefined;
  const detected=catalog.find(x=>x.model===model),effort=detected?(detected.efforts.includes('high')?'high':detected.defaultEffort):'high';
  let rationale=explicit?'Explicit RIVET_CODEX_MODEL override.':matched?`Detected ${family} family for this role; lowest catalog priority, then catalog order.`:`Detected ${family} family unavailable; ${configured.model?'reuse configured model':'use first eligible model by catalog priority and order'}.`;
  rationale+=detected&&effort!=='high'?' high reasoning not advertised; use advertised default.':detected?' high reasoning advertised in cache.':' high reasoning requested; model-specific support unverified.';
  result[route]={harness:'codex',model,effort,rationale,source:matched||(!configured.model&&!explicit)?detected.source:`${configured.source??'Configured model'} (not live verified)${detected?`; reasoning from ${detected.source}`:''}`};
 }
 return result;
}
