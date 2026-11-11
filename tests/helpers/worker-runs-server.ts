import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { Engine } from '../../src/engine.js';
import { server } from '../../src/server.js';
import { bridgeTerminals } from '../../src/master/terminal-bridge.js';
import { workerRunsDirectory } from '../../src/headless-session.js';
import { runTranscript } from '../../src/model/sessions.js';
import type { Principal } from '../../src/model.js';

/**
 * The real control plane e2e:headless-workers' browser step drives (GY-3259): argv is the database
 * URL and a directory whose dist/ holds the built dashboard; the loop's host bridge serves the run
 * logs it keeps under that directory. One item has two worker runs: attempt 1 on account `spent`,
 * ended on its limit notice, and attempt 2 on account `successor`, still running.
 */
const [database, site] = process.argv.slice(2) as [string, string];
const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'agent-a', role: 'worker', runtime: 'claude' };
const coordinator: Principal = { id: 'executor-a', role: 'coordinator' };
const store = new Store(database);
const engine = new Engine(store, 120, 'owner/project');
engine.gitRunner = null;
const http = server(engine, [{ ...operator, token: 'test-human-operator' } as any, { ...worker, token: 'test-worker' } as any, { ...coordinator, token: 'test-coordinator' } as any]);
let item = await engine.execute(operator, 'create', null, { type: 'chore', title: 'Build headless', criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['e2e:fixture'] }] }, randomUUID());
item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
const runs = [{ epoch: 1, account: 'spent', kind: 'claude', ended: true, lines: [['stdout', 'working on the change'], ['stderr', "You've hit your session limit"]] },
  { epoch: 2, account: 'successor', kind: 'muse', ended: false, lines: [['stdout', 'resuming from the kept commit'], ['stderr', 'warning: token=[redacted]']] }] as const;
for (const run of runs) {
  const id = randomUUID(), directory = join(workerRunsDirectory(site), id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'session.json'), JSON.stringify({ id, name: 'work-claude', work: item.key, epoch: run.epoch, principal: worker.id, account: run.account, kind: run.kind, subject: item.key, startedAt: new Date().toISOString() }));
  writeFileSync(join(directory, 'log.jsonl'), run.lines.map(([stream, text]) => JSON.stringify({ at: '2026-11-11T12:00:00.000Z', stream, text })).join('\n') + '\n');
  if (run.ended) writeFileSync(join(directory, 'exit'), '1\n');
  await engine.execute(coordinator, 'session', item.id, { id: `${worker.id}:${run.epoch}`, kind: 'implementation', principal: worker.id, runtime: run.kind, host: 'host-1', agentName: 'work-claude',
    transcript: runTranscript(id), subject: `${item.key}: Build headless`, state: run.ended ? 'finished' : 'running', ...(run.ended ? { outcome: "stopped on its provider's limit notice" } : {}) }, randomUUID());
}
// The dashboard is served from ./dist, as an install serves it.
process.chdir(site);
const stop = new AbortController();
http.listen(0, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  void bridgeTerminals(url, 'test-coordinator', stop.signal, () => process.send!({ url, item: item.id, key: item.key }), undefined, site);
});
process.on('message', () => { stop.abort(); http.close(() => { void store.close().finally(() => process.exit(0)); }); http.closeAllConnections(); });
