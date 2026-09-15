import { createServer, type IncomingMessage } from 'node:http';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Store } from './store.js';
import { Engine, type Command } from './engine.js';
import { Refusal, demand, type Principal } from './model.js';
import { githubFromEnv, processJob, type GitHub } from './github.js';
import { Validation } from './validation.js';
import { defineScenario, scenarios } from './scenarios.js';

export const principalSchema = z.array(z.object({ id: z.string().min(1), role: z.enum(['admin', 'worker', 'producer', 'reader']), token: z.string().min(32), proofs: z.array(z.string()).optional(), displayName: z.string().trim().min(1).max(100).regex(/^[^\u0000-\u001f\u007f]+$/).optional(), runtime: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/).optional() }).strict()).min(1);
export type Credential = Principal & { token: string };
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; demand(size <= 1_000_000, 'Request exceeds 1 MB', 413); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
export function server(engine: Engine, credentials: Credential[], github: GitHub | null = null) {
  const principals = credentials.map(({ token, ...actor }) => ({ actor, hash: createHash('sha256').update(token).digest() }));
  const validation = new Validation(engine, principals.map(p => p.actor), github?.config.repository ?? process.env.GITHUB_REPOSITORY ?? '');
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; img-src 'self' data:; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('Cache-Control', 'no-store');
    const send = (status: number, data: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/healthz') { await engine.store.pool.query('SELECT 1'); return send(200, { ok: true }); }
      if (url.pathname === '/api/github/webhook' && req.method === 'POST') {
        const raw = await body(req); const secret = process.env.GITHUB_WEBHOOK_SECRET;
        demand(secret, 'Webhook not configured', 503);
        const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
        const actual = Buffer.from(String(req.headers['x-hub-signature-256'] ?? ''));
        demand(expected.length === actual.length && timingSafeEqual(expected, actual), 'Invalid webhook signature', 401);
        const payload = JSON.parse(raw.toString());
        demand(payload.repository?.full_name?.toLowerCase() === github?.config.repository.toLowerCase(), 'Repository is not managed', 403);
        // Our own check publications must not create an endless webhook/publish loop.
        if (payload.check_run?.app?.id === github?.config.appId) return send(202, { accepted: true, ignored: 'own check' });
        const delivery = String(req.headers['x-github-delivery'] ?? ''); demand(delivery && delivery.length < 200, 'Missing delivery ID', 400);
        await engine.store.transaction(async db => {
          const result = await db.query('INSERT INTO webhook_receipts(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id', [delivery]);
          if (result.rowCount) await db.query('UPDATE jobs SET available_at=now(),generation=generation+1');
        });
        return send(202, { accepted: true });
      }
      if (url.pathname.startsWith('/api/')) {
        const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
        const hash = createHash('sha256').update(token).digest();
        const actor = principals.find(p => timingSafeEqual(p.hash, hash))?.actor;
        demand(actor, 'A valid Graphyard bearer token is required', 401);
        if (url.pathname === '/api/validation' && req.method === 'GET') return send(200, await validation.list());
        const validationRoute = url.pathname.match(/^\/api\/validation\/(define|build|candidate|request|dispatch|ack|heartbeat|result|cancel|settle|retry)$/);
        if (validationRoute && req.method === 'POST') {
          const command = validationRoute[1], data = JSON.parse((await body(req)).toString()), key = String(req.headers['idempotency-key'] ?? '');
          const result = command === 'define' ? await validation.define(actor, data, key)
            : command === 'build' ? await validation.attestBuild(actor, data, key)
            : command === 'candidate' ? await validation.createCandidate(actor, data, key)
            : command === 'request' ? await validation.createRequest(actor, data, key)
            : command === 'dispatch' ? await validation.dispatch(actor, data, key)
            : command === 'result' ? await validation.result(actor, data, key)
            : command === 'ack' || command === 'heartbeat' ? await validation.runnerCommand(actor, command, data, key)
            : await validation.operatorCommand(actor, command as 'cancel' | 'settle' | 'retry', data, key);
          return send(200, result);
        }
        if (url.pathname === '/api/scenarios') {
          if (req.method === 'GET') return send(200, await scenarios(engine.store));
          if (req.method === 'POST') return send(200, await defineScenario(engine.store, actor, JSON.parse((await body(req)).toString()), String(req.headers['idempotency-key'] ?? '')));
        }
        if (req.method === 'GET' && url.pathname === '/api/status') {
          const jobs = (await engine.store.pool.query('SELECT work_id,available_at,locked_until,attempts,error FROM jobs WHERE error IS NOT NULL ORDER BY available_at LIMIT 50')).rows;
          const githubRepository = github ? await github.reviewRepository() : null;
          const githubPermissions = github ? await github.reviewPermissions() : {};
          const codexAvailable = !!githubRepository && githubPermissions.pull_requests === 'write' && ['read', 'write'].includes(githubPermissions.issues) && githubPermissions.checks === 'write';
          const observedAt = (await engine.store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
          return send(200, { actor, repository: github?.config.repository ?? process.env.GITHUB_REPOSITORY ?? null, github: !!github, check: 'Graphyard / merge', reviewProviders: codexAvailable ? ['github', 'codex'] : ['github'], githubPermissions, githubRepository, githubAppId: github?.config.appId ?? null, githubInstallationId: github?.config.installationId ?? null, jobs, now: observedAt.toISOString() });
        }
        if (req.method === 'GET' && url.pathname === '/api/work-snapshot') return send(200, await engine.store.workSnapshot());
        if (req.method === 'GET' && url.pathname === '/api/work') return send(200, await engine.store.list());
        if (req.method === 'GET' && url.pathname === '/api/events') {
          const id = url.searchParams.get('work') ?? undefined;
          if (id) z.string().uuid().parse(id);
          return send(200, await engine.store.events(id));
        }
        const match = url.pathname.match(/^\/api\/work(?:\/([^/]+)\/([a-z]+))?$/);
        if (req.method === 'POST' && match) {
          const raw = await body(req);
          const result = await engine.execute(actor, (match[2] ?? 'create') as Command, match[1] ?? null, JSON.parse(raw.toString() || '{}'), String(req.headers['idempotency-key'] ?? ''));
          return send(200, result);
        }
        return send(404, { error: 'Route not found' });
      }
      demand(req.method === 'GET' || req.method === 'HEAD', 'Method not allowed', 405);
      const root = resolve('dist');
      const path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
      demand(path.startsWith(root + '/') || path === root, 'Invalid path', 400);
      let file: Buffer; let extension = extname(path);
      try { file = await readFile(path); } catch { file = await readFile(resolve(root, 'index.html')); extension = '.html'; }
      res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' } as Record<string, string>)[extension] ?? 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : file);
    } catch (error) {
      if (error instanceof Refusal) return send(error.status, { error: error.message });
      if (error instanceof z.ZodError) return send(400, { error: 'Invalid input', issues: error.issues });
      if (error instanceof SyntaxError || error instanceof URIError) return send(400, { error: 'Malformed request' });
      console.error('request failed', error instanceof Error ? error.message : 'unknown');
      send(500, { error: 'Internal error; consult server logs' });
    }
  });
}
async function main() {
  try { process.loadEnvFile(); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const credentials = principalSchema.parse(JSON.parse(process.env.GRAPHYARD_PRINCIPALS ?? '[]'));
  demand(new Set(credentials.map(p => p.id)).size === credentials.length && new Set(credentials.map(p => p.token)).size === credentials.length, 'Principal IDs and tokens must be unique');
  const store = new Store(process.env.DATABASE_URL ?? 'postgres://graphyard:graphyard@localhost:5438/graphyard');
  await store.init();
  const engine = new Engine(store, (process.env.GITHUB_CI_APP_IDS ?? '15368').split(',').map(Number));
  const github = await githubFromEnv();
  const http = server(engine, credentials, github);
  const validation = new Validation(engine, credentials.map(({ token, ...actor }) => actor), github?.config.repository ?? process.env.GITHUB_REPOSITORY ?? '');
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; running = true;
    try { await validation.reconcile(); await engine.reconcile(); if (github) await Promise.all(Array.from({ length: 4 }, () => processJob(engine, github))); }
    catch (error) { console.error('reconciliation failed', error instanceof Error ? error.message : 'unknown'); }
    finally { running = false; }
  }, 2000);
  http.listen(Number(process.env.PORT ?? 4310), process.env.HOST ?? '127.0.0.1', () => console.log(`Graphyard listening on port ${process.env.PORT ?? 4310}; GitHub ${github ? 'connected' : 'not configured'}`));
  const shutdown = () => { clearInterval(timer); http.close(() => { void store.close().then(() => process.exit(0)); }); setTimeout(() => process.exit(1), 10_000).unref(); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exit(1); });
