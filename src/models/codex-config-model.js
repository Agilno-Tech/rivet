import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {isAbsolute,resolve,join} from 'node:path';
import {parse} from 'smol-toml';
import {configuredCodexModel,exactPolicyModel} from './detection.js';

const MAX_CONFIG_BYTES=64*1024;
const unresolved=()=>({model:undefined,source:'Codex user config unavailable or unresolved'});
const table=value=>value!==null&&typeof value==='object'&&[null,Object.prototype].includes(Object.getPrototypeOf(value));
const own=(object,key)=>Object.hasOwn(object,key)?object[key]:undefined;

// Read only the saved user model. Project, system, remote and command-line overrides
// are deliberately outside this setup-time suggestion; approval pins the shown ID.
export async function resolveConfiguredCodexModel({environment={},cwd}){
 const explicit=configuredCodexModel(environment);
 if(explicit!==undefined)return {model:explicit,source:'RIVET_CODEX_MODEL'};
 let home;
 if(typeof environment.CODEX_HOME==='string'&&environment.CODEX_HOME.trim())home=resolve(cwd,environment.CODEX_HOME);
 else if(typeof environment.HOME==='string'&&isAbsolute(environment.HOME))home=join(environment.HOME,'.codex');
 if(!home)return unresolved();
 let file;
 try{
  // Nonblocking prevents a FIFO from hanging before fstat; nofollow rejects a
  // symlink at the final path. All validation and bounded reads use this same fd.
  file=await open(join(home,'config.toml'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const before=await file.stat();
  if(!before.isFile()||before.size>MAX_CONFIG_BYTES)return unresolved();
  const bytes=Buffer.alloc(MAX_CONFIG_BYTES+1);let count=0;
  while(count<bytes.length){const {bytesRead}=await file.read(bytes,count,bytes.length-count,null);if(!bytesRead)break;count+=bytesRead;}
  const after=await file.stat();
  if(count>MAX_CONFIG_BYTES||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)return unresolved();
  const config=parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,count)));
  let model=own(config,'model'),source='Codex user config';
  const selected=own(config,'profile');
  if(selected!==undefined){
   const profiles=own(config,'profiles');
   if(typeof selected!=='string'||!selected||!table(profiles)||!Object.hasOwn(profiles,selected)||!table(profiles[selected]))return unresolved();
   const profileModel=own(profiles[selected],'model');
   if(profileModel!==undefined){model=profileModel;source='Codex user config (selected profile)';}
  }
  return {model:exactPolicyModel(model),source};
 }catch{return unresolved();}
 finally{await file?.close().catch(()=>{});}
}
