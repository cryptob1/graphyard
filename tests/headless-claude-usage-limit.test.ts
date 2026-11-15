import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { headlessWorkers, type HeadlessWorkers } from './helpers/headless-workers.js';

// GY-3389: a spent Claude account ends a headless run at once with its usage-credits result; the
// account is held and the same dispatch starts the item on the next account, with no launch failure.
let workers: HeadlessWorkers;
before(async () => { workers = await headlessWorkers('headless-claude-usage-limit'); });
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
