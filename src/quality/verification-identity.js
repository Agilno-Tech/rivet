import { createHmac } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

export function privateDigest(key, value) {
  return createHmac('sha256',key).update(JSON.stringify(value)).digest('hex');
}
function stable(value) {
  if(Array.isArray(value))return value.map(stable);
  if(value && typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));
  return value;
}
// This deliberately rejects links and large installations. Reuse is an optimization;
// incomplete evidence must never become an execution attestation.
export async function verificationIdentity(value,key) {
  const bypass=reason=>({identity:null,reason});
  const policy=value.reuse?.policy;
  if(!policy?.enabled)return bypass('disabled');
  if(policy.reproducible!==true)return bypass('reproducibility-not-declared');
  if(!/^[a-f0-9]{64}$/.test(value.reuse.configDigest??''))return bypass('missing-config-digest');
  if(value.gates.some(g=>g.artifactPaths.length || g.tests.length || g.resultPath))return bypass('fresh-artifacts-required');
  let bytes=0,files=0;
  const fingerprints=[];
  async function fingerprint(path, directory=false) {
    const before=await lstat(path,{bigint:true});
    if(before.isSymbolicLink() || await realpath(path)!==path)throw Error('unsafe');
    if(before.isDirectory()) {
      if(!directory)throw Error('unsafe');
      if(++files>10000)throw Error('limit');
      fingerprints.push([path,String(before.dev),String(before.ino),String(before.mode),'directory']);
      for(const entry of (await readdir(path)).sort())await fingerprint(join(path,entry),true);
      const after=await lstat(path,{bigint:true});
      for(const field of ['dev','ino','mtimeNs','ctimeNs','mode'])if(before[field]!==after[field])throw Error('changed');
    } else {
      if(!before.isFile() || before.nlink!==1n || before.size>128n*1024n*1024n || ++files>10000)throw Error('limit');
      bytes+=Number(before.size); if(bytes>256*1024*1024)throw Error('limit');
      const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
      try {
        const opened=await handle.stat({bigint:true});
        const buffer=Buffer.alloc(Number(before.size)+1);
        let length=0;
        while(length<buffer.length) { const {bytesRead}=await handle.read(buffer,length,buffer.length-length,null);if(!bytesRead)break;length+=bytesRead; }
        const contents=buffer.subarray(0,length);
        const after=await handle.stat({bigint:true});
        const current=await lstat(path,{bigint:true});
        for(const field of ['dev','ino','size','mtimeNs','ctimeNs','mode'])if(before[field]!==opened[field] || opened[field]!==after[field] || after[field]!==current[field])throw Error('changed');
        if(contents.length!==Number(after.size))throw Error('changed');
        fingerprints.push([path,String(after.dev),String(after.ino),String(after.mode),createHmac('sha256',key).update(contents).digest('hex')]);
        return contents;
      } finally {await handle.close();}
    }
  }
  try {
    const root=await lstat(value.projectRoot,{bigint:true});
    if(!root.isDirectory() || root.isSymbolicLink() || await realpath(value.projectRoot)!==value.projectRoot)throw Error('unsafe');
    for(const roots of [policy.dependencyRoots,policy.toolchainRoots]) {
      if(!Array.isArray(roots) || roots.length===0 || roots.length>32)throw Error('roots');
      for(const entry of roots) {
        if(typeof entry!=='string' || isAbsolute(entry) || entry.split('/').some(x=>!x || x==='.' || x==='..' || x==='.git') || /[\\\u0000-\u001f]/.test(entry))throw Error('unsafe');
        const path=resolve(value.projectRoot,entry);
        if(!(await lstat(path)).isDirectory())throw Error('unsafe');
        await fingerprint(path,true);
      }
    }
    const executables=new Set([process.execPath,...value.gates.map(g=>g.executable)]);
    for(const path of executables) {
      const content=await fingerprint(path);
      if(content.subarray(0,2).toString()==='#!') {
        const interpreter=content.subarray(2,256).toString().split('\n')[0].trim();
        if(!isAbsolute(interpreter) || /\s/.test(interpreter) || interpreter.endsWith('/env'))throw Error('interpreter');
        await fingerprint(interpreter);
      }
    }
    const rootAfter=await lstat(value.projectRoot,{bigint:true});
    for(const field of ['dev','ino','mode'])if(root[field]!==rootAfter[field])throw Error('changed');
    const {gitClient,now,signal,...input}=value;
    return {identity:privateDigest(key,stable({version:2,input,root:[String(root.dev),String(root.ino),String(root.mode)],fingerprints,node:process.version,platform:process.platform,arch:process.arch,runtimeEnvironment:process.env})),reason:null};
  }catch{return bypass('inputs-not-safely-fingerprintable');}
}
