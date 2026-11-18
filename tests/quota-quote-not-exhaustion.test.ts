import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { headlessWorkers, type HeadlessWorkers } from './helpers/headless-workers.js';

// GY-3457: claude-a was held as exhausted only because its final message quoted claude-c's limit text.
// An exhaustion is read from the runtime's own exit signal, never from text a session printed in its work.
let workers: HeadlessWorkers;
before(async () => { workers = await headlessWorkers('quota-quote-not-exhaustion'); });
after(async () => { await workers.stop(); });

const claudeLimit = 'Switch to another model, or manage usage credits at https://claude.ai/settings/usage';
const zaiLimit = 'Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-20 12:49:15';
const zaiBody = JSON.stringify({ error: { code: '1310', message: zaiLimit } });
const quotaEvent = JSON.stringify({ type: 'error', sessionID: 'ses_quote', error: { type: 'provider.quota', message: zaiLimit, status: 429, response: { body: zaiBody } } });

const held = async (account: string) => (await workers.registry.snapshot(workers.hostId)).accounts.find(entry => entry.name === account)?.eligible === false;

for (const [kind, name, quoted, key] of [
  // The final assistant message quotes another account's limit text, and the run succeeds.
  ['claude', 'claude-a', { result: `claude-c's session ended on this, so I moved its work here:\n${claudeLimit}`, exit: 0 }, 'GY-9680'],
  // The worker's tool printed the Z.AI 1310 text from a fixture, and the run succeeds.
  ['opencode', 'opencode-a', { printed: `| bash  cat tests/fixtures/zai-quota.txt\n${zaiLimit}\n${zaiBody}`, exit: 0 }, 'GY-9681'],
] as const) test(`integration:quota-quote-not-exhaustion — a ${kind} session that quotes limit text and exits 0 leaves its account available`, async () => {
  await workers.configure([{ name, kind, smokePass: true, ...quoted }]);
  const work = await workers.readyItem(key);
  const launched = await workers.dispatch(work);
  assert.equal(launched.runtime, kind, 'the run stays on its own account');
  assert.equal(launched.epoch, 1);
  const item = await workers.stored(work.id);
  assert.equal(item.capacity?.exhaustions?.length ?? 0, 0, 'no exhaustion is recorded');
  assert.equal(await held(name), false, 'the account stays eligible');
});

for (const [kind, name, ending, key] of [
  ['claude', 'claude-a', { result: claudeLimit }, 'GY-9682'],
  ['opencode', 'opencode-a', { printed: quotaEvent, exit: 0 }, 'GY-9683'],
  ['pi', 'pi-a', { printed: `Error: 429: ${JSON.stringify({ code: '1310', message: zaiLimit })}\nRetry failed after 3 attempts` }, 'GY-9684'],
] as const) test(`integration:quota-quote-not-exhaustion — a ${kind} session that ends on its own limit exit holds its account`, async () => {
  const next = `${name}-next`;
  await workers.configure([{ name, kind, ...ending }, { name: next, kind: 'codex', wait: true }]);
  const work = await workers.readyItem(key);
  const launched = await workers.dispatch(work);
  assert.equal(launched.runtime, 'codex', 'the work moves to the next account');
  const item = await workers.stored(work.id);
  assert.equal(item.capacity?.exhaustions?.find(entry => entry.epoch === 1)?.account, name, 'the session\'s own account is recorded exhausted');
  assert.equal(await held(name), true, 'the account is held');
  await writeFile(join(workers.homes.get(next)!, 'release'), '');
  await workers.submitted(work.id, 2);
});
