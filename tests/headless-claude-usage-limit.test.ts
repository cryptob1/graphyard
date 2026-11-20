import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { headlessWorkers, type HeadlessWorkers } from './helpers/headless-workers.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { spawnHeadless, startHeadlessSession } from '../src/headless-session.js';

// GY-3389: a spent Claude account ends a headless run at once with its usage-credits result; the
// account is held and the same dispatch starts the item on the next account, with no launch failure.
let workers: HeadlessWorkers;
// The reset Z.AI names is a date: the clock is fixed after it, as in the incident that filed this,
// so the hold keeps the reset the notice itself named at any hour the test runs (GY-3561).
before(async () => { mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-20T12:00:00Z') }); workers = await headlessWorkers('headless-claude-usage-limit'); });
after(async () => { await workers.stop(); });

test('e2e:headless-claude-usage-limit — a headless claude usage-credits result holds its account and the same dispatch moves on', async () => {
  await workers.configure([{ name: 'claude-spent', kind: 'claude', result: 'Switch to another model, or manage usage credits at https://claude.ai/settings/usage' }, { name: 'next', kind: 'codex', wait: true }]);
  const work = await workers.readyItem('GY-9670');
  const launched = await workers.dispatch(work);
  assert.equal(await readFile(join(workers.homes.get('claude-spent')!, 'starts'), 'utf8'), '1', 'the spent account ran once');
  assert.equal(launched.runtime, 'codex');
  assert.equal(launched.epoch, 2);
  const item = await workers.stored(work.id);
  assert.equal(item.capacity?.exhaustions?.find(entry => entry.epoch === 1)?.account, 'claude-spent', 'the launch account is recorded exhausted');
  assert.equal((await workers.registry.snapshot(workers.hostId)).accounts.find(account => account.name === 'claude-spent')?.eligible, false, 'the spent account is held');
  assert.equal(item.blocker, null);
  const sessions = item.sessions!.filter(session => session.kind === 'implementation');
  assert.match(sessions[0]!.outcome ?? '', /limit notice/);
  assert.ok(!sessions.some(session => /exited at once/.test(session.outcome ?? '')), 'no launch failure is recorded');
  await writeFile(join(workers.homes.get('next')!, 'release'), '');
  await workers.submitted(work.id, 2);
});

// AC-2: OpenCode on a spent Z.AI plan exits at once printing the provider's quota error; its reset is a Beijing wall clock (GY-3495).
const zaiReset = new Date(Math.floor(Date.now() / 1000) * 1000 + 86_400_000).toISOString();
const zaiWall = new Date(Date.parse(zaiReset) + 8 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');
const zaiQuota = JSON.stringify({ type: 'provider.quota', message: `Weekly/Monthly Limit Exhausted. Your limit will reset at ${zaiWall}`, status: 429 });
// GY-3427: the worker run prints that error inside its JSON error event, with the 429 code 1310 body nested in it.
const zaiQuotaEvent = JSON.stringify({ type: 'error', sessionID: 'ses_etX5zluld0JtaK5', error: { ...JSON.parse(zaiQuota), response: { body: JSON.stringify({ error: { code: '1310', message: `Weekly/Monthly Limit Exhausted. Your limit will reset at ${zaiWall}` } }) } } });

for (const [shape, printed, key] of [['quota line', zaiQuota, 'GY-9671'], ['quota error event', zaiQuotaEvent, 'GY-9674']] as const) test(`e2e:headless-claude-usage-limit — a headless opencode worker exiting on the Z.AI ${shape} is held until its reset and the same dispatch moves on`, async () => {
  await workers.configure([{ name: 'opencode-spent', kind: 'opencode', printed }, { name: 'next-z', kind: 'codex', wait: true }]);
  const work = await workers.readyItem(key);
  const launched = await workers.dispatch(work);
  assert.equal(launched.runtime, 'codex');
  assert.equal(launched.epoch, 2);
  const item = await workers.stored(work.id);
  const spent = item.capacity?.exhaustions?.find(entry => entry.epoch === 1);
  assert.equal(spent?.account, 'opencode-spent');
  assert.equal(spent?.resetsAt, zaiReset, 'held until the reset Z.AI named, in Beijing time');
  assert.equal((await workers.registry.snapshot(workers.hostId)).accounts.find(entry => entry.name === 'opencode-spent')?.eligible, false, 'the spent account is held');
  assert.equal(item.blocker, null);
  assert.ok(!item.sessions!.some(session => /exited at once/.test(session.outcome ?? '')), 'no launch failure is recorded');
  await writeFile(join(workers.homes.get('next-z')!, 'release'), '');
  await workers.submitted(work.id, 2);
});

test('e2e:headless-claude-usage-limit — a headless opencode reviewer on a spent Z.AI plan is held until its reset and the review runs on the next account', async () => {
  const scratch = await temporaryDirectory('opencode-review', join(workers.root, '.graphyard'));
  const [spentBin, nextBin, directory] = [join(scratch, 'spent'), join(scratch, 'next'), join(scratch, 'checkout')];
  for (const path of [spentBin, nextBin, directory]) await mkdir(path, { recursive: true });
  // The reviewer said something before the error: that text reply must not hide the quota line.
  await writeFile(join(spentBin, 'opencode'), `#!/bin/sh\necho '{"type":"text","part":{"text":"Reviewing GY-9672."}}'\necho '${zaiQuota}'\nexit 1\n`, { mode: 0o755 });
  await writeFile(join(nextBin, 'opencode'), '#!/bin/sh\necho \'{"verdict":"approve"}\'\n', { mode: 0o755 });
  const holds: { reason: string; resetsAt: string | null }[] = [], moves: string[] = [];
  const session = await startHeadlessSession({ name: 'review-zai', work: 'GY-9672', subject: 'review', kind: 'opencode', account: 'opencode-a', args: [], environment: { PATH: `${spentBin}:/usr/bin:/bin` },
    directory, root: workers.root, route: 'review', context: {}, prompt: 'Review GY-9672.', exec: spawnHeadless,
    holdAccount: async notice => { holds.push(notice); },
    moveAccount: async (reason, cause) => { moves.push(`${cause}: ${reason}`); return { kind: 'opencode', account: 'opencode-b', args: [], environment: { PATH: `${nextBin}:/usr/bin:/bin` } }; },
    answer: async output => JSON.parse(output.trim()).verdict as string });
  assert.equal(await session.settled, 'approve');
  assert.equal(holds.length, 1);
  assert.match(holds[0]!.reason, /Limit Exhausted/);
  assert.equal(holds[0]!.resetsAt, zaiReset);
  assert.deepEqual(moves.map(move => move.split(':')[0]), ['limit']);
});
