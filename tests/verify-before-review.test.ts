import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { withDatabase } from './helpers/postgres.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Observation, Principal, Work } from '../src/model.js';
import { nextAction } from '../src/model-boundary/next-action.js';
import { verifyWorkingTree } from '../src/cli/verify.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3037: the fixtures here file items, and every item owes an e2e proof; they declare the serve one needs.
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

// GY-115: mechanical verification precedes review. Each test is named for the proof it produces:
// integration:proofs-precede-review (AC-1) and integration:worker-self-verifies (AC-2).

const run = promisify(execFile);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('c1'), H2 = sha40('c2'), B = sha40('b1');

const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const implementer: Principal = { id: 'implementer', role: 'worker' };
const producer: Principal = { id: 'proof-runner', role: 'producer', proofs: ['unit:*', 'integration:*'] };
let store: Store, engine: Engine;
let pr = 1150;
before(async () => {
  store = await withDatabase('verify-before-review'); await store.init();
  engine = new Engine(store, 120, 'owner/project'); engine.principals = [operator, implementer, producer];
});
after(async () => { if (store) await store.close(); });

const events = async (item: Work, kind: string) => (await store.events(item.id)).filter(event => event.kind === kind).reverse();
const reviewRequests = async (item: Work) => (await events(item, 'dispatch.requested')).filter(event => event.payload.details.kind === 'review');
async function submitted(title: string, criteria: Work['criteria']) {
  let item = await engine.execute(operator, 'create', null, { type: 'chore',  title, criteria }, randomUUID());
  item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
  item = await engine.execute(implementer, 'claim', item.id, {}, randomUUID());
  item = await engine.execute(implementer, 'workspace', item.id, { epoch: 1, host: 'machine-a', path: `/tmp/verify/${item.id}`, branch: `graphyard/${item.key.toLowerCase()}-1` }, randomUUID());
  return engine.execute(implementer, 'submit', item.id, { epoch: 1, pr: ++pr }, randomUUID());
}
const observed = (item: Work, sha: string, extra: Partial<Observation> = {}): Observation => ({
  candidate: { sha, baseSha: B, pr: item.submission!.pr, branch: item.workspaces[0].branch, author: 'implementer' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
  // GY-883: a public API path keeps the item in the high lane, which still demands the proofs review must wait for.
  files: ['src/server/routes/a.ts'], scopeFiles: [{ path: 'src/server/routes/a.ts', status: 'added' as const, sha: 'f'.repeat(40), baseSha: null, additions: 1, deletions: 0, binary: false }], at: new Date().toISOString(), prState: 'open', draft: false, baseTip: B, baseTree: sha40('7b'), baseTipContained: true, ...extra });
const prove = (item: Work, proof: string, sha: string, result: 'pass' | 'fail') =>
  engine.execute(producer, 'evidence', item.id, { proof, sha, baseSha: B, policyRevision: item.policyRevision, result, executed: 3, skipped: 0, ...(result === 'pass' ? { exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } } : {}) }, randomUUID());
const gate = (item: Work, name: string) => item.gates.find(entry => entry.name === name)!;

// Since GY-1235 review is no longer held for proofs (CI runs the unit tests on the head and no
// producer is requested), so what remains of integration:proofs-precede-review is its second half:
// a head that fails a trusted proof returns to its worker naming the criterion.
test('integration:proofs-precede-review — a head is reviewed without waiting on producers, and a head that fails a trusted proof returns to its worker naming the criterion', async () => {
  let item = await submitted('Proofs precede review', [
    { id: 'AC-1', text: 'Parses', proofs: ['unit:vbr-parse', 'integration:vbr-flow'] },
    { id: 'AC-2', text: 'Documented', proofs: ['manual:vbr-docs', 'e2e:fixture'] },
  ]);
  item = await engine.observe(item.id, item.revision, observed(item, H));
  // The head builds and its reviewer is asked for; no producer is.
  assert.ok(gate(item, 'build').passed);
  assert.deepEqual(item.autoDispatch!.producers, [], 'no producer request is opened');
  assert.deepEqual([item.autoDispatch!.review?.state, item.autoDispatch!.review?.sha], ['requested', H], 'the reviewer is not held for proofs');
  assert.equal((await reviewRequests(item)).length, 1);
  assert.equal(nextAction(item, [item], new Date())!.kind, 'request-review');

  // One proof passes and the other fails: the head goes back to its worker with the criterion named.
  item = await prove(item, 'unit:vbr-parse', H, 'pass');
  item = await prove(item, 'integration:vbr-flow', H, 'fail');
  assert.equal(item.stage, 'build');
  assert.deepEqual(gate(item, 'build').reasons, [`AC-1: integration:vbr-flow failed on ${H.slice(0, 12)} (trusted evidence from proof-runner); the head returns to its worker before review`]);
  const returned = nextAction(item, [item], new Date())!;
  assert.equal(returned.kind, 'request-rework'); assert.match(returned.reason, /AC-1: integration:vbr-flow failed/);

  // The worker pushes a fix: the new head builds and a reviewer is asked for it at once.
  item = await engine.observe(item.id, item.revision, observed(item, H2));
  assert.ok(gate(item, 'build').passed);
  const review = item.autoDispatch!.review!;
  assert.deepEqual([review.state, review.sha], ['requested', H2]);
  assert.deepEqual((await reviewRequests(item)).map(event => event.payload.details.sha).sort(), [H, H2].sort());
});

// ---- The worker's own check: the real launcher against a stub control plane ----------------------

async function fixtureRepository(files: Record<string, string>) {
  const root = await temporaryDirectory('verify-repo');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'worker@example.test'); git('config', 'user.name', 'Worker'); git('config', 'commit.gpgsign', 'false');
  const commit = async (next: Record<string, string>, message: string) => {
    for (const [path, text] of Object.entries(next)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), text); }
    git('add', '-A'); git('commit', '-q', '-m', message); return git('rev-parse', 'HEAD');
  };
  const base = await commit({ '.gitignore': '.graphyard/\n', ...files }, 'base');
  return { root, base, commit };
}
async function stubControlPlane(work: any, root: string) {
  const submitted: unknown[] = [];
  const server: Server = createServer((request, response) => {
    let body = ''; request.on('data', chunk => body += chunk);
    request.on('end', async () => {
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'GET' && (request.url === `/api/work/${work.id}` || request.url === `/api/work/${work.key}`)) return response.end(JSON.stringify(work));
      // Stub only the transport here; real container placement is covered separately.
      if (request.method === 'POST' && request.url === `/api/work/${work.id}/worker-verification`) {
        const record = await verifyWorkingTree(work, root);
        return response.end(JSON.stringify({ record, rerun: { flaked: [], baseFailures: [] } }));
      }
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
  catch (error: any) { return { code: error.code as number, output: error.stdout?.trim() ? JSON.parse(error.stdout) : { error: error.stderr } }; }
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
  const control = await stubControlPlane(work, repository.root);
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

    // Complete repeats verification and refuses the still-failing required proof.
    const completed = await cli(repository.root, control.url, 'complete', 'GY-7', '1');
    assert.equal(completed.code, 1);
    assert.match(completed.output.error, /complete refused: required proofs failed/);
    assert.deepEqual(control.submitted, []);

    // Fixed and re-verified, the report passes; complete also verifies a newer head.
    await repository.commit({ 'tests/item.test.ts': suite(passing('unit:vbr-parse — parses one'), passing('integration:vbr-flow — flows'), failing('manual:vbr-docs — never run here')) }, 'fix');
    assert.equal((await cli(repository.root, control.url, 'verify', 'GY-7')).code, 0);
    assert.equal((await cli(repository.root, control.url, 'complete', 'GY-7', '1')).output.selfVerification.state, 'passing');
    await repository.commit({ 'README.md': 'later\n' }, 'after verification');
    const refreshed = (await cli(repository.root, control.url, 'complete', 'GY-7', '1')).output;
    assert.equal(refreshed.selfVerification.state, 'passing');
    assert.equal(refreshed.submission.head, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository.root, encoding: 'utf8' }).trim());
    // A missing local record is recreated by the remote verification.
    await rm(join(repository.root, '.graphyard'), { recursive: true });
    assert.equal((await cli(repository.root, control.url, 'complete', 'GY-7', '1')).output.selfVerification.state, 'passing');
  } finally { await control.close(); await rm(repository.root, { recursive: true, force: true }); }
});
