import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import fileDurations from './file-durations.mjs';

// Runs test files in exactly the order given (GY-499). `node --test FILE...` sorts its files by
// path, so a shard's longest file could start last and set the shard's wall time on its own;
// `run({ files })` starts them in the order passed, which for a shard is longest first.
//
//   node --import tsx tests/helpers/ordered-tests.mjs [--durations FILE] FILE...
//
// Output matches the CLI's spec reporter; --durations adds tests/helpers/file-durations.mjs.
// The test children inherit this process's --import, as `node --test` children do.

const args = process.argv.slice(2);
const at = args.indexOf('--durations');
const durations = at >= 0 ? args.splice(at, 2)[1] : undefined;
if (at >= 0 && !durations) throw new Error('--durations needs a value');

const toSpec = new PassThrough({ objectMode: true }), toDurations = new PassThrough({ objectMode: true });
toSpec.compose(spec).pipe(process.stdout);
if (durations) toDurations.compose(fileDurations).pipe(createWriteStream(resolve(durations)));
const stream = run({ files: args.map(file => resolve(file)), concurrency: true });
stream.on('data', event => {
  if (event.type === 'test:fail') process.exitCode = 1;
  toSpec.write(event);
  if (durations) toDurations.write(event);
});
stream.on('end', () => { toSpec.end(); toDurations.end(); });
