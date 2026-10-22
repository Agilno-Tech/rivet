// Only native test events cross the boundary; test stdout cannot forge evidence.
export default async function* reporter(source) {
  for await (const { type, data } of source) {
    if (type === 'test:pass' || type === 'test:fail') {
      yield `${JSON.stringify({ type: 'test', file: data.file, name: data.name,
        status: data.skip ? 'skipped' : data.todo ? 'todo' : type === 'test:pass' ? 'passed' : 'failed' })}\n`;
    } else if (type === 'test:summary') {
      yield `${JSON.stringify({ type: 'summary', file: data.file ?? null, success: data.success,
        counts: data.counts, durationMs: data.duration_ms })}\n`;
    }
  }
}
