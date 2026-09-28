import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import test from 'node:test';
import {confirmTaskAction} from '../../src/cli/task-confirmation.js';

for (const stop of ['eof','input-error','output-error','abort']) {
  test(`task approval declines on ${stop} instead of hanging`,async()=>{
    const input=new PassThrough(),output=new PassThrough(),controller=new AbortController();
    const answer=confirmTaskAction('Approve? ',{input,output,signal:controller.signal});
    if(stop==='eof')input.end();
    if(stop==='input-error')input.emit('error',new Error('closed'));
    if(stop==='output-error')output.emit('error',new Error('closed'));
    if(stop==='abort')controller.abort();
    assert.equal(await answer,false);input.destroy();output.destroy();
  });
}

test('review can take longer than thirty seconds and still requires explicit approval',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const input=new PassThrough(),output=new PassThrough();let settled=false;
  const answer=confirmTaskAction('Approve? ',{input,output}).then(value=>{settled=true;return value;});
  t.mock.timers.tick(60000);await Promise.resolve();assert.equal(settled,false);
  input.write('yes\n');assert.equal(await answer,true);input.destroy();output.destroy();
});
