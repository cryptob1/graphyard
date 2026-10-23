import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  headlessTimeoutLimit, headlessTimeoutLimitCharge, runTimeoutLimit,
} from '../src/model/capacity.js';
import {
  holdRepeatedLimitAccount, masterConfigSchema, observedExhaustions, recordEnvironmentLog,
  repeatedLimitAccount, selectAccount, selectionKey, sessionAccount, type MasterConfig,
} from '../src/master.js';
import type { RunEvent } from '../src/runner/types.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1705: a pane-role session that ends silent (Herdr `done`, never working, no outcome or notice
// past its start bound, still untouched screen) and a headless round stopped at its bound with a
// readable provider limit both hold the account the launch spent and fail the role over. Idle is
// not silent spend: Herdr reports a long or silent command as idle while it still runs.
// Fixed clocks are numeric epochs (no Date.parse/Date.UTC of a calendar day); Date.now() only
// drives the relative holds.

const limitError = '429: {"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-03 08:27:35"}';/** 2026-10-01T22:22:33.900Z as a millisecond epoch — handed to limit detectors as their fixed now. */
const limitNow = 1_790_893_353_900;
const limitReset = new Date(2026, 9, 3, 8, 27, 35).toISOString();

test('unit:run-timeout-limit-signal — a timeout round carries its provider limit from retry/stream errors; prose and tool-end booleans do not', () => {
  const retry: RunEvent = { kind: 'retry', at: new Date(limitNow).toISOString(), attempt: 1, error: limitError };
  const signal = runTimeoutLimit([retry], 'no terminal event within 1200s; the run was stopped', limitNow);
  assert.ok(signal); assert.equal(signal.resetsAt, limitReset); assert.match(signal.reason, /Weekly\/Monthly Limit Exhausted/);
  assert.equal(runTimeoutLimit([{ kind: 'tool-end', at: '', tool: 'x', call: '1', error: true, text: 'limit' } as RunEvent], 'timeout', limitNow), null);
  assert.equal(runTimeoutLimit([], 'no terminal event within 1200s; the run was stopped', limitNow), null, 'a bare timeout detail with no provider error is not a limit');
  const round = headlessTimeoutLimit([
    { result: 'timeout', detail: 'no terminal event within 1200s; the run was stopped', events: [retry] },
    { result: 'timeout', detail: 'no terminal event within 1200s; the run was stopped', events: [{ kind: 'message', error: limitError }] },
  ], limitNow);
  assert.ok(round); assert.equal(round.resetsAt, limitReset);
  // One readable limit in an all-timeout round is enough: the fallback need not repeat the notice.
  const oneNotice = headlessTimeoutLimit([
    { result: 'timeout', detail: 'no terminal event within 1200s; the run was stopped', events: [retry] },
    { result: 'timeout', detail: 'no terminal event within 1200s; the run was stopped', events: [] },
  ], limitNow);
  assert.ok(oneNotice); assert.equal(oneNotice.resetsAt, limitReset);
  assert.equal(headlessTimeoutLimit([{ result: 'timeout', detail: 'stopped', events: [] }, { result: 'timeout', detail: 'stopped', events: [] }], limitNow), null);
  assert.equal(headlessTimeoutLimit([{ result: 'timeout', detail: 'stopped', events: [retry] }, { result: 'exit', detail: 'gone', events: [] }], limitNow), null);
});

test('unit:hold-charged-to-selected-account — sessionAccount and repeatedLimit read the launch/selection account, never a nominal profile', async () => {
  const root = await temporaryDirectory('hold-charged');
  const credentialFile = join(root, 'coordinator.token');
  await writeFile(credentialFile, 'token', { mode: 0o600 });
  const config = { credentialFile } as Pick<MasterConfig, 'credentialFile'>;
  await recordEnvironmentLog(config, [], [], { key: selectionKey('reviewer', 'reviewer-a'), environment: 'claude-c', kind: 'claude', at: new Date().toISOString(), work: 'GY-1701' });
  await recordEnvironmentLog(config, [], [], { key: selectionKey('doctor', 'doctor'), environment: 'zai-a', kind: 'pi', at: new Date().toISOString(), work: null });
  assert.equal((await sessionAccount(root, config, 'reviewer', 'reviewer-a', { work: 'GY-1701' }))?.environment, 'claude-c');
  assert.equal((await sessionAccount(root, config, 'doctor', 'doctor'))?.environment, 'zai-a');
  const base = Date.now();
  const exhaustion = (requestId: string, offsetMs: number) => ({
    at: new Date(base + offsetMs).toISOString(), role: 'reviewer' as const, account: 'claude-c', profile: 'reviewer-a', reason: 'silent', resetsAt: null, requestId,
    recordedBy: 'loop', owner: null, runtime: 'claude', partialWork: { state: 'not-applicable' as const, detail: 'n/a' },
  });
  // Distinct sessions share one request id across failover relaunches — they still count.
  const work = { key: 'GY-1', epoch: 2, capacity: { spent: [], exhaustions: [exhaustion('same-decision', 0), exhaustion('same-decision', 60_000)] } };
  assert.equal(repeatedLimitAccount(work, base + 60_000, 'reviewer')?.account, 'claude-c');
  const duplicateReport = { key: 'GY-1', epoch: 2, capacity: { spent: [], exhaustions: [exhaustion('req-1', 0), exhaustion('req-1', 0)] } };
  assert.equal(repeatedLimitAccount(duplicateReport, base, 'reviewer'), null, 'the same instant reported twice is one session');
});

test('integration:no-repeat-launch-into-silent-account — holdRepeatedLimitAccount before selectAccount keeps a repeatedly spent pane account out of selection', async () => {
  const dir = await temporaryDirectory('pane-repeat-hold');
  const credentialFile = join(dir, 'coordinator.token');
  await writeFile(credentialFile, 'token', { mode: 0o600 });
  await mkdir(join(dir, 'env-a'), { recursive: true }); await mkdir(join(dir, 'env-b'), { recursive: true });
  await writeFile(join(dir, 'env-a/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: 'x' } }));
  await writeFile(join(dir, 'env-b/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: 'x' } }));
  const config = masterConfigSchema.parse({
    version: 1, url: 'https://graphyard.example', credentialFile, cliPath: 'graphyard', repository: 'owner/project', baseBranch: 'main',
    githubAppId: 1, hostId: 'machine-a', masterAgentName: 'gy-master', autoMerge: true, mergeMethod: 'merge', workers: [],
    environments: [{ name: 'env-a', kind: 'claude', home: join(dir, 'env-a') }, { name: 'env-b', kind: 'claude', home: join(dir, 'env-b') }],
    reviewers: [{ name: 'reviewer-a', agentName: 'agent-reviewer-a', kind: 'claude', agentArgs: [], approvals: 'auto', environment: {}, accounts: ['env-a', 'env-b'] }],
  }) as MasterConfig;
  const base = Date.now();
  const exhaustion = (role: 'reviewer', offsetMs: number) => ({
    at: new Date(base + offsetMs).toISOString(), role, account: 'env-a', profile: 'reviewer-a', reason: 'quota', resetsAt: null,
    requestId: 'shared-request', recordedBy: 'loop', owner: null, runtime: 'claude', partialWork: { state: 'not-applicable' as const, detail: 'n/a' },
  });
  // Two spent reviewer sessions sharing one request id hold before selectAccount (the launchReview path).
  const reviewWork = { key: 'GY-1701', epoch: 2, capacity: { spent: [], exhaustions: [exhaustion('reviewer', 0), exhaustion('reviewer', 90_000)] } };
  assert.equal(repeatedLimitAccount(reviewWork, base + 90_000, 'reviewer')?.account, 'env-a');
  const at = base + 90_000;
  const reviewHold = await holdRepeatedLimitAccount(config, reviewWork, at, {}, 'reviewer');
  assert.equal(reviewHold?.account, 'env-a');
  assert.ok((await observedExhaustions(config, at))['env-a']);
  const reviewProfile = config.reviewers[0]!;
  const reviewChosen = await selectAccount(config, 'reviewer', reviewProfile, { quota: false, cacheMs: 0, now: () => at, work: reviewWork.key });
  assert.equal(reviewChosen.account?.name, 'env-b', 'launchReview\'s selectAccount path skips the repeatedly held reviewer account');
});

test('unit:run-timeout-limit-signal — headlessTimeoutLimitCharge holds every named limit attempt with its own reset', () => {
  const retry: RunEvent = { kind: 'retry', at: new Date(limitNow).toISOString(), attempt: 1, error: limitError };
  // Fallback-only notice on an unnamed Pi login: do not charge the silent registry primary.
  const charged = headlessTimeoutLimitCharge([
    { result: 'timeout', detail: 'no terminal event within 1200s; the run was stopped', events: [], account: 'registry-a' },
    { result: 'timeout', detail: 'no terminal event within 1200s; the run was stopped', events: [retry], account: null },
  ], limitNow);
  assert.ok(charged);
  assert.equal(charged.account, null, 'a fallback notice with no named account does not keep the primary registry account');
  assert.deepEqual(charged.holds, []);
  const primaryNotice = headlessTimeoutLimitCharge([
    { result: 'timeout', detail: 'stopped', events: [retry], account: 'registry-a' },
    { result: 'timeout', detail: 'stopped', events: [], account: null },
  ], limitNow);
  assert.equal(primaryNotice?.account, 'registry-a');
  assert.deepEqual(primaryNotice?.holds.map(entry => entry.account), ['registry-a']);
  // Both attempts print a limit: keep the named primary even when the Pi fallback is account: null.
  const both = headlessTimeoutLimitCharge([
    { result: 'timeout', detail: 'stopped', events: [retry], account: 'registry-a' },
    { result: 'timeout', detail: 'stopped', events: [retry], account: null },
  ], limitNow);
  assert.equal(both?.account, 'registry-a');
  assert.deepEqual(both?.holds.map(entry => entry.account), ['registry-a']);
  // Each named hold keeps its own resetsAt; the round wait still uses the earliest reset.
  const earlyReset = new Date(limitNow + 86_400_000).toISOString();
  const early = `Weekly/Monthly Limit Exhausted. Your limit will reset at ${earlyReset.replace('T', ' ').replace(/\.\d+Z$/, '')} UTC`;
  const lateRetry: RunEvent = { kind: 'retry', at: new Date(limitNow).toISOString(), attempt: 1, error: limitError };
  const earlyRetry: RunEvent = { kind: 'retry', at: new Date(limitNow).toISOString(), attempt: 1, error: early };
  const paired = headlessTimeoutLimitCharge([
    { result: 'timeout', detail: 'stopped', events: [lateRetry], account: 'registry-a' },
    { result: 'timeout', detail: 'stopped', events: [earlyRetry], account: null },
  ], limitNow);
  assert.equal(paired?.account, 'registry-a');
  assert.equal(paired?.holds.length, 1);
  assert.equal(paired?.holds[0]!.account, 'registry-a');
  assert.equal(paired?.holds[0]!.limit.resetsAt, limitReset, 'named hold keeps registry-a\'s own reset');
  assert.ok(paired?.limit.resetsAt);
  assert.ok(Date.parse(paired!.limit.resetsAt!) < Date.parse(limitReset), 'round wait still uses the earlier fallback reset');
  const round = headlessTimeoutLimit([
    { result: 'timeout', detail: 'stopped', events: [lateRetry] },
    { result: 'timeout', detail: 'stopped', events: [earlyRetry] },
  ], limitNow);
  assert.equal(round?.resetsAt, paired?.limit.resetsAt, 'round retry still uses the earliest reset');
});
