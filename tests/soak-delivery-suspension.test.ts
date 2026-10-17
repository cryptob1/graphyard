import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { readLedgerAsync, uatBranch, type AsyncGit } from '../src/release-candidate.js';
import { defaultChildRun } from '../src/child-runner.js';
import { localReleasePorts } from '../src/daemon/release-ports.js';
import { settleLocalPromotion } from '../src/daemon/promotion-local.js';
import { masterConfigSchema } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Time-bomb allowance (GY-1938): the 2030-06-01 simulated clock is the ports' injected now; every cut, UAT record and hold derives from it.
/**
 * GY-1938: a real-loop soak of the delivery suspension. The loop's own promotion cycle drives the
 * production release ports (localReleasePorts) over a real origin and checkout — the real cut, UAT
 * deploy, managed validation with its e2e suite and release holds, and promote — one merge a
 * simulated day and a cycle every ten minutes, against a loopback UAT install scripted per day. For
 * three days the install's merger is github with no App wired, so its delivery case can never pass;
 * on the second its routes answer only once /healthz serves the candidate (a rollout warming). Then
 * the App is wired: the first wired day's delivery fails, the next two deliver. Asserts the unwired
 * days suspend the delivery case and pass with no hold, the warming day included (the holds probe
 * the install only after the suites ran); each candidate probes the install a bounded number of
 * times; once wired nothing is suspended, the failing delivery blocks its candidate and files
 * exactly one hold that the next delivering candidate clears; and each candidate is validated once.
 */
const day = 24 * 3_600_000, soakStep = 10 * 60_000, start = Date.parse('2030-06-01T00:00:00Z');
// Each day's install: whether its GitHub App is wired, whether the delivery lands, and whether it warms up behind /healthz.
const days = [
  { wired: false, delivers: false, warming: false },
  { wired: false, delivers: false, warming: true },
  { wired: false, delivers: false, warming: false },
  { wired: true, delivers: false, warming: false },
  { wired: true, delivers: true, warming: false },
  { wired: true, delivers: true, warming: false },
];

test('unit:soak-delivery-suspension — over simulated days the real promotion cycle suspends the delivery case only while the install serves no deliveries, probes each candidate a bounded number of times, files no hold for a suspended case, and once wired blocks a failing delivery with one hold the next delivering candidate clears', { timeout: 300_000 }, async () => {
  const root = await realpath(await temporaryDirectory('soak-delivery-suspension'));
  const install = { origin: '', wired: false, delivers: false, warm: true, merger: 0, status: 0, delivery: 0 };
  const server = createServer((request, response) => {
    const send = (status: number, body: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    const path = new URL(request.url ?? '/', 'http://uat.test').pathname;
    // UAT serves what the loop deployed to it: the origin's uat branch.
    if (path === '/healthz') { install.warm = true; return send(200, { ok: true, commit: execFileSync('git', ['ls-remote', install.origin, `refs/heads/${uatBranch}`], { encoding: 'utf8' }).split(/\s/)[0] }); }
    if (!install.warm) return send(503, { error: 'warming' });
    if (path === '/api/merger') { install.merger += 1; return send(200, { mode: 'github' }); }
    if (path === '/api/status') { install.status += 1; return send(200, install.wired ? { github: true, repository: 'owner/project' } : { github: false, repository: 'owner/project' }); }
    if (path === '/api/delivery') { install.delivery += 1; return send(200, { delivered: install.delivers }); }
    if (path === '/api/ping') return send(200, { ok: true });
    return send(404, { error: 'not found' });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const uatUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const origin = join(root, 'origin.git'), checkout = join(root, 'checkout'), managed = join(root, 'managed');
    await mkdir(managed, { recursive: true });
    install.origin = origin;
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
    const git = (...args: string[]) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const asyncGit: AsyncGit = async args => git(...args);
    for (const [key, value] of [['user.email', 't@example.com'], ['user.name', 'T'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) git('config', key, value);
    const write = async (path: string, content: unknown) => { await mkdir(join(checkout, path, '..'), { recursive: true }); await writeFile(join(checkout, path), `${JSON.stringify(content, null, 2)}\n`); };
    const http = (path: string, expect: unknown[]) => ({ kind: 'http', name: `read ${path}`, method: 'GET', path, status: 200, expect });
    await write('e2e/cases/ping.json', { id: 'ping', title: 'The install answers', tags: ['api'], target: 'uat', required: true, steps: [http('/api/ping', [{ path: 'ok', equals: true }])] });
    await write('e2e/cases/delivery-lands.json', { id: 'delivery-lands', title: 'A delivered change lands', tags: ['api'], target: 'uat', required: true, steps: [http('/api/delivery', [{ path: 'delivered', equals: true }])] });
    await write('e2e/contract.json', { outcomes: [{ id: 'delivers', title: 'A change is delivered', criteria: ['The delivery lands'], cases: ['delivery-lands'] }] });
    git('add', '.'); git('commit', '-q', '-m', 'base'); git('push', '-q', 'origin', 'main'); git('fetch', '-q', 'origin');
    const merge = async (n: number) => {
      const branch = `graphyard/gy-${9300 + n}-1`;
      git('checkout', '-q', '-b', branch, 'refs/remotes/origin/main');
      await writeFile(join(checkout, `change-${n}.txt`), `${n}\n`); git('add', '.'); git('commit', '-q', '-m', `GY-${9300 + n} change`);
      git('checkout', '-q', '--detach', 'refs/remotes/origin/main');
      git('merge', '-q', '--no-ff', branch, '-m', `Merge pull request #${n} from owner/${branch}`, '-m', `GY-${9300 + n}: the change`);
      git('push', '-q', 'origin', 'HEAD:main'); git('fetch', '-q', 'origin');
      return git('rev-parse', 'HEAD');
    };

    let clock = start;
    const filed: { at: number; item: string }[] = [];
    const file = async (item: object) => { filed.push({ at: clock, item: JSON.stringify(item) }); return `GY-${9400 + filed.length}`; };
    const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
      repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { candidates: { everyMerges: 1, idleMinutes: 15 }, mergeWriter: { deployKeyFile: join('/keys', 'deploy'), retrials: 2 } } });
    const environment: NodeJS.ProcessEnv = { ...process.env, GRAPHYARD_UAT_URL: uatUrl };
    delete environment.GRAPHYARD_UAT_STATIC; delete environment.GRAPHYARD_PRODUCTION_URL; delete environment.GRAPHYARD_UAT_TOKEN;
    const ports = () => localReleasePorts(config, checkout, defaultChildRun, { base: managed, record: async () => ({}), environment, now: () => clock, file,
      // The related-item revert's merge trial builds the fixture's tests; its build is not under test here.
      trial: async () => ({ build: 'pass' as const, tests: { passed: 1, failed: [], files: 1 }, durationMs: 1 }),
      plane: { goals: async () => [], stage: async () => undefined, read: async () => ({ hold: { held: false, cases: [] } }) } })!;

    let state = null as Awaited<ReturnType<typeof settleLocalPromotion>>['state'] | null;
    const perDay: { ids: string[]; merger: number; status: number; delivery: number; filed: number }[] = [];
    for (const [index, script] of days.entries()) {
      const n = index + 1, dayStart = start + n * day;
      const tip = await merge(n);
      Object.assign(install, { wired: script.wired, delivers: script.delivers, warm: !script.warming, merger: 0, status: 0, delivery: 0 });
      const filedBefore = filed.length;
      for (let at = dayStart; at < dayStart + 6 * 3_600_000; at += soakStep) {
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
      const ids = ledger.candidates.filter(entry => Date.parse(entry.cutAt) >= dayStart && Date.parse(entry.cutAt) < dayStart + day).map(entry => entry.id);
      perDay.push({ ids, merger: install.merger, status: install.status, delivery: install.delivery, filed: filed.length - filedBefore });
    }

    const ledger = await readLedgerAsync(asyncGit);
    for (const [index, script] of days.entries()) {
      const n = index + 1, { ids, merger, status, delivery } = perDay[index];
      // The day's merge is cut once; the wired, failing day also cuts the related-item revert the failure made.
      assert.equal(ids.length, script.wired && !script.delivers ? 2 : 1, `day ${n}: candidates ${ids.join(', ')}`);
      // Bounded probing: the suite reads the install's merger once a candidate, and the holds re-probe only a run that suspended a case.
      assert.equal(merger, ids.length * (script.wired ? 1 : 2), `day ${n}: the install's merger was probed ${merger} times for ${ids.length} candidates`);
      assert.equal(status, merger, `day ${n}: each probe reads the status once`);
      assert.ok(delivery <= ids.length * 2, `day ${n}: the delivery case asks at most once an attempt (${delivery})`);
      for (const id of ids) {
        const uat = ledger.uat.filter(record => record.id === id);
        assert.equal(uat.length, 1, `day ${n}: candidate ${id} was validated exactly once`);
        const record = uat[0], cases = Object.fromEntries(record.e2e!.cases.map(entry => [entry.case, entry]));
        const promoted = ledger.production.some(entry => entry.id === id);
        if (!script.wired) {
          assert.equal(record.result, 'passed', `day ${n}: an unwired install's suspended delivery case does not fail the candidate: ${JSON.stringify(record.suites)}`);
          assert.deepEqual(record.e2e!.blocking, [], `day ${n}: nothing blocks`);
          assert.equal(cases['delivery-lands'].pending, true, `day ${n}: the delivery case ran and is recorded pending`);
          assert.ok(promoted, `day ${n}: the candidate was promoted`);
        } else if (!script.delivers) {
          assert.equal(record.result, 'failed', `day ${n}: once wired the failing delivery blocks candidate ${id}`);
          assert.deepEqual(record.e2e!.blocking, ['delivery-lands']);
          assert.equal(cases['delivery-lands'].pending, undefined, `day ${n}: suspension no longer applies`);
          assert.ok(!promoted, `day ${n}: the failed candidate was not promoted`);
        } else {
          assert.equal(record.result, 'passed', `day ${n}: a delivering install passes the delivery case for real`);
          assert.equal(cases['delivery-lands'].verdict, 'passed');
          assert.equal(cases['delivery-lands'].pending, undefined);
          assert.ok(promoted, `day ${n}: the candidate was promoted`);
        }
      }
      // Stable holds: no hold for a suspended case, the warming rollout included; one for the wired day's failing outcome, never refiled for its revert candidate.
      assert.equal(perDay[index].filed, script.wired && !script.delivers ? 1 : 0, `day ${n}: hold items filed`);
    }
    assert.match(filed[0]!.item, /delivery-lands/);
    assert.deepEqual(ledger.uat.find(record => record.id === perDay[4].ids[0])!.holds?.map(entry => [entry.kind, entry.outcome]), [['clear', 'delivers']], 'the first delivering candidate clears the hold');
    assert.equal(filed.length, 1, 'one hold item over the whole soak');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
