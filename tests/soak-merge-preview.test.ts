import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { daemonStateSchema, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { mergeWriterIdle, mergeWriterKeptQueue, mergeWriterKeptRefusals, mergeWriterKeptReworks, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { mergeRecordKey, type MergeRecordEvent } from '../src/merge-writer/executor.js';
import { mergeRecordBodySchema, mergeRecordFingerprint } from '../src/server/merge-record.js';
import { previewConcurrency, previewSlots, runPreview, type PreviewSite, type PreviewVerdict } from '../src/merge-writer/preview.js';
import { trialFailurePrefix } from '../src/model/rework-ground.js';
import type { MergeLedgerState } from '../src/model/merge-ledger.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';
import type { ChildRun } from '../src/child-runner.js';
import type { StaticBuildShell } from '../src/release-project.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1718: the merge preview over a simulated day of the real loop's cycles. Every passing trial of
 * a source change is previewed with the real `runPreview` — a checkout of the merge commit, the
 * site built, served on loopback and its required and uat cases run over HTTP — while the script
 * injects the preview's three outcomes and the tip moving under a push: some heads serve a broken
 * score (a failing required case: refused, reworked once, resubmitted), some builds hang past the
 * budget (cancelled, the head queued and previewed again), some required cases run a command that
 * hangs past the budget (its process group killed, the head previewed again), some pushes are rejected on a moved tip
 * (re-trialled and previewed again on the new tip), and some merges change only docs (never
 * previewed). Every item must be delivered exactly once, no preview checkout, slot or late build
 * may outlive its preview, and the writer's state stays bounded.
 */
const minute = 60_000;
const start = Date.parse('2030-06-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy', retrials: 3 } } });
const githubDouble = new Proxy({}, { get: (_, name) => { throw new Error(`the merge writer step called GitHub (${String(name)})`); } });
const site: PreviewSite = { directory: 'dist', build: 'build the site' };

/** The day's script, by item ordinal. */
const items = 60, submitEveryMs = 15 * minute, cycleMs = 2 * minute, cycles = (24 * 60) / 2;
const docsOnly = (n: number) => n % 9 === 0;
const breaksScore = (n: number) => n % 7 === 0 && !docsOnly(n);
const hangsBuild = (n: number) => n % 5 === 0 && !docsOnly(n) && !breaksScore(n);
const tipMoves = (n: number) => n % 11 === 0 && !docsOnly(n);
const hangsCommand = (n: number) => n % 13 === 0 && !docsOnly(n) && !breaksScore(n) && !hangsBuild(n) && !tipMoves(n);
/** What a hanging command step's process line names, so the soak can look for it after its preview. */
const hangingCommand = (marks: string, n: number) => `sleep 30 && touch ${join(marks, `survived-${n}`)}`;

const made: string[] = [];
after(async () => { for (const directory of made) await rm(directory, { recursive: true, force: true }); });

class World {
  main = [sha('base')];
  pushes: string[] = [];
  recorded = new Map<number, MergeRecordEvent[]>();
  reworked = new Map<number, { confirmedAt: number }>();
  decided: number[] = [];
  submissions = new Map<number, { head: string; submittedAt: number }>();
  merges = new Map<string, { n: number; head: string }>();
  previews: { n: number; verdict: PreviewVerdict }[] = [];
  hung = new Map<number, number>(); moved = new Set<number>(); commandHung = new Set<number>();
  trials = 0; activeBuilds = 0; lateBuilds = 0;
  receipts = new Map<string, string>();
  slots = previewSlots();
  constructor(readonly now: () => number, readonly root: string, readonly base: string, readonly marks: string) {}
  tip() { return this.main[0]!; }
  submit(n: number, attempt: number, at: number) { this.submissions.set(n, { head: sha(`head${n}-${attempt}`), submittedAt: at }); }
  firstHead(n: number) { return this.submissions.get(n)!.head === sha(`head${n}-1`); }
  snapshot(): Work[] {
    const now = this.now();
    return [...this.submissions.entries()].filter(([, entry]) => entry.submittedAt <= now).map(([n, entry]) => {
      let ledger = null as MergeLedgerState | null;
      for (const event of this.recorded.get(n) ?? []) {
        if (event.kind === 'intent') ledger = { key: `GY-${n}`, state: 'intent', head: event.head, baseTip: event.baseTip, mergeSha: event.mergeSha, risk: event.risk, intentAt: event.at, pushedAt: null, observedTip: null, refusal: null, events: (ledger?.events ?? 0) + 1 };
        else if (event.kind === 'pushed' && ledger) ledger = { ...ledger, state: 'pushed', pushedAt: event.pushedAt, events: ledger.events + 1 };
        else if (event.kind === 'reconciled' && ledger) ledger = { ...ledger, state: 'reconciled', observedTip: event.observedTip, events: ledger.events + 1 };
        else if (event.kind === 'refused') ledger = { key: `GY-${n}`, head: event.head, baseTip: null, mergeSha: null, risk: null, intentAt: null, pushedAt: null, observedTip: null, ...ledger, events: (ledger?.events ?? 0) + 1, state: 'refused', refusal: { kind: 'merge', reason: event.reason } };
      }
      const delivered = ledger?.state === 'reconciled' && ledger.head === entry.head;
      const candidate = { sha: entry.head, baseSha: sha('base'), pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' };
      return {
        id: `w${n}`, key: `GY-${n}`, description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }],
        policy: { checks: ['test'], review: true }, revision: 1, policyRevision: 1, createdAt: iso(start), updatedAt: iso(start), stageEnteredAt: iso(entry.submittedAt),
        ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: n }, candidate,
        reworkRequested: this.reworked.has(n) && entry.head === sha(`head${n}-1`), scenarioRequirements: [], evidence: [], blocker: null, violations: [], mergeLedger: ledger,
        observation: { source: 'control-plane', candidate, files: this.files(n), checks: [], reviews: [], merged: delivered, mergeSha: delivered ? ledger!.mergeSha : null, mergeable: true, protected: false, baseTip: this.tip(), baseTipContained: true, at: iso(now) },
        gates: ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: name !== 'test' && name !== 'merge', reasons: [] })),
        ...(delivered ? { stage: 'done', delivery: { mergedAt: ledger!.pushedAt ?? iso(now), mergeSha: ledger!.mergeSha!, authorizationRevision: 1 } } : { stage: 'build' }),
      } as unknown as Work;
    });
  }
  files(n: number) { return docsOnly(n) ? ['docs/play.md'] : ['src/game.ts']; }
  /** git, as the preview drives it: `worktree add` writes the merge's site and cases into the checkout; removal is the preview's own `rm`. */
  run: ChildRun = async (_command, args) => {
    if (args.includes('add')) {
      const checkout = args.at(-2)!, merge = this.merges.get(args.at(-1)!)!;
      const broken = breaksScore(merge.n) && merge.head === sha(`head${merge.n}-1`);
      const write = async (path: string, content: unknown) => { await mkdir(join(checkout, path, '..'), { recursive: true }); await writeFile(join(checkout, path), JSON.stringify(content)); };
      await write('site/scores.json', { best: broken ? 'none' : merge.n });
      await write('site/index.html', 'play');
      await write('e2e/cases/scores.json', { id: 'scores', title: 'A player sees the best score', tags: ['api'], target: 'any', required: true, steps: [{ kind: 'http', name: 'read', method: 'GET', path: '/scores.json', status: 200, expect: [{ path: 'best', type: 'number' }] }] });
      // A hanging command step, run first, in the first preview of such an item only.
      if (hangsCommand(merge.n) && !this.commandHung.has(merge.n)) {
        this.commandHung.add(merge.n);
        await write('e2e/cases/a-hang.json', { id: 'a-hang', title: 'A command that never ends', tags: ['api'], target: 'uat', required: true,
          steps: [{ kind: 'command', run: `touch ${join(this.marks, `started-${merge.n}`)} && ${hangingCommand(this.marks, merge.n)}`, timeoutSeconds: 600 }] });
      }
      await write('e2e/cases/home.json', { id: 'home', title: 'The home page answers', tags: ['api'], target: 'uat', required: false, steps: [{ kind: 'http', name: 'home', method: 'GET', path: '/', status: 200, expect: [] }] });
    }
    return '';
  };
  /** The build: a hanging one waits for its cancellation, then winds down a moment later, still in its checkout. */
  shell: StaticBuildShell = async (_command, cwd, signal) => {
    this.activeBuilds += 1;
    try {
      const merge = this.building!;
      if (hangsBuild(merge.n) && (this.hung.get(merge.n) ?? 0) < 2) {
        this.hung.set(merge.n, (this.hung.get(merge.n) ?? 0) + 1);
        await new Promise<void>(accept => signal!.addEventListener('abort', () => accept(), { once: true }));
        await new Promise(accept => setTimeout(accept, 20));
        this.lateBuilds += 1;
        assert.equal(this.slots.running, 1, 'a cancelled build still holds its slot');
        assert.ok((await readdir(cwd)).includes('site'), 'a cancelled build\'s checkout is not removed under it');
        return { ok: false, output: 'killed' };
      }
      await mkdir(join(cwd, 'dist'), { recursive: true });
      for (const name of await readdir(join(cwd, 'site'))) await writeFile(join(cwd, 'dist', name), await readFile(join(cwd, 'site', name)));
      return { ok: true, output: '' };
    } finally { this.activeBuilds -= 1; }
  };
  building: { n: number; head: string } | null = null;
  ports(): MergeWriterReads {
    const world = this;
    return {
      baseBranch: 'main', retrials: 3, now: this.now, merger: async () => 'control-plane',
      fetch: async () => world.tip(),
      merge: async (head, baseTip) => {
        // commit-tree stamps the time, so a head merged again on the same tip (a timed-out preview's retry) is a fresh merge commit.
        const mergeSha = sha(`merge:${head}:${baseTip}:${world.trials}`), n = [...world.submissions.entries()].find(([, entry]) => entry.head === head)![0];
        world.merges.set(mergeSha, { n, head });
        return { mergeSha, files: world.files(n) };
      },
      trial: async (mergeSha, _files, item) => {
        world.trials += 1;
        const n = Number(item.key.slice(3));
        // A foreign commit lands on main during the first trial of a moving item: the push below is rejected and the merge is re-trialled.
        if (tipMoves(n) && !world.moved.has(n)) { world.moved.add(n); world.main.unshift(sha(`foreign:${n}`)); }
        return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1000, logTail: mergeSha, files: ['tests/item.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } };
      },
      // The loop's own port (cycle-merge-writer.ts), over the real preview with the world's git, build and slot pool.
      preview: async (mergeSha, files, item) => {
        if (files.every(path => path.startsWith('docs/'))) return null;
        world.building = world.merges.get(mergeSha)!;
        const verdict = await runPreview({ root: world.root, base: world.base, mergeSha, site, timeoutMs: 400, stepTimeoutMs: 5_000, run: world.run, shell: world.shell, slots: world.slots });
        world.building = null;
        world.previews.push({ n: Number(item.key.slice(3)), verdict });
        return verdict;
      },
      push: async (mergeSha, baseTip) => {
        if (baseTip !== world.tip()) return 'rejected';
        world.main.unshift(mergeSha); world.pushes.push(mergeSha);
        return 'pushed';
      },
      holds: async sha => world.main.includes(sha),
      // The coordinator's receipt rule (server/merge-record.ts): a key replays its own input and refuses any other.
      record: async (item, event) => {
        const key = mergeRecordKey(item, event), fingerprint = mergeRecordFingerprint(item.id, mergeRecordBodySchema.parse(event)), receipt = world.receipts.get(key);
        if (receipt !== undefined) { assert.equal(receipt, fingerprint, `Idempotency key reused with different input: ${key}`); return; }
        world.receipts.set(key, fingerprint);
        const n = Number(item.key.slice(3)); world.recorded.set(n, [...(world.recorded.get(n) ?? []), event]);
      },
    };
  }
  rework = async (work: Work) => {
    const n = Number(work.key.slice(3));
    this.decided.push(n); this.reworked.set(n, { confirmedAt: this.now() });
  };
}

test('unit:soak-merge-preview — a simulated day on the real loop with the real preview: passing previews land, failing required cases are refused and reworked once, timed-out previews are cancelled and retried, moved tips are re-trialled and previewed again, docs-only merges skip it, every item lands exactly once, and no preview checkout, slot or late build outlives its preview while the state stays bounded', { timeout: 300_000 }, async () => {
  const root = await realpath(await temporaryDirectory('soak-merge-preview')); made.push(root);
  const base = join(root, 'worktrees'), marks = join(root, 'marks'); await mkdir(base); await mkdir(marks);
  let now = start;
  const world = new World(() => now, root, base, marks);
  const running = (n: number) => { try { return execFileSync('pgrep', ['-f', hangingCommand(marks, n)], { encoding: 'utf8' }).trim(); } catch { return ''; } };
  for (let n = 1; n <= items; n++) world.submit(n, 1, start + n * submitEveryMs);
  const effects = { agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: world.snapshot(), now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {},
    decisions: async () => ({ decisions: [] }), persist: async () => {},
    github: githubDouble, merge: githubDouble, mergeWriter: world.ports(), rework: world.rework } as unknown as DaemonEffects;
  const state = emptyDaemonState(config);
  for (let cycle = 0; cycle < cycles; cycle++) {
    now = start + cycle * cycleMs;
    for (const [n, { confirmedAt }] of world.reworked) if (world.firstHead(n) && now >= confirmedAt + 30 * minute) world.submit(n, 2, now);
    const result = await runCycle(config, state, effects, () => now);
    for (const action of result.actions) assert.ok(!(action.kind === 'merge' && action.state === 'failed' && /failed before it was recorded/.test(action.detail)), `cycle ${cycle}: ${action.detail}`);
    await mergeWriterIdle(state);
    // Bounded activity: no preview's work, slot or checkout survives the cycle that ran it.
    assert.equal(world.slots.running, 0, `cycle ${cycle}: every preview slot is freed`);
    assert.equal(world.activeBuilds, 0, `cycle ${cycle}: no build outlives its preview`);
    assert.deepEqual(await readdir(base), [], `cycle ${cycle}: every preview checkout and its owner marker removed`);
    for (const n of world.commandHung) assert.equal(running(n), '', `cycle ${cycle}: GY-${n}'s hanging command step outlived its preview`);
    assert.ok(state.mergeWriter.queue.length <= mergeWriterKeptQueue && state.mergeWriter.refusals.length <= mergeWriterKeptRefusals && state.mergeWriter.reworks.length <= mergeWriterKeptReworks, `cycle ${cycle}: the state is bounded`);
  }
  const final = world.snapshot();
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => item.key), [], 'every item is delivered by the end of the day');
  const delivered = final.map(item => item.delivery!.mergeSha);
  assert.equal(new Set(world.pushes).size, world.pushes.length, 'no merge commit was pushed twice');
  assert.deepEqual([...delivered].sort(), [...world.pushes].sort(), 'exactly what was pushed was delivered');
  const all = Array.from({ length: items }, (_, index) => index + 1);
  const ofItem = (n: number) => world.previews.filter(entry => entry.n === n).map(entry => entry.verdict.result);
  // Docs-only merges are never previewed; every other landed merge was previewed and passed on the commit it landed.
  for (const n of all.filter(docsOnly)) assert.deepEqual(ofItem(n), [], `GY-${n} changes only docs`);
  for (const item of final.filter(item => !docsOnly(Number(item.key.slice(3))))) assert.ok(world.previews.some(entry => entry.verdict.mergeSha === item.delivery!.mergeSha && entry.verdict.result === 'pass'), `${item.key} landed on a passing preview of its merge commit`);
  // Failures: refused under the trial-failure ground naming the case, reworked exactly once, landed on the new head.
  const breaking = all.filter(breaksScore);
  assert.deepEqual([...world.decided].sort((a, b) => a - b), breaking, 'each failing preview grounded exactly one rework');
  for (const n of breaking) {
    const reasons = (world.recorded.get(n) ?? []).filter(event => event.kind === 'refused').map(event => (event as { reason: string }).reason);
    assert.ok(reasons.some(reason => reason.startsWith(`${trialFailurePrefix}: E2E case scores failed on the preview`)), `GY-${n}: ${reasons.join(' | ')}`);
    assert.equal(world.firstHead(n), false, `GY-${n} came back on a new head`);
  }
  // Timeouts: each hanging build was cancelled and wound down inside its slot, the head queued and previewed again until it passed, with no rework.
  const hanging = all.filter(hangsBuild);
  for (const n of hanging) assert.deepEqual(ofItem(n), ['timeout', 'timeout', 'pass'], `GY-${n}`);
  assert.equal(world.lateBuilds, hanging.length * 2, 'every timed-out build was cancelled and ended before its slot was freed');
  assert.ok(hanging.every(n => !world.decided.includes(n)), 'a timeout grounds no rework');
  // Command steps: the in-flight process was started, killed with its group at the budget, and the head previewed again.
  const commands = all.filter(hangsCommand);
  assert.ok(commands.length >= 2);
  for (const n of commands) {
    assert.deepEqual(ofItem(n), ['timeout', 'pass'], `GY-${n}`);
    assert.ok(existsSync(join(marks, `started-${n}`)), `GY-${n}'s command step was in flight when the budget ran out`);
    assert.equal(existsSync(join(marks, `survived-${n}`)), false);
    assert.ok(!world.decided.includes(n), 'a timeout grounds no rework');
  }
  // Retrials: a moved tip re-trialled the merge and previewed the new merge commit again.
  for (const n of all.filter(tipMoves)) assert.ok(new Set(world.previews.filter(entry => entry.n === n).map(entry => entry.verdict.mergeSha)).size >= 2, `GY-${n} was previewed again on the moved tip`);
  assert.ok(world.trials > items);
  assert.ok(previewConcurrency >= 1 && world.slots.running === 0);
  assert.deepEqual(daemonStateSchema.parse(JSON.parse(JSON.stringify(state))).mergeWriter, state.mergeWriter);
});
