import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { liveRelease } from '../src/deploy-watch.js';
import { shippedCounts } from '../src/model/board.js';
import type { Work } from '../src/model/work.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3452: shipped means live. Of the week's merges, only those the live commit contains are
// shipped; the rest are waiting to go live. An install that deploys elsewhere (lumina-investor on
// Railway) declares app.healthUrl in graphyard.json; Graphyard reads the live commit from it.

test('integration:shipped-means-live — shipped counts only merges the live commit contains; app.healthUrl names that commit, and merges it contains become shipped', async () => {
  const root = await temporaryDirectory('shipped-live');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'test');
  const commit = (message: string) => { git('commit', '-q', '--allow-empty', '-m', message); return git('rev-parse', 'HEAD'); };
  commit('base');
  const merges = ['GY-1', 'GY-2', 'GY-3'].map(key => ({ key, sha: commit(key) }));
  const main = merges.at(-1)!.sha;
  const now = Date.now();
  const work = merges.map(({ key, sha }, n) => ({ id: key, key, title: key, stage: 'done', delivery: { mergedAt: new Date(now - (3 - n) * 3_600_000).toISOString(), mergeSha: sha, authorizationRevision: 1 } }) as unknown as Work);
  const read = async (args: readonly string[]) => git(...args);
  const keys = (counts: ReturnType<typeof shippedCounts>) => ({ shipped: counts.shipped.map(w => w.key), waiting: counts.waiting.map(w => w.key) });

  // Nothing names a live commit: nothing is claimed shipped, every merge waits to go live.
  assert.equal(await liveRelease(root, null, main, work, read), null);
  assert.deepEqual(keys(shippedCounts(work, null, now)), { shipped: [], waiting: ['GY-1', 'GY-2', 'GY-3'] });

  // A served commit (the serve or deploy record) holding the first merge: it alone is shipped.
  const served = await liveRelease(root, merges[0].sha, main, work, read);
  assert.deepEqual(served, { commit: merges[0].sha, waiting: ['GY-2', 'GY-3'] });
  assert.deepEqual(keys(shippedCounts(work, served, now)), { shipped: ['GY-1'], waiting: ['GY-2', 'GY-3'] });

  // app.healthUrl declared: its answer is the live commit — a JSON field, like lumina's /version, then a plain sha.
  let body = JSON.stringify({ commit: merges[1].sha.slice(0, 12) });
  const server = createServer((_request, response) => response.end(body));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/version`;
    await writeFile(join(root, 'graphyard.json'), JSON.stringify({ app: { healthUrl: url } }));
    const health = await liveRelease(root, merges[0].sha, main, work, read, { now });
    assert.deepEqual(health, { commit: merges[1].sha, waiting: ['GY-3'] }, 'the health URL wins over the served record');
    assert.deepEqual(keys(shippedCounts(work, health, now)), { shipped: ['GY-1', 'GY-2'], waiting: ['GY-3'] });
    // The host deploys the newest merge; the next poll reads it and that merge becomes shipped.
    body = `${main}\n`;
    const deployed = await liveRelease(root, null, main, work, read, { now: now + 61_000 });
    assert.deepEqual(deployed, { commit: main, waiting: [] });
    assert.deepEqual(keys(shippedCounts(work, deployed, now)), { shipped: ['GY-1', 'GY-2', 'GY-3'], waiting: [] });
  } finally { server.close(); }
});
