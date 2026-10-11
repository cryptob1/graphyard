import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { lastLoopSelfProvision, loopProvisionDelay, loopSelfProvision, masterSetup, setupAuditFile } from '../src/cli/master-setup.js';
import { releaseFilingSecret, releaseFilingTransitionSeconds, type ReleaseFilingDeps, type ReleaseFilingStep } from '../src/master/release-filing.js';
import { releaseFilingIdentity } from '../src/release-candidate.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1692 (GY-1691). The loop's own keeping of the release filing credential, over two simulated
 * days of the real loop: a cycle a minute, the setup step (`master setup --apply`, loopSelfProvision)
 * running itself at most once an hour, against a scripted control plane that keeps the operator-agent
 * document as src/operator-agent.ts does and a scripted gh that records the uat secret to the second,
 * as GitHub does. The day is broken six ways and each is repaired: an administrator rotates the
 * identity out of band and never stores the secret; the identity is widened and rotated out of band
 * while the plane refuses rotations, so a narrowing succeeds before its rotation fails (the sequence
 * the credential issue time must survive); the secret is deleted while gh refuses to store one; the
 * install's admin credential is missing from the host; the plane is down; an administrator stores the
 * old token and rotates the identity within the same GitHub second (the ordering the second cannot
 * tell: only the master's own handoff record proves a store); and the day ends current.
 * After every cycle and at the end: the step runs once an hour while it succeeds and, once its
 * filing step fails, is a failed run — recorded by the cycle as its one isolated config action and
 * retried from ten minutes on, doubling (`loopProvisionDelay`), never every cycle and never left an
 * hour — until the first run after the fault lifts repairs it and the hour resumes; no run ever
 * reports the credential current while the secret GitHub holds is not the credential the plane
 * holds newest, every mutation the plane and gh see is one the window called for, no token or admin
 * credential ever reaches an outcome, an audit line, an argument or the kept status file, nothing
 * but the setup step's own action reaches an isolation record, and every system invariant the loop
 * checks holds.
 */
const minute = 60_000, hour = 60 * minute, day = 24 * hour;
/** The clock starts off the second, so every store the master makes lands in its rotation's second: current only through its handoff record. */
const start = Date.parse('2026-10-12T06:00:00.400Z');
const iso = (at: number) => new Date(at).toISOString();
const identity = releaseFilingIdentity.id, repository = 'owner/project';
const admin = 'admin-token-' + 'a'.repeat(32);
const fingerprint = (token: string) => createHash('sha256').update(token).digest('hex').slice(0, 16);
/** The windows, in minutes from the start, each fault stands in. */
const windows = {
  rotatedOutOfBand: 5 * 60,
  widenedWhileRotateRefused: { from: 10 * 60, to: 13 * 60 },
  secretDeletedWhileStoreRefused: { from: 20 * 60, to: 22 * 60 + 30 },
  adminMissing: { from: 30 * 60, to: 33 * 60 },
  planeDown: { from: 40 * 60, to: 42 * 60 },
  storedThenRotatedWithinSecond: 45 * 60,
};
const within = (at: number, window: { from: number; to: number }) => at >= window.from && at < window.to;

const config = (root: string): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(root, '.graphyard-credentials/master/token'), cliPath: join(root, 'bin/graphyard.mjs'),
  repository, baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { intervalSeconds: 60 } });

test('unit:soak-release-filing-invariants — over two simulated days the loop keeps the release filing credential current once an hour: an out-of-band rotation, a narrowing whose rotation fails, a deleted secret gh refuses to store, a missing admin credential, a plane outage and a token stored by hand within the second of a rotation are each repaired on the first run after they lift, no run reads a stale secret as current, a failed filing step is a failed run the cycle records and retries from ten minutes on with backoff until it recovers, no token leaks, and every system invariant holds', { timeout: 300_000 }, async () => {
  const root = await temporaryDirectory('soak-release-filing');
  try {
    const master = config(root);
    let now = start;
    // ---- The plane: the operator-agent document kept as the server keeps it.
    const document: any = { id: identity, displayName: 'Release follow-up', role: 'operator-agent', capabilities: ['intent:create'], scope: { repositories: [repository], workItems: ['*'] }, revision: 1,
      createdAt: iso(start - day), updatedAt: iso(start - day), revokedAt: null, lastMutation: { kind: 'setup', actor: 'operator', at: iso(start - day), reason: 'issued' }, fingerprints: [fingerprint('t0'.repeat(32))], credentialIssuedAt: iso(start - day) };
    const plane = { down: false, rotateFails: false, posts: [] as { at: number; action: string; body: any }[], gets: 0 };
    const mutate = (kind: string, body: any) => { document.revision++; document.updatedAt = iso(now); document.lastMutation = { kind, actor: 'graphyard-master', at: iso(now), reason: body.reason }; };
    const fetcher = (async (url: string, init: RequestInit) => {
      const path = url.replace('https://graphyard.example/api/', ''), body = init.body ? JSON.parse(String(init.body)) : undefined;
      const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
      assert.equal(String((init.headers as Record<string, string>).Authorization), `Bearer ${admin}`, 'every plane call carries the admin credential, never a token');
      if (plane.down) return json(503, { error: 'the control plane is restarting' });
      if (path === 'operator-agents' && init.method === 'GET') { plane.gets++; return json(200, [{ ...document, credentials: undefined }]); }
      const match = /^operator-agents\/([^/]+)\/(configure|rotate)$/.exec(path);
      assert.ok(match && decodeURIComponent(match[1]) === identity, `an unexpected plane call: ${init.method} ${path}`);
      const action = match![2];
      if (action === 'configure') {
        if (body.expectedRevision !== document.revision) return json(409, { error: 'Operator-agent revision changed; reload before configuring' });
        document.capabilities = body.capabilities; document.scope = body.scope; mutate('configure', body);
      } else {
        if (plane.rotateFails) return json(503, { error: 'the credential store is unavailable' });
        const fp = fingerprint(body.token); assert.ok(!document.fingerprints.includes(fp), 'a credential is never issued twice');
        document.fingerprints.push(fp); document.credentialIssuedAt = iso(now); mutate('rotate', body);
        document.lastMutation.transitionEndsAt = iso(now + body.transitionSeconds * 1000);
      }
      plane.posts.push({ at: (now - start) / minute, action, body: { ...body, token: body.token ? fingerprint(body.token) : undefined } });
      return json(200, { ...document, credentials: undefined });
    }) as unknown as typeof fetch;
    // ---- gh: the uat secret as GitHub records it, its updated_at to the second.
    const github = { secret: { updatedAt: new Date(Math.floor((start - day + minute) / 1000) * 1000).toISOString(), fingerprint: fingerprint('t0'.repeat(32)) } as { updatedAt: string; fingerprint: string } | null, storeFails: false, sets: [] as { at: number; stored: boolean; fingerprint: string }[], reads: 0 };
    const gh: NonNullable<ReleaseFilingDeps['gh']> = async (args, input) => {
      assert.ok(!args.some(arg => arg.includes(admin)), 'the admin credential never reaches a gh argument');
      if (args[0] === 'api') {
        github.reads++;
        return github.secret ? { code: 0, stdout: JSON.stringify({ name: releaseFilingSecret, created_at: github.secret.updatedAt, updated_at: github.secret.updatedAt }), stderr: '' } : { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
      }
      assert.deepEqual(args, ['secret', 'set', releaseFilingSecret, '--repo', repository, '--env', 'uat'], `an unexpected gh call: ${args.join(' ')}`);
      assert.ok(input && input.length >= 64 && !args.includes(input), 'the token goes to gh over standard input, never as an argument');
      const stored = !github.storeFails;
      github.sets.push({ at: (now - start) / minute, stored, fingerprint: fingerprint(input!) });
      if (stored) github.secret = { updatedAt: new Date(Math.floor(now / 1000) * 1000).toISOString(), fingerprint: fingerprint(input!) };
      return stored ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible by personal access token' };
    };
    // ---- The host: the install's admin credential, and the tokens the master mints.
    const host = { adminMissing: false, minted: [] as string[] };
    const deps: ReleaseFilingDeps = { adminToken: async () => host.adminMissing ? null : admin, fetch: fetcher, gh, now: () => now, token: () => { const token = createHash('sha256').update(`mint-${host.minted.length}-${now}`).digest('hex'); host.minted.push(token); return token; } };
    const setup = ((setupRoot: string, setupMaster: Parameters<typeof masterSetup>[1], options: Parameters<typeof masterSetup>[2]) =>
      masterSetup(setupRoot, setupMaster, options, { locate: async () => null, now: () => now, releaseFiling: deps })) as typeof masterSetup;
    const runs: { at: number; step: ReleaseFilingStep; outcome: string; failed: boolean }[] = [];
    /** The cycles (minutes from the start) at which the cycle recorded the setup step's failed action. */
    const recordedFailures: number[] = [];
    const effects = {
      agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
      snapshot: async () => ({ work: [], now: iso(now) }),
      closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, persist: async () => {},
      observeDeployment: async () => ({ source: 'endpoint', sha: 'd'.repeat(40), at: iso(now), reason: null, deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {},
      selfProvision: async () => loopSelfProvision(root, master, { now, setup }),
    } as unknown as DaemonEffects;

    const state = emptyDaemonState(master);
    const violations: string[] = [], misread: string[] = [];
    /** Whether GitHub's secret is not the credential the plane holds newest, read off the scripted world itself, which knows what each store held. */
    const stale = () => !github.secret || github.secret.fingerprint !== document.fingerprints.at(-1);
    for (let cycle = 0; now < start + 2 * day; cycle++, now += minute) {
      const at = (now - start) / minute;
      // The world as this minute finds it.
      if (at === windows.rotatedOutOfBand) { document.fingerprints.push(fingerprint('oob1'.repeat(16))); document.credentialIssuedAt = iso(now); document.revision++; document.lastMutation = { kind: 'rotate', actor: 'operator', at: iso(now), reason: 'rotated by hand' }; }
      if (at === windows.widenedWhileRotateRefused.from) {
        document.fingerprints.push(fingerprint('oob2'.repeat(16))); document.credentialIssuedAt = iso(now); document.revision++; document.lastMutation = { kind: 'rotate', actor: 'operator', at: iso(now), reason: 'rotated by hand' };
        document.scope = { repositories: [repository, 'owner/other'], workItems: ['*'] }; document.revision++; document.lastMutation = { kind: 'configure', actor: 'operator', at: iso(now + 1), reason: 'widened by hand' };
      }
      plane.rotateFails = within(at, windows.widenedWhileRotateRefused);
      if (at === windows.secretDeletedWhileStoreRefused.from) github.secret = null;
      github.storeFails = within(at, windows.secretDeletedWhileStoreRefused);
      host.adminMissing = within(at, windows.adminMissing);
      plane.down = within(at, windows.planeDown);
      if (at === windows.storedThenRotatedWithinSecond) {
        // An administrator stores the token the identity holds now (0.9 s ago) and rotates it by hand (0.5 s ago): GitHub reports the store's
        // second, which is the rotation's second. The secret holds a credential the rotation replaced; no handoff record names that store.
        github.secret = { updatedAt: new Date(Math.floor((now - 900) / 1000) * 1000).toISOString(), fingerprint: document.fingerprints.at(-1)! };
        document.fingerprints.push(fingerprint('oob3'.repeat(16))); document.credentialIssuedAt = iso(now - 500); document.revision++; document.lastMutation = { kind: 'rotate', actor: 'operator', at: iso(now - 500), reason: 'rotated by hand' };
        assert.equal(Math.floor(Date.parse(github.secret.updatedAt) / 1000), Math.floor(Date.parse(document.credentialIssuedAt) / 1000), 'the store and the rotation share a GitHub second');
      }

      const result = await runCycle(master, state, effects, () => now);
      // The step runs beside the cycle; its outcome lands before the next minute, as a real minute lets it.
      while ((await lastLoopSelfProvision(root))?.outcome === 'running') await new Promise(resolve => setTimeout(resolve, 1));
      const last = (await lastLoopSelfProvision(root))!;
      // The run that started this minute, settled: what the step found and did.
      if (last.at === iso(now)) runs.push({ at, step: last.releaseFiling!, outcome: last.outcome, failed: last.failed });
      for (const check of state.invariants.report) if (!check.holds) violations.push(`cycle ${cycle} (+${at} min): ${check.invariant} — ${check.reading}`);
      // A run whose filing step failed is a failed run: the cycle after it records the setup step's one isolated config action, and nothing else is isolated.
      const isolated = Object.keys(state.actions).filter(name => name.startsWith('isolated:'));
      assert.ok(isolated.every(name => name === 'isolated:config:setup self-provision'), `cycle ${cycle} (+${at} min): a failure other than the setup step's reached an isolation record: ${isolated.join(', ')}`);
      const failedStep = result.actions.filter(action => action.kind === 'config' && /self-provision/.test(action.detail));
      assert.ok(failedStep.length <= 1, `cycle ${cycle} (+${at} min): one setup action at most`);
      if (failedStep.length) { recordedFailures.push(at); assert.match(failedStep[0]!.detail, /setup self-provision failed: release filing failed: /, `cycle ${cycle} (+${at} min): the failed action names the filing failure`); }
      assert.ok(Object.keys(state.faults.failing).every(key => key === 'isolated:config:setup self-provision'), `cycle ${cycle} (+${at} min): a failing fault run other than the setup step's`);
      // The instrument is truthful: current is reported only while the secret GitHub holds is as new as the credential the plane holds.
      if (last.at === iso(now) && last.releaseFiling!.state === 'current' && stale()) misread.push(`+${at} min: read current while the secret (${github.secret?.updatedAt ?? 'none'}, ${github.secret?.fingerprint}) predates the credential issued ${document.credentialIssuedAt} (${document.fingerprints.at(-1)})`);
      // Nothing secret leaks: not a token, not the admin credential, in what the loop keeps or journals.
      const kept = `${last.outcome} ${last.releaseFiling?.detail ?? ''} ${JSON.stringify(result.actions)}`;
      assert.ok(!kept.includes(admin) && !host.minted.some(token => kept.includes(token)), `cycle ${cycle} (+${at} min): a credential reached the loop's record`);
    }
    assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
    assert.deepEqual(misread, [], 'no run reads a stale secret as current');

    // Bounded: once an hour while the step succeeds or finds the host without an admin credential; a run whose filing step failed is a
    // failed run, retried ten minutes on, then twenty, forty, eighty, a hundred and sixty (`loopProvisionDelay`) — never every cycle, never
    // left the hour a success earns — and the first run after the fault lifts repairs it, after which the hour resumes from that run.
    const schedule = [0, 60, 120, 180, 240, 300, 360, 420, 480, 540,
      600, 610, 630, 670, 750, 910, 970, 1030, 1090, 1150,
      1210, 1220, 1240, 1280, 1360, 1420, 1480, 1540, 1600, 1660, 1720, 1780,
      1840, 1900, 1960, 2020, 2080, 2140, 2200, 2260, 2320, 2380,
      2440, 2450, 2470, 2510, 2590, 2650, 2710, 2770, 2830];
    assert.deepEqual(runs.map(run => run.at), schedule, 'the step runs on the hour, backing off from ten minutes after a failed filing step');
    // The schedule is the loop's own rule applied to what each run found: each run starts loopProvisionDelay(failures in a row) after the last.
    let failures = 0;
    for (const [index, run] of runs.entries()) {
      if (index) assert.equal((run.at - runs[index - 1]!.at) * minute, loopProvisionDelay(failures), `+${run.at} min: the wait after ${failures} failure(s) in a row`);
      failures = run.failed ? failures + 1 : 0;
    }
    assert.deepEqual(runs.filter(run => run.failed).map(run => run.step.state), runs.filter(run => run.step.state === 'failed').map(() => 'failed'), 'a run is failed exactly when its filing step failed');
    assert.deepEqual(runs.filter(run => run.failed).map(run => run.at), [600, 610, 630, 670, 750, 1210, 1220, 1240, 1280, 2440, 2450, 2470, 2510], 'thirteen failed runs in three faults');
    for (const run of runs.filter(run => run.failed)) assert.match(run.outcome, /^failed: release filing failed: .* \(derived variables: /, `+${run.at} min: the failed run's outcome names the filing failure`);
    assert.deepEqual(recordedFailures, runs.filter(run => run.failed).map(run => run.at + 1), 'the cycle after each failed run records the setup step\'s failed action, and no other cycle does');
    assert.match(state.actions['isolated:config:setup self-provision']!.detail, /setup self-provision failed: release filing failed: Graphyard refused operator-agents \(503\)/, 'the one setup action holds the last failure');
    const states = (from: number, to: number) => runs.filter(run => run.at >= from && run.at < to).map(run => run.step.state);
    // Steady state: current, reading only — nothing mutated, nothing stored, nothing audited.
    assert.deepEqual(states(0, windows.rotatedOutOfBand), ['current', 'current', 'current', 'current', 'current']);
    assert.deepEqual(plane.posts.filter(post => post.at < windows.rotatedOutOfBand), []);
    assert.deepEqual(github.sets.filter(set => set.at < windows.rotatedOutOfBand), []);
    // An out-of-band rotation whose secret was never stored: rotated and stored on the next run, with the transition, then current.
    assert.deepEqual(states(windows.rotatedOutOfBand, windows.widenedWhileRotateRefused.from), ['rotated', 'current', 'current', 'current', 'current']);
    assert.deepEqual(plane.posts.filter(post => post.at === windows.rotatedOutOfBand).map(post => [post.action, post.body.transitionSeconds]), [['rotate', releaseFilingTransitionSeconds]]);
    assert.deepEqual(github.sets.filter(set => set.at === windows.rotatedOutOfBand).map(set => set.stored), [true]);
    // Widened and rotated out of band while the plane refuses rotations: the first run narrows and then fails the rotation; the
    // retries, backing off from ten minutes, find the secret still stale (the issue time survived the configure), narrow nothing
    // again, and fail the rotation, until the first run after the plane takes it: rotated and stored, then current on the hour.
    const widened = windows.widenedWhileRotateRefused;
    assert.deepEqual(states(widened.from, windows.secretDeletedWhileStoreRefused.from), ['failed', 'failed', 'failed', 'failed', 'failed', 'rotated', 'current', 'current', 'current', 'current']);
    assert.deepEqual(plane.posts.filter(post => within(post.at, widened) || post.at === 910).map(post => [post.at, post.action]), [[widened.from, 'configure'], [910, 'rotate']], 'one narrowing, then one rotation once the plane takes it');
    assert.match(runs.find(run => run.at === widened.from)!.step.detail, /refused .*\/rotate \(503\)/);
    for (const run of runs.filter(run => within(run.at, widened))) assert.notEqual(run.step.state, 'current', `+${run.at} min: ${run.step.detail}`);
    assert.deepEqual(document.scope, { repositories: [repository], workItems: ['*'] }, 'the identity holds the filing scope alone');
    assert.deepEqual(github.sets.filter(set => within(set.at, widened)), [], 'nothing is stored while no rotation succeeded');
    // The secret deleted while gh refuses to store one: each failed run rotates and fails the store, naming the retry, and is retried
    // with backoff; the first run gh accepts stores the credential it rotated to, and the next is current.
    const deleted = windows.secretDeletedWhileStoreRefused;
    assert.deepEqual(states(deleted.from, windows.adminMissing.from), ['failed', 'failed', 'failed', 'failed', 'rotated', 'current', 'current', 'current', 'current', 'current', 'current', 'current']);
    const attempts = github.sets.filter(set => set.at >= deleted.from && set.at <= deleted.to + 30);
    assert.deepEqual(attempts.map(set => [set.at, set.stored]), [[1210, false], [1220, false], [1240, false], [1280, false], [1360, true]], 'one store attempt per run, backing off, never per cycle');
    for (const run of runs.filter(run => within(run.at, deleted))) assert.match(run.step.detail, /rotated but storing GRAPHYARD_RELEASE_TOKEN .* failed \(gh exited 1\): HTTP 403.*the next run rotates it again/);
    assert.equal(attempts.at(-1)!.fingerprint, plane.posts.find(post => post.at === attempts.at(-1)!.at && post.action === 'rotate')!.body.token, 'the secret stored is the credential that run rotated to');
    // No admin credential on the host: unavailable, naming the administrator's step, and nothing is called — the host's standing
    // condition, never a failed run, so the hour holds; current again once it is back.
    const missing = windows.adminMissing;
    assert.deepEqual(states(missing.from, windows.planeDown.from), ['unavailable', 'unavailable', 'unavailable', 'current', 'current', 'current', 'current', 'current', 'current', 'current']);
    for (const run of runs.filter(run => within(run.at, missing))) { assert.match(run.step.detail, /no installation admin credential is saved/); assert.match(run.step.next!, /graphyard operator-agent setup FILE --token-stdin/); assert.match(run.outcome, /release filing unavailable/); assert.equal(run.failed, false, `+${run.at} min: unavailable is no failed run`); }
    assert.equal(plane.posts.filter(post => within(post.at, missing)).length + github.sets.filter(set => within(set.at, missing)).length, 0, 'nothing is mutated without the admin credential');
    // The plane down: failed, retried with backoff, nothing rotated or stored; current on the first run after it is back.
    const down = windows.planeDown;
    assert.deepEqual(states(down.from, windows.storedThenRotatedWithinSecond), ['failed', 'failed', 'failed', 'failed', 'current', 'current']);
    for (const run of runs.filter(run => within(run.at, down))) assert.match(run.step.detail, /Graphyard refused operator-agents \(503\)/);
    assert.deepEqual(plane.posts.filter(post => post.at >= down.from && post.at < windows.storedThenRotatedWithinSecond), [], 'nothing is mutated after the outage: the credential was already current');
    // A token stored by hand within the second of a rotation by hand: GitHub's second cannot order them and no handoff record names the
    // store, so the run is never read as current — it rotates and stores, its own store landing in its rotation's second, which the
    // handoff record it writes proves to the next run: current, nothing rotated again.
    const byHand = windows.storedThenRotatedWithinSecond;
    assert.deepEqual(states(byHand, 48 * 60), ['rotated', 'current', 'current']);
    assert.match(runs.find(run => run.at === byHand + 10)!.step.detail, /^rotated /);
    assert.deepEqual(plane.posts.filter(post => post.at >= byHand).map(post => [post.at, post.action]), [[byHand + 10, 'rotate']], 'one rotation, not one per run');
    assert.deepEqual(github.sets.filter(set => set.at >= byHand).map(set => [set.at, set.stored]), [[byHand + 10, true]]);
    assert.equal(Math.floor(Date.parse(github.secret!.updatedAt) / 1000), Math.floor(Date.parse(document.credentialIssuedAt) / 1000), 'the master\'s own store landed in its rotation\'s second');
    assert.match(runs.find(run => run.at === byHand + 70)!.step.detail, /is the credential the master stored/);
    const handoff = JSON.parse(await readFile(join(root, '.graphyard', 'release-filing-handoff.json'), 'utf8'));
    assert.deepEqual(handoff, { at: iso(start + (byHand + 10) * minute), fingerprint: document.fingerprints.at(-1), secretUpdatedAt: github.secret!.updatedAt }, 'the handoff record names the credential stored and the store GitHub reported');
    // Every run reads the identity once, but the three with no admin credential (nothing is called) and the four with no plane; the secret is read once
    // per such run and once more after each store, to record the handoff.
    const storedCount = github.sets.filter(set => set.stored).length;
    assert.deepEqual([plane.gets, github.reads], [runs.length - 3 - 4, runs.length - 3 - 4 + storedCount], 'one roster read per run that could make it, one secret read per such run and one per store');

    // The whole two days: every mutation was one a window called for, every store carried a credential the plane issued, and the audit names each stored token by fingerprint only.
    assert.deepEqual(plane.posts.map(post => post.action), ['rotate', 'configure', 'rotate', 'rotate', 'rotate', 'rotate', 'rotate', 'rotate', 'rotate'], 'nine mutations in two days');
    assert.deepEqual(github.sets.map(set => set.stored), [true, true, false, false, false, false, true, true], 'eight store attempts, four stored');
    for (const set of github.sets) assert.ok(document.fingerprints.includes(set.fingerprint), 'every token stored was issued by the plane');
    const audit = (await readFile(setupAuditFile(root), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(audit.map(entry => [entry.variable, entry.secret, entry.fingerprint]), github.sets.filter(set => set.stored).map(set => [releaseFilingSecret, true, set.fingerprint]), 'one audit line per token stored, by fingerprint');
    const status = await readFile(join(root, '.graphyard', 'setup-self-provision.json'), 'utf8');
    for (const text of [status, await readFile(setupAuditFile(root), 'utf8'), JSON.stringify(handoff)]) assert.ok(!text.includes(admin) && !host.minted.some(token => text.includes(token)), 'no credential reaches a file the loop keeps');
    assert.equal(runs.at(-1)!.step.state, 'current', 'the two days end current');
    assert.equal(stale(), false, 'the secret GitHub holds is the credential the plane holds newest');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
