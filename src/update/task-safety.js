import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { CliError } from '../cli/output.js';
import { gitExecutable } from '../cli/project-discovery.js';
import { runArgv } from '../discovery/tools.js';
import { createFeatureRunStore } from '../feature/run-store.js';
import { listExistingFeatureRunPaths, resolveExistingStatePaths } from '../state/paths.js';
import { readSnapshotWithoutLock } from '../state/snapshot-store.js';
import { validateRuntimeSnapshot } from '../runtime/orchestrator.js';
import { validateReport } from '../review/contract.js';

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const TERMINAL = new Set(['completed', 'cancelled']);
function blocked(message) { throw new CliError(message, 'REPOSITORY_CONFLICT'); }
async function metadata(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function assertNoLocks(directory) {
  const names=await readdir(directory);
  if (names.some(name=>name.endsWith('.lock'))) blocked('Rivet task state is in use. Stop its running process, or inspect stale locks with Rivet recovery before updating.');
}
function unfinished() { blocked('This project has unfinished Rivet tasks. Run rivet status, then finish or cancel the tasks before updating.'); }

/** Inspect existing private state only: never create directories, snapshots, or locks. */
export async function assertUpdateTasksIdle(projectRoot, {runner = runArgv, env = process.env} = {}) {
  try {
    const executable=await gitExecutable(env);
    const gitRunner=(_command,args,options)=>runner(executable,args,{...options,env});
    const result=await gitRunner('git',['rev-parse','--git-common-dir'],{cwd:projectRoot,shell:false,timeoutMs:3000,maxOutputBytes:4096});
    const value=typeof result?.stdout==='string'?result.stdout.trim():'';
    if(result?.code!==0||result.timedOut||result.truncated?.stdout||!value||/[\u0000\r\n]/.test(value)) throw new Error('Invalid Git directory');
    const common=await realpath(isAbsolute(value)?value:resolve(projectRoot,value));
    const root=join(common,'rivet'), stat=await metadata(root);
    if(!stat) return;
    if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o700) throw new Error('Unsafe state');
    const entries=await readdir(root);
    if(entries.length>256||entries.some(name=>name.length>64||!ID.test(name))) throw new Error('Invalid state entries');
    const featurePaths=await listExistingFeatureRunPaths(projectRoot,{runner:gitRunner});
    for(const paths of featurePaths) {
      await assertNoLocks(paths.runDir);
      const run=await createFeatureRunStore(paths).readOnly();
      if(!run) throw new Error('Missing feature state');
      if(!TERMINAL.has(run.status)) unfinished();
    }
    for(const name of entries.filter(name=>name!=='feature-runs')) {
      const paths=await resolveExistingStatePaths(projectRoot,name,{runner:gitRunner});
      if(!paths) throw new Error('Missing runtime directory');
      await assertNoLocks(paths.instanceDir);
      const saved=await readSnapshotWithoutLock(paths);
      if(!saved) throw new Error('Missing runtime state');
      if(/^pr-review-[a-f0-9]{32}$/.test(name)) {
        const record=saved.data;
        if(!record||Object.keys(record).sort().join(',')!=='publication,report,snapshot'||typeof record.snapshot?.diff!=='string'
          ||createHash('sha256').update(record.snapshot.diff).digest('hex')!==record.snapshot.diffDigest
          ||typeof record.snapshot.url!=='string'||name!==`pr-review-${createHash('sha256').update(record.snapshot.url).digest('hex').slice(0,32)}`) throw new Error('Invalid review');
        if(record.report===null||record.publication?.status==='pending') blocked('This project has unfinished Rivet tasks in its saved PR reviews. Finish the review report or inspect its unresolved publication before updating.');
        validateReport(record.report,record.snapshot);
        if(record.publication!==null&&record.publication?.status!=='published') throw new Error('Invalid publication');
      } else {
        const state=validateRuntimeSnapshot(saved.data,name);
        if(!TERMINAL.has(state.terminal)) unfinished();
        if(state.graph.status!==state.terminal || state.graph.nodes.some(node=>['running','reserved'].includes(node.status))) throw new Error('Inconsistent terminal state');
      }
    }
    const afterFeatures=await listExistingFeatureRunPaths(projectRoot,{runner:gitRunner});
    if(JSON.stringify(afterFeatures.map(paths=>paths.runId))!==JSON.stringify(featurePaths.map(paths=>paths.runId))) throw new Error('Feature state changed');
    const after=await lstat(root);
    if(after.ino!==stat.ino||after.dev!==stat.dev||JSON.stringify(await readdir(root))!==JSON.stringify(entries)) throw new Error('State changed');
  } catch(error) {
    if(error instanceof CliError && error.code==='REPOSITORY_CONFLICT') throw error;
    blocked('Rivet cannot safely inspect this project’s task state. Inspect or recover its private state before updating; no update was started.');
  }
}
