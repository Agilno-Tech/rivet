import {withTerminalInterruption} from '../cli/interrupt.js';
import {resolve} from 'node:path';
import {createGitClient} from '../git/client.js';
import {taskGovernance} from '../feature/governance.js';
import {CliError,EXIT_CODES,observeOutputErrors} from '../cli/output.js';
import {readJson} from './work.js';

export async function taskGovernanceCommand(parsed,dependencies,project,run){
  const {subcommand:operation,flags}=parsed;
  const extra={decisions:[],decide:['input','input-json'],'approve-decision':['decision'],review:['input','input-json','phase']}[operation];
  if(Object.keys(flags).some(key=>!['project','run',...extra].includes(key)))throw new CliError('Unexpected option for this task evidence command.','INVALID_INPUT');
  if(operation==='decide'&&!flags.input&&!flags['input-json'])throw new CliError('Use rivet task decide --input=<decision.json>.','INVALID_INPUT');
  if(operation==='approve-decision'&&!flags.decision)throw new CliError('Use rivet task approve-decision --decision=<id>.','INVALID_INPUT');
  if(flags.phase!==undefined&&!['plan','final'].includes(flags.phase))throw new CliError('Review phase must be plan or final.','INVALID_INPUT');
  if(flags.input!==undefined&&flags['input-json']!==undefined)throw new CliError('Choose one of --input or --input-json.','INVALID_INPUT');
  let input;
  if(flags['input-json']!==undefined){
    const source=flags['input-json'];
    if(typeof source!=='string'||!source.length||Buffer.byteLength(source)>64*1024)throw new CliError('Inline task evidence must be bounded JSON (up to 64 KiB).','INVALID_INPUT');
    try{input=JSON.parse(source);}catch{throw new CliError('Task evidence is not valid JSON.','INVALID_INPUT');}
  }
  if(flags.input!==undefined)input=readJson(project.root,resolve(project.root,flags.input),dependencies.fs,'Task evidence');
  let confirm,activeSignal;
  if(operation==='approve-decision'){
    if(dependencies.terminalIsInteractive?.()!==true)throw new CliError('Decision approval requires an interactive human terminal.','BLOCKED_AUTHORITY');
    confirm=async record=>{
      let failed=false;
      const unobserve=observeOutputErrors(dependencies.output,()=>{failed=true;});
      try{
        activeSignal.throwIfAborted();
        dependencies.output.log(JSON.stringify(record,null,2));
        if(failed)throw new CliError('Could not display the decision. It remains pending.','REPOSITORY_CONFLICT');
        const answer=await dependencies.taskApprovalPrompt({type:'select',signal:activeSignal,message:'Approve this exact decision? Existing execution and delivery permissions still apply.',choices:[{value:'approve',label:'Approve this decision'},{value:'leave',label:'Leave pending'}]});
        activeSignal.throwIfAborted();
        if(failed)throw new CliError('Decision output failed. It remains pending.','REPOSITORY_CONFLICT');
        return answer==='approve';
      }finally{unobserve?.();}
    };
  }
  try{
    const gitClient=await createGitClient({gitExecutable:await dependencies.resolveCommandExecutable('git')});
    const result=await withTerminalInterruption(async signal=>{
      activeSignal=signal;
      return taskGovernance({project:project.root,runId:run.runId,gitClient,
      operation:operation==='review'&&input!==undefined?'review-submit':operation,input,phase:flags.phase,decisionId:flags.decision,confirm,signal});
    });
    dependencies.output.log(operation==='decisions'?result.markdown:JSON.stringify(result,null,2));
    return EXIT_CODES.SUCCESS;
  }catch(error){
    if(error instanceof CliError)throw error;
    throw new CliError(error.safeMessage??'Task decision or review operation failed. Inspect task status and the input report.','FAILED_GATE');
  }
}
