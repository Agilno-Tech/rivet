import { createInterface } from 'node:readline/promises';

// Plan review has no reading deadline. EOF, stream errors and cancellation all
// decline; callers still revalidate the approved state before any mutation.
export async function readTaskAnswer(message, {input = process.stdin, output = process.stdout, signal} = {}) {
  if (signal?.aborted) return '';
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
    return signal?.aborted ? '' : String(answer).trim();
  } catch { return ''; }
  finally {
    signal?.removeEventListener('abort', abort);
    input.removeListener('error', decline);
    output.removeListener('error', decline);
    readline.close();
  }
}

export async function confirmTaskAction(message, options) {
  return /^(?:y|yes)$/i.test(await readTaskAnswer(message, options));
}

export async function selectTaskOption(question, streams = {}) {
  const prompt = `${question.message}\n${question.choices.map((choice,index)=>`  ${index+1}. ${choice.label}`).join('\n')}\nNumber (blank to leave): `;
  const answer = await readTaskAnswer(prompt, {...streams,signal:question.signal});
  if (!/^[1-9][0-9]*$/.test(answer)) return null;
  const index = Number(answer)-1;
  return Number.isSafeInteger(index) && index < question.choices.length ? question.choices[index].value : null;
}
