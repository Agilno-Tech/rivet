import {CliError} from '../cli/output.js';
const fail=()=>{throw new CliError('Diff is truncated or uses unsupported binary/path syntax. Review these changes manually.','REPOSITORY_CONFLICT');};
function path(value,prefix){if(value==='/dev/null')return null;if(!value?.startsWith(prefix))fail();const result=value.slice(prefix.length);if(!result||result.split('/').some(part=>!part||part==='.'||part==='..')||/[\\\u0000-\u001f\u007f]/.test(result))fail();return result;}
export function reviewDiffFiles(diff){
 if(typeof diff!=='string'||!diff.endsWith('\n'))fail();
 const sections=diff.split(/^diff --git /m);if(sections.shift()!==''||!sections.length||sections.length>500)fail();
 return sections.map(section=>{
  const lines=section.split('\n');const oldIndex=lines.findIndex(line=>line.startsWith('--- '));
  if(oldIndex<0||!lines[oldIndex+1]?.startsWith('+++ '))fail();
  const oldPath=path(lines[oldIndex].slice(4),'a/'),newPath=path(lines[oldIndex+1].slice(4),'b/');
  const ranges=[];let oldRemaining=0,newRemaining=0;
  for(const line of lines.slice(oldIndex+2)){
   const match=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
   if(match){if(oldRemaining||newRemaining)fail();oldRemaining=Number(match[2]??1);newRemaining=Number(match[4]??1);const start=Number(newPath?match[3]:match[1]),count=newPath?newRemaining:oldRemaining;if(count)ranges.push([start,start+count-1]);continue;}
   if(line==='\\ No newline at end of file'||line==='')continue;
   if(line[0]===' '){oldRemaining--;newRemaining--;}else if(line[0]==='-')oldRemaining--;else if(line[0]==='+')newRemaining--;else fail();
   if(oldRemaining<0||newRemaining<0)fail();
  }
  if(oldRemaining||newRemaining||!ranges.length)fail();
  return {path:newPath??oldPath,side:newPath?'new':'old',ranges};
 });
}
