import {basename,join} from 'node:path';
import {compileProjectCommands} from '../config/commands.js';

export class ProjectChecksRequiredError extends Error {
  constructor(message = 'No project verification commands were detected. Run interactive rivet setup --write to choose a check, or pass --checks-json with your project commands, for example: {"test":["python3","-m","pytest"]}. No files were written.') {
    super(message);
    this.code = 'MISSING_CONFIGURATION';
  }
}

export function parseProjectChecks(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || Buffer.byteLength(value) > 16384) throw new ProjectChecksRequiredError('Option --checks-json must be a bounded JSON object of project check commands.');
  try { return JSON.parse(value); }
  catch { throw new ProjectChecksRequiredError('Option --checks-json must contain valid JSON, for example: {"test":["python3","-m","pytest"]}.'); }
}

export function parseProjectDependencies(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || Buffer.byteLength(value) > 16384) throw new ProjectChecksRequiredError('Option --dependencies-json must be a bounded JSON dependency plan.');
  try {
    const parsed=JSON.parse(value);
    if(!parsed || typeof parsed!=='object' || Array.isArray(parsed))throw new Error('Invalid dependency object');
    return parsed;
  }
  catch { throw new ProjectChecksRequiredError('Option --dependencies-json must contain valid JSON with inputs, provides, and ordered steps.'); }
}

// Tokenize one argv command for the setup prompt. No expansion or shell dispatch.
export function parseCheckCommand(value) {
  if(typeof value!=='string' || value.length>16384 || /[\u0000-\u001f\u007f]/.test(value)) throw new ProjectChecksRequiredError('Enter one bounded verification command without control characters.');
  const argv=[];let token='',quote=null,escaped=false,started=false;
  for(const char of value.trim()) {
    if(escaped) {token+=char;escaped=false;started=true;continue;}
    if(char==='\\' && quote!=="'") {escaped=true;started=true;continue;}
    if(quote) {if(char===quote)quote=null;else token+=char;started=true;continue;}
    if(char==='"'||char==="'") {quote=char;started=true;continue;}
    if(/\s/.test(char)) {if(started){argv.push(token);token='';started=false;}continue;}
    if(/[;&|<>`]/.test(char)) throw new ProjectChecksRequiredError('Enter one command without shell operators. Configure separate argv steps with --checks-json for multiple checks.');
    token+=char;started=true;
  }
  if(quote||escaped)throw new ProjectChecksRequiredError('The verification command has an unfinished quote or escape.');
  if(started)argv.push(token);
  if(!argv.length)throw new ProjectChecksRequiredError();
  return argv;
}

export function discoverPortableProject(root, {fs, inspect, read, checks}) {
  const metadata = new Map();
  let totalBytes=0;
  for (const name of ['manage.py','pyproject.toml','requirements.txt','setup.cfg','setup.py','Pipfile','uv.lock','poetry.lock','go.mod','Cargo.toml','Makefile','pom.xml','build.gradle','composer.json','Gemfile','AGENTS.md']) {
    if(['uv.lock','poetry.lock'].includes(name)) {
      const entry=fs.lstatSync(join(root,name),{throwIfNoEntry:false});
      if(entry) {if(!entry.isFile()||entry.isSymbolicLink())throw new ProjectChecksRequiredError('Project lock metadata must be a regular file.');metadata.set(name,'');}
      continue;
    }
    const file=inspect(root,name,fs,false);
    if(file) {
      totalBytes+=file.size;
      if(totalBytes>2*1024*1024)throw new ProjectChecksRequiredError('Project metadata exceeds the discovery read limit. Use smaller metadata files.');
      metadata.set(name,read(file,fs));
    }
  }
  let framework='other', language='other', packageManager='other', source='explicit project checks';
  let commands={};
  const group=argv=>({steps:[{cwd:'.',argv}]});
  if(metadata.has('manage.py') || ['pyproject.toml','requirements.txt','setup.cfg','setup.py','Pipfile'].some(name=>metadata.has(name))) {
    language='python';packageManager=metadata.has('uv.lock')?'uv':metadata.has('poetry.lock')?'poetry':'pip';
    if(metadata.has('manage.py')) {
      framework='django';source='manage.py (Django convention; review before use)';
      commands={check:group(['python3','manage.py','check']),test:group(['python3','manage.py','test'])};
    } else if(['pyproject.toml','requirements.txt','setup.cfg'].some(name=>/\bpytest\b/.test(metadata.get(name)??''))) {
      source='Python metadata (pytest convention; review before use)';
      commands={test:group(['python3','-m','pytest'])};
    }
  } else if(metadata.has('go.mod')) {
    language='go';packageManager='go';source='go.mod (Go convention; review before use)';
    commands={build:group(['go','build','./...']),test:group(['go','test','./...'])};
  } else if(metadata.has('Cargo.toml')) {
    language='rust';packageManager='cargo';source='Cargo.toml (Cargo convention; review before use)';
    commands={build:group(['cargo','build']),test:group(['cargo','test'])};
  }
  if(checks !== undefined) {
    if(!checks || typeof checks!=='object' || Array.isArray(checks)) throw new ProjectChecksRequiredError('Project checks must be a JSON object mapping test/check/build/lint/typecheck to argv arrays or step groups.');
    commands=Object.fromEntries(Object.entries(checks).map(([key,value])=>[key,Array.isArray(value)?group(value):value]));
    source='explicit --checks-json';
  }
  let dependencies;
  if (language === 'python' && metadata.has('requirements.txt') && checks === undefined) {
    const python='./.rivet-deps/venv/bin/python';
    dependencies={inputs:['requirements.txt'],provides:[python],steps:[
      {cwd:'.',argv:['python3','-m','venv','.rivet-deps/venv']},
      {cwd:'.',argv:[python,'-m','pip','--isolated','install','--require-virtualenv','--no-user','-r','requirements.txt']},
    ]};
    for(const group of Object.values(commands)) for(const step of group.steps) if(step.argv[0]==='python3')step.argv[0]=python;
  }
  if(!commands.test && !commands.check) throw new ProjectChecksRequiredError();
  const name=basename(root).normalize('NFKC').slice(0,120);
  const id=name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60).replace(/-$/,'');
  const projectId=(/^[a-z]/.test(id)?id:`project-${id||'local'}`).slice(0,64).replace(/-$/,'');
  const proposal={schemaVersion:3,id:projectId,name,stack:{framework,language,packageManager},commands,...(dependencies?{dependencies}:{})};
  try { compileProjectCommands(proposal); }
  catch { throw new ProjectChecksRequiredError('Project checks are invalid. Use bounded argv arrays with executable names, safe relative working directories, and at least one test or check command. Shell commands are not supported.'); }
  const provenance={id:'project directory basename',name:'project directory basename','stack.framework':source,'stack.language':source,'stack.packageManager':source,'features.storybook':'not detected','features.playwright':'not detected'};
  for(const [key,group] of Object.entries(commands)) group.steps.forEach((_,index)=>{provenance[`commands.${key}.steps[${index}]`]=source;});
  if(dependencies)provenance.dependencies='requirements.txt (isolated Python environment proposal; review before installation)';
  return {root,proposal,inspectedFiles:[...metadata.keys()],features:{storybook:false,playwright:false},architectureHints:metadata.has('AGENTS.md')?['AGENTS.md']:[],existingConfig:fs.existsSync(`${root}/.rivet`),warnings:[{code:'environment-preparation',message:dependencies?'Review the proposed dependency steps. Installation requires separate approval in each isolated checkout.':'Review the proposed commands. Configure dependency installation steps when this project needs environment preparation.'}],unresolved:[],provenance};
}
