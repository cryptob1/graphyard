// Real loop and detached-run processes; only the trial's commands are fixture stubs.
import { spawn } from 'node:child_process';
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultChildRun } from '../../src/child-runner.js';
import { mergeWriterStep } from '../../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState } from '../../src/daemon/state.js';
import { adoptTrialRun, stopTrialRun, launchTrialRun, trialRunFiles, trialRunsDirectory, type TrialRunSpec } from '../../src/merge-writer/trial-run.js';
import { exitWhenStopped } from '../../src/master/loop-restart.js';
import { loopReads, storeSnapshot } from './pipeline-world.js';

if (process.argv[2] === 'trial') {
  const directory = process.argv[3]!, files = trialRunFiles(directory);
  const spec: TrialRunSpec = JSON.parse(await readFile(files.spec, 'utf8'));
  for (const step of ['install', 'build', 'tests']) {
    await appendFile(files.steps, JSON.stringify({ step, at: new Date().toISOString() }) + '\n');
    await defaultChildRun(process.execPath, ['--input-type=module', '-e',
      `import { appendFileSync } from 'node:fs'; appendFileSync(process.argv[1], JSON.stringify({step: process.argv[2], at: Date.now(), pid: process.pid})+'\\n'); if(process.argv[2]==='tests') await new Promise(r=>setTimeout(r,25000));`,
      join(spec.base, 'commands.jsonl'), step]);
  }
  await writeFile(files.result + '.tmp', JSON.stringify({ ok: true, run: {
    build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 25000, logTail: '', files: ['proof.cjs'],
    proofs: { 'unit:declared': { executed: 1, failed: 0 }, 'e2e:fixture': { executed: 1, failed: 0 } },
    e2e: [{ proof: 'e2e:fixture', case: 'fixture', executed: 1, failed: 0 }],
  } }));
  await rename(files.result + '.tmp', files.result);
} else {
  const where = JSON.parse(process.argv[2]!);
  const { snapshot } = storeSnapshot(where.database);
  let state = emptyDaemonState(where.config);
  try { state = JSON.parse(await readFile(where.cursor, 'utf8')); } catch {}
  const reads = loopReads({ ...where, snapshot }, { gate: false });
  reads.adoptTrialRun = adoptTrialRun;
  reads.stopTrialRun = stopTrialRun;
  reads.launchTrialRun = request => launchTrialRun({
    runsRoot: trialRunsDirectory(where.checkout),
    spec: { version: 1, ...request, root: where.checkout, base: where.trials, hidden: [], startedAt: new Date().toISOString() },
    // Keep the production detached launcher, session, watchdog and run files. Substitute only
    // trial-main's command with the three slow-command stubs above.
    spawn: ((file: string, args: string[], options: object) => {
      const index = args.findIndex(arg => arg.endsWith('/trial-main.ts'));
      const replaced = [...args]; replaced.splice(index, 1, fileURLToPath(import.meta.url), 'trial');
      return spawn(file, replaced, options);
    }) as typeof spawn,
  });
  let writing = Promise.resolve();
  const persist = () => {
    const text = JSON.stringify(state);
    writing = writing.then(async () => {
      await writeFile(where.cursor + '.tmp', text);
      await rename(where.cursor + '.tmp', where.cursor);
    });
    return writing;
  };
  // The unit sends SIGTERM; master run exits after flushing its state, leaving detached runs.
  const stopping = exitWhenStopped(process, { graceMs: 10, boundMs: 1000 });
  let stopped = false;
  process.once('SIGTERM', () => { stopped = true; void writing.then(() => stopping.stopped()); });
  while (!stopped) {
    await mergeWriterStep({ state, effects: { mergeWriter: reads, persist, rework: async () => {} },
      now: Date.now, snapshot: { work: await snapshot(), now: new Date().toISOString() }, performed: [] } as never);
    await persist();
    await delay(100);
  }
}
