import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';

// Node's --test-timeout cancels callbacks but does not bound a file process with
// leaked handles. Each file here owns a process group and an external deadline.
const args = process.argv.slice(2);
const at = args.indexOf('--durations');
const durations = at >= 0 ? args.splice(at, 2)[1] : undefined;
const timeoutMs = Number(args.find(arg => arg.startsWith('--file-timeout=')).split('=')[1]);
const breadth = Number(args.find(arg => arg.startsWith('--test-concurrency='))?.split('=')[1] ?? availableParallelism());
const flags = args.filter(arg => arg.startsWith('-') && !/^--(?:file-timeout|test-concurrency)=/.test(arg));
const files = args.filter(arg => !arg.startsWith('-'));
if (durations) writeFileSync(durations, '');
const children = new Set();
const kill = child => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } };
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  for (const child of children) kill(child);
  process.exit(1);
});
let next = 0;
await Promise.all(Array.from({ length: Math.min(breadth, files.length) }, async () => {
  while (next < files.length) {
    const file = files[next++], started = Date.now();
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--test', '--test-reporter=spec', ...flags, file], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let output = '', timedOut = false;
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => { timedOut = true; kill(child); }, timeoutMs);
    const code = await new Promise(resolve => {
      child.on('error', error => { output += `${error.message}\n`; });
      child.on('close', resolve);
    });
    clearTimeout(timer);
    children.delete(child);
    const passed = code === 0 && !timedOut;
    process.stdout.write(output);
    if (!passed) {
      process.exitCode = 1;
      console.log(`not ok - ${file}\n  test at ${file}:1:1\n  ${timedOut ? `test file timed out after ${timeoutMs}ms` : 'test file failed'}`);
    }
    if (durations) appendFileSync(durations, JSON.stringify({ file, durationMs: Date.now() - started, passed }) + '\n');
  }
}));
