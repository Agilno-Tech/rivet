import {createGitClient} from '../git/client.js';
import {taskGovernance} from '../feature/governance.js';
import {invokeFeature} from './feature.js';
import {confirmIsolatedDependencyInstall} from './dependency-approval.js';
import {defaultIntegrationSetupPrompt} from '../cli/integration-setup-prompt.js';
import {observeOutputErrors} from '../cli/output.js';

// Only an interactive human reply clears a pending decision. EOF leaves it pending.
export async function continueAfterQuestions(project,result,dependencies,{signal}={}) {
 if(result.questionsPending||result.status!=='blocked'||dependencies.terminalIsInteractive?.()!==true||!dependencies.resolveCommandExecutable)return result;
 const gitClient=await createGitClient({gitExecutable:await dependencies.resolveCommandExecutable('git')});
 for(let turn=0;turn<128&&result.status==='blocked';turn++) {
  const {decisions}=await taskGovernance({project:project.root,runId:result.runId,gitClient,operation:'decisions'});
  const pending=decisions.filter(d=>d.status==='pending');if(!pending.length)return result;
  for(const decision of pending){
   const answer=await taskGovernance({project:project.root,runId:result.runId,gitClient,operation:'approve-decision',decisionId:decision.id,signal,confirm:async record=>{
    let outputFailed=false;const stop=observeOutputErrors(dependencies.output,()=>{outputFailed=true;});
    try {
     dependencies.output.log(`Product question: ${record.title}\nRecommendation only: ${record.choice}\n${record.rationale}`);
     if(outputFailed||signal?.aborted)return false;
     const selected=await (dependencies.taskApprovalPrompt??defaultIntegrationSetupPrompt)({type:'select',signal,message:'Choose your answer to continue:',choices:[...record.options.map(option=>({value:`answer:${option.id}`,label:option.description})),{value:'leave-pending',label:'Leave pending and stop'}]});
     if(outputFailed||signal?.aborted)return false;
     return typeof selected==='string'&&selected.startsWith('answer:')&&record.options.some(option=>`answer:${option.id}`===selected)?selected.slice(7):false;
    }catch{return false;}finally{stop?.();}
   }});
   if(answer.status==='declined')return {...result,questionsPending:true};
  }
  const current=await invokeFeature(dependencies.feature,'status',{project:project.root,runId:result.runId});
  result=await invokeFeature(dependencies.feature,'resume',{project:project.root,runId:result.runId,expectedVersion:current.version},{signal,confirmDependencyInstall:confirmIsolatedDependencyInstall(dependencies,signal)});
 }
 return result;
}
