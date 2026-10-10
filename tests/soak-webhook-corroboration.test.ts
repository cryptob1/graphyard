import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Observation, type Work } from '../src/model.js';
import { server } from '../src/server.js';
import { GitHub, webhookDeliveryLogMs, webhookDeliveryPages } from '../src/github.js';
import { type DaemonEffects, daemonEffects, emptyDaemonState, runCycle } from '../src/master-daemon.js';
import { systemInvariants, invariantFaultKind } from '../src/model/invariants.js';
import { type BudgetStatus, githubBudgetAttention } from '../src/cli/github-budget-attention.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { clock, hour, minute } from './helpers/soak-world.js';
import { api, credentials, engine, principals, repository, soakConfig, soakControlPlanes, store, token } from './helpers/soak-plane.js';

/**
 * GY-1649 under the real loop for a simulated day. Every cycle the loop's faults step reads
 * `/api/status` and the attention `master status` adds, so the webhooks block's delivery-log
 * corroboration now runs per cycle: this suite serves that status from a real control plane whose
 * GitHub client reads a simulated App delivery log, and runs the loop's own cycles over a day that
 * moves through delivering, quiet, answered, failing, an unreadable log, a rate-limit pause and
 * recovery. It asserts the read stays bounded whatever the cycles and items, each stretch is
 * classified as GitHub's log says, the broken-webhook row stands only while GitHub logged failed
 * attempts (and is never re-filed per cycle), and the system invariants hold. One concern of the
 * release-candidate soak (GY-404), in its own file (GY-1363).
 */
soakControlPlanes('soak-webhook-corroboration', 441);

const REPOSITORY_ID = 77, INSTALLATION = 2;
/** The day's stretches, from the day's start: what GitHub attempts, how it was answered, and whether receipts arrive. */
const day = [
  { name: 'delivering', from: 0, to: 2 * hour, attempts: 10 * minute, code: 202, receipts: true },
  { name: 'quiet', from: 2 * hour, to: 5 * hour, attempts: 0, code: 0, receipts: false },
  { name: 'answered', from: 5 * hour, to: 8 * hour, attempts: 5 * minute, code: 202, receipts: false },
  { name: 'failing', from: 8 * hour, to: 10 * hour, attempts: 5 * minute, code: 502, receipts: false },
  { name: 'unreadable', from: 10 * hour, to: 12 * hour, attempts: 5 * minute, code: 502, receipts: false, logFails: true },
  { name: 'recovered-failing', from: 12 * hour, to: 13 * hour, attempts: 5 * minute, code: 502, receipts: false },
  { name: 'redelivering', from: 13 * hour, to: 16 * hour, attempts: 10 * minute, code: 202, receipts: true },
  { name: 'quiet-again', from: 16 * hour, to: 18 * hour, attempts: 0, code: 0, receipts: false },
  { name: 'paused', from: 18 * hour, to: 19 * hour, attempts: 0, code: 0, receipts: false, paused: true },
  { name: 'quiet-after-pause', from: 19 * hour, to: 24 * hour, attempts: 0, code: 0, receipts: false },
] as const;
type Stretch = typeof day[number];
/** What each stretch must read as once it has settled (an hour past the last receipt, and one delivery-log interval in). */
const expected: Record<Stretch['name'], string> = { delivering: 'delivering', quiet: 'quiet', answered: 'answered', failing: 'failing', unreadable: 'unverified', 'recovered-failing': 'failing',
  redelivering: 'delivering', 'quiet-again': 'quiet', paused: 'unverified', 'quiet-after-pause': 'quiet' };

/** GitHub's App delivery log as `GET /app/hook/deliveries` pages it, plus the repository the status names. */
class DeliveryLog {
  attempts: { delivered_at: string; status_code: number; event: string; installation_id: number; repository_id: number }[] = [];
  reads: { at: number; pages: number }[] = [];
  failing = false;
  constructor(private dayStart: number) {}
  attempt(at: number, code: number) { this.attempts.unshift({ delivered_at: new Date(at).toISOString(), status_code: code, event: code === 202 ? 'check_suite' : 'pull_request', installation_id: INSTALLATION, repository_id: REPOSITORY_ID }); }
  fetch = async (url: unknown): Promise<Response> => {
    const target = new URL(String(url));
    if (target.pathname === '/app/hook/deliveries') {
      const cursor = Number(target.searchParams.get('cursor') ?? 0);
      if (!cursor) this.reads.push({ at: clock.now() - this.dayStart, pages: 0 });
      this.reads.at(-1)!.pages++;
      if (this.failing) return new Response('{"message":"Server Error"}', { status: 502 });
      const visible = this.attempts.filter(entry => Date.parse(entry.delivered_at) <= clock.now()), page = visible.slice(cursor * 100, cursor * 100 + 100);
      const next: Record<string, string> = visible.length > (cursor + 1) * 100 ? { link: `<https://api.github.com/app/hook/deliveries?per_page=100&cursor=${cursor + 1}>; rel="next"` } : {};
      return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json', ...next } });
    }
    if (target.pathname === `/repos/${repository}`) return new Response(JSON.stringify({ id: REPOSITORY_ID, full_name: repository, private: true, permissions: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('{"message":"Not Found"}', { status: 404 });
  };
}

function openObservation(work: Work): Observation {
  const head = 'a'.repeat(40), base = 'b'.repeat(40);
  return { clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr: work.submission!.pr, branch: work.workspaces.at(-1)!.branch, author: 'implementer' },
    checks: [], reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null, files: ['src/soak/webhook.ts'], scopeFiles: [],
    at: new Date().toISOString(), prState: 'open', draft: false, baseTip: base, baseTree: 'c'.repeat(40), baseTipContained: true } as Observation;
}

test('unit:soak-invariants-hold — the real loop reads /api/status every cycle for a simulated day while GitHub\'s delivery log moves through quiet, answered, failing, unreadable, paused and recovered stretches with twelve pull requests open: the delivery-log read stays bounded per hour whatever the cycles and items, every settled stretch is classified as the log says, the broken-webhook row stands only while GitHub logged failed attempts and is filed once per episode, and every system invariant holds', { timeout: 600_000 }, async () => {
  const dayStart = clock.now(), log = new DeliveryLog(dayStart);
  process.env.GITHUB_WEBHOOK_SECRET = 'soak-webhook-secret';
  // A control plane that observes GitHub: the same engine and database as the soak's plane, with the App client wired in.
  const github = new GitHub({ repository, base: 'main', appId: 1234, installationId: INSTALLATION, privateKey: 'not-used' });
  Object.assign(github, { token: 'fixture-token', expires: Number.MAX_SAFE_INTEGER, appHeaders: () => ({ Authorization: 'Bearer fixture-app-jwt' }), appSlug: 'graphyard-owner-project' });
  github.fetch = log.fetch as typeof fetch;
  const plane = server(engine, credentials, github);
  await new Promise<void>(resolve => plane.listen(0, '127.0.0.1', resolve));
  const planeUrl = `http://127.0.0.1:${(plane.address() as { port: number }).port}`;
  try {
    // Twelve items with pull requests open: the count the row is gated on, and the per-item scale the read must not follow.
    const items = 12, worker = { id: 'worker-one', role: 'worker' as const };
    for (let index = 0; index < items; index++) {
      let work = await api(principals.operator, 'POST', 'work', { title: `Open pull request ${index}`, plannedFiles: ['src/soak/webhook.ts'], criteria: [{ id: 'AC-1', text: 'Open', proofs: ['unit:soak-behaves'] }] }) as Work;
      work = await engine.execute(principals.operator, 'ready', work.id, {}, randomUUID());
      work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
      work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'soak-host', path: `/tmp/soak/webhook-${index}`, branch: `graphyard/${work.key.toLowerCase()}-1` }, randomUUID());
      work = await engine.execute(worker, 'submit', work.id, { epoch: 1, pr: 900 + index }, randomUUID());
      await engine.observe(work.id, work.revision, openObservation(work));
    }
    // The loop's own status read, as daemonEffects makes it, against that plane.
    const root = await temporaryDirectory('soak-webhook-root');
    const credentialFile = join(root, 'coordinator.token');
    await writeFile(credentialFile, token(principals.coordinator), { mode: 0o600 });
    const config = { ...soakConfig, url: planeUrl, credentialFile, workers: [] };
    const real = daemonEffects(root, config, { snapshot: async () => ({ work: await store.list(), now: new Date().toISOString() }), mutate: async () => ({}), run: async () => { throw new Error('no child processes in this soak'); } });
    const seen: { elapsed: number; stretch: Stretch['name']; state: string; failedAttempts: number; statusMs: number; rows: string[] }[] = [];
    let statusMs = 0;
    const effects: DaemonEffects = {
      agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: await store.list(), now: new Date().toISOString() }),
      closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, requestSmoke: () => {}, recordDeployment: async () => {}, persist: async () => {}, recordSession: async () => {},
      observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }),
      controlPlane: async () => { const started = Date.now(); try { return await real.controlPlane!(); } finally { statusMs = Date.now() - started; } },
      // The GitHub-budget lines master status adds (src/master-status.ts), read from the status the loop
      // just read. The rest of master status's attention runs host-wide passes (the /tmp reclaim) that
      // a simulated clock must not drive on a shared host, and none of it is this change's.
      reportedAttention: async (_work, coordinator) => ({ items: githubBudgetAttention(coordinator as BudgetStatus, clock.now()) }),
    } as DaemonEffects;
    const state = emptyDaemonState(config);
    const failures: string[] = [];
    const receipt = async () => {
      const raw = JSON.stringify({ repository: { full_name: repository }, ref: 'refs/heads/main', after: 'd'.repeat(40) });
      const response = await fetch(`${planeUrl}/api/github/webhook`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-github-delivery': randomUUID(), 'x-github-event': 'push', 'x-hub-signature-256': `sha256=${createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET!).update(raw).digest('hex')}` } });
      assert.equal(response.status, 202, 'the delivery is accepted');
    };
    const stretchAt = (elapsed: number) => day.find(entry => elapsed >= entry.from && elapsed < entry.to)!;
    for (let elapsed = 0; elapsed < 24 * hour; elapsed += minute) {
      const stretch = stretchAt(elapsed);
      if (stretch.attempts && (elapsed - stretch.from) % stretch.attempts === 0) {
        log.attempt(clock.now(), stretch.code);
        if (stretch.receipts) await receipt();
      }
      log.failing = 'logFails' in stretch;
      Object.assign(github, { blockedUntil: 'paused' in stretch ? dayStart + stretch.to : 0 });
      const before = state.faults.observedAt;
      try { await runCycle(config, state, effects, () => clock.now()); } catch (error) { failures.push(`+${elapsed / minute} min: ${error instanceof Error ? error.message : String(error)}`); }
      if (state.faults.observedAt !== before) {
        const status = await (await fetch(`${planeUrl}/api/status`, { headers: { Authorization: `Bearer ${token(principals.coordinator)}` } })).json() as any;
        const rows = state.faults.instances.filter(entry => entry.subject === 'github' && Object.values(state.faults.open).includes(entry.id)).map(entry => (entry as { text?: string }).text ?? entry.kind);
        seen.push({ elapsed, stretch: stretch.name, state: status.webhooks.state, failedAttempts: status.webhooks.failedAttempts, statusMs, rows });
      }
      clock.advance(minute); await store.pool.query('UPDATE simulated_clock SET offset_ms=$1', [clock.offsetMs]);
    }
    assert.deepEqual(failures, [], 'no cycle failed');
    assert.ok(seen.length >= 20 * 60, `the faults step read the status nearly every cycle: ${seen.length}`);

    // Bounded: the delivery log is read at most once per interval (plus the retries a failing log
    // makes, at the same interval), never per cycle or per item, and each read stays within its page bound.
    const perHour = new Map<number, number>();
    for (const read of log.reads) perHour.set(Math.floor(read.at / hour), (perHour.get(Math.floor(read.at / hour)) ?? 0) + 1);
    const ceiling = hour / webhookDeliveryLogMs + 1;
    assert.deepEqual([...perHour].filter(([, reads]) => reads > ceiling), [], `at most ${ceiling} delivery-log reads an hour with ${items} pull requests open and a cycle a minute: ${JSON.stringify([...perHour])}`);
    assert.ok(log.reads.length <= 24 * ceiling && log.reads.length >= 24 * 3, `the log was read on its interval through the day: ${log.reads.length}`);
    assert.deepEqual(log.reads.filter(read => read.pages > webhookDeliveryPages), [], 'no read pages past its bound');
    assert.deepEqual(log.reads.filter(read => read.at >= 18 * hour && read.at < 19 * hour), [], 'nothing is read while GitHub requests are paused');
    assert.deepEqual(seen.filter(entry => entry.statusMs > 5_000).map(entry => `+${entry.elapsed / minute} min ${entry.statusMs}ms`), [], 'every status read stays bounded');

    // Classified: once a stretch has settled (an hour past its last receipt, and a log interval and a cycle in), it reads as GitHub's log says.
    const settled = seen.filter(entry => {
      const stretch = day.find(candidate => candidate.name === entry.stretch)!, lastReceipt = [...day].reverse().find(candidate => candidate.receipts && candidate.from <= entry.elapsed);
      const silentSince = lastReceipt ? Math.min(lastReceipt.to, entry.elapsed) : 0;
      return entry.elapsed >= stretch.from + webhookDeliveryLogMs + 2 * minute && (stretch.receipts || entry.elapsed >= silentSince + hour + webhookDeliveryLogMs);
    });
    for (const name of Object.keys(expected) as Stretch['name'][]) assert.ok(settled.some(entry => entry.stretch === name), `the ${name} stretch was judged after it settled`);
    assert.deepEqual(settled.filter(entry => entry.state !== expected[entry.stretch]).map(entry => `+${entry.elapsed / minute} min ${entry.stretch}: ${entry.state}`), [], 'every settled stretch reads as the delivery log says');

    // The row: raised only while GitHub logged failed attempts (or the log could not be read), never for a quiet or answered stretch.
    const rowed = (entry: typeof seen[number]) => entry.rows.some(row => /webhook/.test(row));
    assert.deepEqual(seen.filter(entry => ['quiet', 'answered', 'quiet-again', 'quiet-after-pause'].includes(entry.stretch) && rowed(entry) && settled.includes(entry)).map(entry => `+${entry.elapsed / minute} min ${entry.stretch}: ${entry.rows.join(' | ')}`), [], 'no row for a quiet or answered stretch');
    for (const name of ['failing', 'recovered-failing'] as const) {
      const judged = settled.filter(entry => entry.stretch === name);
      assert.ok(judged.length && judged.every(entry => entry.rows.some(row => /the webhook is broken/.test(row) && /status 502/.test(row))), `the ${name} stretch carries the broken-webhook row naming 502: ${JSON.stringify(judged.slice(0, 2))}`);
    }
    const unverified = settled.filter(entry => entry.stretch === 'unreadable' || entry.stretch === 'paused');
    assert.ok(unverified.length && unverified.every(entry => entry.rows.some(row => /could not be read/.test(row)) && !entry.rows.some(row => /broken/.test(row))), 'an unreadable or paused log raises the unverified row, never the broken one');
    assert.ok(settled.filter(entry => entry.stretch === 'redelivering').every(entry => !rowed(entry)), 'a delivery that arrives clears the row');

    // No churn: one standing fault per episode, not one per cycle.
    const webhookInstances = state.faults.instances.filter(entry => entry.subject === 'github' && /webhook/.test((entry as { text?: string }).text ?? ''));
    assert.ok(webhookInstances.length >= 2 && webhookInstances.length <= 8, `the row opened once per episode, not per cycle: ${webhookInstances.length} instances`);

    // The system invariants the loop judged each cycle held throughout.
    const invariantKinds = new Set<string>(systemInvariants.map(invariantFaultKind));
    assert.deepEqual(state.faults.instances.filter(entry => invariantKinds.has(entry.kind)).map(entry => `${entry.kind} at ${entry.at}`), [], 'every system invariant holds');
  } finally {
    await new Promise<void>(resolve => plane.close(() => resolve()));
    delete process.env.GITHUB_WEBHOOK_SECRET;
  }
});
