// GY-3290's fixture launcher (tests/host-heavy-budget.test.ts): one process standing in for an
// install's loop or deploy watch. It joins the host heavy-job budget as its project and runs one
// job through the entry point named, whose heavy part is replaced by a body that records when it ran.
//
//   node --import tsx tests/helpers/heavy-job-launcher.ts MODE ID REPOSITORY_ROOT SCRATCH
import { appendFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { heavyTrial, mergeWriterReads } from '../../src/daemon/cycle-merge-writer.js';
import { joinHostHeavyBudget, sharedHeavyJob, withHeavyJob } from '../../src/master/verification-slots.js';
import { pinKnownGood } from '../../src/master/known-good.js';
import { openPreview } from '../../src/merge-writer/preview.js';
import { gateTrialKey } from '../../src/merge-writer/trial-load.js';
import { runWorkerCheck } from '../../src/merge-writer/worker-check.js';
import { defaultChildRun } from '../../src/child-runner.js';

const [mode, id, root, scratch] = process.argv.slice(2) as [string, string, string, string];
const project = process.env.FIXTURE_PROJECT!, log = process.env.RUN_LOG!;
const body = async () => {
  appendFileSync(log, `start ${id}\n`);
  // A held job runs until its gate file appears; every other job runs until the test says go, and a moment more.
  if (mode === 'hold') while (!existsSync(join(scratch, `gate-${id}`))) await new Promise(done => setTimeout(done, 20));
  else { while (!existsSync(process.env.RUN_GO!)) await new Promise(done => setTimeout(done, 20)); await new Promise(done => setTimeout(done, 200)); }
  appendFileSync(log, `end ${id}\n`);
};
const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const trial = async () => { await body(); return { build: 'pass', tests: { passed: 0, failed: [], files: 0 }, logTail: '' } as any; };

joinHostHeavyBudget(project);
if (mode === 'trial' || mode === 'gate') {
  // The loop's own trial port: a merge's trial, and the batch gate's (its own item key).
  const reads = mergeWriterReads({ baseBranch: 'main', run: {}, repository: project } as any, root, defaultChildRun, { base: scratch, record: async () => {}, trial });
  const check = () => reads.trial(head, [], { key: mode === 'gate' ? gateTrialKey : id, criteria: [] }, undefined, step => console.error(`step: ${step}`));
  // The batch gate wraps its trial port in the reserved heavy job, including for other repositories.
  if (mode === 'gate') await heavyTrial(gateTrialKey, step => console.error(`step: ${step}`), undefined, check, undefined, true);
  else await check();
} else if (mode === 'check') {
  // The fake check runs wholly on this machine, so it holds the worker verification's local slot as a real one's local shards do (GY-3526).
  await runWorkerCheck({ root, base: scratch, baseBranch: 'main', key: id, head, check: 'test', trial: input => sharedHeavyJob(input.localSlot!, { strictOnly: true })(trial) });
} else if (mode === 'preview') {
  const opened = await openPreview({ root, base: scratch, mergeSha: head, timeoutMs: 120_000, application: { id: 'site', kind: 'static', directory: 'site', build: 'true' },
    shell: async () => { await body(); return { ok: true, output: '' }; } }, { keep: false, cases: ['home'] });
  await opened.close();
  if (opened.verdict.result !== 'pass') throw new Error(`the preview did not pass: ${opened.verdict.detail}`);
} else if (mode === 'deploy') {
  // The deploy's build of a pinned commit: its `npm ci` is the recorded body, everything else answers at once.
  await pinKnownGood({ installDir: join(scratch, `install-${id}`), repository: root }, head, async (command, args) => { if (command === 'npm' && args[0] === 'ci') await body(); return ''; });
} else if (mode === 'hold') {
  await withHeavyJob(`held job ${id}`, body);
} else throw new Error(`unknown mode ${mode}`);
