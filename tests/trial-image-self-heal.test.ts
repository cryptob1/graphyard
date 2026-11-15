import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyDaemonState, writeDaemonState } from '../src/daemon/state.js';
import { mergeWriterIdle, mergeWriterStep, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { mergeRecordKinds, type MergeRecordEvent, type MergeTrialRun } from '../src/merge-writer/executor.js';
import type { TrialRunHandle } from '../src/merge-writer/trial-run.js';
import { foldMergeLedger } from '../src/model-boundary/merge-ledger.js';
import { ensureTrialImage } from '../src/install/trial-image.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { masterConfigSchema } from '../src/master.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { DaemonState } from '../src/daemon/state.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3328: after a host move the trial image graphyard-trial:local did not exist, and every trial
// failed in its container. Now a host missing the image provisions it before a trial launches —
// pull the published image, else build it — once for every trial waiting on it. A provision that
// fails is the trial host's fault: no verdict, no rework, and one master status attention line.

const start = Date.parse('2030-09-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const base = sha('base');
const pass: MergeTrialRun = { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1000, logTail: '', files: ['tests/item.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } };

/** A docker stub first on PATH: the trial image exists once a build made it, pulls are denied, and builds fail while `fail` exists. */
async function dockerStub() {
  const directory = await temporaryDirectory('trial-image-docker');
  const log = join(directory, 'docker.log'), built = join(directory, 'built'), fail = join(directory, 'fail');
  writeFileSync(join(directory, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1 $2" in
  "image inspect") [ -e '${built}' ] && exit 0; echo "Error: No such image: $3" >&2; exit 1 ;;
  "image pull") sleep 0.3; echo "Error response from daemon: pull access denied for $3" >&2; exit 1 ;;
  "buildx inspect") exit 0 ;;
  "buildx build") sleep 0.3; if [ -e '${fail}' ]; then echo 'ERROR: failed to solve: no space left on device' >&2; exit 1; fi; touch '${built}'; exit 0 ;;
esac
exit 0
`, { mode: 0o755 });
  return { directory, fail, built, calls: () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [] };
}

/** Two submitted heads, the ledger they record, and the detached trial runs the merge writer launches. */
class World {
  launches: string[] = [];
  recorded: MergeRecordEvent[] = [];
  ledgerEvents: { kind: string; payload: unknown; work: string }[] = [];
  snapshot(): Work[] {
    const folded = foldMergeLedger(this.ledgerEvents as never);
    return [1, 2].map(n => {
      const candidate = { sha: sha(`head${n}`), baseSha: base, pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' };
      return {
        id: `w${n}`, key: `GY-${n}`, title: `Item ${n}`, type: 'feature', description: '', priority: 1, dependencies: [],
        criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }], policy: { checks: ['test'], review: true },
        revision: 1, policyRevision: 1, createdAt: iso(start + n * 1000), updatedAt: iso(start), stageEnteredAt: iso(start + n * 1000),
        ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: n }, candidate, reworkRequested: false,
        scenarioRequirements: [], evidence: [], blocker: null, violations: [], mergeLedger: folded[`GY-${n}`] ?? null, stage: 'build',
        observation: { source: 'control-plane', candidate, files: ['src/app.ts'], checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false, baseTip: base, baseTipContained: true, at: iso(start) },
        gates: ['ready', 'build', 'review'].map(name => ({ name, passed: true, reasons: [] })),
      } as unknown as Work;
    });
  }
  reads(root: string): MergeWriterReads {
    return {
      baseBranch: 'main', now: () => start, parallel: 2,
      fetch: async () => base,
      merge: async (head, tip) => ({ mergeSha: sha(`merge:${head}:${tip}`), files: ['src/item.ts'] }),
      trial: async () => { throw new Error('these reads launch detached trial runs only'); },
      push: async () => 'pushed',
      holds: async () => false,
      record: async (item, event) => {
        this.recorded.push(event);
        const { kind, ...fields } = event as typeof event & { kind: string };
        this.ledgerEvents.push({ kind: mergeRecordKinds[kind], payload: kind === 'intent' ? { key: item.key, ...fields } : kind === 'refused' ? { ...fields, kind: 'merge' } : fields, work: item.key });
      },
      // The production port: the trial image this release's trials run, provisioned when the host lacks it.
      ensureTrialImage: () => ensureTrialImage(root),
      launchTrialRun: spec => {
        this.launches.push(spec.key);
        return { directory: `/runs/${spec.key}`, mergeSha: spec.mergeSha, trial: async () => pass, detach: () => {}, cancel: () => {} } as TrialRunHandle;
      },
      stopTrialRun: () => {},
    };
  }
}

const config = (root: string) => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(root, 'coordinator.token'), cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
const cycle = (world: World, state: DaemonState, root: string) => mergeWriterStep({ state, effects: { mergeWriter: world.reads(root), persist: async () => {}, rework: async () => {} },
  now: () => start, snapshot: { work: world.snapshot(), now: iso(start) }, performed: [] } as unknown as Cycle);
const waitFor = async (what: () => boolean, ms = 10_000) => { for (let waited = 0; !what() && waited < ms; waited += 10) await new Promise(resolve => setTimeout(resolve, 10)); };

test('e2e:trial-image-self-heal — with the trial image absent, two trials started together provision it once (pull, then build) and both run; a failing build gives neither head a verdict nor a rework and raises one attention line naming the image and the docker error', { timeout: 120_000 }, async () => {
  const stub = await dockerStub(), root = await temporaryDirectory('trial-image-root');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const revision = sha('release');
  const saved = { PATH: process.env.PATH, GRAPHYARD_TRIAL_IMAGE: process.env.GRAPHYARD_TRIAL_IMAGE, GRAPHYARD_VERSION: process.env.GRAPHYARD_VERSION, GRAPHYARD_BUILD_REVISION: process.env.GRAPHYARD_BUILD_REVISION };
  // This release names a published trial image, which the stub's registry denies: the provision pulls, then builds.
  Object.assign(process.env, { PATH: `${stub.directory}:${process.env.PATH}`, GRAPHYARD_VERSION: `unreleased ${revision.slice(0, 12)}`, GRAPHYARD_BUILD_REVISION: revision });
  delete process.env.GRAPHYARD_TRIAL_IMAGE;
  try {
    // The image is absent: both heads' trials wait on one provision, then both run.
    const world = new World(), state = emptyDaemonState(config(root));
    await cycle(world, state, root);
    await waitFor(() => world.launches.length === 2);
    assert.deepEqual([...world.launches].sort(), ['GY-1', 'GY-2'], `both trials ran after the provision: ${stub.calls().join(' | ')}`);
    const calls = stub.calls();
    assert.equal(calls.filter(call => call.startsWith('image pull ')).length, 1, `one pull: ${calls.join(' | ')}`);
    assert.equal(calls.filter(call => call.startsWith('buildx build ')).length, 1, `one build once the pull failed: ${calls.join(' | ')}`);
    assert.ok(calls.findIndex(call => call.startsWith('image pull ')) < calls.findIndex(call => call.startsWith('buildx build ')), 'the pull is tried first');
    assert.ok(calls.find(call => call.startsWith('buildx build '))!.includes('--tag graphyard-trial:local'), 'the build makes the image trials run');
    await mergeWriterIdle(state);

    // The image is absent again and the build fails: a trial-host fault, no verdict and no rework on either head.
    rmSync(stub.built); writeFileSync(stub.fail, '');
    const broken = new World(), faulted = emptyDaemonState(config(root));
    await cycle(broken, faulted, root);
    await mergeWriterIdle(faulted);
    await cycle(broken, faulted, root);
    assert.deepEqual(broken.launches, [], 'no trial runs without its image');
    // The open intent is settled unpushed and the head queued again, as after any trial-host fault: never a refusal for its own failure.
    for (const event of broken.recorded.filter(event => event.kind === 'refused')) assert.match((event as { reason: string }).reason, /was never pushed: .* the head is queued again/);
    for (const event of broken.recorded.filter(event => event.kind === 'trial')) assert.equal((event as { outcome?: string }).outcome, 'host-failure', 'the trial records no verdict on the head');
    assert.deepEqual(faulted.mergeWriter.reworks, [], 'no rework is asked for');
    assert.deepEqual(faulted.mergeWriter.refusals, [], 'no refusal is kept');

    const credentials = await temporaryDirectory('trial-image-credentials');
    const savedConfig = { ...config(root), credentialFile: join(credentials, 'token') };
    await writeDaemonState(savedConfig, faulted);
    const report = await masterStatusReport(root, savedConfig, async () => ({ work: [], now: iso(Date.now()) }), async () => base);
    const lines = report.attention.filter(line => /graphyard-trial:local/.test(line.text));
    assert.equal(lines.length, 1, `one attention line: ${JSON.stringify(report.attention)}`);
    assert.match(lines[0]!.text, /failed to solve: no space left on device/, 'it names the docker error');
  } finally {
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});
