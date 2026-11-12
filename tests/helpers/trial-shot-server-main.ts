import { Store } from '../../src/store.js';
import { Engine } from '../../src/engine.js';
import { server } from '../../src/server.js';
import { gitRunnerFor } from '../../src/merge-writer/local-observation.js';

const store = new Store(process.argv[2]!);
const engine = new Engine(store, 120, 'owner/project');
engine.gitRunner = gitRunnerFor(process.argv[3]!);
engine.baseBranch = 'main';
const http = server(engine, [
  { id: 'operator', role: 'admin', sessionKind: 'human', token: 'test-human-operator' },
  { id: 'implementer', role: 'worker', token: 'test-worker-operator' },
  { id: 'graphyard-merge-writer', role: 'coordinator', token: 'test-merge-writer-operator' },
]);
http.listen(0, '127.0.0.1', () => process.send!({ url: `http://127.0.0.1:${(http.address() as { port: number }).port}` }));
process.on('message', () => { http.close(() => { void store.close().finally(() => process.exit(0)); }); http.closeAllConnections(); });
