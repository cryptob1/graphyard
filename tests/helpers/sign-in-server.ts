import { Store } from '../../src/store.js';
import { Engine } from '../../src/engine.js';
import { server } from '../../src/server.js';

const store = new Store(process.argv[2]!);
const engine = new Engine(store, 120, 'owner/project');
engine.gitRunner = null;
const http = server(engine, [{ id: 'operator', role: 'admin', sessionKind: 'human', token: 'test-human-operator' }]);
http.listen(0, '127.0.0.1', () => process.send!({ url: `http://127.0.0.1:${(http.address() as { port: number }).port}` }));
process.on('message', () => http.close(async () => { await store.close(); process.exit(0); }));
