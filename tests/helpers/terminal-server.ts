import { randomUUID } from 'node:crypto';
import { Store } from '../../src/store.js';
import { Engine } from '../../src/engine.js';
import { server } from '../../src/server.js';
import { loopPanesRegistry } from '../../src/model/loop-presence.js';
import { repositoryPolicy, setRepositoryPolicy } from '../../src/model-boundary/repository-policy.js';
import type { Principal } from '../../src/model.js';

/**
 * The real control plane e2e:master-page-terminal drives (GY-3211), forked with the stub herdr
 * first on PATH: argv is the database URL and the directory whose dist/ holds the built dashboard.
 * The loop has named its master pane `w1:master`, and one item records a running worker session in
 * pane `w1:worker`. Credentials: the human operator (test-human-operator) and a reader (test-reader).
 */
const [database, site] = process.argv.slice(2) as [string, string];
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });
const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'agent-a', role: 'worker', runtime: 'claude' };
const coordinator: Principal = { id: 'executor-a', role: 'coordinator' };
const store = new Store(database);
const engine = new Engine(store, 120, 'owner/project');
engine.gitRunner = null;
const http = server(engine, [
  { ...operator, token: 'test-human-operator' } as any,
  { id: 'watcher', role: 'reader', token: 'test-reader' },
  { ...worker, token: 'test-worker' } as any,
  { ...coordinator, token: 'test-coordinator' } as any,
]);
loopPanesRegistry(engine).observe({ configHome: null, session: null, host: 'host-1', running: true, master: 'w1:master' });
let item = await engine.execute(operator, 'create', null, { type: 'chore', title: 'Watch a worker', criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['e2e:fixture'] }] }, randomUUID());
item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
item = await engine.execute(worker, 'claim', item.id, {}, randomUUID());
await engine.execute(coordinator, 'session', item.id, { id: 'worker-1', kind: 'implementation', runtime: 'claude', host: 'host-1', workspace: 'w1', agentName: 'work-claude',
  pane: 'w1:worker', attach: 'herdr pane attach w1:worker --workspace w1', subject: `${item.key}: Watch a worker`, state: 'running', observed: 'working', observedAt: new Date().toISOString() }, randomUUID());
// The dashboard is served from ./dist, as an install serves it.
process.chdir(site);
http.listen(0, '127.0.0.1', () => process.send!({ url: `http://127.0.0.1:${(http.address() as { port: number }).port}` }));
process.on('message', () => { http.close(() => { void store.close().finally(() => process.exit(0)); }); http.closeAllConnections(); });
