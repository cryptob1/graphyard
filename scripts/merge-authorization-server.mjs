// Runs inside the untrusted candidate container. The trusted controller talks to it only
// over HTTP and performs all assertions in its own process.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const sourceRoot = process.env.GRAPHYARD_SOURCE_ROOT ?? '/app';
const load = file => import(pathToFileURL(resolve(sourceRoot, 'src', file)).href);
const [{ Store }, { Engine }, { server }] = await Promise.all([load('store.js'), load('engine.js'), load('server.js')]);
const principals = JSON.parse(process.env.GRAPHYARD_PRINCIPALS ?? '[]');
const controlToken = process.env.GRAPHYARD_PROBE_CONTROL_TOKEN;
const store = new Store(process.env.DATABASE_URL); await store.init();
const engine = new Engine(store, [15368], 120, 'graphyard-probe/candidate');
let snapshot = null;
const github = { config: { repository: 'graphyard-probe/candidate', base: 'main', appId: 1, installationId: 1, privateKey: '' }, verify: async () => structuredClone(snapshot), serverTime: async () => Date.now(), reviewRepository: async () => null, reviewPermissions: async () => ({}) };
server(engine, principals, github).listen(4310, '0.0.0.0');
createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json');
  try {
    if (request.headers.authorization !== `Bearer ${controlToken}` || request.method !== 'POST' || request.url !== '/observe') { response.statusCode = 404; response.end(JSON.stringify({ error: 'Not found' })); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')); snapshot = input.observation;
    // A Graphyard-published speculative tip is harness-supplied for the same reason the
    // observation is: the candidate exposes no route that could invent either.
    if (input.speculation) await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{queue,speculation}',$2::jsonb) WHERE id=$1", [input.id, JSON.stringify(input.speculation)]);
    response.end(JSON.stringify(await engine.observe(input.id, input.revision, input.observation)));
  } catch (error) { response.statusCode = error?.status ?? 500; response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Probe control failed' })); }
}).listen(4311, '0.0.0.0');
