import {createHash} from 'node:crypto';
import {lstat,realpath,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
const DIRECTORY='.rivet-deps';
const MARKER='.rivet-owner.json';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const identity=stat=>`${stat.dev}:${stat.ino}`;
const fail=()=>{throw new Error('Managed dependency directory is unsafe.');};
export async function readDependencyFile(path,maxBytes) {
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try {
  const before=await file.stat({bigint:true});
  if(!before.isFile()||before.nlink!==1n||before.size>BigInt(maxBytes)||await realpath(path)!==path)fail();
  const buffer=Buffer.alloc(maxBytes+1);let count=0;
  while(count<buffer.length) {const result=await file.read(buffer,count,buffer.length-count,null);if(!result.bytesRead)break;count+=result.bytesRead;}
  const after=await file.stat({bigint:true}),entry=await lstat(path,{bigint:true});
  if(count>maxBytes||!entry.isFile()||entry.isSymbolicLink()||identity(before)!==identity(after)||identity(before)!==identity(entry)||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||BigInt(count)!==after.size)fail();
  return buffer.subarray(0,count);
 }finally {await file.close();}
}
export async function inspectDependencyDirectory(root) {
 const rootStat=await lstat(root,{bigint:true});
 if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||await realpath(root)!==root)fail();
 const path=join(root,DIRECTORY);
 let stat;try {stat=await lstat(path,{bigint:true});}catch(error){if(error.code==='ENOENT')return null;throw error;}
 if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(path)!==path||(stat.mode&0o077n)!==0n)fail();
 const marker=await readDependencyFile(join(path,MARKER),4096);
 const value=JSON.parse(marker.toString('utf8'));
 if(Object.keys(value).sort().join(',')!=='directoryIdentity,kind,root,rootIdentity,token,version'||value.kind!=='rivet-dependencies'||value.version!==1||value.root!==root||value.rootIdentity!==identity(rootStat)||value.directoryIdentity!==identity(stat)||typeof value.token!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.token))fail();
 if((await readDependencyFile(join(path,'.gitignore'),32)).toString()!=='*\n')fail();
 return Object.freeze({identity:identity(stat),marker:hash(marker)});
}
