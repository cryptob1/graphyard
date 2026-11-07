// The loop's own item-preview step for e2e-serve's scratch install (GY-3193): the plane e2e.serve
// starts has no loop, so an item a preview case creates would never gain its preview. This steps
// `itemPreviewStep` over the ports the daemon wires, as the plane's coordinator, from the scratch
// repository; stop() ends it and every preview it started.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultChildRun } from '../src/child-runner.ts';
import { mergeRecordKey, mergeWriterReads } from '../src/daemon/cycle-merge-writer.ts';
import { itemPreviewStep } from '../src/merge-writer/preview.ts';
import { previewDemand } from '../src/project-previews.ts';

export function startPreviewLoop({ url, token, root, base, intervalMs = 1_000 }) {
  const call = async (method, path, body, key) => {
    const response = await fetch(new URL(`/api/${path}`, url), { method, signal: AbortSignal.timeout(60_000), body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) } });
    const text = await response.text();
    if (response.status !== 200) throw new Error(`${method} /api/${path} answered ${response.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };
  const config = { baseBranch: 'main', repository: 'scratch/delivery', run: { mergeWriter: { deployKeyFile: join(base, 'unused-key') } } };
  const ports = mergeWriterReads(config, root, defaultChildRun, { base, merger: async () => 'control-plane',
    record: (work, event) => call('POST', `work/${work.id}/merge-record`, event, mergeRecordKey(work, event)) }).itemPreviews;
  const live = new Map();
  let stopped = false, wake = () => {};
  const running = (async () => {
    await mkdir(base, { recursive: true });
    while (!stopped) {
      try {
        // Only a preview's item is stepped, so a case with none never spawns the Compose sweep; a sweep with no Docker (a trial) says so each step, which is no news.
        const { work } = await call('GET', 'work-snapshot?view=coordination');
        if (live.size || work.some(item => item.preview || previewDemand(item, ports.delivery()))) for (const note of await itemPreviewStep(live, work, ports)) if (!note.startsWith('Could not sweep')) console.log(note);
      }
      catch (error) { console.error(`The preview step failed: ${error instanceof Error ? error.message : String(error)}`); }
      await new Promise(done => { const timer = setTimeout(done, intervalMs); wake = () => { clearTimeout(timer); done(); }; });
    }
  })();
  return { stop: async () => {
    stopped = true; wake(); await running;
    // A preview still starting settles once cancelled; every one is then closed, its server ended and checkout removed.
    for (const entry of live.values()) entry.stop.abort();
    for (let waited = 0; [...live.values()].some(entry => !entry.opened) && waited < 60_000; waited += 100) await new Promise(done => setTimeout(done, 100));
    await Promise.all([...live.values()].map(entry => entry.opened?.close().catch(() => {})));
  } };
}
