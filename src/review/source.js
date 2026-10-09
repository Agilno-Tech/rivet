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
export function createReviewSource({target,transport,headers,signal}) {
 const {repository,number}=target, provider=repository.provider;
 const http=createProviderHttpClient({provider,transport,headers,baseUrl:endpoints[provider],allowEncodedSlash:true,maxResponseBytes:512*1024});
 const root=provider==='github'?`/repos/${repository.fullName}/pulls/${number}`:provider==='bitbucket'?`/repositories/${repository.fullName}/pullrequests/${number}`:`/projects/${encodeURIComponent(repository.fullName)}/merge_requests/${number}`;
 async function identity() {
  const {data:v}=await http.request({method:'GET',path:root,signal});
  const id=provider==='github'?v.number:provider==='bitbucket'?v.id:v.iid;
  const headSha=provider==='github'?v.head?.sha:provider==='bitbucket'?v.source?.commit?.hash:v.diff_refs?.head_sha;
  const baseSha=provider==='github'?v.base?.sha:provider==='bitbucket'?v.destination?.commit?.hash:v.diff_refs?.base_sha;
  if(id!==number||!SHA.test(headSha)||!SHA.test(baseSha)||!['open','OPEN','opened'].includes(v.state))fail('Review is closed or its exact commit identities are unavailable.');
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
 async function capture() {
  const before=await identity();
  const path=provider==='github'?root:provider==='bitbucket'?`/repositories/${repository.fullName}/diff/${before.headSha}..${before.baseSha}?topic=true`:`${root}/raw_diffs`;
  const diff=(await http.requestText({method:'GET',path,signal,headers:{accept:provider==='github'?'application/vnd.github.diff':'text/plain'}})).data;
  if(typeof diff!=='string'||!diff.startsWith('diff --git ')||diff.includes('\0')||Buffer.byteLength(diff)>384*1024)fail('Review diff is empty, unavailable, binary-only or too large. Review it manually.');
  const supplied=JSON.stringify({...before,diff});
  const credential=typeof headers?.authorization==='string'?headers.authorization.replace(/^Bearer /,''):null;
  if(containsSecretMaterial(supplied)||(credential?.length>=8&&supplied.includes(credential)))fail('Review contains credential-shaped text. Remove secrets before delegating it.');
  const files=reviewDiffFiles(diff);
  let expectedCount=before.changedFileCount;
  if(provider==='bitbucket'){const stats=(await http.request({method:'GET',path:`/repositories/${repository.fullName}/diffstat/${before.headSha}..${before.baseSha}?topic=true&pagelen=100`,signal})).data;expectedCount=stats?.size;if(!Number.isSafeInteger(expectedCount)||expectedCount<1||expectedCount>500)fail('PR file count is unavailable or exceeds the 500-file review limit.');}
  if(files.length!==expectedCount)fail('Provider returned an incomplete diff. Review the PR manually.');
  await assertCurrent(before);
  return {schemaVersion:1,url:target.url,repository,number,...before,diff,files,diffDigest:digest(diff),capturedAt:new Date().toISOString(),limitations:['Diff-only review; surrounding files and configured checks were not executed.','Provider diff size/truncation limits may apply. Inspect large and binary changes manually.']};
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
