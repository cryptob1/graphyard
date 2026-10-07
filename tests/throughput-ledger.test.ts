import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Work } from '../src/model.js';
import { loopThroughputMeasurement, readThroughputMeasurement, throughputClaim, throughputClaimVisibility, throughputMeasurementDirectory, throughputStatus, type ThroughputReport } from '../src/throughput.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// @ts-expect-error Dependency-free measurement script.
import { main as measureMain } from '../scripts/measure-throughput.mjs';

/**
 * GY-1437: GY-87's throughput verification is owned end to end. The loop re-measures the serving
 * release while its claim is short of session-free deliveries, every attempt lands in the ledger
 * with its per-delivery list, timestamps and output, and a claim still unverified 48 hours after
 * the pursuit opened escalates the operator naming the exact blocker instead of aging.
 */

// The ledger is new with GY-1437: loaded inside each test, so a base without it fails these as test cases.
const ledgerModule = () => import('../src/throughput-ledger.js');
/** The re-measure interval GY-1437 adds; an hour, read from the module when it has one. */
const remeasureMs = async () => ((await import('../src/throughput.js')) as { throughputRemeasureMs?: number }).throughputRemeasureMs ?? 60 * 60_000;

const commit = (label: string) => createHash('sha1').update(label).digest('hex');
const hour = 3_600_000;
const served = commit('served-release');

/** GY-87 delivered and observed serving: the window opens at its deployment, and no session-free delivery has landed since. */
const claim = { id: 'claim', key: throughputClaim.item, stage: 'done', title: 'GY-87', criteria: [], gates: [], violations: [], blocker: null, policy: { checks: [], review: true },
  delivery: { mergedAt: '2100-01-01T00:00:00.000Z', mergedAtRepository: '2100-01-01T00:00:00.000Z', mergeSha: commit('GY-87'), authorizationRevision: 1,
    deployment: { sha: served, mergeSha: commit('GY-87'), source: 'endpoint', observedAt: '2100-01-01T01:00:00.000Z', covers: 'exact', at: '2100-01-01T01:00:00.000Z', observer: 'coordinator-1' } } } as unknown as Work;

const verifiedReport = (measuredAt: string): ThroughputReport => ({ measuredAt, claim: throughputClaim, verdict: 'verified', reason: 'met over 10 session-free deliveries', shortfall: null,
  deployed: { revision: served, revisionSource: 'release.revision', version: null, origin: 'https://graphyard.example', observedAt: measuredAt, containsClaim: true, reason: null },
  window: { since: '2100-01-01T01:00:00.000Z', until: null, basis: 'deployment-observation', reason: 'observed' },
  population: { rule: 'rule', delivered: 10, real: 10, admitted: 10, excluded: 0 },
  deliveries: Array.from({ length: 10 }, (_, index) => ({ key: `GY-${index + 1}`, work: `w${index}`, pr: index + 1, mergeSha: commit(`m${index}`), mergedAt: `2100-01-02T0${index}:00:00.000Z`,
    submittedAt: null, submitToMergeMs: 10 * 60_000, actions: [], idle: null, admitted: true, exclusions: [] })) as unknown as ThroughputReport['deliveries'],
  excluded: [], submitToMerge: { count: 10, p50Ms: 600_000, p90Ms: 600_000 } as ThroughputReport['submitToMerge'], idle: { maxMs: 0, key: null, action: null, kind: null },
  all: { count: 10, submitToMerge: { count: 10, p50Ms: 600_000, p90Ms: 600_000 } as ThroughputReport['submitToMerge'], idleMaxMs: 0 }, populationEffect: null, met: true });

test('integration:throughput-measurement-ledger — the serving release is re-measured as session-free deliveries accumulate, each attempt keeps its per-delivery list, timestamps and output, and a claim still unverified after 48 hours escalates the operator naming the exact blocker', async () => {
  const { appendThroughputLedger, readThroughputLedger, recordedEntry, throughputEscalationMs, throughputLedgerFile, throughputPursuit } = await ledgerModule();
  const throughputRemeasureMs = await remeasureMs();
  const root = await temporaryDirectory('throughput-ledger');
  const directory = join(root, throughputMeasurementDirectory);
  let clock = Date.parse('2100-01-01T02:00:00.000Z');
  const input = { work: [claim], observedSha: served, now: () => clock, origin: 'https://graphyard.example',
    status: async () => ({ now: new Date(clock).toISOString(), release: { version: '1.0.0', revision: served } }),
    readItem: async () => { throw new Error('nothing in the window to read'); }, contains: async () => true as boolean | null };

  // The first measurement of the serving release finds 0 of 10 session-free deliveries: recorded,
  // not settled, and the ledger opens the pursuit with the record's deliveries, window and output.
  const first = await loopThroughputMeasurement(root, input);
  assert.equal(first.outcome, 'recorded'); assert.equal(first.settled, false);
  assert.equal(first.report!.population.admitted, 0);
  let ledger = await readThroughputLedger(directory);
  assert.equal(ledger.openedAt, first.report!.measuredAt, 'the pursuit opens at the first unverified attempt');
  assert.equal(ledger.entries.length, 1);
  const [entry] = ledger.entries;
  assert.equal(entry.source, 'loop'); assert.equal(entry.outcome, 'recorded'); assert.equal(entry.file, first.file);
  assert.equal(entry.blocker, 'no-session-free-deliveries'); assert.equal(entry.admitted, 0); assert.equal(entry.needed, throughputClaim.minimumDeliveries);
  assert.deepEqual(entry.window, { since: '2100-01-01T01:00:00.000Z', until: first.report!.measuredAt }, 'the window timestamps are kept');
  assert.match(entry.output, /GY-87 throughput claim: UNVERIFIED/, 'the command\'s own output is kept');
  assert.deepEqual(entry.deliveries, [], 'the per-delivery list is kept (none have landed yet)');

  // Inside the re-measure interval the record stands; past it the same release is measured again
  // rather than frozen at its first count — the loop owns the accumulating measurement.
  clock += throughputRemeasureMs - 1;
  const fresh = await loopThroughputMeasurement(root, input);
  assert.equal(fresh.outcome, 'current'); assert.equal(fresh.settled, false);
  assert.match(fresh.detail, /measured again from .* as deliveries accumulate/);
  clock += 1;
  const again = await loopThroughputMeasurement(root, input);
  assert.equal(again.outcome, 'recorded', 'an unverified measurement of the serving release is re-read');
  ledger = await readThroughputLedger(directory);
  assert.equal(ledger.entries.length, 2); assert.equal(ledger.openedAt, first.report!.measuredAt, 'the pursuit clock keeps running');

  // Inside the 48-hour bound the attention is carried by the loop (in motion until the bound), not aged as a fault.
  const deployed = { revision: served, version: '1.0.0' };
  const carried = await throughputStatus(root, { release: deployed }, [claim], clock);
  assert.equal(carried.pursuit!.escalated, false);
  assert.equal(carried.attention!.inMotionUntil, new Date(Date.parse(ledger.openedAt!) + throughputEscalationMs).toISOString());
  assert.equal(carried.attention!.human, false);
  assert.match(carried.attention!.text, /the loop re-measures the serving release as deliveries accumulate .* escalates the operator at/);

  // Past 48 hours with no session-free deliveries, the operator is escalated with that exact blocker.
  clock = Date.parse(ledger.openedAt!) + throughputEscalationMs;
  const stalled = await throughputStatus(root, { release: deployed }, [claim], clock);
  assert.equal(stalled.pursuit!.escalated, true); assert.equal(stalled.pursuit!.blocker, 'no-session-free-deliveries');
  assert.equal(stalled.attention!.human, true); assert.equal(stalled.attention!.inMotionUntil, undefined);
  assert.equal(stalled.attention!.humanOnly, 'goals and priorities');
  assert.match(stalled.attention!.text, /escalated: the claim has stayed unverified for 48h .* the blocker is no session-free deliveries occurring: 0 of the 10 deliveries/);

  // The by-hand run records into the same ledger: a run without a credential records the missing
  // credential, one that cannot reach the plane records the unreachable URL, and the escalation
  // names the newest attempt's blocker.
  const quiet = console.log, exitCode = process.exitCode;
  try {
    console.log = () => {};
    await assert.rejects(measureMain(['--record', directory], { GRAPHYARD_URL: 'https://graphyard.example' }), /Set GRAPHYARD_TOKEN/);
    assert.equal((await readThroughputLedger(directory)).entries.at(-1)!.blocker, 'missing-credentials');
    assert.equal(throughputPursuit(await readThroughputLedger(directory), clock)!.blocker, 'missing-credentials');
    const credentialed = await throughputStatus(root, { release: deployed }, [claim], clock);
    assert.equal(credentialed.attention!.humanOnly, 'issuing credentials to people');
    assert.match(credentialed.attention!.text, /the blocker is missing credentials/);
    await assert.rejects(measureMain(['--record', directory], { GRAPHYARD_URL: 'https://graphyard.example', GRAPHYARD_TOKEN: 'reader' },
      { fetcher: async () => { throw new TypeError('fetch failed'); } }), /fetch failed/);
    const unreachable = (await readThroughputLedger(directory)).entries.at(-1)!;
    assert.equal(unreachable.blocker, 'unreachable-url'); assert.equal(unreachable.source, 'script'); assert.equal(unreachable.outcome, 'failed');
    assert.match((await throughputStatus(root, { release: deployed }, [claim], clock)).attention!.text, /the blocker is unreachable URL/);

    // Once ten session-free deliveries have accumulated a by-hand record verifies the claim: the
    // ledger keeps its per-delivery list and output, the pursuit closes and the attention retires.
    const measuredAt = new Date(clock).toISOString();
    const recorded = await measureMain(['--record', directory], { GRAPHYARD_URL: 'https://graphyard.example', GRAPHYARD_TOKEN: 'reader' }, {
      fetcher: async (url: URL) => ({ ok: true, json: async () => url.pathname === '/api/status' ? { now: measuredAt } : { now: measuredAt, work: [] } }),
      deployedRevision: () => ({ revision: served, source: 'release.revision' }), run: () => ({ status: 0, stderr: '' }),
      measure: async () => ({ report: verifiedReport(measuredAt) }), render: () => 'GY-87 throughput claim: VERIFIED',
    });
    assert.equal(recorded.verdict, 'verified');
    ledger = await readThroughputLedger(directory);
    const verified = ledger.entries.at(-1)!;
    assert.equal(verified.verdict, 'verified'); assert.equal(verified.blocker, null); assert.equal(verified.at, measuredAt);
    assert.equal(verified.deliveries.length, 10); assert.ok(verified.deliveries.every(delivery => delivery.admitted && delivery.mergedAt && delivery.pr));
    assert.match(verified.output, /VERIFIED\nRecorded /);
    assert.equal(ledger.openedAt, null, 'verification closes the pursuit');
    const retired = await throughputStatus(root, { release: deployed }, [claim], clock);
    assert.equal(retired.verdict, 'verified'); assert.equal(retired.attention, null); assert.equal(retired.pursuit, null);
    // And the loop does not measure a verified release again.
    clock += 10 * throughputRemeasureMs;
    const settled = await loopThroughputMeasurement(root, input);
    assert.equal(settled.outcome, 'current'); assert.equal(settled.settled, true);
  } finally { console.log = quiet; process.exitCode = exitCode; }

  // The ledger is not a measurement record: retention and the newest-record read never touch it.
  assert.ok((await readdir(directory)).includes(throughputLedgerFile));
  assert.equal((await readThroughputMeasurement(root))!.report.verdict, 'verified');
  // An unreadable ledger reads empty rather than failing master status.
  await writeFile(join(directory, throughputLedgerFile), '{not json');
  assert.deepEqual(await readThroughputLedger(directory), { version: 1, openedAt: null, entries: [] });
  // Retention bounds the entries; the pursuit clock survives the oldest entries' retirement.
  const opened = await appendThroughputLedger(directory, recordedEntry({ ...verifiedReport('2100-02-01T00:00:00.000Z'), verdict: 'unverified' }, { source: 'loop', file: null, output: 'x' }), 2);
  for (let index = 1; index <= 3; index++) await appendThroughputLedger(directory, recordedEntry({ ...verifiedReport(`2100-02-01T0${index}:00:00.000Z`), verdict: 'unverified' }, { source: 'loop', file: null, output: 'x' }), 2);
  const bounded = await readThroughputLedger(directory);
  assert.equal(bounded.entries.length, 2); assert.equal(bounded.openedAt, opened.openedAt);
  assert.equal(JSON.parse(await readFile(join(directory, throughputLedgerFile), 'utf8')).openedAt, '2100-02-01T00:00:00.000Z');
});

test('integration:throughput-measurement-ledger — failures classify into the blockers an escalation names, and the loop keeps asking while the serving release is unverified', async () => {
  const { classifyThroughputFailure } = await ledgerModule();
  assert.equal(classifyThroughputFailure('Set GRAPHYARD_TOKEN or GRAPHYARD_TOKEN_FILE to a credential'), 'missing-credentials');
  assert.equal(classifyThroughputFailure('Graphyard refused the work snapshot (401)'), 'missing-credentials');
  assert.equal(classifyThroughputFailure('Set GRAPHYARD_URL to the control plane origin'), 'unreachable-url');
  assert.equal(classifyThroughputFailure('Graphyard refused the control-plane status (502)'), 'unreachable-url');
  assert.equal(classifyThroughputFailure('The operation was aborted due to timeout'), 'unreachable-url');
  assert.equal(classifyThroughputFailure('Unexpected end of JSON input'), 'measurement-failed');
  // Visibility without a ledger keeps its previous shape: the master owns it and it is not in motion.
  const plain = throughputClaimVisibility(null, { revision: served, version: null }, 3);
  assert.equal(plain.pursuit, null); assert.equal(plain.attention!.inMotionUntil, undefined); assert.equal(plain.attention!.role, 'master');

  // The loop's deployment step: an unverified answer is not settled, so it is asked again on the backoff rather than never.
  const directory = await temporaryDirectory('throughput-ledger-cycle');
  const token = join(directory, 'coordinator.token');
  await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: token, cliPath: 'graphyard', repository: 'owner/project', baseBranch: 'main',
    githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], run: { deploymentReuseMinutes: 0 } });
  const state = emptyDaemonState(master);
  state.lock = { id: 'lock', pid: process.pid, host: master.hostId, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() };
  let asks = 0, settled = false;
  const effects: DaemonEffects = {
    agents: () => [], credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: [claim], now: new Date().toISOString() }), closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'endpoint', sha: served, at: new Date().toISOString(), reason: null, deployed: [claim.key], pending: [], requests: 0 }) as any,
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    measureThroughput: async () => { asks++; return { outcome: asks === 1 ? 'recorded' : 'current', settled, revision: served, detail: settled ? 'verified' : `0 of 10 (ask ${asks})` }; },
  };
  for (let cycles = 0; cycles < 8; cycles++) await runCycle(master, state, effects, () => Date.now());
  assert.equal(state.actions[`throughput:${served}`].state, 'waiting', 'an unverified measurement waits to be measured again');
  assert.ok(asks >= 3 && asks <= 5, `eight cycles cost ${asks} asks on the backoff`);
  settled = true;
  for (let cycles = 0; cycles < 40 && state.actions[`throughput:${served}`].state !== 'done'; cycles++) await runCycle(master, state, effects, () => Date.now());
  assert.equal(state.actions[`throughput:${served}`].state, 'done', 'a verified measurement settles the release');
  const count = asks;
  for (let cycles = 0; cycles < 3; cycles++) await runCycle(master, state, effects, () => Date.now());
  assert.equal(asks, count, 'and it is never asked again');
});
