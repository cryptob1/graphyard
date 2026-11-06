import { Store } from '../../src/store.js';
import { Engine } from '../../src/engine.js';
import { server } from '../../src/server.js';

const store = new Store(process.argv[2]!);
const engine = new Engine(store, 120, 'owner/project');
engine.gitRunner = null;
const http = server(engine, [{ id: 'operator', role: 'admin', sessionKind: 'human', token: 'test-human-operator' }]);
http.listen(0, '127.0.0.1', () => process.send!({ url: `http://127.0.0.1:${(http.address() as { port: number }).port}` }));
// A restart replaces the process: stop listening, cut every connection — a poll in flight sees the
// socket go, exactly as a real deploy — and end once the store is closed. Waiting for in-flight
// responses to finish (plain http.close) hung the restart for as long as the slowest request, past
// the test's own budget.
process.on('message', () => { http.close(() => { void store.close().finally(() => process.exit(0)); }); http.closeAllConnections(); });
