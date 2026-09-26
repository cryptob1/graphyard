import { relative, resolve } from 'node:path';

// A node:test reporter (GY-499): one JSON line per test file with the wall time of its process,
// `{ "file": "tests/x.test.ts", "durationMs": 1234, "passed": true }`. The runner adds it for
// `--durations FILE`; `node scripts/ci-tests.mjs durations FILE...` merges the lines into
// tests/helpers/timing-baseline.json, which is what CI balances its shards by.
export default async function* fileDurations(source) {
  for await (const event of source) {
    // The file-level completion is the one whose name is the file itself, at the top level.
    if (event.type !== 'test:complete' || event.data.nesting !== 0 || !event.data.file || resolve(event.data.name) !== event.data.file) continue;
    yield `${JSON.stringify({ file: relative(process.cwd(), event.data.file).split('\\').join('/'), durationMs: Math.round(event.data.details.duration_ms), passed: event.data.details.passed !== false })}\n`;
  }
}
