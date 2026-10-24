import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mergeWriterIdle, mergeWriterReads, mergeWriterStep } from '../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import type { ChildRun } from '../src/child-runner.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import type { Observation, Work } from '../src/model/work.js';

// GY-2940: the merge writer's deploy-key push failed on every cycle of a fresh install whose
// origin was still https, and the loop logged only `Command failed: git … push …` with no stderr,
// so the cause was invisible. The push now rethrows with git's stderr (first 300 chars) in the
// message, so the recorded failure text and the loop's log line name it.

const start = Date.parse('2030-06-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const base = sha('base'), head = sha('head'), tree = sha('tree');
const ROOT = '/repo/checkout';
const STDERR = "fatal: could not read Username for 'https://github.com': Terminal prompts disabled";

const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy' } } });

const item = (): Work => ({
  id: 'w1', key: 'GY-1', title: 'GY-1', type: 'feature', description: '', priority: 1, dependencies: [],
  criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }],
  policy: { checks: ['test'], review: true }, stage: 'build', revision: 1, policyRevision: 1, ready: true, epoch: 1, lease: null,
  workspaces: [], submission: { epoch: 1, pr: 7 },
  candidate: { sha: head, baseSha: base, pr: 7, branch: 'graphyard/gy-1-1', author: 'worker' }, reworkRequested: false, scenarioRequirements: [], evidence: [],
  observation: { source: 'control-plane', candidate: { sha: head, baseSha: base, pr: 7, branch: 'graphyard/gy-1-1', author: 'worker' }, checks: [], reviews: [], merged: false, mergeSha: null,
    mergeable: true, protected: true, files: ['src/app.ts'], at: iso(start), baseTip: base } as unknown as Observation,
  blocker: null, gates: ['build', 'review'].map(name => ({ name, passed: true, reasons: [] })), violations: [],
  createdAt: iso(start), updatedAt: iso(start), stageEnteredAt: iso(start - 60_000),
} as unknown as Work);

/** The substituted git host: every read answers from its kind, and the deploy-key push fails exactly as an https origin does. */
function substitutedGit(): ChildRun {
  return async (command, args) => {
    assert.equal(command, 'git');
    const argv = args.slice(args[0] === '-C' ? 2 : 0);
    const [head0] = argv;
    if (head0 === 'push') throw Object.assign(new Error(`Command failed: git -C ${ROOT} ${argv.join(' ')}`), { status: 128, stdout: '', stderr: `${STDERR}\n` });
    if (head0 === 'fetch') return '';
    if (head0 === 'rev-parse' && argv.at(-1) === 'refs/remotes/origin/main^{commit}') return `${base}\n`;
    if (head0 === 'rev-parse' && argv.at(-1) === `${head}^1`) return `${base}\n`;
    if (head0 === 'rev-parse' && argv.at(-1) === `${head}^{tree}`) return `${tree}\n`;
    if (head0 === 'rev-list') return `${head}\n`;
    if (head0 === 'update-ref') return '';
    if (head0 === 'diff') return 'src/app.ts\n';
    throw new Error(`substituted git has no answer for: ${argv.join(' ')}`);
  };
}

/** The merge writer's real reads over the substituted git, with the trial replaced by a passing verdict. */
function reads(recorded: { key: string; event: any }[]) {
  return mergeWriterReads(config, ROOT, substitutedGit(), {
    base: 'main',
    record: async (target, event) => { recorded.push({ key: target.key, event }); return {}; },
    merger: async () => 'control-plane',
    trial: async (mergeSha): Promise<MergeTrialRun> => ({ build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: ['src/app.ts'], proofs: {} }),
  });
}

test('unit:merge-push-failure-carries-stderr — the push step rethrows git\'s stderr and the loop\'s failure record and log line carry it', async () => {
  const recorded: { key: string; event: any }[] = [], performed: any[] = [];
  const readsPorts = reads(recorded);
  // The push itself: the failure text the flight records names git's cause, not just `Command failed`.
  await assert.rejects(readsPorts.push(head, base), error => (error as Error).message.includes('fatal: could not read Username'));
  // Through the step: the flight fails on the push, and the next cycle records and logs the failure with the stderr in it.
  const state = emptyDaemonState(config);
  const work = [item()];
  const effects = { mergeWriter: readsPorts, persist: async () => {}, rework: async () => {} };
  let clock = start;
  const step = async () => {
    clock += 1000;
    await mergeWriterStep({ state, effects, now: () => clock, snapshot: { work }, performed } as unknown as Cycle);
  };
  await step(); await mergeWriterIdle(state);
  await step();
  const detail = state.actions[`merge-writer:GY-1:${head}`]?.detail ?? '';
  assert.match(detail, /Merge of GY-1 head .* failed before it was recorded, so the head stays queued and is tried again/);
  assert.ok(detail.includes('fatal: could not read Username'), `the recorded failure names the cause: ${detail}`);
  assert.ok(detail.includes(STDERR), 'the whole stderr line survives in the record');
  // The log line the loop prints is this action's detail, prefixed exactly as run.ts prints it.
  const logLine = `[graphyard-master] cycle ${state.cycle} merge failed: ${detail}`;
  assert.ok(logLine.includes('fatal: could not read Username'), 'the loop\'s log line names the cause');
  // Nothing was recorded pushed: the head stays queued, and the attempt's records stop at the trial.
  assert.deepEqual(recorded.map(entry => entry.event.kind), ['intent', 'trial']);
});
