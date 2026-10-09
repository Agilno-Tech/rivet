import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CliError } from '../cli/output.js';
import { runArgv } from '../discovery/tools.js';
import { resolveConfiguredProject } from '../cli/project-discovery.js';
import { inspectManagedInstall } from '../install/managed.js';
import integrity from '../install/runtime-integrity.cjs';
import { reference } from '../install/project-reference.js';
import { assertUpdateTasksIdle } from '../update/task-safety.js';
import { discoverInstallation, fetchLatestVersion, packageMetadata, globalUpdateArgs, PACKAGE_NAME, REGISTRY } from '../update/discovery.js';

function projectCandidate(cwd, fs) {
  let directory = resolve(cwd);
  for (;;) {
    if (fs.lstatSync(join(directory,'.rivet'),{throwIfNoEntry:false})) return directory;
    if (fs.existsSync(join(directory,'.git'))) return null;
    const parent = dirname(directory); if (parent === directory) return null;
    directory = parent;
  }
}
function pinnedVersion(root, pin, dependencies) {
  if (!pin) return null;
  const {fs}=dependencies;
  const cache=join(fs.realpathSync(dependencies.home()),'.cache','rivet','project-runtimes');
  const index=join(cache,`source-${pin.id}-${process.platform}-${process.arch}.json`);
  // A missing cache can be rebuilt by the updater; never execute or trust its contents.
  if (!fs.existsSync(index)) return 'unavailable';
  try {
    const stat=fs.lstatSync(index);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024||fs.realpathSync(cache)!==cache) throw new Error();
    const data=JSON.parse(fs.readFileSync(index,'utf8'));
    if(!/^[a-f0-9]{64}$/.test(data.runtimeId)) throw new Error();
    return integrity.runtimeIntegrity(join(cache,data.runtimeId),data.runtimeId,pin.id).metadata.package.version;
  } catch { throw new CliError('The pinned project runtime cache is invalid. Inspect the runtime before updating.', 'REPOSITORY_CONFLICT'); }
}
function targetsFor(root, fs) {
  return ['claude','codex'].filter(target => Boolean(fs.lstatSync(join(root,target === 'claude' ? '.claude' : '.agents','skills','rivet'),{throwIfNoEntry:false})));
}
function installationFlags(targets, projectRoot) {
  return { minimal:true, ...(projectRoot ? {project:projectRoot} : {global:true}), target:targets.length === 2 ? 'both' : targets[0] };
}
function inspectScope(dependencies, root, projectRoot) {
  const targets = targetsFor(root,dependencies.fs);
  const flags = installationFlags(targets,projectRoot);
  const plan = targets.length ? inspectManagedInstall({command:'install',flags},dependencies) : null;
  const versions=Object.fromEntries((plan?.targets??[]).map(item=>{
    const fs=dependencies.fs, descriptor=fs.openSync(item.manifestPath,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
    try {
      const stat=fs.fstatSync(descriptor), buffer=Buffer.alloc(16385);
      if(!stat.isFile()||stat.size>16384) throw new CliError('Managed manifest changed during update planning.', 'REPOSITORY_CONFLICT');
      const count=fs.readSync(descriptor,buffer,0,buffer.length,0);
      if(count>16384) throw new CliError('Managed manifest changed during update planning.', 'REPOSITORY_CONFLICT');
      const version=JSON.parse(buffer.subarray(0,count).toString('utf8')).package.version;
      return [item.target,/^[0-9A-Za-z.+-]{1,128}$/.test(version)?version:'unknown'];
    } finally { fs.closeSync(descriptor); }
  }));
  return {targets,flags,plan,versions};
}
async function runChecked(runner, command, args, options, label) {
  let result;
  try { result = await runner(command,args,{...options,shell:false,timeoutMs:180000,maxOutputBytes:65536}); }
  catch { throw new CliError(`${label} failed. Check permissions and connectivity, then retry.`, 'PROVIDER_UNAVAILABLE'); }
  if (result?.code !== 0 || result.timedOut) throw new CliError(`${label} failed${result?.timedOut ? ' or timed out' : ''}. Check permissions and connectivity, then retry.`, 'PROVIDER_UNAVAILABLE');
  return result;
}

export async function updateCommand(parsed, dependencies) {
  if (parsed.operands?.length || Object.keys(parsed.flags).some(key=>!['global','project','check','json'].includes(key))
    || Object.values(parsed.flags).some(value=>value!==true) || (parsed.flags.global && parsed.flags.project)) {
    throw new CliError('Use rivet update [--global | --project] [--check] [--json].','INVALID_INPUT');
  }
  const {fs,output,packageRoot}=dependencies;
  const overrides=dependencies.update ?? {}, runner=overrides.runner ?? runArgv;
  const cwd=dependencies.cwd(), env={...dependencies.env,npm_config_ignore_scripts:'true',npm_config_update_notifier:'false',npm_config_logs_max:'0',COREPACK_ENABLE_NETWORK:'0',COREPACK_ENABLE_DOWNLOAD_PROMPT:'0',COREPACK_ENABLE_PROJECT_SPEC:'0',COREPACK_ENABLE_AUTO_PIN:'0'};
  const current=packageMetadata(packageRoot,fs);
  let project=null;
  if (projectCandidate(cwd,fs)) {
    project=await resolveConfiguredProject(cwd,undefined,{runner,env});
  }
  if (parsed.flags.project && !project) throw new CliError('Run rivet update --project inside a configured project.','MISSING_CONFIGURATION');
  const taskProject=project;
  if(parsed.flags.global) project=null;
  const global=!parsed.flags.project;
  // All target ownership and local task safety checks precede package-manager mutations.
  const projectReference=project ? reference(project.root,fs) : null;
  const projectVersion=project ? pinnedVersion(project.root,projectReference,dependencies) : null;
  const projectScope=project ? inspectScope(dependencies,project.root,project.root) : null;
  const globalScope=global ? inspectScope(dependencies,dependencies.home(),null) : null;
  if(projectReference && !projectScope.targets.length) throw new CliError('The project runtime has no managed harness targets. Restore or remove the project runtime explicitly before updating.','REPOSITORY_CONFLICT');
  if(taskProject) await assertUpdateTasksIdle(taskProject.root,{runner,env});
  const installation=global ? await discoverInstallation(packageRoot,{fs,runner,cwd,env}) : null;
  const latest=await fetchLatestVersion(overrides.fetch ?? dependencies.fetch ?? globalThis.fetch);
  const result={currentVersion:current.version,latestVersion:latest,checkOnly:parsed.flags.check===true,
    global:global ? {manager:installation.manager,status:current.version===latest?'current':'available',targets:globalScope.targets} : null,
    project:project ? {root:project.root,runtimePinned:Boolean(projectReference),currentVersion:projectVersion,instructionVersions:projectScope.versions,targets:projectScope.targets,status:projectScope.targets.length?'refresh-available':'no managed instructions'} : null,
    completed:[],changedFiles:[]};
  const emit=()=>{
    if(parsed.flags.json) output.json({ok:true,command:'update',result});
    else {
      output.log(`Rivet ${current.version} → ${latest}${result.checkOnly?' (check only)':''}`);
      if(result.global) output.log(`Machine (${result.global.manager}): ${result.global.status}.`);
      if(result.project){
        output.log(`Project: ${result.project.status}.`);
        if(result.project.runtimePinned) output.log(`Project runtime: ${result.project.currentVersion} → ${latest}.`);
        for(const [target,version] of Object.entries(result.project.instructionVersions)) output.log(`Project ${target} instructions: ${version} → ${latest}.`);
      }
      if(!project && !parsed.flags.global) output.log('No configured project detected. Run rivet update --project in each project to refresh its instructions and runtime pin.');
      if(result.completed.length) output.log(`Completed: ${result.completed.join(', ')}.`);
      if(result.changedFiles.length){output.log('Refreshed managed files (review project changes before committing):');for(const file of result.changedFiles) output.log(`  ${file}`);}
    }
  };
  if(parsed.flags.check){emit();return 0;}
  // The registry request and manager discovery can take time. Recheck ownership and task state
  // immediately before the first mutation, preserving exactly the selected destinations.
  if(taskProject) await assertUpdateTasksIdle(taskProject.root,{runner,env});
  const verifyScopeSelection=(scope,root,projectRoot)=>{
    if(projectRoot){
      const now=reference(projectRoot,fs);
      if((now?.id??null)!==(projectReference?.id??null)) throw new CliError('The project runtime pin changed during the update. Retry.', 'REPOSITORY_CONFLICT');
    }
    const now=inspectScope(dependencies,root,projectRoot);
    if(JSON.stringify(now.targets)!==JSON.stringify(scope.targets)) throw new CliError(`${projectRoot?'Project':'Global'} managed targets changed during the update. Retry.`, 'REPOSITORY_CONFLICT');
  };
  if(project) verifyScopeSelection(projectScope,project.root,project.root);
  if(globalScope) verifyScopeSelection(globalScope,dependencies.home(),null);
  let stage, freshRoot=installation?.packageRoot;
  try {
    if(global && current.version!==latest){
      await runChecked(runner,installation.manager,globalUpdateArgs(installation.manager,latest),{cwd,env},'Global Rivet update');
      // Resolve again: pnpm may replace its global package symlink with a different store path.
      freshRoot=fs.realpathSync(installation.lookupPath);
      if(packageMetadata(freshRoot,fs).version!==latest) throw new CliError('The package manager finished, but the installed Rivet version does not match the requested release. Inspect the global installation before retrying.','REPOSITORY_CONFLICT');
      result.global.status='updated';result.completed.push('global CLI');
    }
    if(!global){
      stage=fs.mkdtempSync(join(tmpdir(),'rivet-update-'));fs.chmodSync(stage,0o700);
      await runChecked(runner,'npm',['install','--prefix',stage,'--omit=dev','--ignore-scripts','--no-audit','--no-fund','--package-lock=false',`--registry=${REGISTRY}`,`${PACKAGE_NAME}@${latest}`],{cwd:stage,env},'Latest project updater preparation');
      freshRoot=join(stage,'node_modules','@agilno-tech','rivet');
      if(packageMetadata(freshRoot,fs).version!==latest) throw new CliError('Prepared Rivet runtime has an unexpected version.','REPOSITORY_CONFLICT');
    }
    const entry=join(freshRoot,'bin','cli.js');
    // Start fresh Node processes so global replacement cannot mix versions in this process.
    const installScope=async(scope,root,pinned)=>{
      if(!scope.targets.length && !pinned) return;
      const target=scope.targets.length===2?'both':scope.targets[0];
      const args=[entry,'install','--minimal',...(pinned?['--project-runtime']:[]),...(root?[`--project=${root}`]:['--global']),...(target?[`--target=${target}`]:[]),'--json'];
      try { await runChecked(runner,process.execPath,args,{cwd:root??cwd,env},root?'Project Rivet refresh':'Global harness instruction refresh'); }
      catch { throw new CliError(`Rivet instruction/runtime refresh stopped. Check managed files for edits, project runtime locks and directory permissions. Retry rivet update ${root?'--project':'--global'} after resolving the conflict.`, 'REPOSITORY_CONFLICT'); }
    };
    if(globalScope?.targets.length){
      verifyScopeSelection(globalScope,dependencies.home(),null);
      await installScope(globalScope,null,false);result.completed.push('global harness instructions');
      for(const item of globalScope.plan.targets) result.changedFiles.push(join(item.skillDir,'SKILL.md'),item.manifestPath);
    }
    if(project){
      await assertUpdateTasksIdle(project.root,{runner,env});
      verifyScopeSelection(projectScope,project.root,project.root);
      if(projectReference && !projectScope.targets.length) throw new CliError('The project runtime has no managed harness targets. Restore or remove the project runtime explicitly before updating.','REPOSITORY_CONFLICT');
      await installScope(projectScope,project.root,Boolean(projectReference));
      result.project.status=projectScope.targets.length?'updated':'no managed instructions';
      if(projectScope.targets.length){
        result.completed.push(projectReference?'project runtime and instructions':'project instructions');
        for(const item of projectScope.plan.targets) result.changedFiles.push(join(item.skillDir,'SKILL.md'),item.manifestPath);
        if(projectReference) result.changedFiles.push(join(project.root,'.rivet.cjs'));
      }
    }
    emit();return 0;
  } catch(error) {
    const message=error instanceof CliError ? error.safeMessage : 'Update stopped because the installation could not be safely verified.';
    const progress=result.completed.length ? ` Completed: ${result.completed.join(', ')}. The remaining phases were not confirmed; retry after resolving the issue.` : ' A package-manager operation may have been partial; inspect installed versions before retrying.';
    const failure=new CliError(message+progress,error instanceof CliError?error.code:'REPOSITORY_CONFLICT');
    if(parsed.flags.json){output.json({ok:false,command:'update',error:{code:failure.code,message:failure.safeMessage},result});return failure.exitCode;}
    throw failure;
  } finally {
    if(stage) fs.rmSync(stage,{recursive:true,force:true});
  }
}
