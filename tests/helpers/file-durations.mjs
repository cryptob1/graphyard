import { relative, resolve } from 'node:path';

// A node:test reporter (GY-499): one JSON line per test file with the wall time of its process,
// `{ "file": "tests/x.test.ts", "durationMs": 1234, "passed": true }`. The runner adds it for
// `--durations FILE`; the merge writer's trial reads the lines for which files passed.
export default async function* fileDurations(source) {
  // Every test:fail event in a file marks that file failed (GY-1887): a file whose own test failed
  // can still complete with details.passed true (run 39014555162 recorded a failing file as passing
  // beside its own log), so the status is derived from every failing test in the file, not only the
  // file-level completion. A load failure fails the file-level test itself, which is a test:fail too.
  const failed = new Set();
  for await (const event of source) {
    if (event.type === 'test:fail' && event.data?.file) failed.add(resolve(event.data.file));
    // The file-level completion is the one whose name is the file itself, at the top level.
    if (event.type !== 'test:complete' || event.data.nesting !== 0 || !event.data.file || resolve(event.data.name) !== event.data.file) continue;
    yield `${JSON.stringify({ file: relative(process.cwd(), event.data.file).split('\\').join('/'), durationMs: Math.round(event.data.details.duration_ms), passed: event.data.details.passed !== false && !failed.has(resolve(event.data.file)) })}\n`;
  }
}
