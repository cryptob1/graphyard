import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import * as githubModule from '../src/github.js';
import { CHECK_NAME, GitHub, processJob, verdictRunsPerHead } from '../src/github.js';
import * as mergeQueue from '../src/merge-queue.js';
import { LANDABLE_CHECK, type Observation, type Principal, type Work } from '../src/model.js';
import { checkInvariants, emptyInvariantRecord, systemInvariants } from '../src/model/invariants.js';
import { mergeStallAttention } from '../src/cli/status-attention.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { clock, clockSql, hour, minute, sha } from './helpers/soak-world.js';

/**
 * GY-1917 over two simulated days of the real observation job (`processJob`), which publishes the
 * `Graphyard / merge` verdict through the real `GitHub.publish`, asks GitHub to merge through the
 * real `gateMerge`, and on a failed observation takes the real reconciliation error path. Twelve
 * items arrive through the days. Each merged item's first observations after its merge throw (the
 * GY-1912 sequence: GitHub merged the head before the item reached done), so it waits on
 * reconciliation through repeated failures; for one hour every open item's observation throws too.
 * One merged head's passing run is rewritten to REFUSED by another writer (a pre-GY-1917 executor)
 * before Graphyard observes the merge, and two more an hour after their items reached done.
 * Throughout: no App write reaches a merged head, while an open head whose observation failed reads
 * REFUSED; nothing merges while its latest run is not success; runs per head and writes per
 * observation stay bounded; the delivered-verdict refresh reads at most its batch per pass, stops
 * reading a head once its watch ends, and saves each post-delivery rewrite once; each rewritten
 * delivery is one public-verdict-contradicts-delivery attention item on every cycle from its
 * delivery (or from the first refresh after its rewrite), and no other item is ever named; every
 * item is delivered; and every system invariant holds after every cycle.
 */
const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const APP = 4935393, CI = 15368;
const start = Date.parse('2031-09-01T06:00:00Z');
const cycleMs = 2 * minute, days = 2, items = 12, arrivalEveryMs = 3 * hour, ciMs = 30 * minute;
/** Observations of a merged pull request that throw before one reads the merge: inside the merge-stall bound, which reads the stale record. */
const failuresAfterMerge = 3;
const base = sha('base');
/** One hour, from just after item 8 arrives: its observations fail while its head is open. */
const outage = (at: number) => at >= start + 21 * hour + 5 * minute && at < start + 22 * hour + 5 * minute;
/** The delivery whose passing run another writer rewrites after the merge. */
const rewritten = 5;
/** The deliveries whose passing run another writer rewrites an hour after the item reached done. */
const rewrittenAfterDone = [8, 11], rewriteAfterDoneMs = hour;
// Read through the namespace, so the file still loads (and its case fails) against a base without them.
const { deliveredVerdictIntervalMs = 0, deliveredVerdictWatchMs = 0, deliveredVerdictBatch = 0 } = githubModule as any;
const protection = [{ name: CHECK_NAME, appId: APP }, { name: LANDABLE_CHECK, appId: APP }, { name: 'secrets', appId: CI }, { name: 'test', appId: CI }, { name: 'typecheck', appId: CI }];
// Read through the namespace, so the file still loads (and its cases fail) against a base without them.
const mergeVerdictRun = (runs: any[], head: string) => (mergeQueue as any).mergeVerdictRun?.(runs, APP, head) ?? undefined;

interface PullRequest { n: number; head: string; pushedAt: number; autoMerge: boolean; merged: { head: string; mergeSha: string; at: number } | null; failedSinceMerge: number }
class World {
  prs = new Map<number, PullRequest>();
  runs: any[] = [];
  serial = 1_000;
  writes = 0;
  /** Every App write that reached a head after GitHub merged it. */
  afterMerge: string[] = [];
  merges: { n: number; head: string; latest: string | null }[] = [];
  /** Every read of a merged head's verdict runs, at the instant it was made. */
  mergedReads: { head: string; at: number }[] = [];
  latest(head: string, name = CHECK_NAME, app = APP) { return this.runs.filter(run => run.name === name && run.head_sha === head && run.app.id === app).sort((a, b) => b.id - a.id)[0] ?? null; }
  passing(head: string) { return protection.every(check => this.latest(head, check.name, check.appId)?.conclusion === 'success'); }
  prOfHead(head: string) { return [...this.prs.values()].find(pr => pr.head === head)!; }
  tick(now: number) {
    for (const pr of this.prs.values()) {
      if (pr.merged) continue;
      if (now >= pr.pushedAt + ciMs && !this.latest(pr.head, 'test', CI)) {
        for (const name of ['secrets', 'test', 'typecheck']) this.runs.push({ id: ++this.serial, name, head_sha: pr.head, status: 'completed', conclusion: 'success', app: { id: CI } });
        this.runs.push({ id: ++this.serial, name: LANDABLE_CHECK, head_sha: pr.head, status: 'completed', conclusion: 'success', app: { id: APP } });
      }
      if (pr.autoMerge && this.passing(pr.head)) this.merge(pr, now);
    }
  }
  merge(pr: PullRequest, now: number) {
    this.merges.push({ n: pr.n, head: pr.head, latest: this.latest(pr.head)?.conclusion ?? null });
    pr.merged = { head: pr.head, mergeSha: sha('merge', pr.head), at: now }; pr.autoMerge = false;
    // Another writer rewrites this delivery's passing run, outside Graphyard's own publication.
    if (pr.n === rewritten) Object.assign(this.latest(pr.head), { conclusion: 'failure', output: { title: 'REFUSED', summary: '- Reconciliation failed; fresh verification required' } });
  }
  write(head: string, method: string) {
    this.writes++;
    const pr = this.prOfHead(head);
    if (pr.merged?.head === head) this.afterMerge.push(`#${pr.n} ${method} ${head.slice(0, 12)}`);
  }
  client(): GitHub {
    const world = this, github = new GitHub({ repository: 'owner/project', base: 'main', appId: APP, installationId: 1, privateKey: 'not-used' });
    github.request = async (path: string, method = 'GET', body?: any) => {
      if (method === 'POST' && path === '/check-runs') {
        world.write(body.head_sha, 'POST');
        const run = { ...body, id: ++world.serial, app: { id: APP } };
        world.runs.push(run);
        return run;
      }
      if (method === 'PATCH' && path.startsWith('/check-runs/')) {
        const run = world.runs.find(entry => entry.id === Number(path.slice('/check-runs/'.length)))!;
        world.write(run.head_sha, 'PATCH');
        Object.assign(run, body);
        return run;
      }
      if (method !== 'GET') throw new Error(`Unexpected GitHub write ${method} ${path}`);
      const pull = /^\/pulls\/(\d+)$/.exec(path);
      if (pull) {
        const pr = world.prs.get(Number(pull[1]))!;
        return { number: pr.n, state: pr.merged ? 'closed' : 'open', draft: false, merged: !!pr.merged, merge_commit_sha: pr.merged?.mergeSha ?? null, head: { sha: pr.head }, base: { ref: 'main', sha: base } };
      }
      if (path === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: base } };
      if (/^\/commits\/[a-f0-9]{40}$/.test(path)) return { sha: path.slice(9), commit: { tree: { sha: sha('tree', path) } } };
      const listing = /^\/commits\/([a-f0-9]{40})\/check-runs\?check_name=([^&]+)&/.exec(path);
      if (listing && [...world.prs.values()].some(pr => pr.merged?.head === listing[1]) && path.includes('page=1')) world.mergedReads.push({ head: listing[1], at: clock.now() });
      if (listing) return { check_runs: path.includes('page=1') ? world.runs.filter(run => run.head_sha === listing[1] && run.name === decodeURIComponent(listing[2])) : [] };
      throw new Error(`Unexpected GitHub request ${method} ${path}`);
    };
    github.graphql = async (query: string, variables: any) => {
      const pr = world.prs.get(variables.number ?? Number(String(variables.id).slice(3)))!;
      if (/mergeQueue\(branch/.test(query)) return { repository: { mergeQueue: null, pullRequest: { id: `PR_${pr.n}`, headRefOid: pr.head, mergeStateStatus: world.passing(pr.head) && pr.n % 2 ? 'CLEAN' : 'BLOCKED', isInMergeQueue: false, autoMergeRequest: pr.autoMerge ? { enabledAt: new Date(clock.now()).toISOString() } : null, mergeQueueEntry: null } } };
      const operation = /(enablePullRequestAutoMerge|mergePullRequest|disablePullRequestAutoMerge)/.exec(query)?.[1];
      if (!operation) throw new Error(`Unexpected GraphQL ${query.slice(0, 80)}`);
      if (operation === 'disablePullRequestAutoMerge') { pr.autoMerge = false; return {}; }
      assert.equal(variables.head, pr.head, 'every merge request is bound to the head');
      if (operation === 'enablePullRequestAutoMerge') pr.autoMerge = true;
      else if (world.passing(pr.head)) world.merge(pr, clock.now());
      else throw new Error('Required status check "Graphyard / merge" is expected.');
      return {};
    };
    return github;
  }
  /** The observation, or the throw GY-1912 met: a merged pull request's first observations, and every observation in the outage. */
  observation(work: Work, now: number): Observation {
    const pr = this.prs.get(work.submission!.pr)!;
    if (pr.merged && pr.failedSinceMerge < failuresAfterMerge) { pr.failedSinceMerge++; throw new Error('PR is closed, draft, or retargeted; refusing success'); }
    if (outage(now)) throw new Error('GitHub answered 502');
    const head = pr.head, ci = (name: string) => ({ name, result: this.latest(head, name, CI)?.conclusion ?? 'in_progress', appId: CI });
    return { clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr: pr.n, branch: work.workspaces[0].branch, author: 'implementer' },
      checks: [ci('test'), ci('typecheck'), ci('secrets')], reviews: [{ reviewer: 'reviewer', sha: head, state: 'APPROVED' }],
      protected: true, mergeable: true, prState: pr.merged ? 'closed' : 'open', draft: false, merged: !!pr.merged, mergeSha: pr.merged?.mergeSha ?? null,
      ...(pr.merged ? { mergedAt: new Date(pr.merged.at).toISOString(), mergeVerdict: mergeVerdictRun(this.runs.filter(run => run.head_sha === head), head) } : {}),
      requiredChecks: protection, protectionChecks: protection,
      files: [`src/item-${pr.n}.ts`], scopeFiles: [], baseTip: base, at: new Date(now).toISOString() } as unknown as Observation;
  }
}

let database: EmbeddedPostgres; let store: Store; let engine: Engine;
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1917;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('soak-merge-verdict-after-merge'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('soak_merge_verdict_after_merge');
  clock.install(start);
  const connection = `postgres://graphyard:testing-only@127.0.0.1:${port}/soak_merge_verdict_after_merge`;
  const setup = new pg.Client({ connectionString: connection });
  await setup.connect();
  for (const statement of clockSql) await setup.query(statement);
  await setup.query('UPDATE simulated_clock SET offset_ms=$1', [clock.offsetMs]);
  await setup.query('ALTER DATABASE soak_merge_verdict_after_merge SET search_path = public, pg_catalog');
  await setup.end();
  store = new Store(connection); await store.init();
  engine = new Engine(store, [CI], 120, 'owner/project'); engine.submissionObserver = null; engine.controlPlaneAppId = APP;
});
after(async () => { clock.uninstall(); if (store) await store.close(); if (database) await database.stop(); });

test('unit:soak-merge-verdict-after-merge — two simulated days of the real observation job and its reconciliation error path: no App write reaches a merged head through repeated observation failures while open heads are refused, writes and runs stay bounded, a delivery its public verdict contradicts is one stable attention item, every item is delivered, and every system invariant holds after every cycle', { timeout: 600_000 }, async () => {
  const world = new World(), github = world.client();
  const adapter = {
    observe: async (item: Work) => world.observation(item, clock.now()),
    publish: github.publish.bind(github), mergeVerdictOf: github.mergeVerdictOf?.bind(github), requiredCheckShortfall: github.requiredCheckShortfall.bind(github),
    mergeQueueState: github.mergeQueueState.bind(github), enqueuePullRequest: github.enqueuePullRequest.bind(github),
    dequeuePullRequest: github.dequeuePullRequest.bind(github), publishGroupCheck: async () => {},
  } as unknown as GitHub;
  const record = emptyInvariantRecord(), violations: string[] = [], observed = new Set<string>();
  const contradictions: { at: number; subjects: string[]; texts: string[] }[] = [];
  const refusedOpen: string[] = [];
  let mostWrites = 0, awaitingAfterMerge = 0, mostReadsPerCycle = 0;
  const doneAt = new Map<string, number>(), rewrittenAt = new Map<number, number>();
  for (let cycle = 0; cycle < (days * 24 * hour) / cycleMs; cycle++) {
    const now = clock.now();
    for (let n = 1; n <= items; n++) {
      if (world.prs.has(n) || now < start + (n - 1) * arrivalEveryMs) continue;
      let w = await engine.execute(operator, 'create', null, { title: `Item ${n}`, criteria: [{ id: 'AC-1', text: 'It behaves', proofs: ['unit:it-behaves'] }] }, randomUUID());
      w = await engine.execute(operator, 'ready', w.id, {}, randomUUID());
      w = await engine.execute(worker, 'claim', w.id, {}, randomUUID());
      w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'machine-a', path: `/tmp/${w.id}`, branch: `graphyard/${w.id}` }, randomUUID());
      await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: n }, randomUUID());
      world.prs.set(n, { n, head: sha('head', n, 1), pushedAt: now, autoMerge: false, merged: null, failedSinceMerge: 0 });
    }
    world.tick(now);
    for (const item of await store.list()) {
      if (item.stage === 'done' || !item.submission) continue;
      const pr = world.prs.get(item.submission.pr)!;
      if (pr.merged && pr.failedSinceMerge < failuresAfterMerge) awaitingAfterMerge++;
      await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
      await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL WHERE work_id=$1', [item.id]);
      const before = world.writes;
      await processJob(engine, adapter);
      mostWrites = Math.max(mostWrites, world.writes - before);
      // An open head whose observation failed is refused, as before GY-1917.
      if (!pr.merged && outage(now) && (await store.workItem(item.id))?.candidate?.sha === pr.head) {
        const latest = world.latest(pr.head);
        assert.equal(latest?.output?.title, 'REFUSED', `cycle ${cycle}: #${pr.n}'s open head is refused when its observation fails`);
        assert.match(latest.output.summary, /Reconciliation failed; fresh verification required/);
        refusedOpen.push(`#${pr.n}`);
      }
    }
    // The refresh also runs when no item is open: one more pass of the job with nothing due.
    await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
    const readsBefore = world.mergedReads.length;
    await processJob(engine, adapter);
    const work = await store.list();
    for (const item of work) if (item.stage === 'done' && !doneAt.has(item.key)) doneAt.set(item.key, now);
    // Another writer rewrites a delivered head's passing run an hour after its item reached done.
    for (const n of rewrittenAfterDone) {
      const item = work.find(entry => entry.submission?.pr === n), head = world.prs.get(n)?.merged?.head;
      if (!item || !head || rewrittenAt.has(n) || !doneAt.has(item.key) || now < doneAt.get(item.key)! + rewriteAfterDoneMs) continue;
      Object.assign(world.latest(head), { conclusion: 'failure', output: { title: 'REFUSED', summary: '- Reconciliation failed; fresh verification required' } });
      rewrittenAt.set(n, now);
    }
    mostReadsPerCycle = Math.max(mostReadsPerCycle, world.mergedReads.length - readsBefore);
    for (const check of checkInvariants(record, { work, now, agents: [] })) {
      if (check.observed) observed.add(check.invariant);
      if (!check.holds) violations.push(`+${Math.round((now - start) / minute)} min ${check.line}`);
    }
    const attention = mergeStallAttention({ work, now: new Date(now).toISOString() }).filter(entry => entry.text.startsWith('public-verdict-contradicts-delivery'));
    contradictions.push({ at: now, subjects: attention.map(entry => entry.subject), texts: attention.map(entry => entry.text) });
    assert.deepEqual(world.afterMerge, [], `cycle ${cycle}: no App write reaches a merged head`);
    assert.deepEqual(world.merges.filter(entry => entry.latest !== 'success'), [], `cycle ${cycle}: a head merged while its latest ${CHECK_NAME} run was not success`);
    for (const pr of world.prs.values())
      assert.ok(world.runs.filter(run => run.name === CHECK_NAME && run.head_sha === pr.head).length <= verdictRunsPerHead, `cycle ${cycle}: #${pr.n} holds at most ${verdictRunsPerHead} verdict runs`);
    clock.advance(cycleMs); await store.pool.query('UPDATE simulated_clock SET offset_ms=$1', [clock.offsetMs]);
  }

  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.ok([...observed].every(name => (systemInvariants as readonly string[]).includes(name)));
  assert.ok(observed.has('merge-stall'), 'the merge-stall invariant was judged');
  assert.ok(mostWrites <= 2, `at most one update and one creation of the verdict per observation (${mostWrites})`);
  assert.ok(awaitingAfterMerge >= items * failuresAfterMerge, `every merged item waited on reconciliation through its failed observations (${awaitingAfterMerge})`);
  assert.ok(refusedOpen.length > 0, 'the outage refused open heads');
  const final = await store.list();
  assert.deepEqual(final.filter(item => item.stage !== 'done' || !item.delivery).map(item => `${item.key} ${item.stage}: ${item.gates.flatMap(gate => gate.reasons).join('; ')}`), [], 'every item is delivered after recovery');
  // Every delivered head but the rewritten ones still reads the success it was merged under.
  const rewrites = [rewritten, ...rewrittenAfterDone];
  for (const pr of world.prs.values()) assert.equal(world.latest(pr.merged!.head).conclusion, rewrites.includes(pr.n) ? 'failure' : 'success', `#${pr.n}'s run after delivery`);
  assert.deepEqual([...rewrittenAt.keys()].sort((a, b) => a - b), rewrittenAfterDone, 'every post-delivery rewrite happened');
  // The contradictions: one attention item per rewritten delivery on every cycle from when it is
  // seen — its delivery, or the first refresh pass after its rewrite — and no other item ever.
  const keyOf = (n: number) => final.find(item => item.submission?.pr === n)!.key;
  const keys = rewrites.map(keyOf);
  assert.deepEqual(contradictions.filter(entry => entry.subjects.some(subject => !keys.includes(subject))), [], 'no other delivery is ever named');
  assert.ok(contradictions.every(entry => new Set(entry.subjects).size === entry.subjects.length), 'one attention item per contradicted delivery');
  for (const n of rewrites) {
    const key = keyOf(n), seenFrom = n === rewritten ? doneAt.get(key)! : rewrittenAt.get(n)! + deliveredVerdictIntervalMs + cycleMs;
    assert.deepEqual(contradictions.filter(entry => entry.at >= seenFrom && !entry.subjects.includes(key)).map(entry => new Date(entry.at).toISOString()), [], `${key} is named on every cycle from ${new Date(seenFrom).toISOString()}`);
    if (n !== rewritten) assert.deepEqual(contradictions.filter(entry => entry.at < rewrittenAt.get(n)! && entry.subjects.includes(key)), [], `${key} is not named before its rewrite`);
    const text = contradictions.flatMap(entry => entry.texts).find(entry => entry.includes(` ${key} `))!;
    assert.match(text, new RegExp(`^public-verdict-contradicts-delivery: ${key} merged head ${world.prs.get(n)!.head.slice(0, 12)} .*run \\d+ reads failure`));
  }
  // The refresh is bounded: at most its batch per pass, never past a head's watch, and one save per rewrite.
  assert.ok(deliveredVerdictBatch > 0 && mostReadsPerCycle <= deliveredVerdictBatch, `at most ${deliveredVerdictBatch} delivered heads read per pass (${mostReadsPerCycle})`);
  for (const pr of world.prs.values()) {
    const late = world.mergedReads.filter(read => read.head === pr.merged!.head && read.at > pr.merged!.at + deliveredVerdictWatchMs + deliveredVerdictIntervalMs + cycleMs);
    assert.deepEqual(late, [], `#${pr.n}'s verdict is not read after its watch`);
  }
  assert.ok(world.mergedReads.some(read => rewrittenAfterDone.map(n => world.prs.get(n)!.head).includes(read.head)), 'delivered heads were re-read');
  const refreshed = (await store.pool.query("SELECT work_id FROM events WHERE kind='merge-verdict.refreshed'")).rows.map(row => String(row.work_id)).sort();
  assert.deepEqual(refreshed, rewrittenAfterDone.map(n => final.find(item => item.submission?.pr === n)!.id).sort(), 'each post-delivery rewrite is saved once');
});
