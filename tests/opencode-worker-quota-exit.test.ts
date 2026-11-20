import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { headlessWorkers, type HeadlessWorkers } from './helpers/headless-workers.js';

// GY-3427: an OpenCode worker on a spent Z.AI plan exits at once printing its JSON error event, the
// provider.quota 429 (code 1310) nested in it; GY-3420 lost two epochs because the account stayed eligible.
let workers: HeadlessWorkers;
// The reset Z.AI names is a date: the clock is fixed after it, as in the incident that filed this,
// so the hold keeps the reset the notice itself named at any hour the test runs (GY-3561).
before(async () => { mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-20T12:00:00Z') }); workers = await headlessWorkers('opencode-worker-quota-exit'); });
after(async () => { await workers.stop(); });

const body = JSON.stringify({ error: { code: '1310', message: 'Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-20 12:49:15' } });
const event = JSON.stringify({ type: 'error', timestamp: 1763300000000, sessionID: 'ses_1a2b3c4d5e6feEZJI8NT7US4xBq',
  error: { type: 'provider.quota', message: 'Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-20 12:49:15', status: 429, response: { body } } });

test('integration:opencode-worker-quota-exit — the Z.AI quota error event holds the account until its reset and the item runs on another account', async () => {
  await workers.configure([{ name: 'opencode-spent', kind: 'opencode', printed: event }, { name: 'next-account', kind: 'codex', wait: true }]);
  const work = await workers.readyItem('GY-9673');
  const launched = await workers.dispatch(work);
  assert.equal(launched.runtime, 'codex', 'the item runs on another account');
  assert.equal(launched.epoch, 2);
  const item = await workers.stored(work.id);
  const spent = item.capacity?.exhaustions?.find(entry => entry.epoch === 1);
  assert.equal(spent?.account, 'opencode-spent');
  assert.equal(spent?.resetsAt, '2026-11-20T04:49:15.000Z', 'held until the reset Z.AI named, in Beijing time');
  assert.equal((await workers.registry.snapshot(workers.hostId)).accounts.find(entry => entry.name === 'opencode-spent')?.eligible, false, 'the spent account is held');
  assert.ok(!item.sessions!.some(session => /exited at once/.test(session.outcome ?? '')), 'no launch failure is recorded');
  await writeFile(join(workers.homes.get('next-account')!, 'release'), '');
  await workers.submitted(work.id, 2);
});
