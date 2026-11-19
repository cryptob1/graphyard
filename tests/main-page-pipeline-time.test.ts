import { test } from 'node:test';
import assert from 'node:assert/strict';

// GY-3527: the Work page's one sentence on how long an item takes from release to merge.
const now = Date.UTC(2026, 0, 1, 12, 0);
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

test('unit:main-page-pipeline-time — a normal run is one calm line with the median, the slowest tenth and the last merge', async () => {
  const { pipelineSentence } = await import('../src/pipeline-speed.js');
  const line = pipelineSentence({ median: 42, p90: 95, samples: 10, lastMergeAt: ago(12), oldest: { id: 'a', key: 'GY-5', title: 'Fresh work', stage: 'review', releasedAt: ago(30) } }, now);
  assert.deepEqual(line, { warning: false, text: 'An item takes 42 min from release to merge (slowest tenth 1 h 35 min). Last merge 12 min ago.' });
  assert.doesNotMatch(line.text, /GY-|[0-9a-f]{8}-/);
});

test('unit:main-page-pipeline-time — a stale last merge warns, naming the oldest item in the pipeline, its stage and one next action', async () => {
  const { pipelineSentence } = await import('../src/pipeline-speed.js');
  const line = pipelineSentence({ median: 40, p90: 400, samples: 10, lastMergeAt: ago(150), oldest: { id: 'b', key: 'GY-8', title: 'Slow change', stage: 'test', releasedAt: ago(100) } }, now);
  assert.equal(line.warning, true);
  assert.equal(line.open, 'b');
  assert.equal(line.text, 'No merge for 2 h 30 min, over three times the usual 40 min. Oldest: GY-8 Slow change, in its merge trial. Next: open GY-8 and clear what holds it.');
});

test('unit:main-page-pipeline-time — an item in the pipeline longer than the slowest tenth warns, naming it, its stage and one next action', async () => {
  const { pipelineSentence } = await import('../src/pipeline-speed.js');
  const line = pipelineSentence({ median: 30, p90: 60, samples: 10, lastMergeAt: ago(10), oldest: { id: 'c', key: 'GY-9', title: 'Stuck change', stage: 'build', releasedAt: ago(125) } }, now);
  assert.equal(line.warning, true);
  assert.equal(line.open, 'c');
  assert.equal(line.text, 'GY-9 Stuck change has been in the pipeline 2 h 5 min, longer than the slowest tenth (1 h); it is being built. Next: open GY-9 and clear what holds it.');
});

test('unit:main-page-pipeline-time — with no merges yet the line says so and nothing warns', async () => {
  const { pipelineSentence } = await import('../src/pipeline-speed.js');
  assert.deepEqual(pipelineSentence({ median: null, p90: null, samples: 0, lastMergeAt: null, oldest: null }, now), { warning: false, text: 'No merges to time yet.' });
});

test('unit:main-page-pipeline-time — the server reads the last 10 merges and the open item released longest ago', async () => {
  const { pipelineTime } = await import('../src/pipeline-speed.js');
  const merged = Array.from({ length: 12 }, (_, index) => ({ id: `m${index}`, key: `GY-${index}`, title: 't', stage: 'done', delivery: { mergedAt: ago(index * 10) } }));
  const open = [{ id: 'o1', key: 'GY-20', title: 'Newer', stage: 'build' }, { id: 'o2', key: 'GY-21', title: 'Older', stage: 'review' }, { id: 'o3', key: 'GY-22', title: 'Backlog', stage: 'backlog' }];
  // Each merge took (index + 1) * 10 minutes; GY-10 and GY-11 are outside the last ten and took far longer.
  const released = new Map<string, number>([...merged.map((item, index) => [item.id, Date.parse(ago(index * 10)) - (index < 10 ? (index + 1) * 10 : 1000) * 60_000] as [string, number]),
    ['o1', Date.parse(ago(20))], ['o2', Date.parse(ago(50))], ['o3', Date.parse(ago(500))]]);
  const time = pipelineTime([...merged, ...open] as never, released);
  assert.deepEqual({ median: time.median, p90: time.p90, samples: time.samples }, { median: 50, p90: 90, samples: 10 });
  assert.equal(time.lastMergeAt, ago(0));
  assert.deepEqual(time.oldest, { id: 'o2', key: 'GY-21', title: 'Older', stage: 'review', releasedAt: ago(50) });
});
