import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { CHECK_NAME, GitHub, processJob, verdictRunsPerHead } from '../src/github.js';
import { LANDABLE_CHECK, type Observation, type Principal, type Work } from '../src/model.js';
import { checkInvariants, emptyInvariantRecord, systemInvariants } from '../src/model/invariants.js';
import { mergeStallAttention } from '../src/cli/status-attention.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { recordLegacyMerger } from './helpers/legacy-merger.js';
import { clock, clockSql, hour, minute, sha } from './helpers/soak-world.js';

/**
 * GY-1884 over two simulated days of the real observation job (`processJob`), which publishes the
 * `Graphyard / merge` verdict through the real `GitHub.publish` and asks GitHub to merge through
 * the real `gateMerge`, against a GitHub whose check runs persist across observations. Twelve items
 * arrive through the days; every head is first REFUSED while its CI runs, then passes. GitHub keeps
 * some completed runs unchanged on update (the verdict is created anew), and two first heads never
 * take a passing verdict at all (persistent unsuccessful publication) until the worker pushes a new
 * head. For six hours every observation records the required checks the way the pre-GY-1884 read
 * did, while GitHub's protection binds all five to their apps. Throughout: no merge is requested and
 * nothing merges while the latest `Graphyard / merge` run at that head is not success; the App's
 * runs per head and its writes per observation stay bounded; a stuck head's refusal is recorded once;
 * the disagreement is one attention item while it lasts and none after; every item is delivered; and
 * every system invariant holds after every cycle.
 */
const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const APP = 4935393, CI = 15368;
const start = Date.parse('2031-08-04T06:00:00Z');
const cycleMs = 5 * minute, days = 2, items = 12, arrivalEveryMs = 3 * hour, ciMs = 30 * minute, newHeadAfterMs = 4 * hour;
const base = sha('base');
/** GitHub answers an update of a completed run with the run unchanged. */
const frozen = (n: number) => n % 3 === 0;
/** No write ever makes the first head's latest run read success. */
const stuck = (n: number) => n === 4 || n === 9;
const drift = (at: number) => at >= start + 10 * hour && at < start + 16 * hour;
const protection = [{ name: CHECK_NAME, appId: APP }, { name: LANDABLE_CHECK, appId: APP }, { name: 'secrets', appId: CI }, { name: 'test', appId: CI }, { name: 'typecheck', appId: CI }];
const legacyRecord = [{ name: 'secrets', appId: null }, { name: 'test', appId: null }, { name: 'typecheck', appId: null }];

interface PullRequest { n: number; heads: { sha: string; pushedAt: number }[]; autoMerge: boolean; merged: { head: string; mergeSha: string; at: number } | null; heldSince: number | null }
class World {
  prs = new Map<number, PullRequest>();
  /** Every check run GitHub holds, by id. */
  runs: any[] = [];
  serial = 1_000;
  writes = 0;
  /** Each merge request and each merge, with the latest Graphyard / merge conclusion at the head when it happened. */
  requests: { n: number; head: string; operation: string; latest: string | null }[] = [];
  merges: { n: number; head: string; latest: string | null; mode: string }[] = [];
  head(pr: PullRequest) { return pr.heads.at(-1)!.sha; }
  latest(head: string, name = CHECK_NAME, app = APP) { return this.runs.filter(run => run.name === name && run.head_sha === head && run.app.id === app).sort((a, b) => b.id - a.id)[0] ?? null; }
  passing(head: string) { return protection.every(check => this.latest(head, check.name, check.appId)?.conclusion === 'success'); }
  ciDone(pr: PullRequest, now: number) { return now >= pr.heads.at(-1)!.pushedAt + ciMs; }
  /** GitHub's own side of a cycle: CI completes, the landability check follows it, armed auto-merges land, and a held head is replaced. */
  tick(now: number) {
    for (const pr of this.prs.values()) {
      if (pr.merged) continue;
      const head = this.head(pr);
      if (this.ciDone(pr, now) && !this.latest(head, 'test', CI)) {
        for (const name of ['secrets', 'test', 'typecheck']) this.runs.push({ id: ++this.serial, name, head_sha: head, status: 'completed', conclusion: 'success', app: { id: CI } });
        // The control plane's landability verdict, which this observation adapter does not publish itself.
        this.runs.push({ id: ++this.serial, name: LANDABLE_CHECK, head_sha: head, status: 'completed', conclusion: 'success', app: { id: APP } });
      }
      if (pr.autoMerge && this.passing(head)) this.merge(pr, now, 'auto-merge');
      // The worker answers a head held for its verdict with a new one.
      if (pr.heldSince !== null && now - pr.heldSince >= newHeadAfterMs) { pr.heads.push({ sha: sha('head', pr.n, pr.heads.length + 1), pushedAt: now }); pr.heldSince = null; pr.autoMerge = false; }
    }
  }
  merge(pr: PullRequest, now: number, mode: string) {
    const head = this.head(pr);
    this.merges.push({ n: pr.n, head, latest: this.latest(head)?.conclusion ?? null, mode });
    pr.merged = { head, mergeSha: sha('merge', head), at: now }; pr.autoMerge = false;
  }
  stuckHead(pr: PullRequest, head: string) { return stuck(pr.n) && head === pr.heads[0].sha; }
  /** The real client, its transport answered from this world. */
  client(): GitHub {
    const world = this, github = new GitHub({ repository: 'owner/project', base: 'main', appId: APP, installationId: 1, privateKey: 'not-used' });
    const prOf = (path: string) => world.prs.get(Number(/^\/pulls\/(\d+)$/.exec(path)?.[1]))!;
    github.request = async (path: string, method = 'GET', body?: any) => {
      if (method === 'POST' && path === '/check-runs') {
        world.writes++;
        const pr = [...world.prs.values()].find(entry => entry.heads.some(h => h.sha === body.head_sha))!;
        const previous = world.latest(body.head_sha);
        const run = { ...body, id: ++world.serial, app: { id: APP }, conclusion: world.stuckHead(pr, body.head_sha) && previous ? previous.conclusion : body.conclusion };
        world.runs.push(run);
        return run;
      }
      if (method === 'PATCH' && path.startsWith('/check-runs/')) {
        world.writes++;
        const run = world.runs.find(entry => entry.id === Number(path.slice('/check-runs/'.length)))!;
        const pr = [...world.prs.values()].find(entry => entry.heads.some(h => h.sha === run.head_sha))!;
        if (!frozen(pr.n) && !world.stuckHead(pr, run.head_sha)) Object.assign(run, body);
        return run;
      }
      if (method !== 'GET') throw new Error(`Unexpected GitHub write ${method} ${path}`);
      if (/^\/pulls\/\d+$/.test(path)) { const pr = prOf(path); return { number: pr.n, state: pr.merged ? 'closed' : 'open', draft: false, head: { sha: world.head(pr) }, base: { ref: 'main', sha: base } }; }
      if (path === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: base } };
      if (/^\/commits\/[a-f0-9]{40}$/.test(path)) return { sha: path.slice(9), commit: { tree: { sha: sha('tree', path) } } };
      const listing = /^\/commits\/([a-f0-9]{40})\/check-runs\?check_name=([^&]+)&/.exec(path);
      if (listing) return { check_runs: path.includes('page=1') ? world.runs.filter(run => run.head_sha === listing[1] && run.name === decodeURIComponent(listing[2])) : [] };
      throw new Error(`Unexpected GitHub request ${method} ${path}`);
    };
    github.graphql = async (query: string, variables: any) => {
      const pr = world.prs.get(variables.number ?? Number(String(variables.id).slice(3)))!;
      const head = world.head(pr);
      if (/mergeQueue\(branch/.test(query)) return { repository: { mergeQueue: null, pullRequest: { id: `PR_${pr.n}`, headRefOid: head, mergeStateStatus: world.passing(head) && pr.n % 2 ? 'CLEAN' : 'BLOCKED', isInMergeQueue: false, autoMergeRequest: pr.autoMerge ? { enabledAt: new Date(clock.now()).toISOString() } : null, mergeQueueEntry: null } } };
      const operation = /(enablePullRequestAutoMerge|mergePullRequest|disablePullRequestAutoMerge)/.exec(query)?.[1];
      if (!operation) throw new Error(`Unexpected GraphQL ${query.slice(0, 80)}`);
      if (operation === 'disablePullRequestAutoMerge') { pr.autoMerge = false; return {}; }
      assert.equal(variables.head, head, 'every merge request is bound to the head');
      world.requests.push({ n: pr.n, head, operation, latest: world.latest(head)?.conclusion ?? null });
      if (operation === 'enablePullRequestAutoMerge') pr.autoMerge = true;
      // GitHub enforces protection on an immediate merge: every required check passing at the head.
      else if (world.passing(head)) world.merge(pr, clock.now(), 'immediate');
      else throw new Error('Required status check "Graphyard / merge" is expected.');
      return {};
    };
    return github;
  }
  observation(work: Work, now: number): Observation {
    const pr = this.prs.get(work.submission!.pr)!, head = pr.merged?.head ?? this.head(pr);
    const ci = (name: string) => ({ name, result: this.latest(head, name, CI)?.conclusion ?? 'in_progress', appId: CI });
    return { clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr: pr.n, branch: work.workspaces[0].branch, author: 'implementer' },
      checks: [ci('test'), ci('typecheck'), ci('secrets')], reviews: [{ reviewer: 'reviewer', sha: head, state: 'APPROVED' }],
      protected: true, mergeable: true, prState: pr.merged ? 'closed' : 'open', draft: false, merged: !!pr.merged, mergeSha: pr.merged?.mergeSha ?? null,
      ...(pr.merged ? { mergedAt: new Date(pr.merged.at).toISOString() } : {}),
      requiredChecks: drift(now) ? legacyRecord : protection, protectionChecks: protection,
      files: [`src/item-${pr.n}.ts`], scopeFiles: [], baseTip: base, at: new Date(now).toISOString() } as unknown as Observation;
  }
}

let database: EmbeddedPostgres; let store: Store; let engine: Engine;
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1884;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('soak-merge-verdict'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('soak_merge_verdict');
  clock.install(start);
  const connection = `postgres://graphyard:testing-only@127.0.0.1:${port}/soak_merge_verdict`;
  // The database reads the simulated clock: its time functions are shadowed before the schema exists.
  const setup = new pg.Client({ connectionString: connection });
  await setup.connect();
  for (const statement of clockSql) await setup.query(statement);
  await setup.query('UPDATE simulated_clock SET offset_ms=$1', [clock.offsetMs]);
  await setup.query('ALTER DATABASE soak_merge_verdict SET search_path = public, pg_catalog');
  await setup.end();
  store = new Store(connection); await store.init(); await recordLegacyMerger(store);
  engine = new Engine(store, [CI], 120, 'owner/project'); engine.submissionObserver = null; engine.controlPlaneAppId = APP;
});
after(async () => { clock.uninstall(); if (store) await store.close(); if (database) await database.stop(); });

test('unit:soak-merge-verdict — two simulated days of the real observation job: no merge is requested or lands while the head\'s latest Graphyard / merge run is not success, refused heads recover once their checks pass, a verdict GitHub will not take is held with bounded runs and writes and one recorded refusal until a new head lands, a shared required-checks disagreement is one attention item while it lasts, every item is delivered, and every system invariant holds after every cycle', { timeout: 600_000 }, async () => {
  const world = new World(), github = world.client();
  const adapter = {
    observe: async (item: Work) => world.observation(item, clock.now()),
    publish: github.publish.bind(github), requiredCheckShortfall: github.requiredCheckShortfall.bind(github),
    mergeQueueState: github.mergeQueueState.bind(github), enqueuePullRequest: github.enqueuePullRequest.bind(github),
    dequeuePullRequest: github.dequeuePullRequest.bind(github), publishGroupCheck: async () => {},
  } as unknown as GitHub;
  const record = emptyInvariantRecord(), violations: string[] = [], observed = new Set<string>(), failures: string[] = [];
  const disagreements: { at: number; count: number; text: string }[] = [];
  let mostWrites = 0;
  for (let cycle = 0; cycle < (days * 24 * hour) / cycleMs; cycle++) {
    const now = clock.now();
    // Arrivals: each item claimed, given its workspace and submitted on pull request #n.
    for (let n = 1; n <= items; n++) {
      if (world.prs.has(n) || now < start + (n - 1) * arrivalEveryMs) continue;
      let w = await engine.execute(operator, 'create', null, { title: `Item ${n}`, criteria: [{ id: 'AC-1', text: 'It behaves', proofs: ['unit:it-behaves'] }] }, randomUUID());
      w = await engine.execute(operator, 'ready', w.id, {}, randomUUID());
      w = await engine.execute(worker, 'claim', w.id, {}, randomUUID());
      w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'machine-a', path: `/tmp/${w.id}`, branch: `graphyard/${w.id}` }, randomUUID());
      await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: n }, randomUUID());
      world.prs.set(n, { n, heads: [{ sha: sha('head', n, 1), pushedAt: now }], autoMerge: false, merged: null, heldSince: null });
    }
    world.tick(now);
    // The observation job, once per open submitted item.
    for (const item of await store.list()) {
      if (item.stage === 'done' || !item.submission) continue;
      await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
      await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL WHERE work_id=$1', [item.id]);
      const before = world.writes;
      try { await processJob(engine, adapter); } catch (error) { failures.push(`${item.key}: ${error instanceof Error ? error.message : String(error)}`); }
      mostWrites = Math.max(mostWrites, world.writes - before);
      // A head whose verdict GitHub will not take is held: the worker sees it and pushes again.
      const pr = world.prs.get(item.submission.pr)!;
      if (pr.heldSince === null && !pr.merged && world.stuckHead(pr, world.head(pr)) && world.latest(world.head(pr), 'test', CI)) pr.heldSince = now;
    }
    const work = await store.list();
    for (const check of checkInvariants(record, { work, now, agents: [] })) {
      if (check.observed) observed.add(check.invariant);
      if (!check.holds) violations.push(`+${Math.round((now - start) / minute)} min ${check.line}`);
    }
    const attention = mergeStallAttention({ work, now: new Date(now).toISOString() }).filter(entry => entry.text.startsWith('required-checks-disagree'));
    disagreements.push({ at: now, count: attention.length, text: attention[0]?.text ?? '' });
    // Merge safety, every cycle: nothing requested or merged while the head's latest verdict was not success.
    assert.deepEqual(world.requests.filter(entry => entry.latest !== 'success'), [], `cycle ${cycle}: a merge was requested while the latest ${CHECK_NAME} run was not success`);
    assert.deepEqual(world.merges.filter(entry => entry.latest !== 'success'), [], `cycle ${cycle}: a head merged while the latest ${CHECK_NAME} run was not success`);
    for (const pr of world.prs.values()) for (const { sha: head } of pr.heads)
      assert.ok(world.runs.filter(run => run.name === CHECK_NAME && run.head_sha === head).length <= verdictRunsPerHead, `cycle ${cycle}: #${pr.n} ${head.slice(0, 12)} holds at most ${verdictRunsPerHead} verdict runs`);
    clock.advance(cycleMs); await store.pool.query('UPDATE simulated_clock SET offset_ms=$1', [clock.offsetMs]);
  }

  assert.deepEqual(failures, [], 'no observation failed');
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.ok(observed.has('merge-stall'), 'the merge-stall invariant was judged');
  assert.ok([...observed].every(name => (systemInvariants as readonly string[]).includes(name)));
  assert.ok(mostWrites <= 2, `at most one update and one creation of the verdict per observation (${mostWrites})`);
  const final = await store.list();
  assert.deepEqual(final.filter(item => item.stage !== 'done' || !item.delivery).map(item => `${item.key} ${item.stage}: ${item.gates.flatMap(gate => gate.reasons).join('; ')}`), [], 'every item is delivered');
  // Every head was first REFUSED, then passed: the refused run was updated in place, or GitHub kept it and a newer success was created.
  for (const pr of world.prs.values()) {
    const delivered = pr.merged!.head, verdicts = world.runs.filter(run => run.name === CHECK_NAME && run.head_sha === delivered).sort((a, b) => a.id - b.id);
    assert.equal(verdicts.at(-1).conclusion, 'success', `#${pr.n} merged on a success`);
    assert.equal(verdicts.length, frozen(pr.n) ? 2 : 1, `#${pr.n}: ${frozen(pr.n) ? 'the kept REFUSED run beside one new success' : 'the REFUSED run updated in place'}`);
    if (frozen(pr.n)) assert.equal(verdicts[0].conclusion, 'failure');
    assert.ok(world.requests.some(entry => entry.n === pr.n && entry.head === delivered), `#${pr.n}: the merge was requested on its delivered head`);
  }
  // The stuck first heads: never a merge request, the verdict runs capped, one recorded refusal, then delivered on a new head.
  for (const n of [4, 9]) {
    const pr = world.prs.get(n)!, first = pr.heads[0].sha;
    assert.equal(pr.heads.length, 2, `#${n} was replaced by a new head`);
    assert.deepEqual(world.requests.filter(entry => entry.head === first), [], `#${n}: no merge was requested on the head GitHub kept REFUSED`);
    assert.equal(world.runs.filter(run => run.name === CHECK_NAME && run.head_sha === first).length, verdictRunsPerHead, `#${n}: the App stopped creating runs at the bound`);
    const item = final.find(entry => entry.submission?.pr === n)!;
    const refusals = (await store.events(item.id)).filter((event: { kind: string; payload: any }) => event.kind === 'merge.enqueue.refused' && event.payload.details.head === first);
    assert.equal(refusals.length, 1, `#${n}: the held verdict is recorded as one refusal of that head`);
    assert.match(refusals[0].payload.details.reason, /GitHub refused to record GY-\d+'s passing verdict: the latest Graphyard \/ merge run at [0-9a-f]{12} reads failure, not success/);
    assert.equal(pr.merged!.head, pr.heads[1].sha);
  }
  // The shared disagreement: exactly one attention item on every cycle with an open item inside the window, none outside it.
  const inside = disagreements.filter(entry => drift(entry.at - cycleMs) && drift(entry.at));
  assert.ok(inside.length > 0 && inside.every(entry => entry.count <= 1), 'never more than one item for the one disagreement');
  assert.ok(inside.some(entry => entry.count === 1 && entry.text.includes('secrets (any app), test (any app), typecheck (any app)') && entry.text.includes(`${CHECK_NAME} (app ${APP})`)), 'the item names both lists');
  assert.deepEqual(disagreements.filter(entry => !drift(entry.at) && !drift(entry.at - cycleMs) && entry.count), [], 'no attention outside the window: it clears once observations agree');
});
