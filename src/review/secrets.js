import {containsSecretMaterial} from '../clients/contract.js';

// These signatures are never eligible for a review-content exception/redaction.
export function hasReviewCredential(text) {
 return /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.:=-]{8,}|\b(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|npm_|glpat-|hf_)[A-Za-z0-9_-]{8,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(text.normalize('NFKC').replace(/\p{Cf}/gu,''));
}
const assignments=/\b([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*/g;
const boundary=text=>/^[ \t]*[)\]}]*[ \t]*(?:$|[\r\n;]|#)/.test(text);
function identifier(text,start) {return /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(text.slice(start))?.[0];}
function skip(text,start) {while(/[ \t\r\n]/.test(text[start]??'!'))start++;return start;}
// Deliberately a small expression grammar, not a language parser: no evaluation,
// arbitrary strings, operators or keyword args. Environment names (with an
// optional empty default) and identifier-shaped mapping keys are recognized.
function expression(text,start,depth=0) {
 if(depth>16)return null;
 start=skip(text,start);
 const scalar=/^(?:\.\.\.|[0-9]+(?:\.[0-9]+)?)/.exec(text.slice(start));
 if(scalar)return {end:start+scalar[0].length,call:false};
 const name=identifier(text,start);if(!name)return null;
 let at=skip(text,start+name.length);
 if(text[at]!=='(')return {end:start+name.length,call:false};
 at=skip(text,at+1);
 if(['os.environ.get','os.getenv'].includes(name)) {
  const env=/^(['"])[A-Z_][A-Z0-9_]{0,127}\1[ \t]*(?:,[ \t]*(['"])\2[ \t]*)?\)/.exec(text.slice(at));
  return env?{end:at+env[0].length,call:true}:null;
 }
 if(/\.(?:pop|get)$/.test(name)) {
  const key=/^(['"])[A-Za-z_][A-Za-z0-9_]{0,127}\1[ \t]*\)/.exec(text.slice(at));
  if(key)return {end:at+key[0].length,call:true};
 }
 if(text[at]===')')return {end:at+1,call:true};
 for(let args=0;args<128;args++) {
  const arg=expression(text,at,depth+1);if(!arg)return null;
  at=skip(text,arg.end);
  if(text[at]===')')return {end:at+1,call:true};
  if(text[at]!==',')return null;
  at=skip(text,at+1);if(text[at]===')')return {end:at+1,call:true};
 }
 return null;
}
function maskAssignments(text,accept) {
 if(typeof text!=='string'||text!==text.normalize('NFKC')||/\p{Cf}/u.test(text)||hasReviewCredential(text))return text;
 const ranges=[];
 for(const match of text.matchAll(assignments)) {
  if(!containsSecretMaterial(`${match[1]}=value`))continue;
  const start=match.index+match[0].length;
  if(accept(text,start,match.index))ranges.push([match.index,match.index+match[1].length]);
 }
 // Mask only the label for checking. All RHS text remains subject to scanning.
 for(const [start,end] of ranges.reverse())text=text.slice(0,start)+'rivet_value'+text.slice(end);
 return text;
}
export function maskReviewExpressions(text, python=false, codeOffsets=null) {
 if(!codeOffsets&&/"{3}|'{3}|`|\/\*/.test(text))return text;
 return maskAssignments(text,(line,start,index)=>{
  // Only classify assignments outside visible quoted strings and comments.
  if(codeOffsets&&!codeOffsets[index])return false;
  const prefix=codeOffsets?'':line.slice(line.lastIndexOf('\n',index-1)+1,index);
  let quote=null;
  for(let i=0;i<prefix.length;i++){
   const ch=prefix[i];
   if(quote){if(ch==='\\')i++;else if(ch===quote)quote=null;}
   else if(ch==='\"'||ch==="'")quote=ch;
   else if(ch==='#'||prefix.slice(i,i+2)==='//')return false;
  }
  if(quote)return false;
  const bearer=/^f(['"])Bearer \{[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\}\1/.exec(line.slice(start));
  if(python&&bearer&&(/^[ \t]*,/.test(line.slice(start+bearer[0].length))||boundary(line.slice(start+bearer[0].length))))return true;
  const result=expression(line,start);
  return result!==null&&(result.call||(python&&/^[A-Za-z_]/.test(line.slice(start))))&&boundary(line.slice(result.end));
 });
}
// Used solely for scanning, never as saved/exported/model-visible content.
export function reviewSnapshotForScan(snapshot) {
 return {...snapshot,diff:maskReviewDiff(snapshot.diff)};
}
export function reviewReportForScan(report) {
 return {...report,summary:maskReviewExpressions(report.summary),
  findings:report.findings?.map(item=>({...item,message:maskReviewExpressions(item.message)})),
  limitations:report.limitations?.map(item=>maskReviewExpressions(item))};
}


// Scan old and new Python source independently: a quote added on one side must
// not reclassify a context line on the other. Keep quote state only across
// adjacent hunks; missing source can contain an unseen string delimiter. This is a bounded lexical
// check, not a Python evaluator; literal call arguments remain strict.
function pythonCodeOffsets(text,state) {
 const code=new Uint8Array(text.length);
 if(state.unknown)return code;
 let comment=false;
 for(let i=0;i<text.length;i++) {
  const ch=text[i];
  if(comment){if(ch==='\n')comment=false;continue;}
  if(state.quote){
   if(ch==='\\'){i++;continue;}
   if(text.startsWith(state.quote,i)){i+=state.quote.length-1;state.quote=null;}
   continue;
  }
  if(ch==='#'){comment=true;continue;}
  if(ch==='"'||ch==="'"){
   // Formatted/template strings can nest same-quote literals inside replacement
   // expressions. This lexer does not parse that grammar; never guess where
   // the outer string closes or classify its later contents as source code.
   let prefixStart=i;while(prefixStart>0&&/[A-Za-z]/.test(text[prefixStart-1]))prefixStart--;
   const prefix=text.slice(prefixStart,i);
   if(/[ft]/i.test(prefix)){state.unknown=true;return code;}
   state.quote=text.startsWith(ch.repeat(3),i)?ch.repeat(3):ch;
   i+=state.quote.length-1;continue;
  }
  code[i]=1;
 }
 return code;
}
function pythonSections(diff,visit) {
 const lines=diff.split('\n');let start=0;
 while(start<lines.length) {
  let end=start+1;while(end<lines.length&&!lines[end].startsWith('diff --git '))end++;
  const section=lines.slice(start,end).join('\n');
  const header=/^--- (?:a\/(.+)|\/dev\/null)\n\+\+\+ (?:b\/(.+)|\/dev\/null)$/m.exec(section);
  if(header&&(header[1]??header[2]).endsWith('.py')&&(header[2]??header[1]).endsWith('.py')) {
   const states={old:{quote:null,nextLine:1,unknown:false},new:{quote:null,nextLine:1,unknown:false}};
   for(let h=start;h<end;h++) {
    const range=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[h]);
    if(!range)continue;
    let stop=h+1;while(stop<end&&!lines[stop].startsWith('@@ '))stop++;
    for(const side of ['old','new']) {
     const group=side==='old'?1:3,count=Number(range[group+1]??1);
     const first=Number(range[group])+(count===0?1:0),state=states[side];
     if(first!==state.nextLine)state.unknown=true;
     state.nextLine=first+count;
     const indexes=[];
     for(let i=h+1;i<stop;i++)if(lines[i][0]===' '||lines[i][0]===(side==='old'?'-':'+'))indexes.push(i);
     const source=indexes.map(i=>lines[i].slice(1)).join('\n')+'\n';
     visit({source,indexes,code:pythonCodeOffsets(source,states[side]),header:h,side,section:start});
    }
    h=stop-1;
   }
  }
  start=end;
 }
 return lines;
}
export function maskReviewDiff(diff) {
 const candidates=new Map(),headers=new Set();
 const lines=pythonSections(diff,({source,indexes,code,header})=>{
  headers.add(header);
  const original=source.split('\n');
  const masked=maskReviewExpressions(source,true,code).split('\n');
  let offset=0;
  indexes.forEach((index,i)=>{
   const value=code[offset+(/\S/.exec(original[i])?.index??0)]?maskPythonSignature(masked[i]):masked[i];
   candidates.set(index,candidates.has(index)&&candidates.get(index)!==value?null:value);
   offset+=original[i].length+1;
  });
 });
 for(const [index,value] of candidates)if(value!==null)lines[index]=lines[index][0]+value;
 // Hunk labels are optional display context, still scanned independently.
 return lines.map((line,index)=>headers.has(index)?maskPythonSignature(line):line).join('\n');
}

// Only builtin parameter annotations in visible Python function signatures.
// Defaults, strings, comments and arbitrary annotation expressions stay strict.
function maskPythonSignature(line) {
 const source=line.replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@[ \t]*/, '');
 if(!/^[ \t]*(?:async[ \t]+)?def[ \t]+/.test(source)||/['"#]/.test(source))return line;
 return line.replace(/([,(][ \t]*)([A-Za-z_][A-Za-z0-9_]*)([ \t]*:[ \t]*(?:str|bytes|None)(?:[ \t]*\|[ \t]*(?:str|bytes|None))*[ \t]*)(?=[,)])/g,
  (all,prefix,label,type)=>containsSecretMaterial(label+'=value')?prefix+'rivet_value'+type:all);
}

// A literal must visibly end on this physical Python line. Commas/semicolons
// terminate a value even in multiline calls. A complete standalone literal is
// eligible too; ambiguous strings/continuations retain the whole-file fallback.
export function reviewLineOmissionIndexes(diff) {
 const eligible=new Set(),ineligible=new Set(),chunks=[],following=new Map();
 pythonSections(diff,chunk=>chunks.push(chunk));
 for(const {source,indexes,code,side,section} of chunks.reverse()){
  const key=`${section}:${side}`;
  const lines=source.split('\n'),nextCode=[];let offset=0,next=following.get(key)??'';
  for(let i=lines.length-1;i>=0;i--){nextCode[i]=next;if(lines[i].trim()&&!lines[i].trimStart().startsWith('#'))next=lines[i].trimStart();}
  following.set(key,next);
  indexes.forEach((index,i)=>{
   const text=lines[i];let found=false;
   const masked=maskAssignments(text,(line,start,at)=>{
    if(!code[offset+at])return false;
    const literal=/^(['"])(?:\\[^\n]|(?!\1)[^\\\n])*?\1/.exec(line.slice(start));
    if(!literal||literal[0].startsWith("'".repeat(3))||literal[0].startsWith('"'.repeat(3)))return false;
    const rest=line.slice(start+literal[0].length).trimStart();
    // A comma/semicolon ends this value, even inside a multiline call. Without
    // punctuation, require visible termination and exclude continued strings.
    // Python adjacent literals may have case-insensitive prefixes (r, f, u,
    // rf, etc.). Treat any letter prefix before a quote conservatively, so
    // new or unrecognized prefixes cannot expose a credential continuation.
    const next=nextCode[i];
    if(!/^[,;]/.test(rest)&&(!/^[)\]}]*[ \t]*(?:#.*)?$/.test(rest)||/^(?:[+'"\\]|[A-Za-z]+['"])/.test(next)))return false;
    found=true;return true;
   });
   if(found&&!containsSecretMaterial(maskReviewExpressions(masked,true)))eligible.add(index);
   else ineligible.add(index);
   offset+=text.length+1;
  });
 }
 for(const index of ineligible)eligible.delete(index);
 return eligible;
}
