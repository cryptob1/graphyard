import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal } from '../src/model.js';
import { assessPromotion, cut, deployToUat, gitIn, productionBranch, promote, readLedgerAsync, uatTagPrefix, uatValidationWindowMs, validateAndRecord, writeRecordAsync, type AsyncGit, type ReleaseCandidate, type UatRecord } from '../src/release-candidate.js';
import { defaultChildRun } from '../src/child-runner.js';
import { localReleasePorts } from '../src/daemon/release-ports.js';
import { settleLocalPromotion } from '../src/daemon/promotion-local.js';
import { masterConfigSchema } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1860: a producer imports an external run through POST /api/validation/import. The plane binds
// it to the release candidate whose head is exactly the run's sha (read from the `rc/` tags through
// the GitHub adapter), refuses any other credential and any sha no candidate was cut at, keeps every
// verdict — skipped stays skipped — with the run's provenance, idempotently by run id, and the
// imports leave the candidate's hold exactly as importedRunVerdict judges them.

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const reader: Principal = { id: 'auditor', role: 'reader' };
const producer: Principal = { id: 'huck-producer', role: 'producer' };
const principals = [operator, worker, reader, producer];
const tokens = new Map(principals.map(p => [p.id, `${p.id}-${'t'.repeat(40)}`]));

// Three candidates cut at three heads; `elsewhere` is a commit no candidate holds.
const boundSha = 'a'.repeat(40), holdSha = 'b'.repeat(40), versionSha = 'c'.repeat(40), elsewhere = 'd'.repeat(40);
const candidates = [
  { id: '20261017T010000Z', sha: boundSha }, { id: '20261017T020000Z', sha: holdSha }, { id: '20261017T030000Z', sha: versionSha },
].map(entry => ({ ...entry, cutAt: `${entry.id.slice(0, 4)}-${entry.id.slice(4, 6)}-${entry.id.slice(6, 8)}T${entry.id.slice(9, 11)}:00:00.000Z`, trigger: 'manual', since: null, items: [] })) as Pick<ReleaseCandidate, 'id' | 'sha' | 'cutAt'>[];
const tagObject = (index: number) => String(index + 1).repeat(40);
/** The GitHub reads the import makes: the `rc/` tag refs, and each annotated tag carrying its candidate record. `down` fails every read. */
const github = {
  config: { repository: 'owner/project' }, down: false, reads: 0,
  async request(path: string) {
    github.reads++;
    if (github.down) throw new Error('GitHub is unreachable');
    if (path.startsWith('/git/matching-refs/tags/rc/')) return /page=1(?:&|$)/.test(path) ? candidates.map((entry, index) => ({ ref: `refs/tags/rc/${entry.id}`, object: { sha: tagObject(index), type: 'tag' } })) : [];
    const index = candidates.findIndex((_, i) => path === `/git/tags/${tagObject(i)}`);
    if (index >= 0) return { object: { sha: candidates[index].sha, type: 'commit' }, message: JSON.stringify(candidates[index]) };
    throw new Error(`unexpected GitHub read ${path}`);
  },
};

let database: EmbeddedPostgres, store: Store, http: ReturnType<typeof server>, url: string, scratch: string;

before(async () => {
  const port = Number(process.env.GRAPHYARD_VALIDATION_IMPORT_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1860);
  scratch = await temporaryDirectory('validation-import');
  database = new EmbeddedPostgres({ databaseDir: join(scratch, 'pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('validation_import_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/validation_import_test`); await store.init();
  const engine = new Engine(store, [15368], 120, 'owner/project');
  http = server(engine, principals.map(p => ({ ...p, token: tokens.get(p.id)! })), github as any);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); if (scratch) await rm(scratch, { recursive: true, force: true }); });

async function call(path: string, actor: Principal, data?: unknown) {
  const response = await fetch(`${url}/api/${path}`, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${tokens.get(actor.id)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: data === undefined ? undefined : JSON.stringify(data) });
  return { status: response.status, body: await response.json() as any };
}
const imported = async (data: unknown) => { const result = await call('validation/import', producer, data); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
const hold = async (sha: string) => (await call(`validation/import/${sha}`, reader)).body.hold;
/** `GET /api/PATH` as the CLI's api reads it: a refusal throws with its status. */
const readAs = (actor: Principal) => async (path: string) => {
  const { status, body } = await call(path, actor);
  if (status >= 400) throw Object.assign(new Error(JSON.stringify(body)), { status });
  return body;
};

/** A bare origin and a clone with one commit on main, for a real release ledger. */
async function repository() {
  const root = await temporaryDirectory('validation-import-ledger');
  const origin = join(root, 'origin.git'), work = join(root, 'work');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, work);
  for (const [key, value] of [['user.name', 'test'], ['user.email', 'test@example.test'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) git(work, 'config', key, value);
  git(work, 'commit', '-q', '--allow-empty', '-m', 'initial');
  git(work, 'push', '-q', 'origin', 'HEAD:main');
  return { origin, git: gitIn(work) };
}

const run = (sha: string, runId: string, cases: readonly Record<string, unknown>[], over: Record<string, unknown> = {}) =>
  ({ format: 'graphyard-external-run-v1', producer: 'huck-engineer', runId, sha, cases, ...over });
const trace = 'https://huck.example/runs/r-1/checkout-guest/trace';

test('unit:validation-import-route-binds-by-sha — POST /api/validation/import refuses a non-producer credential and a sha no candidate holds, and persists a producer run at a candidate head idempotently with every verdict, skipped kept, and its provenance', async () => {
  const handIn = run(boundSha, 'huck-run-1', [
    { id: 'checkout-guest', verdict: 'passed', attempts: 1, durationMs: 4310, required: true, result: 'PASS', evidence: [trace] },
    { id: 'search-facet', verdict: 'skipped', attempts: 0, durationMs: 0, result: 'SKIPPED_BY_TAG' },
    { id: 'checkout-card', verdict: 'blocked', attempts: 0, durationMs: 0, reason: 'the payment sandbox was unreachable', result: 'ENV_MISSING' },
  ], { toolVersion: 'huck-engineer 4.2.1', result: 'PARTIAL', environment: 'uat' });

  for (const actor of [worker, reader, operator]) {
    const refused = await call('validation/import', actor, handIn);
    assert.equal(refused.status, 403, `${actor.role} is refused`);
    assert.match(refused.body.error, /producer credential is required/);
  }
  const unbound = await call('validation/import', producer, { ...handIn, sha: elsewhere, runId: 'huck-run-elsewhere' });
  assert.equal(unbound.status, 409);
  assert.match(unbound.body.error, new RegExp(`No release candidate was cut at ${elsewhere}`));
  assert.equal(((await call(`validation/import/${elsewhere}`, reader)).body.runs).length, 0, 'a refused run is never recorded');

  const first = await imported(handIn);
  assert.equal(first.replayed, false);
  assert.deepEqual(first.imported.candidate, { id: candidates[0].id, sha: boundSha }, 'the run binds to the candidate cut at its exact head');
  assert.equal(first.imported.importedBy, producer.id);
  const record = first.imported.run;
  assert.equal(record.runId, 'huck-run-1');
  assert.equal(record.producer, 'huck-engineer');
  assert.equal(record.toolVersion, 'huck-engineer 4.2.1');
  assert.equal(record.result, 'PARTIAL');
  assert.deepEqual(record.cases.map((entry: any) => [entry.id, entry.verdict, entry.result]),
    [['checkout-guest', 'passed', 'PASS'], ['search-facet', 'skipped', 'SKIPPED_BY_TAG'], ['checkout-card', 'blocked', 'ENV_MISSING']], 'every verdict as given, skipped never flattened to blocked or unrun');
  assert.deepEqual(record.cases[0].evidence, [trace]);
  assert.equal(record.cases[2].reason, 'the payment sandbox was unreachable');

  const read = (await call(`validation/import/${boundSha}`, reader)).body;
  assert.equal(read.runs.length, 1);
  assert.deepEqual(read.runs[0].run, record, 'the persisted record keeps the run as imported');

  const again = await imported(handIn);
  assert.equal(again.replayed, true, 'the same run again replays its record');
  assert.deepEqual(again.imported, first.imported);
  assert.equal((await call(`validation/import/${boundSha}`, reader)).body.runs.length, 1, 'a replay writes nothing');
  const changed = await call('validation/import', producer, { ...handIn, cases: handIn.cases.slice(0, 1) });
  assert.equal(changed.status, 409);
  assert.match(changed.body.error, /already imported with a different document/);

  // A committed run replays from its record: no GitHub read, so a replay succeeds while GitHub is unreachable.
  github.down = true; const reads = github.reads;
  try {
    const offline = await imported(handIn);
    assert.equal(offline.replayed, true);
    assert.deepEqual(offline.imported, first.imported, 'the replay carries the candidate the run bound to');
    assert.equal(github.reads, reads, 'a replay reads nothing from GitHub');
    assert.equal((await call(`validation/import/${boundSha}`, reader)).body.runs.length, 1, 'an offline replay writes nothing');
    const offlineChanged = await call('validation/import', producer, { ...handIn, cases: handIn.cases.slice(0, 1) });
    assert.equal(offlineChanged.status, 409, 'a different document under a used run id is still refused');
    assert.match(offlineChanged.body.error, /already imported with a different document/);
    const fresh = await call('validation/import', producer, { ...handIn, runId: 'huck-run-new' });
    assert.notEqual(fresh.status, 200, 'a first import needs the ledger read');
  } finally { github.down = false; }
});

test('unit:validation-import-feeds-hold — a required failed, blocked or unrun case holds the candidate, an all-passing run releases it, and skipped follows the required-case rule', async () => {
  const passing = (id: string) => ({ id, verdict: 'passed', attempts: 1, durationMs: 100, required: true });
  assert.equal((await hold(holdSha)).held, false, 'no import, no hold');

  const held = await imported(run(holdSha, 'hold-1', [
    passing('login'),
    { id: 'pay', verdict: 'failed', attempts: 1, durationMs: 100, required: true },
    { id: 'ship', verdict: 'blocked', attempts: 0, durationMs: 0, required: true, reason: 'no carrier sandbox' },
    { id: 'refund', verdict: 'unrun', attempts: 0, durationMs: 0, required: true },
    { id: 'export', verdict: 'skipped', attempts: 0, durationMs: 0, required: true },
    { id: 'theme', verdict: 'skipped', attempts: 0, durationMs: 0 },
    { id: 'avatar', verdict: 'failed', attempts: 1, durationMs: 100 },
  ]));
  assert.equal(held.verdict.passed, false);
  assert.equal(held.hold.held, true);
  assert.deepEqual(held.hold.cases.map((entry: any) => [entry.id, entry.verdict]).sort(),
    [['export', 'skipped'], ['pay', 'failed'], ['refund', 'unrun'], ['ship', 'blocked']], 'required failed, blocked, unrun and skipped hold; optional skipped and failed do not');
  assert.equal(held.hold.cases.find((entry: any) => entry.id === 'ship').reason, 'no carrier sandbox');
  assert.deepEqual(await hold(holdSha), held.hold, 'the read gives the same hold');

  const partly = await imported(run(holdSha, 'hold-2', [passing('pay'), passing('ship')]));
  assert.deepEqual(partly.hold.cases.map((entry: any) => entry.id).sort(), ['export', 'refund'], 'a later pass releases only the cases it reports');

  const released = await imported(run(holdSha, 'hold-3', ['login', 'pay', 'ship', 'refund', 'export'].map(passing)));
  assert.equal(released.verdict.passed, true);
  assert.deepEqual(released.hold, { held: false, cases: [], runs: 3 }, 'an all-passing run releases the candidate');
  assert.equal((await hold(boundSha)).runs, 1, 'the hold is per candidate: another head counts only its own imports');

  // The hold feeds promotion: a real candidate, cut, deployed and passed on UAT, is refused production while an import holds it.
  const { promotionImports } = await import('../src/validation-import.js');
  const repo = await repository();
  const { candidate } = cut(repo.git, { base: 'main', trigger: 'manual', now: new Date('2026-10-01T12:00:00Z'), push: true }) as { candidate: ReleaseCandidate };
  deployToUat(repo.git, candidate.id, 'main');
  const serving = (async () => new Response(JSON.stringify({ ok: true, commit: candidate.sha }))) as unknown as typeof fetch;
  const uat = await validateAndRecord(repo.git, candidate.id, 'https://uat.example.test', [{ name: 'smoke', run: async () => ({ name: 'smoke', passed: true, detail: 'ok' }) }],
    { base: 'main', push: true, timeoutMs: 60_000, fetcher: serving, sleep: async () => {}, now: () => new Date('2026-10-01T12:30:00Z') });
  assert.equal(uat.record.result, 'passed', 'UAT alone would promote it');
  candidates.push(candidate);
  const promoteNow = async () => promote(repo.git, candidate.id, { base: 'main', push: true, now: new Date('2026-10-01T13:00:00Z'), imported: await promotionImports(readAs(reader), candidate) });
  const productionTip = () => { try { return execFileSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${productionBranch}`], { cwd: repo.origin, encoding: 'utf8' }).trim(); } catch { return null; } };

  await imported(run(candidate.sha, 'promote-1', [passing('login'), { id: 'pay', verdict: 'failed', attempts: 1, durationMs: 100, required: true }]));
  const refused = await promoteNow();
  assert.equal(refused.promoted, false, 'a required failed import holds the candidate out of production');
  assert.match((refused as any).refusals.join('\n'), new RegExp(`held by imported external runs at ${candidate.sha}: pay \\(failed in run promote-1\\)`));
  assert.equal(productionTip(), null, 'production did not move');

  await imported(run(candidate.sha, 'promote-2', [passing('login'), { id: 'pay', verdict: 'skipped', attempts: 0, durationMs: 0, required: true }]));
  assert.equal((await promoteNow()).promoted, false, 'a required skipped case still holds it');

  const unread = assessPromotion(candidate, uat.record as UatRecord, null, [], await promotionImports(async () => { throw new Error('plane unreachable'); }, candidate));
  assert.equal(unread.promotable, false, 'a hold that cannot be read is never read as released');
  assert.match(unread.refusals.join('\n'), /could not be read \(plane unreachable\)/);

  await imported(run(candidate.sha, 'promote-3', [passing('login'), passing('pay')]));
  const promoted = await promoteNow();
  assert.equal(promoted.promoted, true, 'a covering passing import releases the restriction');
  assert.equal(productionTip(), candidate.sha);
});

test('unit:validation-import-case-version-not-inferred — catalogCommitSha is stored as provenance only and never read into a case version', async () => {
  const catalog = 'e'.repeat(40);
  const result = await imported(run(versionSha, 'version-1', [
    { id: 'login', verdict: 'passed', attempts: 1, durationMs: 100, required: true },
    { id: 'pay', verdict: 'passed', attempts: 1, durationMs: 100, required: true, caseVersion: 'pay@7' },
  ], { catalogCommitSha: catalog }));
  const stored = (await call(`validation/import/${versionSha}`, reader)).body.runs[0].run;
  for (const record of [result.imported.run, stored]) {
    assert.equal(record.catalogCommitSha, catalog, 'the catalog commit is kept as provenance');
    assert.equal(record.cases[0].caseVersion, null, 'no case version given: it stays null, never inferred from the catalog commit');
    assert.equal(record.cases[1].caseVersion, 'pay@7', 'a given case version is kept as given');
  }
});

/**
 * GY-1860: a real-loop soak of the imported-run hold. The loop's own promotion cycle drives the
 * production release ports (localReleasePorts) over a real origin and checkout — the real cut and
 * the real promote, which reads each candidate's hold through the plane — one merge a simulated day
 * and a cycle every ten minutes. UAT is simulated and always passes; the plane answers each
 * candidate's hold from a script: held, unread, released, no import route, or held for good. Asserts
 * that a held or unread candidate is never promoted, that it is retried with a fresh hold read once a
 * promotion interval and promoted once its hold is released, without UAT rerunning; that a candidate
 * held past the UAT window stops being read and a newer cut supersedes it; and that no candidate is
 * validated or recorded in production twice.
 */
const day = 24 * 3_600_000, soakStep = 10 * 60_000, start = Date.parse('2030-06-01T00:00:00Z');
type Answer = 'held' | 'unread' | 'released' | 'absent';
// Each day's candidate: the answers its hold reads give in turn, the last repeating.
const holdScripts: Answer[][] = [
  ['held', 'held', 'released'],
  ['unread', 'unread', 'released'],
  ['held', 'unread', 'held', 'released'],
  ['absent'],
  ['held'],
  ['released'],
];

test('unit:soak-validation-import-hold — the real promotion cycle retries a held or unread candidate with a fresh hold read, promotes it once released without rerunning UAT, and never promotes a held candidate or writes twice', { timeout: 300_000 }, async () => {
  const root = await realpath(await temporaryDirectory('soak-import-hold'));
  try {
    const origin = join(root, 'origin.git'), checkout = join(root, 'checkout'), managed = join(root, 'managed');
    await mkdir(managed, { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
    const git = (...args: string[]) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const asyncGit: AsyncGit = async args => git(...args);
    for (const [key, value] of [['user.email', 't@example.com'], ['user.name', 'T'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) git('config', key, value);
    await writeFile(join(checkout, 'README.md'), '# Fixture\n');
    git('add', '.'); git('commit', '-q', '-m', 'base'); git('push', '-q', 'origin', 'main'); git('fetch', '-q', 'origin');
    const merge = async (n: number) => {
      const branch = `graphyard/gy-${9100 + n}-1`;
      git('checkout', '-q', '-b', branch, 'refs/remotes/origin/main');
      await writeFile(join(checkout, `change-${n}.txt`), `${n}\n`); git('add', '.'); git('commit', '-q', '-m', `GY-${9100 + n} change`);
      git('checkout', '-q', '--detach', 'refs/remotes/origin/main');
      git('merge', '-q', '--no-ff', branch, '-m', `Merge pull request #${n} from owner/${branch}`, '-m', `GY-${9100 + n}: the change`);
      git('push', '-q', 'origin', 'HEAD:main'); git('fetch', '-q', 'origin');
      return git('rev-parse', 'HEAD');
    };

    // The plane: each candidate's hold, answered from its day's script; every read is logged.
    let clock = start;
    const dayOf = new Map<string, number>();
    const reads: { day: number; id: string; at: number; answer: Answer }[] = [];
    const read = async (path: string) => {
      const [, sha = '', id = ''] = /^validation\/import\/([a-f0-9]{40})\?candidate=(.+)$/.exec(path) ?? [];
      const n = dayOf.get(sha);
      assert.ok(n !== undefined, `the hold read names a candidate head: ${path}`);
      const script = holdScripts[n - 1], answer = script[Math.min(reads.filter(entry => entry.day === n).length, script.length - 1)];
      reads.push({ day: n, id: decodeURIComponent(id), at: clock, answer });
      if (answer === 'unread') throw Object.assign(new Error('the plane is unavailable'), { status: 503 });
      if (answer === 'absent') throw Object.assign(new Error('no import route'), { status: 404 });
      return { hold: answer === 'held' ? { held: true, cases: [{ id: 'checkout', verdict: 'failed', runId: `run-${n}` }] } : { held: false, cases: [] } };
    };
    const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
      repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { candidates: { everyMerges: 1, idleMinutes: 15 }, mergeWriter: { deployKeyFile: join('/keys', 'deploy'), retrials: 2 } } });
    const ports = () => localReleasePorts(config, checkout, defaultChildRun, { base: managed, record: async () => ({}), environment: { ...process.env, GRAPHYARD_UAT_URL: 'https://uat.example.test' }, now: () => clock,
      plane: { goals: async () => [], stage: async () => undefined, read }, validation })!;
    const validated: string[] = [];
    // Only UAT itself is simulated, behind the ports' recorded-verdict check: the cut, the promotion and its hold read are the production ports.
    const validation = {
      uat: async (id: string) => ({ sha: (await readLedgerAsync(asyncGit)).candidates.find(entry => entry.id === id)!.sha }),
      validate: async (id: string) => {
        const entry = (await readLedgerAsync(asyncGit)).candidates.find(candidate => candidate.id === id)!;
        validated.push(id);
        const record = { id, sha: entry.sha, result: 'passed' as const, deployedSha: entry.sha, at: new Date(clock).toISOString(), suites: [{ name: 'e2e', passed: true, detail: 'ok' }], followUp: null };
        await writeRecordAsync(asyncGit, `${uatTagPrefix}${id}`, entry.sha, record, true);
        return { record, followUp: null };
      },
    };

    let state = null as Awaited<ReturnType<typeof settleLocalPromotion>>['state'] | null;
    const candidateOf = new Map<number, string>();
    for (let n = 1; n <= holdScripts.length; n += 1) {
      clock = start + n * day;
      const tip = await merge(n);
      dayOf.set(tip, n);
      // Six simulated hours of cycles: past the UAT window, so a hold that never releases stops being read.
      for (let at = clock; at < start + n * day + 6 * 3_600_000; at += soakStep) {
        clock = at;
        const local = ports();
        const ledgerRead = { ledger: async () => { const ledger = await readLedgerAsync(asyncGit); return { mainSha: tip, promotedSha: ledger.production[0]?.sha ?? null, promotedAt: null, behind: null,
          candidates: ledger.candidates.map(entry => ({ id: entry.id, sha: entry.sha, cutAt: entry.cutAt, prs: entry.prs ?? entry.items.length, queued: entry.queued ?? 0 })) }; },
          runs: async () => [], dispatch: async () => { throw new Error('no dispatch in control-plane mode'); }, local };
        const result = await settleLocalPromotion(state, ledgerRead, { now: clock, everyMinutes: 10, intervalMs: 120_000, frozen: null, watchedTip: tip });
        assert.equal(result.failure, null, `day ${n} at ${new Date(clock).toISOString()}: ${result.state.reason ?? ''}`);
        state = result.state;
        assert.equal(state.inFlight, false, `day ${n}: every cycle settles its candidate`);
      }
      const ledger = await readLedgerAsync(asyncGit);
      candidateOf.set(n, ledger.candidates.find(entry => entry.sha === tip)!.id);
    }

    const ledger = await readLedgerAsync(asyncGit);
    assert.equal(ledger.candidates.length, holdScripts.length, 'one candidate was cut a day, and a retry never cut another');
    assert.deepEqual([...validated].sort(), [...candidateOf.values()].sort(), 'each candidate ran UAT exactly once; a retry never reran it');
    const promoted = ledger.production.map(record => record.id);
    assert.equal(new Set(promoted).size, promoted.length, 'no candidate was recorded in production twice');
    const expected = [1, 2, 3, 4, 6].map(n => candidateOf.get(n)!);
    assert.deepEqual([...promoted].sort(), expected.sort(), 'every released candidate was promoted, and the one held for good was not');
    for (const [n, script] of holdScripts.entries()) {
      const mine = reads.filter(entry => entry.day === n + 1), id = candidateOf.get(n + 1)!;
      assert.ok(mine.every(entry => entry.id === id), `day ${n + 1}: the hold is read for that candidate only`);
      if (n + 1 === 5) {
        // Held for good: read once an interval, never past the UAT window, and never promoted.
        assert.ok(mine.length >= 2 && mine.length <= uatValidationWindowMs / soakStep + 1, `day 5 reads its hold a bounded number of times (${mine.length})`);
        assert.ok(mine.every(entry => entry.at - (start + 5 * day) < uatValidationWindowMs), 'no hold read past the UAT window');
        continue;
      }
      // Every scripted answer was read once, in order, and the candidate was promoted on the first releasing read.
      assert.deepEqual(mine.map(entry => entry.answer), script, `day ${n + 1}: one fresh read a retry until the hold released`);
      for (let i = 1; i < mine.length; i++) assert.ok(mine[i].at - mine[i - 1].at >= soakStep, `day ${n + 1}: retries are one promotion interval apart`);
    }
    // Production ends on the last released candidate, and the held one never reached it.
    assert.equal(git('ls-remote', 'origin', `refs/heads/${productionBranch}`).split(/\s/)[0], ledger.candidates.find(entry => entry.id === candidateOf.get(6))!.sha);
  } finally { await rm(root, { recursive: true, force: true }); }
});
