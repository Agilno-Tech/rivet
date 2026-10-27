import {containsSecretMaterial} from '../clients/contract.js';

// These signatures are never eligible for a review-content exception/redaction.
export function hasReviewCredential(text) {
 return /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.:=-]{8,}|\b(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|npm_|glpat-|hf_)[A-Za-z0-9_-]{8,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(text.normalize('NFKC').replace(/\p{Cf}/gu,''));
}
const assignments=/\b([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*/g;
const boundary=text=>/^[ \t]*[)\]}]*[ \t]*(?:$|[\r\n;]|#)/.test(text);
function identifier(text,start) {return /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(text.slice(start))?.[0];}
function skip(text,start) {while(text[start]===' '||text[start]==='\t')start++;return start;}
// Deliberately a small expression grammar, not a language parser: no evaluation,
// strings (except a sole environment-name argument), operators or keyword args.
function expression(text,start,depth=0) {
 if(depth>16)return null;
 start=skip(text,start);
 const scalar=/^(?:\.\.\.|[0-9]+(?:\.[0-9]+)?)/.exec(text.slice(start));
 if(scalar)return {end:start+scalar[0].length,call:false};
 const name=identifier(text,start);if(!name)return null;
 let at=skip(text,start+name.length);
 if(text[at]!=='(')return {end:at,call:false};
 at=skip(text,at+1);
 if(['os.environ.get','os.getenv'].includes(name)) {
  const env=/^(['"])[A-Z_][A-Z0-9_]{0,127}\1[ \t]*\)/.exec(text.slice(at));
  return env?{end:at+env[0].length,call:true}:null;
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
export function maskReviewExpressions(text, python=false) {
 if(/"{3}|'{3}|`|\/\*/.test(text))return text;
 return maskAssignments(text,(line,start,index)=>{
  // Only classify assignments outside visible quoted strings and comments.
  const prefix=line.slice(line.lastIndexOf('\n',index-1)+1,index);
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


// Derive eligibility from diff headers, never caller-provided files metadata.
// Python is the only source grammar currently recognized. A visible multiline
// string delimiter makes the entire file ambiguous, so retain strict scanning.
export function maskReviewDiff(diff) {
 return diff.split(/(?=^diff --git )/m).map(section=>{
  const header=/^--- a\/(.+)\n\+\+\+ b\/(.+)$/m.exec(section);
  if(!header||!header[1].endsWith('.py')||!header[2].endsWith('.py')
    ||/"{3}|'{3}|`|\/\*/.test(section))return section;
  let inHunk=false;
  return section.split('\n').map(line=>{
   if(/^@@ /.test(line)){inHunk=true;return maskPythonSignature(line);}
   return inHunk&&/^[+ -]/.test(line)?line[0]+maskPythonSignature(maskReviewExpressions(line.slice(1),true)):line;
  }).join('\n');
 }).join('');
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
// terminate a value; a closing call requires a visible opening parenthesis.
// Ambiguous strings/continuations retain the whole-file fallback.
export function reviewLineOmissionIndexes(diff) {
 const eligible=new Set();let offset=0;
 for(const section of diff.split(/(?=^diff --git )/m)) {
  const lines=section.split('\n');
  const header=/^--- a\/(.+)\n\+\+\+ b\/(.+)$/m.exec(section);
  if(header&&header[1].endsWith('.py')&&header[2].endsWith('.py')&&!/"{3}|'{3}|`|\/\*|\\/.test(section)) {
   let inHunk=false;
   for(let i=0;i<lines.length;i++) {
    if(/^@@ /.test(lines[i])){inHunk=true;continue;}
    if(!inHunk||! /^[+ -]/.test(lines[i]))continue;
    const code=lines[i].slice(1);let found=false;
    const masked=maskAssignments(code,(text,start,index)=>{
     const prefix=text.slice(0,index);
     // Restrict prefixes to code punctuation and complete simple strings.
     const withoutStrings=prefix.replace(/(['"])[^'"\n]*?\1/g,'');
     if(/['"#]/.test(withoutStrings))return false;
     const literal=/^(['"])[^'"\n]*\1/.exec(text.slice(start));if(!literal)return false;
     const rest=text.slice(start+literal[0].length).trimStart();
     if(!/^[,;]/.test(rest)&&!(rest.startsWith(')')&&withoutStrings.includes('(')))return false;
     found=true;return true;
    });
    if(found&&!containsSecretMaterial(maskReviewExpressions(masked)))eligible.add(offset+i);
   }
  }
  offset+=lines.length-1;
 }
 return eligible;
}
