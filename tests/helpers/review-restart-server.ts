// A fresh process deliberately has no launch bearer registrations from its predecessor.
import { Store } from '../../src/store.js';
import { Engine } from '../../src/engine.js';
import { server } from '../../src/server.js';

const store = new Store(process.argv[2]!);
const engine = new Engine(store, 120, 'owner/project');
engine.submissionObserver = null;
const http = server(engine, [
  { id: 'master', role: 'coordinator', token: 'restart-test-master' },
  { id: 'implementer', role: 'worker', token: 'restart-test-worker' },
]);
http.listen(0, '127.0.0.1', () => process.send!({ url: `http://127.0.0.1:${(http.address() as { port: number }).port}`, pid: process.pid }));
process.on('message', () => http.close(async () => { await store.close(); process.exit(0); }));
