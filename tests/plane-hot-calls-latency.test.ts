import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { LedgerRowCache, readInterventionLedger, readScanWindow } from '../src/interventions.js';
import { synthesizeRetro } from '../src/retro-synthesis.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1749: after the loop moved onto 2fda1fb the control plane's hot calls took tens of seconds
// (decide 30 s, requirements 18 s, status 16 s, a lease renewal 9 s at p95) while /healthz answered
// in 0.6 s. The process was up; the database was busy. What kept it busy was the server's own
// minute: the pattern scan and the retro synthesis each read the policy window of the intervention
// ledger — the newest twenty thousand rows of 27 kinds, most of them carrying the item's whole
// stored document — and projected twelve fields of it with `payload->'field'`. A stored document is
// a TOAST pointer and every `->` decompresses it again, so a row cost a dozen document reads, the
// projection ran for every row of the window before the ordering cut it, and both readers did it
// again every minute. The ledger of this fixture, 6000 such rows, took 4.6 s and 830 000 buffer
// accesses to read once; the ledger of the live installation is three times as large and its
// database a fraction of the size of the machine this runs on. The read now cuts to the newest rows
// by seq alone, projects each of those from its payload read once, and a scan keeps what it projected.
const repository = 'owner/hot-calls';
const CLOSED = 850, OPEN = 20, OBSERVATIONS_PER_ITEM = 40, DECISIONS_PER_ITEM = 12, LEDGER_ROWS = 6_000, DOCUMENT_BLOCKS = 700;
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, worker].map(principal => ({ ...principal, token: `hot-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
const master = { id: 'master-operator', token: `master-operator-${'m'.repeat(32)}`, capabilities: ['intent:create', 'intent:ready', 'intent:unblock', 'policy:requirements', 'decision:resolve', 'decision:attest', 'decision:merge', 'decision:rework', 'decision:grant'] };
const requestBudgetMs = 3_000, renewalBudgetMs = 1_000;
const policy = { threshold: 1_000_000, windowDays: 7 };
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

const call = async (credential: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const started = performance.now();
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
  const parsed = await response.json() as any;
  return { status: response.status, body: parsed, ms: performance.now() - started };
};

/** A delivered item as the ledger keeps it: its filing, scope history, last observation and gate verdicts. */
function closedItem(index: number, now: Date): Work {
  const sha = (n: number) => `${index.toString(16).padStart(4, '0')}${n.toString(16).padStart(4, '0')}`.padEnd(40, 'a');
  const at = new Date(now.getTime() - (CLOSED - index) * 3_600_000).toISOString();
  return {
    id: randomUUID(), key: `GY-${index + 1}`, title: `Closed ${index}`, description: 'A delivered item. '.repeat(200), type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: ['src/'], stage: 'done', revision: 300, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 2, lease: null, implementers: ['worker-a'], submission: { epoch: 2, pr: index + 1 },
    candidate: { sha: sha(12), baseSha: 'b'.repeat(40), pr: index + 1, branch: `graphyard/gy-${index + 1}-2`, author: 'worker-a' }, reworkRequested: false, scenarioRequirements: [], blocker: null, violations: [],
    evidence: Array.from({ length: 24 }, (_, n) => ({ id: randomUUID(), proof: 'unit:works', sha: sha(n), baseSha: 'b'.repeat(40), policyRevision: 1, producer: 'proof-runner', trusted: true, result: 'pass', executed: 3, skipped: 0, at, environment: 'node', url: 'https://ci.example/run', scopeFiles: Array.from({ length: 30 }, (_, f) => `src/m${f}.ts`) })),
    delivery: { mergedAt: at, mergeSha: sha(12), pr: index + 1 },
    origin: { judgement: { id: randomUUID(), text: 'x'.repeat(2_200) } }, baseRefresh: { reason: 'y'.repeat(1_200), at }, researchBrief: { text: 'z'.repeat(850) }, triage: { note: 't'.repeat(800) }, scopeDecision: { text: 's'.repeat(700) },
    workspaces: Array.from({ length: 3 }, (_, n) => ({ host: 'vishrog', path: `/work/GY-${index + 1}-${n}`, epoch: n, owner: 'worker-a', branch: `graphyard/gy-${index + 1}-${n}`, note: 'w'.repeat(250) })),
    gates: ['build', 'review', 'test', 'merge'].map(name => ({ name, passed: true, reasons: [], verdict: { inputs: { key: `GY-${index + 1}`, sha: sha(12), baseSha: 'b'.repeat(40), evidence: [], policyRevision: 1 }, version: 1, note: 'g'.repeat(200) } })),
    observation: { at, candidate: { sha: sha(12), baseSha: 'b'.repeat(40), pr: index + 1 }, files: Array.from({ length: 25 }, (_, f) => `src/module-${f}/component-${index}.ts`), checks: [{ name: 'test', conclusion: 'success' }], reviews: [], merged: true, mergeSha: sha(12), prState: 'closed' },
    autoDispatch: { review: null, producers: [], history: [] }, actionQueue: { actions: [], history: [] }, sessions: [],
  } as unknown as Work;
}

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 64;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('plane-hot-calls'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('hot_calls');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/hot_calls`); await store.init();
  engine = new Engine(store, 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const created = await call(token(operator), 'POST', 'operator-agents', { id: master.id, displayName: master.id, capabilities: master.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: master.token, reason: 'Onboarding provisions agent identities' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const now = new Date();
  for (let index = 0; index < CLOSED; index++) {
    const item = closedItem(index, now);
    await store.pool.query('INSERT INTO work_items(id,document) VALUES($1,$2)', [item.id, JSON.stringify(item)]);
  }
  // Their history: whole-document observations, the decisions a long-lived fleet recorded (most applied) ...
  await store.pool.query(`INSERT INTO events(work_id,actor,kind,payload) SELECT id,'github','github.observed',jsonb_build_object('work',document,'details',jsonb_build_object('observation',n)) FROM work_items, generate_series(1,$1::int) AS n`, [OBSERVATIONS_PER_ITEM]);
  await store.pool.query(`INSERT INTO events(work_id,actor,kind,payload) SELECT w.id,'master-operator','decision.requested',jsonb_build_object('id',w.id::text||'-'||n,'action',(ARRAY['release','rework','requirements','resolve'])[1+n%4],'input',jsonb_build_object('trigger','lease-loss'),'reason','history') FROM work_items w, generate_series(1,$1::int) AS n`, [DECISIONS_PER_ITEM]);
  await store.pool.query(`INSERT INTO events(work_id,actor,kind,payload) SELECT w.id,'approver-agent','decision.applied',jsonb_build_object('id',w.id::text||'-'||n) FROM work_items w, generate_series(1,$1::int) AS n WHERE n%5<>0`, [DECISIONS_PER_ITEM]);
  // ... and the intervention ledger the scan reads: rows of the 27 kinds, each embedding the item's whole stored document (a long document that does not compress away).
  const kinds = ['rework', 'decision.requested', 'decision.approved', 'decision.applied', 'requirements', 'blocked', 'unblock', 'scope', 'settle', 'lease.expired'];
  await store.pool.query(`INSERT INTO events(work_id,actor,kind,payload,created_at)
    SELECT w.id, 'x', ($1::text[])[1 + n % 10], jsonb_build_object('details', jsonb_build_object('n', n), 'id', n::text, 'work', w.document || jsonb_build_object('history', (SELECT string_agg(md5(i::text || n::text), '') FROM generate_series(1, $3::int) AS i))), now() - (($2::int - n) * interval '1 minute')
    FROM generate_series(1, $2::int) AS n CROSS JOIN LATERAL (SELECT id, document FROM work_items OFFSET (n % $4::int) LIMIT 1) w`, [kinds, LEDGER_ROWS, DOCUMENT_BLOCKS, CLOSED]);
  await store.pool.query('ANALYZE events');
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

/** Shared buffer accesses (hits and reads) one statement makes, as the database counts them. */
async function buffersOf(text: string, values: unknown[]) {
  const plan = (await store.pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`, values as any[])).rows[0]['QUERY PLAN'][0].Plan;
  return Number(plan['Shared Hit Blocks']) + Number(plan['Shared Read Blocks']);
}
/** The statements `run` sends the report pool, with the rows each returned. */
async function spyOnReports<T>(run: () => Promise<T>) {
  const seen: { text: string; values: unknown[]; rows: number }[] = [];
  const pool = store.reportPool as any, query = pool.query;
  pool.query = async (...args: any[]) => { const result = await query.apply(pool, args); seen.push({ text: String(args[0]?.text ?? args[0]), values: args[1], rows: result.rows.length }); return result; };
  try { return { result: await run(), seen }; } finally { pool.query = query; }
}

test('unit:plane-hot-calls-bounded-under-load — decide, requirements and status each answer under 3 s on 850 closed and 20 open items while the server scans the intervention ledger, and a concurrent lease renewal under 1 s', async () => {
  const open: Work[] = [];
  for (let n = 0; n < OPEN; n++) {
    const made = await call(master.token, 'POST', 'work', { title: `open-${n}`, plannedFiles: [`src/open-${n}.ts`], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], reason: 'seed' });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    open.push(made.body);
  }
  assert.equal((await call(token(operator), 'POST', `work/${open[0].key}/ready`, {})).status, 200);
  const claimed = await call(token(worker), 'POST', `work/${open[0].key}/claim`, {});
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const epoch = claimed.body.epoch as number;
  const target = open[1];
  const rewrite = { expectedPolicyRevision: target.policyRevision, criteria: target.criteria, dependencies: [], plannedFiles: [...target.plannedFiles, 'src/more.ts'], exclusiveResources: [], producerProofs: [], reason: 'widen' };
  // What the server does every minute (main.ts), run back to back for as long as the calls are timed.
  const cache = new LedgerRowCache();
  let scanning = true, scans = 0;
  const scan = (async () => {
    while (scanning) {
      const began = performance.now();
      const window = await readScanWindow(store, policy, { cache });
      await synthesizeRetro(store, policy, { window });
      scans++; if (process.env.SCANLOG) console.log('scan', scans, Math.round(performance.now() - began), 'ms');
    }
  })();
  const decide = [] as number[], requirements = [] as number[], status = [] as number[], renewals = [] as number[];
  try {
    // At least three rounds, and until the scan has run three times: its first pass reads the window, the later ones what was written since.
    for (let round = 0; round < 3 || (scans < 3 && round < 120); round++) {
      if (round >= 3) await new Promise(resolve => setTimeout(resolve, 250));
      // A fresh draft each round, so every timed release is a first request and succeeds.
      const fresh = await call(master.token, 'POST', 'work', { title: `decide-${round}`, plannedFiles: [`src/decide-${round}.ts`], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], reason: 'seed' });
      assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
      let renewing = true;
      const renewal = (async () => { while (renewing) { const renewed = await call(token(worker), 'POST', `work/${open[0].key}/heartbeat`, { epoch }); assert.equal(renewed.status, 200, JSON.stringify(renewed.body)); renewals.push(renewed.ms); } })();
      const [decided, revised, read] = await Promise.all([
        call(master.token, 'POST', `work/${fresh.body.key}/decide`, { action: 'release', input: { expectedRevision: fresh.body.revision }, reason: `round ${round}` }),
        call(token(operator), 'POST', `work/${target.key}/requirements`, { ...rewrite, plannedFiles: [...rewrite.plannedFiles, `src/more-${round}.ts`] }),
        call(token(operator), 'GET', 'status'),
      ]);
      renewing = false; await renewal;
      for (const [name, result] of Object.entries({ decide: decided, requirements: revised, status: read })) assert.equal(result.status, 200, `${name}: ${result.status} ${JSON.stringify(result.body).slice(0, 300)}`);
      decide.push(decided.ms); requirements.push(revised.ms); status.push(read.ms);
      rewrite.expectedPolicyRevision += 1;
    }
  } finally { scanning = false; await scan; }
  assert.ok(scans >= 3, `the scan ran ${scans} times beside the calls`);
  // Plain bounds, not assertTiming: the stability baseline needs twenty full-suite runs recorded per timing name.
  for (const [name, samples, budget] of [['decide', decide, requestBudgetMs], ['requirements', requirements, requestBudgetMs], ['status', status, requestBudgetMs], ['lease renewal', renewals, renewalBudgetMs]] as const)
    assert.ok(samples.length >= 3 && Math.max(...samples) <= budget, `${name} took up to ${Math.max(...samples)} ms against ${budget} ms over ${samples.length} samples`);
});

test('unit:intervention-ledger-read-bounded — the ledger window is read from each stored document once, only for the rows it keeps, and a scan reads only the rows written since', async () => {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString(), limit = 2_000;
  const statements = await spyOnReports(() => readInterventionLedger(store.reportPool, { since, limit }));
  const projection = statements.seen.find(entry => entry.text.includes('unnest') && entry.text.includes('windowed'))!;
  assert.ok(projection, 'the window is read in one statement');
  // The buffers it touches are bounded by the size of what is stored, not by a multiple of it per
  // projected field: reading every kept document once touches each stored page about once.
  const pages = Number((await store.pool.query("SELECT (pg_total_relation_size('events') / current_setting('block_size')::int) AS pages")).rows[0].pages);
  const buffers = await buffersOf(projection.text, projection.values);
  assert.ok(buffers <= pages, `the window read touched ${buffers} buffers against ${pages} pages stored in the whole ledger`);
  assert.equal(statements.result.truncated, true, 'the limit cut the window');
  assert.ok(statements.result.rows.length > 0 && statements.result.rows.length <= limit + 1_000);

  // A scan keeps the rows it projected: the second read projects none, the next only what was written since.
  const cache = new LedgerRowCache();
  const first = await spyOnReports(() => readInterventionLedger(store.reportPool, { since, cache }));
  const projected = (entries: typeof first.seen) => entries.filter(entry => entry.text.includes('= ANY($1::bigint[])') && entry.text.includes('AS details')).reduce((sum, entry) => sum + entry.rows, 0);
  assert.ok(projected(first.seen) >= LEDGER_ROWS, 'the first read projects the window');
  const again = await spyOnReports(() => readInterventionLedger(store.reportPool, { since, cache }));
  assert.equal(projected(again.seen), 0, 'an unchanged ledger projects nothing');
  assert.deepEqual(again.result.rows, first.result.rows);
  const written = 5;
  await store.pool.query(`INSERT INTO events(work_id,actor,kind,payload) SELECT id,'x','blocked',jsonb_build_object('details',jsonb_build_object('n',n),'work',document) FROM work_items, generate_series(1,$1::int) AS n WHERE number = 1`, [written]);
  const next = await spyOnReports(() => readInterventionLedger(store.reportPool, { since, cache }));
  assert.equal(projected(next.seen), written, 'only the rows written since are projected');
  // What the cache serves is what a fresh read returns.
  const fresh = await readInterventionLedger(store.reportPool, { since });
  assert.deepEqual(next.result.rows, fresh.rows);
  assert.equal(next.result.retainedFrom, fresh.retainedFrom);
});
