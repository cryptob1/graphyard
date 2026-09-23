import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Observation, Principal, Work } from '../src/model.js';
import { mechanicalHold, reviewNeed } from '../src/model/dispatch.js';
import { nextAction } from '../src/model/next-action.js';
import { preventableRework } from '../src/preventable-rework.js';

// GY-115: mechanical verification precedes review. Each test is named for the proof it produces:
// integration:proofs-precede-review, integration:worker-self-verifies and
// integration:unexercised-proof-rejected; AC-4 and AC-5 are manual proofs judged by a producer.

const run = promisify(execFile);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('c1'), H2 = sha40('c2'), B = sha40('b1');

const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const implementer: Principal = { id: 'implementer', role: 'worker' };
const producer: Principal = { id: 'proof-runner', role: 'producer', proofs: ['unit:*', 'integration:*'] };
let database: EmbeddedPostgres, store: Store, engine: Engine;
let pr = 1150;
before(async () => {
  const port = Number(process.env.GRAPHYARD_VERIFY_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 74);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-verify-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.principals = [operator, implementer, producer];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

const events = async (item: Work, kind: string) => (await store.events(item.id)).filter(event => event.kind === kind).reverse();
const reviewRequests = async (item: Work) => (await events(item, 'dispatch.requested')).filter(event => event.payload.details.kind === 'review');
async function submitted(title: string, criteria: Work['criteria']) {
  let item = await engine.execute(operator, 'create', null, { title, plannedFiles: ['src/'], criteria }, randomUUID());
  item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
  item = await engine.execute(implementer, 'claim', item.id, {}, randomUUID());
  item = await engine.execute(implementer, 'workspace', item.id, { epoch: 1, host: 'machine-a', path: `/tmp/verify/${item.id}`, branch: `graphyard/${item.key.toLowerCase()}-1` }, randomUUID());
  return engine.execute(implementer, 'submit', item.id, { epoch: 1, pr: ++pr }, randomUUID());
}
const observed = (item: Work, sha: string, extra: Partial<Observation> = {}): Observation => ({
  candidate: { sha, baseSha: B, pr: item.submission!.pr, branch: item.workspaces[0].branch, author: 'implementer' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
  files: ['src/a.ts'], scopeFiles: [], at: new Date().toISOString(), prState: 'open', draft: false, baseTip: B, baseTree: sha40('7b'), baseTipContained: true, ...extra });
const prove = (item: Work, proof: string, sha: string, result: 'pass' | 'fail', extra: Record<string, unknown> = {}) =>
  engine.execute(producer, 'evidence', item.id, { proof, sha, baseSha: B, policyRevision: item.policyRevision, result, executed: 3, skipped: 0, ...extra }, randomUUID());
const gate = (item: Work, name: string) => item.gates.find(entry => entry.name === name)!;

test('integration:proofs-precede-review — no review request is raised before the head\'s mechanical proofs have run, and a head that fails one returns to its worker naming the criterion without a reviewer session', async () => {
  let item = await submitted('Proofs precede review', [
    { id: 'AC-1', text: 'Parses', proofs: ['unit:vbr-parse', 'integration:vbr-flow'] },
    { id: 'AC-2', text: 'Documented', proofs: ['manual:vbr-docs'] },
  ]);
  item = await engine.observe(item.id, item.revision, observed(item, H));
  // The head builds and its producers are asked for; the reviewer is not.
  assert.ok(gate(item, 'build').passed);
  assert.deepEqual(item.autoDispatch!.producers.map(request => request.group), ['unit', 'integration']);
  assert.equal(item.autoDispatch!.review, null, 'no review request stands for an unverified head');
  assert.deepEqual(await reviewRequests(item), []);
  const pending = reviewNeed(item, [item]);
  assert.equal(pending.state, 'proofs-pending'); assert.match(pending.reason, /AC-1 unit:vbr-parse, AC-1 integration:vbr-flow have not run/);
  const waiting = nextAction(item, [item], new Date())!;
  assert.equal(waiting.kind, 'dispatch'); assert.equal(waiting.inputs.kind === 'dispatch' && waiting.inputs.target, 'proof', 'what the head waits on is its producers, not a reviewer');

  // One proof passes and the other fails: the head goes back to its worker with the criterion named.
  item = await prove(item, 'unit:vbr-parse', H, 'pass');
  assert.equal(item.autoDispatch!.review, null, 'a partly verified head is still not reviewed');
  item = await prove(item, 'integration:vbr-flow', H, 'fail');
  assert.equal(item.stage, 'build');
  assert.deepEqual(gate(item, 'build').reasons, [`AC-1: integration:vbr-flow failed on ${H.slice(0, 12)} (trusted evidence from proof-runner); the head returns to its worker before review`]);
  assert.equal(item.autoDispatch!.review, null);
  assert.deepEqual(await reviewRequests(item), [], 'the failing head never consumed a reviewer session');
  const returned = nextAction(item, [item], new Date())!;
  assert.equal(returned.kind, 'request-rework'); assert.match(returned.reason, /AC-1: integration:vbr-flow failed/);
  // Every review provider holds the same way: the control plane's own codex/agent dispatch reads mechanicalHold.
  for (const reviewProvider of ['codex', 'agent'] as const) assert.equal(mechanicalHold({ ...item, policy: { ...item.policy, reviewProvider } }, [item], new Date())?.state, 'proof-failed');

  // The worker pushes a fix: the new head is proven first, and only then is a reviewer asked for it.
  item = await engine.observe(item.id, item.revision, observed(item, H2));
  assert.ok(gate(item, 'build').passed); assert.equal(item.autoDispatch!.review, null);
  item = await prove(item, 'unit:vbr-parse', H2, 'pass');
  item = await prove(item, 'integration:vbr-flow', H2, 'pass');
  const review = item.autoDispatch!.review!;
  assert.deepEqual([review.state, review.sha], ['requested', H2]);
  const requested = await reviewRequests(item);
  assert.equal(requested.length, 1); assert.equal(requested[0].payload.details.sha, H2);
  // The manual proof waits beside the review, not ahead of it.
  assert.match(gate(item, 'acceptance').reasons.join('\n'), /AC-2: manual:vbr-docs needs trusted passing evidence/);
});

// ---- The worker's own check: the real launcher against a stub control plane ----------------------

async function fixtureRepository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-verify-repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'worker@example.test'); git('config', 'user.name', 'Worker'); git('config', 'commit.gpgsign', 'false');
  const commit = async (next: Record<string, string>, message: string) => {
    for (const [path, text] of Object.entries(next)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), text); }
    git('add', '-A'); git('commit', '-q', '-m', message); return git('rev-parse', 'HEAD');
  };
  const base = await commit(files, 'base');
  return { root, base, commit };
}
async function stubControlPlane(work: Record<string, unknown>) {
  const submitted: unknown[] = [];
  const server: Server = createServer((request, response) => {
    let body = ''; request.on('data', chunk => body += chunk);
    request.on('end', () => {
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'GET' && request.url === '/api/work') return response.end(JSON.stringify([work]));
      if (request.method === 'POST' && request.url === `/api/work/${work.id}/submit`) { submitted.push(JSON.parse(body)); return response.end(JSON.stringify({ key: work.key, stage: 'build', submission: JSON.parse(body) })); }
      response.statusCode = 404; response.end('{}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, submitted, close: () => new Promise(resolve => server.close(resolve)) };
}
const cli = async (cwd: string, url: string, ...args: string[]) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(GRAPHYARD|HERDR)_/.test(name)));
  try { const { stdout } = await run(process.execPath, [launcher, ...args], { cwd, env: { ...env, GRAPHYARD_URL: url, GRAPHYARD_TOKEN: 'worker-token' }, maxBuffer: 16 * 1024 * 1024 }); return { code: 0, output: JSON.parse(stdout) }; }
  catch (error: any) { return { code: error.code as number, output: JSON.parse(error.stdout) }; }
};
const passing = (title: string) => `test(${JSON.stringify(title)}, () => {});\n`;
const failing = (title: string) => `test(${JSON.stringify(title)}, () => { throw new Error('criterion not met'); });\n`;
const suite = (...cases: string[]) => `import { test } from 'node:test';\n${cases.join('')}`;

test('integration:worker-self-verifies — graphyard verify runs exactly the automatable proofs the item\'s criteria name against the working tree, names the manual ones as outstanding, and complete reports what ran and its outcome', async () => {
  const work = { id: randomUUID(), key: 'GY-7', criteria: [
    { id: 'AC-1', text: 'Parses', proofs: ['unit:vbr-parse', 'manual:vbr-docs'] },
    { id: 'AC-2', text: 'Flows', proofs: ['integration:vbr-flow'] },
    { id: 'AC-3', text: 'Browser', proofs: ['e2e:vbr-browser'] },
  ] };
  const repository = await fixtureRepository({ 'package.json': '{"type":"module"}\n' });
  const control = await stubControlPlane(work);
  try {
    // The implementation: one proof passes, one fails; a case with a longer name sharing the prefix and
    // the manual proof's own case would both fail if they were run, and neither may be.
    await repository.commit({ 'tests/item.test.ts': suite(passing('unit:vbr-parse — parses one'), passing('unit:vbr-parse — parses two'), failing('unit:vbr-parser-legacy — another proof'),
      failing('integration:vbr-flow — flows'), failing('manual:vbr-docs — never run here')) }, 'implementation');
    const verified = await cli(repository.root, control.url, 'verify', 'GY-7');
    assert.equal(verified.code, 1, 'a failing proof fails the command');
    const byProof = Object.fromEntries(verified.output.ran.map((entry: any) => [entry.proof, entry]));
    assert.deepEqual(Object.keys(byProof), ['unit:vbr-parse', 'integration:vbr-flow'], 'exactly the automatable proofs run');
    assert.deepEqual([byProof['unit:vbr-parse'].result, byProof['unit:vbr-parse'].executed, byProof['unit:vbr-parse'].criteria], ['pass', 2, ['AC-1']]);
    assert.deepEqual([byProof['integration:vbr-flow'].result, byProof['integration:vbr-flow'].executed, byProof['integration:vbr-flow'].failed, byProof['integration:vbr-flow'].criteria], ['fail', 1, 1, ['AC-2']]);
    assert.deepEqual(verified.output.outstanding.map((entry: any) => [entry.proof, entry.criteria]), [['manual:vbr-docs', ['AC-1']], ['e2e:vbr-browser', ['AC-3']]]);
    assert.match(verified.output.outstanding[0].reason, /manual proof is judged by an independent producer/);
    assert.equal(verified.output.head, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository.root, encoding: 'utf8' }).trim());

    // complete submits and reports what verify ran on HEAD, with each outcome.
    const completed = await cli(repository.root, control.url, 'complete', 'GY-7', '1', '42');
    assert.equal(completed.code, 0); assert.deepEqual(control.submitted, [{ epoch: 1, pr: 42 }]);
    const report = completed.output.selfVerification;
    assert.equal(report.state, 'failing'); assert.match(report.reason, /integration:vbr-flow did not pass on HEAD/);
    assert.deepEqual(report.ran.map((entry: any) => [entry.proof, entry.result, entry.executed]), [['unit:vbr-parse', 'pass', 2], ['integration:vbr-flow', 'fail', 1]]);
    assert.deepEqual(report.outstanding.map((entry: any) => entry.proof), ['manual:vbr-docs', 'e2e:vbr-browser']);

    // Fixed and re-verified, the report passes; a commit after verification is reported as stale.
    await repository.commit({ 'tests/item.test.ts': suite(passing('unit:vbr-parse — parses one'), passing('integration:vbr-flow — flows'), failing('manual:vbr-docs — never run here')) }, 'fix');
    assert.equal((await cli(repository.root, control.url, 'verify', 'GY-7')).code, 0);
    assert.equal((await cli(repository.root, control.url, 'complete', 'GY-7', '1', '42')).output.selfVerification.state, 'passing');
    await repository.commit({ 'README.md': 'later\n' }, 'after verification');
    const stale = (await cli(repository.root, control.url, 'complete', 'GY-7', '1', '42')).output.selfVerification;
    assert.equal(stale.state, 'stale'); assert.match(stale.reason, /run graphyard verify GY-7 again/);
    // Nothing was verified in a fresh worktree: complete says so rather than staying silent.
    await rm(join(repository.root, '.graphyard'), { recursive: true });
    assert.equal((await cli(repository.root, control.url, 'complete', 'GY-7', '1', '42')).output.selfVerification.state, 'not-run');
  } finally { await control.close(); await rm(repository.root, { recursive: true, force: true }); }
});

test('integration:unexercised-proof-rejected — a proof that passes on the base tree is recorded as unexercised, does not satisfy its criterion, and returns the head before review; the worker sees the same verdict locally', async () => {
  let item = await submitted('Unexercised proof', [{ id: 'AC-1', text: 'Guards the change', proofs: ['unit:vbr-guard'] }]);
  item = await engine.observe(item.id, item.revision, observed(item, H));
  // A baseline must be run on the candidate's own base.
  await assert.rejects(prove(item, 'unit:vbr-guard', H, 'pass', { baseline: { sha: H2, result: 'fail', executed: 0, skipped: 0 } }), /baseline run must be made on the candidate's base/);
  // Passing on the base tree as well: kept on the record, as unexercised, and satisfying nothing.
  item = await prove(item, 'unit:vbr-guard', H, 'pass', { baseline: { sha: B, result: 'pass', executed: 3, skipped: 0 } });
  const record = item.evidence.at(-1)!;
  assert.equal(record.trusted, true); assert.equal(record.result, 'pass'); assert.equal(record.unexercised, true);
  assert.match(gate(item, 'acceptance').reasons.join('\n'), /AC-1: unit:vbr-guard needs trusted passing evidence.*the passing record is unexercised: the proof passes on the base tree too/);
  assert.deepEqual(gate(item, 'build').reasons, [`AC-1: unit:vbr-guard passes on the base tree ${B.slice(0, 12)} as well as on ${H.slice(0, 12)}, so it does not exercise its criterion (unexercised proof); the head returns to its worker before review`]);
  assert.equal(item.autoDispatch!.review, null); assert.deepEqual(await reviewRequests(item), []);
  assert.equal(nextAction(item, [item], new Date())!.kind, 'request-rework');
  // The same proof failing on the base tree exercises the change: it satisfies the criterion and the review follows.
  item = await prove(item, 'unit:vbr-guard', H, 'pass', { baseline: { sha: B, result: 'fail', executed: 0, skipped: 0 } });
  assert.equal(item.evidence.at(-1)!.unexercised, undefined);
  assert.ok(gate(item, 'build').passed); assert.ok(gate(item, 'acceptance').passed);
  assert.equal(item.autoDispatch!.review!.sha, H);

  // The worker's own check reaches the same verdict before anything is submitted.
  const work = { id: randomUUID(), key: 'GY-8', criteria: [{ id: 'AC-1', text: 'Guards the change', proofs: ['unit:vbr-guard', 'unit:vbr-new'] }] };
  const repository = await fixtureRepository({ 'package.json': '{"type":"module"}\n', 'tests/guard.test.ts': suite(passing('unit:vbr-guard — already true before the change')) });
  const control = await stubControlPlane(work);
  try {
    await repository.commit({ 'tests/new.test.ts': suite(passing('unit:vbr-new — true only with the change')) }, 'implementation');
    const verified = await cli(repository.root, control.url, 'verify', 'GY-8', '--baseline', repository.base);
    assert.equal(verified.code, 1, 'an unexercised proof fails the check');
    const byProof = Object.fromEntries(verified.output.ran.map((entry: any) => [entry.proof, entry]));
    assert.deepEqual([byProof['unit:vbr-guard'].result, byProof['unit:vbr-guard'].baseline.result, byProof['unit:vbr-guard'].unexercised], ['pass', 'pass', true]);
    assert.deepEqual([byProof['unit:vbr-new'].result, byProof['unit:vbr-new'].baseline.result, byProof['unit:vbr-new'].baseline.executed, byProof['unit:vbr-new'].unexercised], ['pass', 'fail', 0, false]);
    assert.equal(byProof['unit:vbr-guard'].baseline.sha, repository.base);
    // The base tree was a temporary checkout; nothing of it is left behind.
    assert.doesNotMatch(execFileSync('git', ['worktree', 'list'], { cwd: repository.root, encoding: 'utf8' }), /base-/);
    const report = (await cli(repository.root, control.url, 'complete', 'GY-8', '1', '43')).output.selfVerification;
    assert.equal(report.state, 'failing'); assert.deepEqual(report.ran.find((entry: any) => entry.proof === 'unit:vbr-guard').unexercised, true);
  } finally { await control.close(); await rm(repository.root, { recursive: true, force: true }); }

  // AC-4's measure reads the same record: a returned head a mechanical proof caught, and whether a reviewer saw it.
  const delivered = { ...item, stage: 'done', candidate: { ...item.candidate!, sha: H2 }, delivery: { mergedAt: new Date().toISOString(), mergeSha: sha40('d1'), authorizationRevision: 1 } } as Work;
  const measured = preventableRework([delivered]);
  assert.deepEqual([measured.items, measured.catchable, measured.catchableBeforeReview, measured.catchableAfterReview], [1, 1, 0, 1]);
  assert.deepEqual(measured.heads[0].criteria, ['AC-1']);
  // The report splits the same count at the item's landing: before it, and after it.
  // @ts-expect-error Dependency-free measurement script.
  const { measure, render } = await import('../scripts/measure-preventable-rework.mjs');
  const landing = { ...delivered, key: 'GY-115', id: randomUUID(), evidence: [], autoDispatch: undefined, delivery: { ...delivered.delivery!, mergedAt: new Date(Date.now() + 60_000).toISOString() } } as Work;
  const later = { ...delivered, key: 'GY-9', id: randomUUID(), delivery: { ...delivered.delivery!, mergedAt: new Date(Date.now() + 120_000).toISOString() } } as Work;
  const report = measure([delivered, landing, later], Date.now(), { since: null, until: null, split: 'GY-115' }, preventableRework);
  assert.equal(report.landedAt, landing.delivery!.mergedAt);
  assert.deepEqual([report.before.items, report.before.catchable, report.after.items, report.after.catchable, report.after.catchableAfterReview], [1, 1, 2, 1, 1]);
  assert.match(render(report), /before: 1 delivery, .* 1 caught by an automatable proof of the item's own criteria — 1 after a reviewer was asked, 0 before any review/);
  const unlanded = measure([delivered], Date.now(), { since: null, until: null, split: 'GY-115' }, preventableRework);
  assert.equal(unlanded.after, null); assert.match(unlanded.reason, /GY-115 is not a work item/);
});
