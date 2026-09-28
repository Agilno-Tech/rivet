import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {constants} from 'node:fs';
import {copyFile, mkdir, realpath, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyReleaseArtifact, parseReleaseArguments} from './release-artifact.mjs';
const NAME='@agilno-tech/rivet', REGISTRY='https://registry.npmjs.org/', MAX=64*1024*1024;
const fail=reason=>{throw new Error(reason);};
function versionParts(version) {
  const match=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-alpha\.(0|[1-9]\d*)$/.exec(version);
  if(!match)fail('invalid-version');const parts=match.slice(1).map(Number);if(parts.some(p=>!Number.isSafeInteger(p)))fail('invalid-version');return parts;
}
function compare(a,b){const left=versionParts(a),right=versionParts(b);for(let i=0;i<left.length;i++)if(left[i]!==right[i])return left[i]>right[i]?1:-1;return 0;}
async function readResponse(response,limit){
  if(Number(response.headers.get('content-length'))>limit)fail('registry-response-too-large');
  const reader=response.body?.getReader();if(!reader)fail('registry-read-failed');let size=0;const chunks=[];
  try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)fail('registry-response-too-large');chunks.push(value);}return Buffer.concat(chunks);}
  finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
}
function validMetadata(value,version){if(value?.name!==NAME||typeof value.version!=='string'||(version!=='alpha'&&value.version!==version))fail('registry-identity-mismatch');versionParts(value.version);return value;}
export async function registryMetadata(version,{fetchImpl=fetch}={}){
  if(version!=='alpha')versionParts(version);
  const response=await fetchImpl(`${REGISTRY}${encodeURIComponent(NAME)}/${version}`,{redirect:'error',signal:AbortSignal.timeout(30000),headers:{accept:'application/json'}});
  if(response.status===404)return null;if(!response.ok)fail('registry-read-failed');
  return validMetadata(JSON.parse((await readResponse(response,1024*1024)).toString('utf8')),version);
}
export async function registryArtifact(metadata,{fetchImpl=fetch}={}){
  validMetadata(metadata,metadata?.version);
  const expected=`${REGISTRY}${NAME}/-/rivet-${metadata.version}.tgz`;
  if(metadata.dist?.tarball!==expected)fail('invalid-tarball-url');
  const response=await fetchImpl(expected,{redirect:'error',signal:AbortSignal.timeout(60000)});
  if(!response.ok)fail('registry-read-failed');return readResponse(response,MAX);
}
export async function ensurePublished(manifest,{getMetadata=registryMetadata,getBytes=registryArtifact,publish,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  if(manifest.package?.name!==NAME||!/^[a-f0-9]{64}$/.test(manifest.artifact?.sha256)||!Number.isSafeInteger(manifest.artifact?.bytes)||manifest.artifact.bytes<1||manifest.artifact.bytes>MAX)fail('invalid-manifest');
  const version=manifest.package.version;versionParts(version);
  const verify=async metadata=>{
    validMetadata(metadata,version);const bytes=await getBytes(metadata);
    if(bytes.length!==manifest.artifact.bytes||createHash('sha256').update(bytes).digest('hex')!==manifest.artifact.sha256)fail('registry-artifact-mismatch');return bytes;
  };
  const existing=await getMetadata(version);
  if(existing)return {status:'already-published',bytes:await verify(existing)};
  const alpha=await getMetadata('alpha');
  if(alpha){validMetadata(alpha,'alpha');if(compare(version,alpha.version)<=0)fail('alpha-channel-ahead');}
  if(typeof publish!=='function')fail('publisher-required');
  // Never repeat a possibly successful write. Reconcile through registry reads.
  try {await publish();}catch{/* npm output retains the publication error; verify before deciding success. */}
  for(let attempt=0;attempt<6;attempt++){
    if(attempt)await sleep(5000);
    const published=await getMetadata(version);
    if(published)return {status:'published',bytes:await verify(published)};
  }
  fail('publish-not-confirmed');
}
async function main(){
  const flags=process.argv.slice(2),downloadFlags=flags.filter(f=>f.startsWith('--download-directory='));
  if(downloadFlags.length!==1)fail('download-directory-required');
  const directory=downloadFlags[0].slice('--download-directory='.length);
  if(!isAbsolute(directory)||resolve(directory)!==directory||/[\x00-\x1f\x7f]/.test(directory)||await realpath(dirname(directory))!==dirname(directory))fail('invalid-download-directory');
  const args=parseReleaseArguments(['verify',...flags.filter(f=>!f.startsWith('--download-directory='))]);
  if(!args.tag||!args.sha||!args['artifact-sha256'])fail('exact-artifact-identity-required');
  const options={directory:args.directory,tag:args.tag,expectedSourceSha:args.sha,expectedArtifactSha256:args['artifact-sha256']};
  const manifest=await verifyReleaseArtifact(options);
  await mkdir(directory,{mode:0o700});
  const result=await ensurePublished(manifest,{publish:async()=>{
    // Recheck the selected bytes immediately before npm consumes them.
    await verifyReleaseArtifact(options);
    execFileSync('npm',['publish',join(args.directory,manifest.artifact.filename),'--access=public','--tag=alpha','--provenance','--ignore-scripts',`--registry=${REGISTRY}`],{stdio:'inherit',timeout:180000});
  }});
  for(const file of ['release-manifest.json','SHA256SUMS'])await copyFile(join(args.directory,file),join(directory,file),constants.COPYFILE_EXCL);
  await writeFile(join(directory,manifest.artifact.filename),result.bytes,{flag:'wx',mode:0o600});
  await verifyReleaseArtifact({...options,directory});
  console.log(JSON.stringify({ok:true,status:result.status,version:manifest.package.version,directory,sha256:manifest.artifact.sha256}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{await main();}catch(error){console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;}
}
