import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { liveRun } from '../src/runner/registry.js';
import { transcriptRun } from '../src/model/sessions.js';
import type { Work } from '../src/model.js';
import { contractKinds, headlessWorkerKindTest, headlessWorkers, type HeadlessWorkers } from './helpers/headless-workers.js';

// GY-3259: workers run through the headless runner; this file holds the matrix's built-in contract
// kinds and the account-handoff behaviour, and tests/headless-workers-registry-kinds.test.ts holds
// the registry-contract kinds — one file cannot host the whole matrix inside the merge trial's
// five-minute per-file bound (tests/helpers/bounded-tests.mjs).
let workers: HeadlessWorkers;
before(async () => { workers = await headlessWorkers('headless-workers'); });
after(async () => { await workers.stop(); });
for (const kind of contractKinds) headlessWorkerKindTest(() => workers, kind);

test('e2e:headless-workers — a limit exit hands the item to the next account within ONE dispatch invocation; both run logs stay readable', async () => {
  await workers.configure([{ name: 'spent', kind: 'claude', failure: "You've hit your session limit · resets 11pm" }, { name: 'successor', kind: 'muse', wait: true }]);
  const work = await workers.readyItem('GY-9650');
  const launched = await workers.dispatch(work);
  // Before dispatch returned: the first run ended, its work and hold were recorded, and the successor runs under a new epoch.
  assert.equal(await readFile(join(workers.homes.get('spent')!, 'starts'), 'utf8'), '1');
  assert.ok(await workers.started('successor'), 'the successor started before dispatch returned');
  assert.equal(launched.epoch, 2);
  assert.equal(launched.runtime, 'muse');
  assert.ok(liveRun('eng-a'), 'the successor is a live worker session');
  assert.match(launched.fallback?.note ?? '', /spent/);
  const handedOff = await workers.stored(work.id);
  const exhaustion = handedOff.capacity?.exhaustions?.find(entry => entry.epoch === 1);
  assert.equal(exhaustion?.account, 'spent');
  assert.equal(exhaustion?.partialWork?.state, 'committed', 'the uncommitted work of the first run was kept on its branch');
  assert.equal((await workers.registry.snapshot(workers.hostId)).accounts.find(account => account.name === 'spent')?.eligible, false, 'the spent account is held');
  // The successor resumes the preserved work: its brief names the kept commit.
  assert.ok(((await workers.started('successor')).args as string[]).some(word => word.includes(exhaustion!.partialWork!.commit!.slice(0, 12))), 'the successor brief names the preserved commit');
  await writeFile(join(workers.homes.get('successor')!, 'release'), '');
  await workers.submitted(work.id, 2);
  // The item lists both runs by attempt — the prior account's, ended on its limit, and the successor's.
  const sessions = (await workers.stored(work.id)).sessions!.filter(session => session.kind === 'implementation');
  assert.deepEqual(sessions.map(session => [session.id, session.state]), [['worker-a:1', 'finished'], ['worker-a:2', 'running']]);
  assert.match(sessions[0]!.outcome ?? '', /limit notice/);
  const first = transcriptRun(sessions[0]!.transcript)!;
  assert.equal(transcriptRun(sessions[1]!.transcript), launched.run);
  // Both runs' logs — the settled limit run and the completed successor — are served, redacted, to a reader of the item.
  const spent = await workers.runLog(work, first);
  assert.equal(spent.status, 200, JSON.stringify(spent.body));
  assert.equal(spent.body.ended, true);
  assert.equal(spent.body.run.account, 'spent');
  assert.ok(spent.body.lines.some((line: any) => line.stream === 'stdout' && /stub claude working on GY-9650 epoch 1/.test(line.text) && line.at));
  assert.ok(spent.body.lines.some((line: any) => line.stream === 'stderr' && /session limit/.test(line.text)));
  assert.ok(spent.body.lines.some((line: any) => line.stream === 'stderr' && line.text.includes('token=[redacted]')));
  assert.ok(!JSON.stringify(spent.body).includes('leaked-secret-value'), 'credentials are redacted before they are stored');
  const done = await workers.runLog(work, launched.run);
  assert.equal(done.status, 200);
  assert.equal(done.body.run.account, 'successor');
  assert.ok(done.body.lines.some((line: any) => line.stream === 'stdout' && /^submitted [0-9a-f]{40} 200$/.test(line.text)));
  // Access is the item's readers': a remote request without a credential is refused, and another item's path never reaches a run it does not name.
  for (const headers of [{ 'X-Forwarded-For': '203.0.113.9' }, { Authorization: `Bearer not-a-token-${'y'.repeat(32)}` }] as Record<string, string>[])
    assert.equal((await fetch(`${workers.url}/api/work/${work.key}/runs/${launched.run}/log`, { headers })).status, 401, 'a remote reader without this repository\'s credential is refused');
  const other: Work = await workers.readyItem('GY-9651');
  assert.equal((await workers.runLog(other, launched.run)).status, 404);
  assert.equal(existsSync(workers.herdrCalls), false);
});

test('e2e:headless-workers — no eligible account left: the item stays queued with the cause recorded', async () => {
  await workers.configure([{ name: 'last-a', kind: 'claude', failure: "You've hit your session limit · resets 11pm" }, { name: 'last-b', kind: 'codex', failure: "You've hit your usage limit. Try again at 11:00 PM." }]);
  const work = await workers.readyItem('GY-9660');
  await assert.rejects(workers.dispatch(work), /no further account|could be launched/);
  const item = await workers.stored(work.id);
  assert.equal(item.lease, null, 'nothing holds the item');
  assert.equal(item.ready, true);
  assert.deepEqual(item.capacity?.exhaustions?.map(entry => entry.account).sort(), ['last-a', 'last-b']);
  for (const name of ['last-a', 'last-b']) assert.equal(await readFile(join(workers.homes.get(name)!, 'starts'), 'utf8'), '1', 'each account starts at most once');
});
