import {redactSecrets} from '../state/redact.js';
import {hasReviewCredential,maskReviewDiff,reviewSnapshotForScan} from './secrets.js';
import {reviewDiffFiles} from './diff.js';
import {createProviderWireBody} from '../adapters/contract.js';
import {createHash} from 'node:crypto';
import {createProviderHttpClient} from '../adapters/http.js';
import {parseRepositoryRemote} from '../repositories/identity.js';
import {CliError} from '../cli/output.js';
import {containsSecretMaterial} from '../clients/contract.js';
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const SHA=/^[a-f0-9]{40}$/;
const endpoints={github:'https://api.github.com',bitbucket:'https://api.bitbucket.org/2.0',gitlab:'https://gitlab.com/api/v4'};
const fail=message=>{throw new CliError(message,'REPOSITORY_CONFLICT');};
export function parseReviewUrl(value) {
 let url;try{url=new URL(value);}catch{fail('Provide a GitHub, GitLab or Bitbucket pull request URL.');}
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash)fail('Review URL must be a plain HTTPS pull request URL.');
 const suffix=url.hostname==='github.com'?'/pull/':url.hostname==='bitbucket.org'?'/pull-requests/':url.hostname==='gitlab.com'?'/-/merge_requests/':null;
 const index=suffix?url.pathname.lastIndexOf(suffix):-1;
 const number=index<0?'':url.pathname.slice(index+suffix.length);
 if(!/^[1-9][0-9]{0,8}$/.test(number))fail('Provide a GitHub, GitLab or Bitbucket pull request URL.');
 const repository=parseRepositoryRemote(`${url.origin}${url.pathname.slice(0,index)}`);
 if(value!==`${repository.url}${suffix}${number}`)fail('Review URL must use the canonical repository URL.');
 return Object.freeze({repository,number:Number(number),url:value});
}
export function createReviewSource({target,transport,headers,signal,environment={}}) {
 const {repository,number}=target, provider=repository.provider;
 const http=createProviderHttpClient({provider,transport,headers,baseUrl:endpoints[provider],allowEncodedSlash:true,maxResponseBytes:512*1024});
 const root=provider==='github'?`/repos/${repository.fullName}/pulls/${number}`:provider==='bitbucket'?`/repositories/${repository.fullName}/pullrequests/${number}`:`/projects/${encodeURIComponent(repository.fullName)}/merge_requests/${number}`;
 async function bitbucketCommit(ref, destination=false) {
  const hash=ref?.commit?.hash;
  if(typeof hash==='string'&&SHA.test(hash))return hash;
  if(typeof hash!=='string'||!/^[a-f0-9]{4,39}$/.test(hash))fail('Review commit identity is unavailable or invalid.');
  const name=ref?.repository?.full_name;
  let commitRepository;
  try {commitRepository=parseRepositoryRemote(`https://bitbucket.org/${name}`);}catch{fail('Review commit repository is unavailable or invalid.');}
  if(commitRepository.fullName!==name||(destination&&name!==repository.fullName))fail('Review commit repository does not match the pull request.');
  const {data}=await http.request({method:'GET',path:`/repositories/${name}/commit/${hash}`,signal});
  if(typeof data?.hash!=='string'||!SHA.test(data.hash)||!data.hash.startsWith(hash))fail('Review commit could not be resolved to an exact matching identity.');
  return data.hash;
 }
 async function identity() {
  const {data:v}=await http.request({method:'GET',path:root,signal});
  const id=provider==='github'?v.number:provider==='bitbucket'?v.id:v.iid;
  if(id!==number||!['open','OPEN','opened'].includes(v.state))fail('Review is closed or its identity is unavailable.');
  const headSha=provider==='github'?v.head?.sha:provider==='bitbucket'?await bitbucketCommit(v.source):v.diff_refs?.head_sha;
  const baseSha=provider==='github'?v.base?.sha:provider==='bitbucket'?await bitbucketCommit(v.destination,true):v.diff_refs?.base_sha;
  if(!SHA.test(headSha)||!SHA.test(baseSha))fail('Review exact commit identities are unavailable.');
  if(provider==='gitlab'&&v.sha!==headSha)fail('Review head changed while preparing its diff. Retry.');
  const title=v.title,description=(provider==='github'?v.body:v.description)??'';
  if(typeof title!=='string'||title.length>4096||typeof description!=='string'||description.length>64000)fail('Review description is invalid or too large.');
  const count=provider==='github'?v.changed_files:provider==='gitlab'?Number(v.changes_count):null;
  if(provider!=='bitbucket'&&(!Number.isSafeInteger(count)||count<1||count>500))fail('PR file count is unavailable or exceeds the 500-file review limit.');
  return {headSha,baseSha,title,description,changedFileCount:count};
 }
 async function assertCurrent(snapshot) {
  const now=await identity();
  if(now.headSha!==snapshot.headSha||now.baseSha!==snapshot.baseSha||now.title!==snapshot.title||now.description!==snapshot.description)fail('Review changed since capture. Start a new review before using these findings.');
 }
 async function capture({confirmRedactions}={}) {
  const before=await identity();
  const path=provider==='github'?root:provider==='bitbucket'?`/repositories/${repository.fullName}/diff/${before.headSha}..${before.baseSha}?topic=true`:`${root}/raw_diffs`;
  let diff=(await http.requestText({method:'GET',path,signal,headers:{accept:provider==='github'?'application/vnd.github.diff':'text/plain'}})).data;
  if(typeof diff!=='string'||!diff.startsWith('diff --git ')||diff.includes('\0')||Buffer.byteLength(diff)>384*1024)fail('Review diff is empty, unavailable, binary-only or too large. Review it manually.');
  const supplied=JSON.stringify({...before,diff});
  const credential=typeof headers?.authorization==='string'?headers.authorization.replace(/^Bearer /,''):null;
  if(hasReviewCredential(supplied)||(credential?.length>=8&&supplied.includes(JSON.stringify(credential).slice(1,-1)))
    ||JSON.stringify(redactSecrets({before,diff},{environment}))!==JSON.stringify({before,diff}))fail('Review contains credential material. Remove secrets before delegating it.');
  if(containsSecretMaterial(JSON.stringify(before)))fail('Review metadata contains credential-shaped text. Remove secrets before delegating it.');
  const files=reviewDiffFiles(diff);
  if(containsSecretMaterial(JSON.stringify(files)))fail('Review paths contain credential-shaped text. Review these changes manually.');
  let expectedCount=before.changedFileCount;
  if(provider==='bitbucket'){const stats=(await http.request({method:'GET',path:`/repositories/${repository.fullName}/diffstat/${before.headSha}..${before.baseSha}?topic=true&pagelen=100`,signal})).data;expectedCount=stats?.size;if(!Number.isSafeInteger(expectedCount)||expectedCount<1||expectedCount>500)fail('PR file count is unavailable or exceeds the 500-file review limit.');}
  if(files.length!==expectedCount)fail('Provider returned an incomplete diff. Review the PR manually.');
  const omissions=[],omittedFiles=new Set(),bodyLines=[],hunkHeaders=[];let file=-1,oldLine=0,newLine=0,inHunk=false;
  const rawDigest=digest({url:target.url,repository,before,diff});
  const lines=diff.split('\n');
  const scannedLines=maskReviewDiff(diff).split('\n');
  const omitFile=(line,side)=>{
   const path=files[file].path;
   if(!omittedFiles.has(path))omissions.push({scope:'file',path,line,side,reason:'Credential-shaped content; the entire file diff will be omitted, including other hunks and context lines.'});
   omittedFiles.add(path);
  };
  for(let index=0;index<lines.length;index++) {
   const line=lines[index];
   if(line.startsWith('diff --git ')){file++;inHunk=false;}
   const hunk=/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
   if(hunk){hunkHeaders.push({index,path:files[file].path,header:hunk[0]});oldLine=Number(hunk[1]);newLine=Number(hunk[2]);inHunk=true;if(containsSecretMaterial(line))omitFile(files[file].side==='old'?oldLine:newLine,files[file].side);continue;}
   const body=inHunk&&['+','-',' '].includes(line[0]);
   if(containsSecretMaterial(scannedLines[index])||body&&containsSecretMaterial(scannedLines[index]+' rivet_unresolved')) {
    if(!body)fail('Review contains credential-shaped metadata that cannot be omitted. Remove secrets before delegating it.');
    omitFile(line[0]==='-'?oldLine:newLine,line[0]==='-'?'old':'new');
   }
   if(body){bodyLines.push({index,path:files[file].path});if(line[0]!=='+')oldLine++;if(line[0]!=='-')newLine++;}
  }
  // Preserve diff line counts without expanding content; omittedFiles and limitations explain the omission.
  for(const {index,path} of bodyLines)if(omittedFiles.has(path))lines[index]=lines[index][0];
  for(const {index,path,header} of hunkHeaders)if(omittedFiles.has(path))lines[index]=header;
  if(omissions.length) {
   const approval={version:1,rawDigest,sanitizedDigest:digest(lines.join('\n')),omissionsDigest:digest(omissions)};
   if(omissions.length>100||typeof confirmRedactions!=='function'||await confirmRedactions(structuredClone(omissions),approval)!==true||signal?.aborted)fail('Review needs approval to omit credential-shaped file diffs; no context was saved or delegated.');
   diff=lines.join('\n');
  }
  if(containsSecretMaterial(JSON.stringify(reviewSnapshotForScan({...before,diff}))))fail('Review contains credential-shaped text. Remove secrets before delegating it.');
  await assertCurrent(before);
  return {schemaVersion:1,url:target.url,repository,number,...before,diff,files,diffDigest:digest(diff),capturedAt:new Date().toISOString(),...(omittedFiles.size?{omittedFiles:[...omittedFiles]}:{}),limitations:[...(omissions.length?[`${omissions.length} file diff(s) omitted with approval; omitted code was not reviewed.`]:[]),...(omittedFiles.size?[`Entire file diff omitted with approval: ${[...omittedFiles].join(', ')}. No code from these files was reviewed.`]:[]),...(omittedFiles.size===files.length?['All file diffs were omitted; no source code was reviewed. Manual review is required.']:[]),'Diff-only review; surrounding files and configured checks were not executed.','Provider diff size/truncation limits may apply. Inspect large and binary changes manually.']};
 }
 async function publishComment(snapshot,body) {
  await assertCurrent(snapshot);
  const wireBody=createProviderWireBody({provider,action:'review-comment',resourceId:repository.fullName,expectedState:'open',expectedVersion:snapshot.headSha,idempotencyKey:digest({url:target.url,headSha:snapshot.headSha,body}),payload:{number,body}});
  const path=provider==='github'?`/repos/${repository.fullName}/issues/${number}/comments`:provider==='bitbucket'?`${root}/comments`:`${root}/notes`;
  const response=await http.request({method:'POST',path,wireBody,signal});
  if(!Number.isSafeInteger(response.data?.id)||response.data.id<1)fail('Review comment outcome is unknown. Inspect the PR before retrying.');
  return {id:response.data.id};
 }
 return Object.freeze({capture,assertCurrent,publishComment});
}
