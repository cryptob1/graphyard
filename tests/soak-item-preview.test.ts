import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { mergeRecordKey, type MergeRecordEvent } from '../src/merge-writer/executor.js';
import { mergeRecordFingerprint } from '../src/server/merge-record.js';
import { openPreview, previewCheckoutPrefix, previewSlots, type ItemPreviewPorts, type OpenedPreview } from '../src/merge-writer/preview.js';
import { applyPreviewRecord, previewHistoryLimit, previewRecordBodySchema, type ItemPreview } from '../src/project-previews.js';
import type { ProjectDelivery } from '../src/project-applications.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';
import type { ChildRun } from '../src/child-runner.js';
import type { StaticBuildShell } from '../src/release-project.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1902: item previews over a simulated day of the real loop's cycles (`runCycle`). Items citing a
 * case bound to a declared static application arrive through the day: each is previewed on the base
 * tip until its head is submitted, then on its head with the real `openPreview` — a checkout, the
 * site built and served on loopback, its declared case run over HTTP — and the passing site
 * published with its running record. Some heads break the case (failed, never retried on that
 * commit), some items move to a second head (superseded), some are closed (cancelled) and the rest
 * delivered; the server refuses some records outright and loses the reply to others, and the loop
 * restarts twice, its previews dying with it. Every preview must end recorded, no preview start or
 * record write is duplicated, the published sites, checkouts and servers stay bounded by the
 * previews running, nothing is left at the end and every system invariant holds.
 */
const minute = 60_000;
const start = Date.parse('2030-06-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy', retrials: 1 } } });
const githubDouble = new Proxy({}, { get: (_, name) => { throw new Error(`the item preview soak called GitHub (${String(name)})`); } });
const delivery: ProjectDelivery = { mode: 'local', previews: 'local', candidateMaxChanges: 5, productionVerification: true, source: 'graphyard.json',
  applications: [{ id: 'site', kind: 'static', directory: 'dist', build: 'build the site' }], cases: { 'site-home': 'site' } };

/** The day's script, by item ordinal. */
const items = 40, arriveEveryMs = 20 * minute, cycleMs = 2 * minute, cycles = (24 * 60) / 2, restarts = [200, 400];
const arrives = (n: number) => start + n * arriveEveryMs;
const breaksFirst = (n: number) => n % 5 === 0;
const secondHead = (n: number) => n % 3 === 0 || breaksFirst(n);
const closed = (n: number) => n % 4 === 0;
const head = (n: number, attempt: number) => sha(`head${n}-${attempt}`);

const made: string[] = [];
after(async () => { for (const directory of made) await rm(directory, { recursive: true, force: true }); });

class World {
  docs = new Map<number, Work>();
  /** The commit each preview checkout serves, and what it builds: the head's ordinal and whether its case breaks. */
  commits = new Map<string, { n: number; broken: boolean }>();
  receipts = new Map<string, string>();
  /** Applied record writes per preview id and state, and the server's published sites by item. */
  writes = new Map<string, number>();
  published = new Map<string, string>();
  calls = 0; refused = 0; lost = 0;
  /** Every preview this loop generation opened, by `key@sha`, and the servers still open. */
  generation = 0;
  starts = new Map<string, number>();
  serving = new Set<OpenedPreview>();
  inFlight = new Set<Promise<unknown>>();
  awaiting = new Set<string>();
  /** Previews whose `starting` the server has not confirmed: the loop retries it before the preview opens. */
  retrying = new Set<string>();
  slots = previewSlots();
  constructor(readonly now: () => number, readonly root: string, readonly base: string) {
    for (let n = 1; n <= items; n++) this.commits.set(head(n, 1), { n, broken: breaksFirst(n) }), this.commits.set(head(n, 2), { n, broken: false });
    this.commits.set(sha('base'), { n: 0, broken: false });
  }
  /** The item's head at `now`: none for its first ten minutes, its second two hours after it arrived when it has one. */
  headOf(n: number, now: number) { return now < arrives(n) + 10 * minute ? null : secondHead(n) && now >= arrives(n) + 120 * minute ? head(n, 2) : head(n, 1); }
  snapshot(): Work[] {
    const now = this.now();
    const work: Work[] = [];
    for (let n = 1; n <= items && arrives(n) <= now; n++) {
      const doc = this.docs.get(n) ?? { id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, key: `GY-${n}` } as Work;
      this.docs.set(n, doc);
      const current = this.headOf(n, now), ended = now >= arrives(n) + (closed(n) ? 300 : 480) * minute;
      const candidate = current ? { sha: current, baseSha: sha('base'), pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' } : null;
      work.push({
        ...doc, title: `Item ${n}`, description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'The home shows the change', proofs: ['e2e:site-home'] }],
        policy: { checks: ['test'], review: true }, plannedFiles: [], revision: 1, policyRevision: 1, createdAt: iso(arrives(n)), updatedAt: iso(now), stageEnteredAt: iso(arrives(n)),
        ready: true, epoch: 1, lease: null, workspaces: [], submission: current ? { epoch: 1, pr: n } : null, candidate, scenarioRequirements: [], evidence: [], blocker: null, violations: [],
        gates: ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: name !== 'test' && name !== 'merge', reasons: [] })),
        ...(ended ? closed(n) ? { stage: 'done', closure: { kind: 'obsolete', reason: 'Not needed', ref: null, by: 'operator', at: iso(now), from: 'build' } } : { stage: 'done', delivery: { mergedAt: iso(now), mergeSha: current!, authorizationRevision: 1 } } : { stage: 'build' }),
      } as unknown as Work);
    }
    return work;
  }
  /** git, as the preview drives it: `worktree add` writes the commit's site and its case into the checkout. */
  run: ChildRun = async (_command, args) => {
    if (args.includes('add')) {
      const checkout = args.at(-2)!, commit = this.commits.get(args.at(-1)!)!;
      const write = async (path: string, content: string) => { await mkdir(join(checkout, path, '..'), { recursive: true }); await writeFile(join(checkout, path), content); };
      await write('site/home.json', JSON.stringify({ heading: commit.broken ? 'broken' : 'home', n: commit.n }));
      await write('site/index.html', `<script src="app.js"></script><p>${args.at(-1)}</p>`);
      await write('site/app.js', 'document.title = "home";');
      await write('e2e/cases/site-home.json', JSON.stringify({ id: 'site-home', title: 'The home answers', tags: ['api'], target: 'any', required: false,
        steps: [{ kind: 'http', name: 'home', method: 'GET', path: '/home.json', status: 200, expect: [{ path: 'heading', equals: 'home' }] }] }));
    }
    return '';
  };
  shell: StaticBuildShell = async (_command, cwd) => {
    await mkdir(join(cwd, 'dist'), { recursive: true });
    for (const name of await readdir(join(cwd, 'site'))) await writeFile(join(cwd, 'dist', name), await readFile(join(cwd, 'site', name)));
    return { ok: true, output: '' };
  };
  /** The real preview, counted: each start by its key and commit, each served one until it is closed. */
  open: typeof openPreview = (input, options) => {
    const key = `${options.variables!.GRAPHYARD_PREVIEW_KEY}@${input.mergeSha}#${this.generation}`;
    this.starts.set(key, (this.starts.get(key) ?? 0) + 1);
    const opening = openPreview(input, options).then(opened => {
      this.awaiting.add(options.variables!.GRAPHYARD_PREVIEW_KEY!);
      if (!opened.url) return opened;
      const close = opened.close, served = { ...opened, close: async () => { this.serving.delete(served); await close(); } };
      this.serving.add(served);
      return served;
    });
    this.inFlight.add(opening); void opening.finally(() => this.inFlight.delete(opening));
    return opening;
  };
  /** The server's record route (server/routes/work.ts): every seventh call refused outright, every eleventh applied with its reply lost; a key replays its own input and refuses any other. */
  record = async (item: { id: string; key: string }, preview: ItemPreview, site?: unknown): Promise<unknown> => {
    const event = previewRecordBodySchema.parse({ kind: 'preview', preview, ...(site ? { site } : {}) });
    if (preview.state !== 'starting') this.awaiting.delete(item.key), this.retrying.delete(preview.id);
    this.calls += 1;
    const unconfirmed = (error: Error) => { if (preview.state === 'starting') this.retrying.add(preview.id); return error; };
    if (this.calls % 7 === 0) { this.refused += 1; throw unconfirmed(new Error('503: the server is restarting')); }
    const key = mergeRecordKey(item, event as unknown as MergeRecordEvent), fingerprint = mergeRecordFingerprint(item.id, event), receipt = this.receipts.get(key);
    if (receipt !== undefined) { assert.equal(receipt, fingerprint, `Idempotency key reused with different input: ${key}`); this.retrying.delete(preview.id); return { recorded: true }; }
    const doc = [...this.docs.values()].find(entry => entry.id === item.id)!;
    const refusal = applyPreviewRecord(doc, preview);
    if (refusal) throw new Error(`409: ${refusal}`);
    this.receipts.set(key, fingerprint);
    const write = `${preview.id}:${preview.state}`;
    this.writes.set(write, (this.writes.get(write) ?? 0) + 1);
    if (doc.preview?.state === 'running') this.published.set(doc.id, doc.preview.id); else this.published.delete(doc.id);
    if (this.calls % 11 === 0) { this.lost += 1; throw unconfirmed(new Error('the reply was lost')); }
    this.retrying.delete(preview.id);
    return { recorded: true };
  };
  ports(): MergeWriterReads {
    const fail = async () => { throw new Error('the item preview soak runs under the GitHub merger'); };
    const itemPreviews: ItemPreviewPorts = { root: this.root, base: this.base, timeoutMs: 30_000, delivery: () => delivery, baseTip: async () => sha('base'), record: this.record,
      run: this.run, shell: this.shell, slots: this.slots, stepTimeoutMs: 5_000, now: this.now, open: this.open };
    return { baseBranch: 'main', retrials: 1, now: this.now, merger: async () => 'github', fetch: fail, merge: fail, trial: fail, preview: fail, push: fail, holds: fail, record: fail, itemPreviews } as unknown as MergeWriterReads;
  }
  /** Waits until every preview started has been confirmed, opened and settled, and its outcome was sent to the server. */
  async settle() {
    const busy = () => this.retrying.size || this.inFlight.size || this.awaiting.size;
    for (let waited = 0; busy() && waited < 30_000; waited += 5) await new Promise(accept => setTimeout(accept, 5));
    assert.equal(busy(), 0, 'every preview settles');
  }
}

test('unit:soak-item-preview — a simulated day of item previews on the real loop: base, head, superseded, failed, cancelled and delivered previews under refused records, lost replies and two loop restarts each start once per loop, are written once per state, end recorded with their checkouts, servers and published sites removed, and stay bounded while every invariant holds', { timeout: 300_000 }, async () => {
  const root = await realpath(await temporaryDirectory('soak-item-preview')); made.push(root);
  const base = join(root, 'worktrees'); await mkdir(base);
  let now = start;
  const world = new World(() => now, root, base);
  const effects = { agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: world.snapshot(), now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, decisions: async () => ({ decisions: [] }), persist: async () => {},
    github: githubDouble, merge: githubDouble, shadow: null, mergeWriter: world.ports(), decide: async () => ({ id: 'none' }) } as unknown as DaemonEffects;
  let state = emptyDaemonState(config);
  const checkouts = async () => (await readdir(base)).filter(name => name.startsWith(previewCheckoutPrefix) && !name.endsWith('.owner'));
  for (let cycle = 0; cycle < cycles; cycle++) {
    now = start + cycle * cycleMs;
    if (restarts.includes(cycle)) {
      // The loop restarts: its process ends, taking every preview server it ran with it, and the next start's sweep removes their checkouts.
      for (const served of [...world.serving]) await served.close();
      state = emptyDaemonState(config); world.generation += 1;
    }
    await runCycle(config, state, effects, () => now);
    await world.settle();
    // Bounded: a checkout and a server only for each preview serving, a published site only for each item whose record says running, and a bounded history.
    const docs = [...world.docs.values()];
    assert.equal((await checkouts()).length, world.serving.size, `cycle ${cycle}: a checkout exactly for each served preview`);
    assert.ok(world.serving.size <= docs.filter(doc => doc.preview && doc.preview.state !== 'failed' && doc.preview.state !== 'cleaned').length, `cycle ${cycle}: no server outlives its preview's record`);
    for (const doc of docs) {
      assert.equal(world.published.get(doc.id), doc.preview?.state === 'running' ? doc.preview.id : undefined, `cycle ${cycle}: ${doc.key} publishes exactly its running preview's site`);
      assert.ok((doc.previewHistory ?? []).length <= previewHistoryLimit, `cycle ${cycle}: ${doc.key}'s preview history is bounded`);
    }
    for (const check of state.invariants.report) assert.ok(check.holds, `cycle ${cycle}: invariant ${check.invariant} is violated: ${check.line}`);
  }
  // Ending: each item's last preview is recorded ended, nothing serves, nothing is published, no checkout is left.
  const docs = [...world.docs.values()];
  assert.equal(docs.length, items);
  for (const doc of docs) {
    const n = Number(doc.key.slice(3));
    assert.ok(doc.preview && (doc.preview.state === 'cleaned' || doc.preview.state === 'failed'), `${doc.key} ends with its preview ended: ${doc.preview?.state}`);
    assert.equal(doc.preview!.endReason, closed(n) ? 'cancelled' : 'delivered', `${doc.key} ended ${closed(n) ? 'cancelled' : 'delivered'}`);
    const all = [...(doc.previewHistory ?? []), doc.preview!];
    const shown = JSON.stringify(all.map(entry => [entry.source, entry.sha.slice(0, 6), entry.state, entry.endReason]));
    assert.ok(all.some(entry => entry.source === 'base' && (entry.endReason === 'superseded' || entry.endReason === 'restarted')), `${doc.key}'s base preview ended when its head arrived or the loop restarted: ${shown}`);
    if (breaksFirst(n)) assert.ok(all.some(entry => entry.sha === head(n, 1) && entry.state === 'failed' && entry.cases.some(result => result.result === 'fail')), `${doc.key}'s broken head failed its case: ${shown}`);
    if (secondHead(n) && !breaksFirst(n)) assert.ok(all.some(entry => entry.sha === head(n, 1) && entry.endReason === 'superseded'), `${doc.key}'s first head was superseded: ${shown}`);
    assert.ok(all.some(entry => entry.sha === doc.preview!.sha && entry.readyAt), `${doc.key}'s last head served before it ended: ${shown}`);
  }
  assert.ok(docs.some(doc => [...(doc.previewHistory ?? []), doc.preview!].some(entry => entry.endReason === 'restarted')), 'a restart recorded the previews it left behind');
  assert.equal(world.serving.size, 0, 'no preview server is left');
  assert.deepEqual(await checkouts(), [], 'no preview checkout is left');
  assert.equal(world.published.size, 0, 'no published site is left');
  assert.equal(world.slots.running, 0, 'every slot is freed');
  // No duplicate starts or writes: a commit of an item starts once per loop process, and each preview's state is applied once.
  for (const [key, count] of world.starts) assert.equal(count, 1, `${key} started once`);
  for (const [write, count] of world.writes) assert.equal(count, 1, `${write} was written once`);
  assert.ok(world.refused > 10 && world.lost > 5, `the server refused ${world.refused} records and lost ${world.lost} replies`);
});
