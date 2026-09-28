import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import metadata from '../../package.json' with { type: 'json' };
import { EXIT_CODES } from '../cli/output.js';
import { collectSupportBundle } from './bundle.js';

const COMMANDS = new Set(['doctor','support','delivery','evidence','feature','goals','init','install','models','integrations','repositories','orchestrate','preflight','protocols','run','status','setup','uninstall','verify','work','task','worktrees']);
const SUBCOMMANDS = new Set(['status','start','approve','resume','deps','recover','propose','watch','prepare','publish','review','merge','deploy','inspect','list','check','discover','configure','intake','add','remove','show','validate','plan','activate','cancel','stop','next','complete','submit','verify','record','sync','doctor','create','clean']);
const PLATFORMS = new Set(['aix','darwin','freebsd','linux','openbsd','sunos','win32']);
const ARCHITECTURES = new Set(['arm','arm64','ia32','loong64','mips','mipsel','ppc','ppc64','riscv64','s390','s390x','x64']);
// Deliberately closed: arbitrary provider/OS codes can contain private input.
// These values correspond to fixed error constructors/reasons in Rivet source.
const CAUSE_CODES = new Set([
  'ERR_HOST_RUN_BUSY', 'ERR_HOST_RUN_STALE_LOCK', 'ERR_HOST_RUN_RECOVERY_STATE',
  'ERR_FEATURE_RUN_VERSION_CONFLICT', 'ERR_INVALID_FEATURE_RUN', 'ERR_INVALID_FEATURE_PLAN',
  'ERR_INVALID_FEATURE_DECOMPOSITION', 'ERR_FEATURE_RUNTIME_BRIDGE', 'ERR_VERIFICATION_REPORT_VERSION_CONFLICT',
  'ERR_FEATURE_WORKFLOW_CONFIGURATION', 'ERR_FEATURE_WORKFLOW_PROPOSAL_MISMATCH',
  'ERR_FEATURE_WORKFLOW_STATE_CONFLICT', 'ERR_FEATURE_WORKFLOW_REPOSITORY', 'ERR_FEATURE_WORKFLOW_RUN_MISSING',
  'ERR_HOST_EXECUTION_VERIFICATION_FAILED', 'ERR_HOST_EXECUTION_STATE_CONFLICT', 'ERR_HOST_EXECUTION_REPOSITORY',
  'ERR_LOCAL_APPROVAL_INVALID', 'ERR_LOCAL_APPROVAL_CONFIGURATION', 'ERR_LOCAL_APPROVAL_INTERRUPTED', 'ERR_LOCAL_APPROVAL_CANCELLED',
  'ERR_GIT_NON_FAST_FORWARD', 'ERR_GIT_REPOSITORY_CHANGED', 'ERR_GIT_REPOSITORY_PATH_UNSAFE',
  'ERR_GIT_UNSAFE_EXECUTABLE', 'ERR_GIT_GIT_OUTPUT_INVALID', 'ERR_GIT_REVIEW_DIFF_UNAVAILABLE',
  'ERR_AGENT_TIMEOUT', 'ERR_AGENT_PROVIDER_UNAVAILABLE', 'ERR_AGENT_ABORTED', 'ERR_AGENT_OUTPUT_INVALID',
  'ERR_AGENT_EXECUTABLE_UNSAFE', 'ERR_AGENT_CWD_UNSAFE', 'ERR_AGENT_TEMPLATE_INVALID',
  'ERR_APPLICATION_CONFIGURATION', 'ERR_STATE_VERSION_CONFLICT', 'ERR_RUNTIME_APPROVAL_REQUIRED',
  'ERR_RUNTIME_NOT_ACTIVATED', 'ERR_RUNTIME_VERSION_CONFLICT', 'ERR_RUNTIME_CLIENT_OUTPUT',
]);
const ISSUE_URL = 'https://github.com/FraneAgilno/rivet/issues/new';
let fingerprint;
async function runtimeFingerprint() {
  // Only installed Rivet source files, never the user's repository or runtime state.
  return fingerprint ??= Promise.all(['../../package.json','../cli/main.js','../cli/parse-args.js'].map(path=>readFile(new URL(path,import.meta.url))))
    .then(files=>{const hash=createHash('sha256');for(const file of files)hash.update(String(file.length)).update(':').update(file);return hash.digest('hex');})
    .catch(()=>null);
}
function version(value) { return typeof value==='string' && /^v?\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[A-Za-z0-9.-]{1,64})?$/.test(value) ? value.replace(/^v/,'') : 'unknown'; }
async function safeParent(temporaryDirectory) {
  const selected=temporaryDirectory??tmpdir();
  if(typeof selected!=='string'||!isAbsolute(selected)||/[\0\r\n]/.test(selected))throw new Error();
  const initial=await lstat(selected);
  if(!initial.isDirectory()||initial.isSymbolicLink())throw new Error();
  const parent=await realpath(selected),uid=process.getuid?.();
  for(let current=parent;;current=dirname(current)) {
    const stat=await lstat(current);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error();
    if(uid!==undefined && stat.uid!==uid && stat.uid!==0)throw new Error();
    // A root-owned sticky system temp directory is safe for a private mkdtemp child.
    if(uid!==undefined && (stat.mode&0o022)!==0 && !(stat.uid===0 && (stat.mode&0o1000)!==0))throw new Error();
    if(dirname(current)===current)break;
  }
  return parent;
}
async function savePrivate(report,{temporaryDirectory}={}) {
  const serialized=`${JSON.stringify(report,null,2)}\n`;
  if(Buffer.byteLength(serialized)>64*1024)throw new Error();
  const parent=await safeParent(temporaryDirectory);
  const directory=await mkdtemp(join(parent,'rivet-support-'));
  await chmod(directory,0o700);
  const stat=await lstat(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(process.getuid && stat.uid!==process.getuid())||(stat.mode&0o777)!==0o700)throw new Error();
  const path=join(directory,'report.json');
  const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
  try {
    const opened=await file.stat();
    if(!opened.isFile()||opened.nlink!==1||(opened.mode&0o777)!==0o600||(process.getuid && opened.uid!==process.getuid()))throw new Error();
    await file.writeFile(serialized,'utf8');await file.sync();
  } finally { await file.close(); }
  return {path,report};
}

/** Best effort: accepts only fixed public categories; never records raw error data. */
export async function saveFailureReport(input={},storage={}) {
  try {
    const code=typeof input.code==='string' && Object.hasOwn(EXIT_CODES,input.code) && input.code!=='SUCCESS' ? input.code : 'INTERNAL_ERROR';
    const command=COMMANDS.has(input.command)?input.command:'unknown';
    const report={schemaVersion:1,format:'rivet-failure-report',createdAt:new Date().toISOString(),
      versions:{rivet:version(metadata.version),node:version(process.version),platform:PLATFORMS.has(process.platform)?process.platform:'unknown',architecture:ARCHITECTURES.has(process.arch)?process.arch:'unknown'},
      runtimeFingerprint:await runtimeFingerprint(),command:{name:command,subcommand:command!=='unknown'&&SUBCOMMANDS.has(input.subcommand)?input.subcommand:null},
      failure:{code,exitCode:EXIT_CODES[code],causeCode:CAUSE_CODES.has(input.causeCode)?input.causeCode:null},
      sharing:{issueUrl:ISSUE_URL,instructions:'Review this file before attaching it to an issue. Add reproduction steps and expected behavior. No upload is performed.'}};
    return await savePrivate(report,storage);
  } catch { return null; }
}

/** Persist only the existing allowlisted collector's output, never a raw caller bundle. */
export async function saveSupportReport(projectRoot,collectorOptions={},storage={}) {
  try {
    const collected=await collectSupportBundle(projectRoot,collectorOptions);
    const report={...collected,format:'rivet-support-report',createdAt:new Date().toISOString(),runtimeFingerprint:await runtimeFingerprint(),
      versions:{...collected.versions,rivet:collected.versions.rivet===null?null:version(metadata.version)}};
    return await savePrivate(report,storage);
  } catch { throw new Error('Support report could not be saved.'); }
}
