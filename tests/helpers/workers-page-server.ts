import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { Engine } from '../../src/engine.js';
import { server } from '../../src/server.js';
import { bridgeTerminals } from '../../src/master/terminal-bridge.js';
import { workerRunsDirectory } from '../../src/headless-session.js';
import { runTranscript } from '../../src/model/sessions.js';
import { runFiles } from '../../src/runner/pi.js';
import type { Principal } from '../../src/model.js';

/**
 * The real control plane e2e:workers-page-live-session drives (GY-3314): argv is the database URL
 * and a directory whose dist/ holds the built dashboard; the loop's host bridge serves the run logs
 * it keeps under that directory. Six builders on their own claimed items, a reviewer and a producer
 * are open headless runs with logs on disk — the first builder's is long enough to scroll — and the
 * master's coordination session is open beside them: nine rows.
 */
const [database, site] = process.argv.slice(2) as [string, string];
const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'executor-a', role: 'coordinator' };
const store = new Store(database);
const engine = new Engine(store, 120, 'owner/project');
engine.gitRunner = null;
const http = server(engine, [{ ...operator, token: 'test-human-operator' } as any, { ...coordinator, token: 'test-coordinator' } as any]);

const runs: { id: string; directory: string }[] = [];
const openRun = (key: string, epoch: number, principal: string, kind: 'implementation' | 'review' | 'proof', lines: string[]) => {
  const id = randomUUID(), directory = join(workerRunsDirectory(site), id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'session.json'), JSON.stringify({ id, name: `work-${principal}`, work: key, epoch, principal, account: `${principal}-account`, kind: 'claude', subject: key, startedAt: new Date().toISOString() }));
  writeFileSync(join(directory, 'log.jsonl'), lines.map((text, index) => JSON.stringify({ at: new Date(Date.now() - (lines.length - index) * 60_000).toISOString(), stream: 'stdout', text })).join('\n') + '\n');
  runs.push({ id, directory });
  return id;
};
const record = (item: string, handle: Record<string, unknown>) => engine.execute(coordinator, 'session', item, { runtime: 'claude', host: 'host-1', state: 'running', observed: 'working', observedAt: new Date().toISOString(), ...handle }, randomUUID());

// Six builders, each on its own claimed item with a long title the row truncates.
const builders = ['ada-worker', 'juno-worker', 'pixel-worker', 'milo-worker', 'nova-worker', 'otto-worker'];
const items: { id: string; key: string; title: string }[] = [];
const handles: Record<string, unknown>[] = [];
for (let index = 0; index < builders.length; index++) {
  const principal = builders[index]!;
  const worker: Principal = { id: principal, role: 'worker', runtime: 'claude' };
  let item = await engine.execute(operator, 'create', null, { type: 'chore', title: index === 0
    ? 'Rework the delivery pipeline so a merge is observed within one loop cycle of landing and the release line names the deploy it waits on'
    : `Make the ${['settings', 'costs', 'board', 'guide', 'tests'][index - 1]} page read clearly on a phone`, criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['e2e:fixture'] }] }, randomUUID());
  item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
  item = await engine.execute(worker, 'claim', item.id, {}, randomUUID());
  items.push({ id: item.id, key: item.key, title: item.title });
  const lines = index === 0 ? [...Array(40).keys()].map(n => `line ${n + 1} of the long run`) : [`working on ${item.key}`];
  const handle = { id: `${principal}:1`, kind: 'implementation', principal, agentName: `work-${principal}`,
    transcript: runTranscript(openRun(item.key, 1, principal, 'implementation', lines)), subject: `${item.key}: ${item.title}` };
  handles.push(handle);
  await record(item.id, handle);
}
// A reviewer and a producer on the last item's head, beside its builder, and the master's
// coordination session: open, headless, nothing to attach to — its row opens the Master page.
const sixth = items.at(-1)!;
await record(sixth.id, { id: 'reviewer-a:1', kind: 'review', role: 'review', principal: 'reviewer-a', agentName: 'reviewer-a',
  transcript: runTranscript(openRun(sixth.key, 1, 'reviewer-a', 'review', ['reading the diff of the head'])), subject: `${sixth.key}: review` });
await record(sixth.id, { id: 'producer-a:1', kind: 'proof', role: 'proof:e2e', principal: 'producer-a', agentName: 'producer-a',
  transcript: runTranscript(openRun(sixth.key, 1, 'producer-a', 'proof', ['running the bound e2e cases'])), subject: `${sixth.key}: proofs` });
await record(sixth.id, { id: 'master-1:1', kind: 'coordination', role: 'master', principal: 'graphyard-master-1', agentName: 'master-1', subject: 'Coordinate the cycle' });

// The dashboard is served from ./dist, as an install serves it.
process.chdir(site);
const stop = new AbortController();
http.listen(0, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  void bridgeTerminals(url, 'test-coordinator', stop.signal, () => process.send!({ url, first: runs[0]!.id, session: `${builders[0]}:1`, master: 'master-1:1' }), undefined, site);
});
// 'end' ends the first builder's run, as its process exiting and the observer seeing it would.
process.on('message', async message => {
  if (message === 'end') {
    writeFileSync(runFiles(runs[0]!.directory).exit, '0');
    await record(items[0]!.id, { ...handles[0], state: 'finished', observed: 'ended' });
    process.send!('ended');
    return;
  } stop.abort(); http.close(() => { void store.close().finally(() => process.exit(0)); }); http.closeAllConnections(); });
