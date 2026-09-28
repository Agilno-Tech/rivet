import { createInterface } from 'node:readline/promises';

// Plan review has no reading deadline. EOF, stream errors and cancellation all
// decline; callers still revalidate the approved state before any mutation.
export async function confirmTaskAction(message, {input = process.stdin, output = process.stdout, signal} = {}) {
  if (signal?.aborted) return false;
  const readline = createInterface({input, output});
  let decline;
  const ended = new Promise(resolve => { decline = () => resolve(''); });
  const abort = () => { decline(); readline.close(); };
  readline.once('close', decline);
  readline.on('error', decline);
  input.once('error', decline);
  output.once('error', decline);
  signal?.addEventListener('abort', abort, {once:true});
  try {
    const answer = await Promise.race([readline.question(message), ended]);
    return !signal?.aborted && /^(?:y|yes)$/i.test(String(answer).trim());
  } catch { return false; }
  finally {
    signal?.removeEventListener('abort', abort);
    input.removeListener('error', decline);
    output.removeListener('error', decline);
    readline.close();
  }
}
