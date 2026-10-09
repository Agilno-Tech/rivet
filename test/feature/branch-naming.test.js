import assert from 'node:assert/strict';
import test from 'node:test';
import { selectBranchNaming, renderBranchName, inferBranchPatterns } from '../../src/feature/branch-naming.js';

const repository = { branchPattern: 'feature/{slug}' };
test('bugfix request uses fix before branch creation, not the feature default', () => {
  assert.deepEqual(selectBranchNaming(repository, {title:'Fix login timeout'}), {workType:'bugfix',pattern:'fix/{slug}'});
});
test('tracker type beats planner and title guesses; explicit repository pattern wins', () => {
  assert.deepEqual(selectBranchNaming({...repository,branchPatterns:{bugfix:'bugfix/{ticket}/{slug}'}},
    {title:'Add validation',workType:'bugfix',source:{kind:'jira',ref:'APP-21'}}, 'feature'),
    {workType:'bugfix',pattern:'bugfix/APP-21/{slug}'});
  assert.equal(selectBranchNaming({branchPattern:'team/{slug}'},{title:'Fix login'}).pattern,'team/{slug}');
});
test('typed patterns and planner classification support non-obvious task titles', () => {
  assert.deepEqual(selectBranchNaming({branchPattern:'{type}/{slug}'},{title:'Login times out'},'bugfix'), {workType:'bugfix',pattern:'fix/{slug}'});
  assert.equal(selectBranchNaming(repository,{title:'Add a page mentioning bug fixes'}).workType,'feature');
});
test('unsafe and missing-ticket patterns fail before worktree creation', () => {
  for (const pattern of ['fix/../{slug}','fix/{unknown}/{slug}','fix/{slug}/{slug}','fix/.hidden/{slug}','fix/{ticket}/{slug}']) {
    assert.throws(()=>selectBranchNaming({branchPattern:pattern},{title:'Fix login'}));
  }
  assert.throws(()=>renderBranchName({pattern:'fix/{slug}'}, '../escape','run-one'));
});
test('rendering uses approved naming and preserves unique run suffix',()=>{
  assert.equal(renderBranchName({pattern:'bugfix/{slug}'},'login-timeout','run-one'),'bugfix/login-timeout-run-one');
});
test('setup infers only unambiguous familiar prefixes from existing branches',()=>{
  assert.deepEqual(inferBranchPatterns(['refs/heads/bugfix/APP-1','refs/remotes/origin/bugfix/APP-2','refs/heads/feat/thing']),
    {bugfix:'bugfix/{slug}',feature:'feat/{slug}'});
  assert.deepEqual(inferBranchPatterns(['refs/heads/fix/a','refs/heads/bugfix/b']),{});
});

test('planner classification beats incidental words at the beginning of a title',()=>{
  assert.deepEqual(selectBranchNaming(repository,{title:'Feature flag crashes on startup'},'bugfix'),{workType:'bugfix',pattern:'fix/{slug}'});
});

test('terminal fix requests preserve explicit bugfix intent through normalization', async()=>{
  const {normalizedTask}=await import('../../src/commands/human-run.js');
  const {resolveInlineWorkRequest}=await import('../../src/work-request/local.js');
  const request=resolveInlineWorkRequest({text:normalizedTask('Fix login timeout'),capturedAt:'2029-01-01T00:00:00.000Z'});
  assert.equal(request.workType,'bugfix');
  assert.equal(selectBranchNaming(repository,request,'feature').pattern,'fix/{slug}');
});
