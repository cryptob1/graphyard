import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer as netServer, type AddressInfo } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { readLedgerAsync, uatTagPrefix, writeRecordAsync, type AsyncGit } from '../src/release-candidate.js';
import { defaultChildRun } from '../src/child-runner.js';
import { exactCandidatePorts, localReleasePorts } from '../src/daemon/release-ports.js';
import { settleLocalPromotion } from '../src/daemon/promotion-local.js';
import { masterConfigSchema } from '../src/master.js';
import { Store, save } from '../src/store.js';
import { lockedWork } from '../src/store/locked-read.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { ExactCandidate } from '../src/model/release.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Time-bomb allowance (GY-1904): the 2030-06-01 simulated clock is the ports' and the cycle's injected now; the plane's own clock is
// the database's, so each waiting delivery's merge time is aged by every simulated step instead of read against a calendar date.
/**
 * GY-1904: a real-loop soak of exact candidates. The loop's own promotion cycle drives the production
 * release ports (localReleasePorts) over a real origin and checkout, and those ports cut through the
 * plane's real /api/candidates routes (a server over embedded Postgres) through the loop's own client
 * ports (exactCandidatePorts). Two simulated days of merges arrive in bursts and singles: a backlog of
 * six, lone merges that wait out the bounded wait, a crash between the plane's cut and the `rc` tag,
 * and a plane restart. UAT is simulated (one in four fails). Asserts: every delivered change is in
 * exactly one candidate of at most five, the sixth only in the next; every `rc` record is tagged at
 * its exact candidate's source and carries exactly its members; a partial batch is cut only after the
 * wait; the crashed cut is tagged, not cut past; every candidate holds exactly one verdict, the one its
 * `rc` recorded; and the cut and validation work stays one per candidate. GY-1905: every candidate's
 * checkout declares two combined required cases and each UAT run reports both; production advances,
 * one selection at a time and in cut order, only to candidates that passed both, while a failed one
 * is held and production keeps the previous passing release, through the plane restart. GY-1906:
 * every cycle the plane's own sweep reads production's identity endpoint (GRAPHYARD_PRODUCTION_IDENTITY_URL)
 * once a candidate is selected: a stable identity is verified and appends nothing, drift windows are
 * mismatched while the newest selection stays expected, a failing endpoint records nothing and keeps
 * the last verdict, and identity events and reads stay one per change and one per sweep, through the restart.
 */
const minute = 60_000, day = 24 * 60 * minute, soakStep = 10 * minute, start = Date.parse('2030-06-01T00:00:00Z'), waitMinutes = 15;
const freePort = async () => { const probe = netServer(); await new Promise<void>(done => probe.listen(0, '127.0.0.1', done)); const { port } = probe.address() as AddressInfo; await new Promise<void>(done => probe.close(() => done())); return port; };
const requiredCases = ['soak-home', 'soak-sign-in'];
const operator = { id: 'operator', role: 'admin' as const, token: `operator-${'o'.repeat(40)}` }, coordinator = { id: 'graphyard', role: 'coordinator' as const, token: `coordinator-${'c'.repeat(40)}` };

/** Merges per simulated day, at minutes after midnight; 'crash' cuts on the plane alone, as a loop that died before tagging; 'restart' restarts the plane. */
const days: (number | 'crash' | 'restart')[][] = [
  [9 * 60, 9 * 60, 9 * 60, 9 * 60, 9 * 60, 9 * 60, 13 * 60, 16 * 60, 16 * 60 + 5],
  [10 * 60, 10 * 60, 10 * 60, 10 * 60, 11 * 60 + 50, 'crash', 'restart', 15 * 60, 15 * 60, 15 * 60, 15 * 60, 15 * 60, 15 * 60, 15 * 60],
];

test('unit:soak-exact-candidates — two simulated days of the real promotion cycle cut exact candidates of at most five through the plane, tag each rc at its source, wait out partial batches, resume a crashed cut, survive a plane restart, record one verdict a candidate and promote only candidates passing every combined required case', { timeout: 300_000 }, async () => {
  const root = await realpath(await temporaryDirectory('soak-exact-candidates'));
  const pgPort = await freePort();
  const database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('soak-exact-candidates-pg'), user: 'graphyard', password: 'testing-only', port: pgPort, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('soak_exact');
  // GY-1906: production's identity endpoint, answering what the test's deployment serves; the plane reads it on every sweep.
  let identity: { status: number; body?: unknown } = { status: 500 }, identityReads = 0;
  const endpoint = httpServer((_request, response) => { identityReads += 1; response.writeHead(identity.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(identity.body ?? {})); });
  await new Promise<void>(done => endpoint.listen(0, '127.0.0.1', done));
  const identityUrl = process.env.GRAPHYARD_PRODUCTION_IDENTITY_URL;
  process.env.GRAPHYARD_PRODUCTION_IDENTITY_URL = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/identity`;
  let store: Store, http: ReturnType<typeof server>, url = '';
  const startPlane = async () => {
    store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${pgPort}/soak_exact`); await store.init();
    http = server(new Engine(store, 120, 'owner/project'), [operator, coordinator]);
    await new Promise<void>(done => http.listen(0, '127.0.0.1', done));
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  };
  const stopPlane = async () => { await new Promise<void>(done => http.close(() => done())); await store.close(); };
  await startPlane();
  try {
    const origin = join(root, 'origin.git'), checkout = join(root, 'checkout'), managed = join(root, 'managed');
    await mkdir(managed, { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
    const git = (...args: string[]) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const asyncGit: AsyncGit = async args => git(...args);
    for (const [key, value] of [['user.email', 't@example.com'], ['user.name', 'T'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) git('config', key, value);
    await writeFile(join(checkout, 'README.md'), '# Fixture\n');
    // GY-1905: the two combined required cases every candidate's own checkout declares.
    await mkdir(join(checkout, 'e2e', 'cases'), { recursive: true });
    // A failed candidate is held, not reverted: the soak judges promotion, and the revert path has its own tests (release-failure-action).
    await writeFile(join(checkout, 'graphyard.json'), `${JSON.stringify({ release: { onFailure: 'hold' } })}\n`);
    for (const id of requiredCases) await writeFile(join(checkout, 'e2e', 'cases', `${id}.json`), `${JSON.stringify({ id, title: id, tags: ['soak'], target: 'uat', required: true, steps: [{ kind: 'browser', action: 'open', path: '/' }] })}\n`);
    git('add', '.'); git('commit', '-q', '-m', 'base'); git('push', '-q', 'origin', 'main'); git('fetch', '-q', 'origin');
    const baseSha = git('rev-parse', 'HEAD');

    // The plane's client as the loop's: the coordinator posts under a request id, and a refusal is thrown as master's client throws it.
    const api = async (method: string, path: string, credential: string, body?: unknown, key?: string) => {
      const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(JSON.stringify(result)), { confirmedRefusal: response.status < 500 });
      return result;
    };
    let requests = 0;
    const candidatePorts = exactCandidatePorts((path, data, key) => { requests += 1; return api('POST', path, coordinator.token, data, key); }, path => { requests += 1; return api('GET', path, coordinator.token); });

    // A merge on main, delivered on the plane: an item created through the API, recorded done with its real merge commit.
    let merges = 0;
    const delivered: { id: string; key: string; mergeSha: string; at: number }[] = [];
    const merge = async (at: number) => {
      merges += 1;
      const branch = `graphyard/soak-${merges}`;
      git('checkout', '-q', '-b', branch, 'refs/remotes/origin/main');
      await writeFile(join(checkout, `change-${merges}.txt`), `${merges}\n`); git('add', '.'); git('commit', '-q', '-m', `change ${merges}`);
      git('checkout', '-q', '--detach', 'refs/remotes/origin/main');
      git('merge', '-q', '--no-ff', branch, '-m', `Merge pull request #${merges} from owner/${branch}`);
      git('push', '-q', 'origin', 'HEAD:main'); git('fetch', '-q', 'origin');
      const mergeSha = git('rev-parse', 'HEAD');
      const item = await api('POST', 'work', operator.token, { title: `Soak change ${merges}`, description: 'A change delivered to main.', type: 'feature', priority: 3,
        policy: { checks: ['test'], review: true }, criteria: [{ id: 'AC-1', text: 'Delivered', proofs: ['unit:delivered'] }] }, `work-${merges}`);
      await store.transaction(async (db, now) => {
        const work = (await lockedWork(db, [item.id])).find(entry => entry.id === item.id)!;
        work.stage = 'done'; work.delivery = { mergedAt: now.toISOString(), mergeSha, authorizationRevision: work.revision };
        await save(db, work, 'graphyard', 'merge-writer.reconciled', now, { mergeSha });
      });
      delivered.push({ id: item.id, key: item.key, mergeSha, at });
      return mergeSha;
    };
    // The plane reads a delivery's wait against its own clock: every simulated step ages each delivery no candidate holds yet.
    const age = async (ms: number) => {
      const taken = new Set(((await api('GET', 'candidates', coordinator.token)).candidates as ExactCandidate[]).flatMap(candidate => candidate.members.map(member => member.workId)));
      const waiting = delivered.filter(entry => !taken.has(entry.id)).map(entry => entry.id);
      if (!waiting.length) return;
      await store.transaction(async (db, now) => {
        for (const read of await lockedWork(db, waiting)) {
          const work = structuredClone(read);
          work.delivery = { ...work.delivery!, mergedAt: new Date(Date.parse(work.delivery!.mergedAt) - ms).toISOString() };
          await save(db, work, 'test', 'test.aged', now);
        }
      });
    };

    let clock = start;
    const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
      repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { candidates: { idleMinutes: waitMinutes }, mergeWriter: { deployKeyFile: join('/keys', 'deploy'), retrials: 2 } } });
    const validated: string[] = [];
    // Only UAT itself is simulated: the cut, the plane, the verdict's record and the promotion are the production ports.
    const validation = {
      uat: async (id: string) => ({ sha: (await readLedgerAsync(asyncGit)).candidates.find(entry => entry.id === id)!.sha }),
      validate: async (id: string) => {
        const entry = (await readLedgerAsync(asyncGit)).candidates.find(candidate => candidate.id === id)!;
        validated.push(id);
        const passed = validated.length % 4 !== 0;
        // Every combined required case runs; a failed candidate fails the sign-in case alone.
        const cases = requiredCases.map(name => ({ case: name, verdict: passed || name !== 'soak-sign-in' ? 'passed' as const : 'failed' as const, required: true, attempts: 1, failingStep: null }));
        const record = { id, sha: entry.sha, result: passed ? 'passed' as const : 'failed' as const, deployedSha: entry.sha, at: new Date(clock).toISOString(),
          suites: [{ name: 'e2e', passed, detail: passed ? 'ok' : 'sign-in failed' }], followUp: null,
          e2e: { runId: `run-${validated.length}`, sha: entry.sha, blocking: passed ? [] : ['soak-sign-in'], cases } };
        await writeRecordAsync(asyncGit, `${uatTagPrefix}${id}`, entry.sha, record, true);
        return { record, followUp: null };
      },
    };
    const ports = () => localReleasePorts(config, checkout, defaultChildRun, { base: managed, record: async () => ({}), environment: { ...process.env, GRAPHYARD_UAT_URL: 'https://uat.example.test' }, now: () => clock,
      plane: { goals: async () => [], stage: async () => undefined, candidates: candidatePorts }, validation })!;

    let state = null as Awaited<ReturnType<typeof settleLocalPromotion>>['state'] | null;
    let crashed: ExactCandidate | null = null, cycles = 0;
    const productionTip = () => { try { return execFileSync('git', ['-C', origin, 'rev-parse', '--verify', '--quiet', 'refs/heads/release/production'], { encoding: 'utf8' }).trim(); } catch { return null; } };
    const served: (string | null)[] = [];
    type Selection = { candidate: string; promotion: { releaseId: string; sourceSha: string; artifact: string } };
    const live = { sweeps: 0, failures: 0, drifts: 0, recorded: 0, verified: 0, recovered: 0, drifted: false, lastKey: null as string | null, lastRecordedFor: null as string | null, last: null as { candidate: string; status: string } | null };
    for (const [index, schedule] of days.entries()) {
      const dayStart = start + (index + 1) * day;
      const pending = [...schedule];
      for (let at = dayStart + 8 * 60 * minute; at < dayStart + 20 * 60 * minute; at += soakStep) {
        if (clock < at) await age(at - Math.max(clock, at - soakStep));
        clock = at;
        while (pending.length && (typeof pending[0] !== 'number' || dayStart + pending[0] * minute <= clock)) {
          const next = pending.shift()!;
          if (next === 'crash') crashed = await api('POST', 'candidates', coordinator.token, { trigger: 'manual' }, 'crashed-cut');
          else if (next === 'restart') { await stopPlane(); await startPlane(); }
          else await merge(dayStart + next * minute);
        }
        const tip = git('rev-parse', 'refs/remotes/origin/main');
        const local = ports();
        const reads = { ledger: async () => { const ledger = await readLedgerAsync(asyncGit); return { mainSha: tip, promotedSha: ledger.production[0]?.sha ?? null, promotedAt: null, behind: null,
          candidates: ledger.candidates.map(entry => ({ id: entry.id, sha: entry.sha, cutAt: entry.cutAt, prs: entry.prs ?? entry.items.length, queued: entry.queued ?? 0 })) }; },
          runs: async () => [], dispatch: async () => { throw new Error('no dispatch in control-plane mode'); }, local };
        const result = await settleLocalPromotion(state, reads, { now: clock, everyMinutes: 10, intervalMs: 120_000, frozen: null, watchedTip: tip });
        assert.equal(result.failure, null, `${new Date(clock).toISOString()}: ${result.state.reason ?? ''}`);
        state = result.state; cycles += 1;
        assert.equal(state.inFlight, false, 'every cycle settles its candidate');
        served.push(productionTip());

        // GY-1906: the plane's sweep reads production's live identity; the endpoint answers what release/production serves,
        // drifts to another release for two cycles in every 31, and fails one cycle in every 13.
        const selections = (await store!.pool.query("SELECT payload FROM events WHERE kind='release.candidate.promotion' ORDER BY seq")).rows.map(row => row.payload as Selection);
        const newest = selections.at(-1) ?? null, tipNow = served.at(-1);
        const mode = cycles % 13 === 7 ? 'fail' : cycles % 31 === 20 || cycles % 31 === 21 ? 'drift' : 'serve';
        const runs = [...selections].reverse().find(entry => entry.promotion.sourceSha === tipNow) ?? null;
        const body = mode === 'drift' ? { release: 'rc-drifted', sourceSha: baseSha, artifact: newest?.promotion.artifact } : runs ? { release: runs.promotion.releaseId, sourceSha: runs.promotion.sourceSha, artifact: runs.promotion.artifact } : { sourceSha: baseSha };
        identity = mode === 'fail' ? { status: 500 } : { status: 200, body };
        const readsBefore = identityReads;
        const swept = await api('POST', 'delivery/sweep', operator.token, {}, `sweep-${cycles}`);
        const view = (await api('GET', 'delivery', coordinator.token)).environments.find((entry: { id: string }) => entry.id === 'production');
        const when = new Date(clock).toISOString();
        if (!newest) { assert.equal(swept.live, undefined, `${when}: nothing selected, nothing read`); assert.equal(identityReads, readsBefore); continue; }
        live.sweeps += 1;
        assert.equal(identityReads, readsBefore + 1, `${when}: one identity read a sweep`);
        assert.deepEqual([view.expected.candidate, view.expected.sourceSha], [newest.candidate, newest.promotion.sourceSha], `${when}: the newest selection stays expected`);
        const status = view.verification.status as string;
        if (mode === 'fail') {
          live.failures += 1;
          assert.match(swept.live.error, /answered 500/); assert.equal(swept.live.recorded, false);
          assert.equal(status, live.last?.candidate === newest.candidate ? live.last.status : 'unobserved', `${when}: a failed read keeps the last verdict`);
        } else {
          const key = JSON.stringify(body), recorded = key !== live.lastKey || live.lastRecordedFor !== newest.candidate;
          assert.equal(swept.live.recorded, recorded, `${when}: an identity is appended only when it changes or a newer selection awaits it`);
          if (recorded) { live.recorded += 1; live.lastKey = key; live.lastRecordedFor = newest.candidate; }
          if (mode === 'drift') {
            live.drifts += 1;
            assert.equal(status, 'mismatched', `${when}: drift`);
            assert.match(view.verification.reasons.join(' '), new RegExp(`Production serves source ${baseSha}, not ${newest.promotion.sourceSha}.*The expected release is still candidate ${newest.candidate}`));
          } else assert.equal(status, tipNow === newest.promotion.sourceSha ? 'verified' : 'mismatched', `${when}: production serves ${tipNow}`);
        }
        if (status === 'verified') { live.verified += 1; if (live.drifted) live.recovered += 1; }
        if (mode !== 'fail') live.drifted = mode === 'drift' || (live.drifted && status !== 'verified');
        live.last = { candidate: newest.candidate, status };
      }
    }

    const ledger = await readLedgerAsync(asyncGit);
    const plane = (await api('GET', 'candidates', coordinator.token)).candidates.slice().reverse() as ExactCandidate[];
    // Every delivered change is in exactly one candidate of at most five, in merge order; nothing waits at the end.
    const members = plane.flatMap(candidate => candidate.members.map(member => member.workId));
    assert.deepEqual(members, delivered.map(entry => entry.id), 'every delivered change taken once, in merge order: none lost, none repeated');
    assert.ok(plane.every(candidate => candidate.members.length >= 1 && candidate.members.length <= 5), JSON.stringify(plane.map(candidate => candidate.members.length)));
    assert.equal((await api('GET', 'candidates', coordinator.token)).waiting, 0);
    // The burst of six: five in one candidate, the sixth the whole of the next.
    assert.deepEqual(plane[0].members.map(member => member.workId), delivered.slice(0, 5).map(entry => entry.id));
    assert.deepEqual(plane[1].members.map(member => member.workId), [delivered[5].id]);
    // A partial batch is cut only once its oldest change has waited the bounded wait, never before.
    for (const candidate of plane.filter(entry => entry.members.length < 5 && entry.trigger === 'schedule')) {
      const oldest = delivered.find(entry => entry.id === candidate.members[0].workId)!;
      const record = ledger.candidates.find(entry => entry.exact?.id === candidate.id)!;
      assert.ok(Date.parse(record.cutAt) - oldest.at >= waitMinutes * minute, `${candidate.id} waited ${(Date.parse(record.cutAt) - oldest.at) / minute} minutes`);
    }
    // The crashed cut was tagged next, not cut past, and the plane restart lost nothing.
    assert.ok(crashed, 'the crash step ran');
    assert.ok(ledger.candidates.some(entry => entry.exact?.id === crashed!.id), `the crashed cut ${crashed!.id} was tagged`);
    // Every rc record is tagged at its exact candidate's source, carries exactly its members, and its source holds them all.
    assert.equal(ledger.candidates.length, plane.length, 'one rc record a candidate');
    for (const candidate of plane) {
      const record = ledger.candidates.find(entry => entry.exact?.id === candidate.id);
      assert.ok(record, `${candidate.id} was tagged`);
      assert.equal(record.sha, candidate.sourceSha); assert.equal(record.exact!.identity, candidate.identity);
      assert.deepEqual(record.exact!.members.map(member => member.mergeSha), candidate.members.map(member => member.mergeSha));
      assert.deepEqual(record.items.map(item => item.mergeSha), [...candidate.members].reverse().map(member => member.mergeSha));
      for (const member of candidate.members) git('merge-base', '--is-ancestor', member.mergeSha, record.sha);
      // Each candidate holds exactly the verdict its rc recorded.
      const uat = ledger.uat.find(entry => entry.id === record.id)!;
      assert.deepEqual(candidate.validation && { release: candidate.validation.release, sha: candidate.validation.sha, identity: candidate.validation.identity, result: candidate.validation.result },
        { release: record.id, sha: record.sha, identity: candidate.identity, result: uat.result === 'passed' ? 'pass' : 'fail' });
    }
    // GY-1905: production advances only to candidates whose every combined required case passed, each selected once, in cut order;
    // a failed candidate is never selected and production keeps the previous passing release, through the plane restart.
    const passing = plane.filter(candidate => candidate.validation?.result === 'pass'), failing = plane.filter(candidate => candidate.validation?.result === 'fail');
    assert.ok(passing.length >= 3 && failing.length >= 1, `the soak judged both outcomes: ${passing.length} passing, ${failing.length} failing`);
    const promotions = (await store!.pool.query("SELECT payload FROM events WHERE kind='release.candidate.promotion' ORDER BY seq")).rows.map(row => row.payload as { candidate: string; sequence: number; promotion: { sourceSha: string; required: string[] } });
    const promoted = promotions.map(entry => entry.candidate);
    assert.ok(promoted.every(id => passing.some(candidate => candidate.id === id)), `only passing candidates were selected: ${promoted.join(', ')}`);
    assert.equal(new Set(promoted).size, promoted.length, 'each candidate selected at most once');
    assert.deepEqual(promotions.map(entry => entry.sequence), [...promotions.map(entry => entry.sequence)].sort((a, b) => a - b), 'selections advance in cut order, never back');
    assert.ok(promotions.every(entry => JSON.stringify(entry.promotion.required) === JSON.stringify(requiredCases)), 'each selection names every combined required case');
    assert.ok(promoted.length >= passing.length - 1, `production kept up with passing candidates: ${promoted.length} of ${passing.length} selected`);
    const shipped = new Set(promotions.map(entry => entry.promotion.sourceSha));
    assert.ok(served.every(sha => sha === null || shipped.has(sha)), 'production only ever served a selected passing candidate');
    assert.equal(served.at(-1), promotions.at(-1)!.promotion.sourceSha, 'production serves the newest selection');
    for (const candidate of failing) assert.ok(!shipped.has(candidate.sourceSha), `failed ${candidate.id} never served`);
    const delivery = (await api('GET', 'delivery', coordinator.token)).environments.find((entry: { id: string }) => entry.id === 'production');
    assert.equal(delivery.expected.sourceSha, promotions.at(-1)!.promotion.sourceSha, 'the delivery view expects the newest passing selection');
    // Bounded work: one UAT validation a candidate, and plane calls bounded by the cycles.
    assert.deepEqual([...validated].sort(), ledger.candidates.map(entry => entry.id).sort(), 'each rc ran UAT exactly once');
    assert.ok(requests <= cycles * 4 + plane.length * 5, `plane requests stay bounded (${requests} over ${cycles} cycles)`);
    // GY-1906: the live identity reads judged stable identities, drift and endpoint failures, and stayed one read a sweep and one event a change.
    assert.ok(live.failures >= 3 && live.drifts >= 2 && live.recovered >= 1 && live.verified >= live.sweeps / 2, JSON.stringify(live));
    assert.equal(identityReads, live.sweeps, 'one identity read per sweep with a selection, none before');
    assert.equal((await store!.pool.query("SELECT count(*)::int AS n FROM events WHERE kind='delivery.identity-observed'")).rows[0].n, live.recorded, 'identity events are exactly the changes');
    assert.ok(live.recorded <= promoted.length + 2 * live.drifts + 1, `identity events stay bounded by selections and drift: ${live.recorded}`);
    assert.equal(delivery.verification.status, live.last!.status, 'the delivery view reads the last sweep\'s verdict');
    const events = await store!.pool.query("SELECT kind, count(*)::int AS n FROM events WHERE kind LIKE 'release.candidate%' GROUP BY kind ORDER BY kind");
    assert.deepEqual(events.rows, [{ kind: 'release.candidate', n: plane.length }, { kind: 'release.candidate.promotion', n: promoted.length }, { kind: 'release.candidate.validation', n: plane.length }], 'one immutable cut and one verdict a candidate, one selection a promoted one');
  } finally {
    await stopPlane().catch(() => {});
    await new Promise<void>(done => endpoint.close(() => done()));
    if (identityUrl === undefined) delete process.env.GRAPHYARD_PRODUCTION_IDENTITY_URL; else process.env.GRAPHYARD_PRODUCTION_IDENTITY_URL = identityUrl;
    await database.stop();
    await rm(root, { recursive: true, force: true });
  }
});
