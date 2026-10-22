import { fixtureGit } from '../helpers/git-executable.js';
import assert from 'node:assert/strict';
import {execFile as callback} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,realpath,writeFile,rm,chmod,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createGitClient} from '../../src/git/client.js';
const execFile=promisify(callback);
async function setup(t) {
 const root=await realpath(await mkdtemp(join(tmpdir(),'rivet-checkpoint-')));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const git=async(...args)=>(await execFile(fixtureGit,['-C',root,...args])).stdout;
 await git('init','--quiet','--initial-branch=main');
 await writeFile(join(root,'tracked'),'original'); await writeFile(join(root,'deleted'),'remove');
 await git('add','.'); await git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','initial');
 return {root,git,client:await createGitClient({gitExecutable:await realpath(fixtureGit)})};
}
test('checkpoint manifest preserves staged unstaged untracked deletion and mode identities without committing',async t=>{
 const {root,git,client}=await setup(t);
 const head=(await git('rev-parse','HEAD')).trim();
 await writeFile(join(root,'tracked'),'staged');await git('add','tracked');
 await writeFile(join(root,'tracked'),'unstaged');await writeFile(join(root,'new'),'new');await rm(join(root,'deleted'));
 const first=await client.checkpointManifest(root);
 assert.equal(first.headSha,head);assert.deepEqual(first.entries.map(e=>e.path),['deleted','new','tracked']);
 await writeFile(join(root,'tracked'),'same path different bytes');
 assert.notEqual((await client.checkpointManifest(root)).digest,first.digest);
 await writeFile(join(root,'tracked'),'unstaged');await git('add','tracked');
 assert.notEqual((await client.checkpointManifest(root)).digest,first.digest);
 const beforeMode=await client.checkpointManifest(root);await chmod(join(root,'new'),0o755);
 assert.notEqual((await client.checkpointManifest(root)).digest,beforeMode.digest);
 assert.equal((await git('rev-parse','HEAD')).trim(),head);
});
test('checkpoint manifest refuses symlink dirty paths',async t=>{
 const {root,client}=await setup(t);await symlink('/tmp',join(root,'unsafe'));
 await assert.rejects(()=>client.checkpointManifest(root));
});
