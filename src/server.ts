import { createServer, type IncomingMessage } from 'node:http';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Store } from './store.js';
import { Engine, type Command } from './engine.js';
import { Refusal, demand, parseReviewerApps, type Principal } from './model.js';
import { githubFromEnv, processJob, type GitHub } from './github.js';
import { Validation } from './validation.js';
import { Delivery } from './delivery.js';
import { defineScenario, scenarios } from './scenarios.js';
import { OperatorAgents } from './operator-agent.js';

export const principalSchema = z.array(z.object({ id: z.string().min(1), role: z.enum(['admin', 'coordinator', 'worker', 'producer', 'reader']), token: z.string().min(32), proofs: z.array(z.string()).optional(), displayName: z.string().trim().min(1).max(100).regex(/^[^\u0000-\u001f\u007f]+$/).optional(), runtime: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/).optional() }).strict()).min(1);
export type Credential = Principal & { token: string };
async function body(req: IncomingMessage, limit = 1_000_000) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; demand(size <= limit, 'Request exceeds size limit', 413); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
export function server(engine: Engine, credentials: Credential[], github: GitHub | null = null) {
  const principals = credentials.map(({ token, ...actor }) => ({ actor, hash: createHash('sha256').update(token).digest() }));
  // The engine is constructed with the repository that this control plane is
  // authorized to coordinate.  GITHUB_REPOSITORY is merely a process default
  // (and is automatically set to the CI checkout), so it must not override an
  // explicit engine binding or scope validation becomes environment-dependent.
  const repository = engine.repository || github?.config.repository || process.env.GITHUB_REPOSITORY || '';
  demand(!engine.repository || !github || engine.repository.toLowerCase() === github.config.repository.toLowerCase(),
    'Engine and GitHub repositories must match');
  // Keep mutation authorization on the same canonical repository binding used
  // by authentication and operator-agent administration. Some embedders pass
  // the repository only through their GitHub adapter.
  engine.repository = repository;
  // Reviewer identities come from deployment configuration alongside the control-plane App,
  // so a single parsed registry authorizes both policy validation and provider observation.
  if (github) { engine.reviewerApps = github.config.reviewerApps ?? []; engine.controlPlaneAppId = github.config.appId; }
  demand(!engine.reviewerApps.some(app => app.appId === engine.controlPlaneAppId),
    'A registered reviewer App must be distinct from the Graphyard control-plane App');
  const validation = new Validation(engine, principals.map(p => p.actor), repository);
  const delivery = new Delivery(validation);
  const operatorAgents = new OperatorAgents(engine.store, repository, credentials.map(credential => ({ id: credential.id, tokenHash: createHash('sha256').update(credential.token).digest('hex') })));
  engine.operatorAuthorizer = operatorAgents.revalidate.bind(operatorAgents);
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
        const configured = principals.find(p => timingSafeEqual(p.hash, hash));
        if (configured) await operatorAgents.assertConfiguredPrincipalSafe({ id: configured.actor.id, tokenHash: hash.toString('hex') });
        const actor = configured?.actor ?? await operatorAgents.authenticate(token);
        demand(actor, 'A valid Graphyard bearer token is required', 401);
        if (actor.role === 'operator-agent') demand(actor.scope?.repositories.includes(repository), 'Repository is outside operator-agent scope', 403);
        if (url.pathname === '/api/operator-agents' && req.method === 'GET') return send(200, await operatorAgents.list(actor));
        if (url.pathname === '/api/operator-agents' && req.method === 'POST') return send(200, await operatorAgents.setup(actor, JSON.parse((await body(req)).toString()), String(req.headers['idempotency-key'] ?? '')));
        const operatorRoute = url.pathname.match(/^\/api\/operator-agents\/([^/]+)\/(configure|rotate|revoke)$/);
        if (operatorRoute && req.method === 'POST') {
          const data = JSON.parse((await body(req)).toString()), key = String(req.headers['idempotency-key'] ?? '');
          return send(200, operatorRoute[2] === 'configure' ? await operatorAgents.configure(actor, operatorRoute[1], data, key)
            : operatorRoute[2] === 'rotate' ? await operatorAgents.rotate(actor, operatorRoute[1], data, key) : await operatorAgents.revoke(actor, operatorRoute[1], data, key));
        }
        const operatorVisible = (items: any[]) => actor.role !== 'operator-agent' ? items : items.filter(item => actor.scope?.workItems.includes('*') || actor.scope?.workItems.includes(item.id) || actor.scope?.workItems.includes(item.key));
        if (actor.role === 'operator-agent') demand(
          url.pathname === '/api/status' || url.pathname === '/api/work-snapshot' || url.pathname === '/api/work' || url.pathname === '/api/events' || /^\/api\/work(?:\/[^/]+\/[a-z]+)?$/.test(url.pathname),
          'Route is not available to operator agents', 403);
        if (url.pathname === '/api/validation/artifacts' && req.method === 'POST') return send(200, await validation.uploadArtifact(actor, JSON.parse((await body(req, 11_200_000)).toString()), String(req.headers['idempotency-key'] ?? '')));
        const artifactRead = url.pathname.match(/^\/api\/validation\/artifacts\/([^/]+)\/([^/]+)$/);
        if (artifactRead && req.method === 'GET') {
          const artifact = await validation.readArtifact(actor, artifactRead[1], artifactRead[2]);
          const safePreview = artifact.bytes.length <= 1_000_000 && (artifact.mediaType === 'image/png' || artifact.mediaType === 'application/json' || artifact.mediaType === 'text/plain');
          const preview = url.searchParams.get('preview') === '1' && safePreview;
          const filename = artifact.name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'graphyard-artifact';
          res.writeHead(200, { 'Content-Type': preview ? artifact.mediaType : 'application/octet-stream', 'Content-Disposition': `${preview ? 'inline' : 'attachment'}; filename="${filename}"`, 'Content-Length': artifact.bytes.length,
            'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'no-store' });
          return res.end(artifact.bytes);
        }
        if (url.pathname === '/api/validation' && req.method === 'GET') return send(200, await validation.list(url.searchParams.get('cursor') ?? undefined));
        if (url.pathname === '/api/validation/definitions' && req.method === 'GET') return send(200, await validation.definitions(url.searchParams.get('cursor') ?? undefined));
        const candidateRead = url.pathname.match(/^\/api\/validation\/candidate\/([^/]+)$/);
        if (candidateRead && req.method === 'GET') return send(200, await validation.readCandidate(candidateRead[1]));
        // The host attestor's independent read of what it is about to execute. Read-only,
        // and refused to the worker and producer credentials that run and collect.
        const attemptRead = url.pathname.match(/^\/api\/validation\/attempt\/([^/]+)$/);
        if (attemptRead && req.method === 'GET') return send(200, await validation.attemptAuthority(actor, attemptRead[1]));
        const validationRoute = url.pathname.match(/^\/api\/validation\/(define|build|candidate|request|dispatch|ack|heartbeat|collection-authority|collection-heartbeat|result|cancel|settle|retry)$/);
        if (validationRoute && req.method === 'POST') {
          const command = validationRoute[1], data = JSON.parse((await body(req)).toString()), key = String(req.headers['idempotency-key'] ?? '');
          const result = command === 'define' ? await validation.define(actor, data, key)
            : command === 'build' ? await validation.attestBuild(actor, data, key)
            : command === 'candidate' ? await validation.createCandidate(actor, data, key)
            : command === 'request' ? await validation.createRequest(actor, data, key)
            : command === 'dispatch' ? await validation.dispatch(actor, data, key)
            : command === 'result' ? await validation.result(actor, data, key)
            : command === 'ack' || command === 'heartbeat' ? await validation.runnerCommand(actor, command, data, key)
            : command === 'collection-heartbeat' ? await validation.collectionHeartbeat(actor, data, key)
            : command === 'collection-authority' ? await validation.collectionAuthority(actor, data)
            : await validation.operatorCommand(actor, command as 'cancel' | 'settle' | 'retry', data, key);
          return send(200, result);
        }
        // D3: releases, expected-release selection and deployment observations. Reads are
        // open to every authenticated non-operator-agent credential; each mutation derives its
        // authority from the credential and the registration it names.
        if (url.pathname === '/api/delivery' && req.method === 'GET') return send(200, await delivery.status());
        if (url.pathname === '/api/delivery/observations' && req.method === 'GET') return send(200, await delivery.observations(url.searchParams.get('environment') ?? '', url.searchParams.get('cursor') ?? undefined));
        const deliveryRoute = url.pathname.match(/^\/api\/delivery\/(build|release|approve|select|lease|observe|notify|sweep)$/);
        if (deliveryRoute && req.method === 'POST') {
          const command = deliveryRoute[1], data = JSON.parse((await body(req)).toString() || '{}'), key = String(req.headers['idempotency-key'] ?? '');
          if (command === 'sweep') { demand(actor.role === 'admin', 'Operator permission required', 403); return send(200, await delivery.sweep()); }
          const result = command === 'build' ? await delivery.attestBuild(actor, data, key)
            : command === 'release' ? await delivery.createRelease(actor, data, key)
            : command === 'approve' ? await delivery.approve(actor, data, key)
            : command === 'select' ? await delivery.select(actor, data, key)
            : command === 'lease' ? await delivery.lease(actor, data)
            : command === 'observe' ? await delivery.observe(actor, data, key)
            : await delivery.notify(actor, data);
          return send(200, result);
        }
        if (url.pathname === '/api/scenarios') {
          if (req.method === 'GET') return send(200, await scenarios(engine.store));
          if (req.method === 'POST') return send(200, await defineScenario(engine.store, actor, JSON.parse((await body(req)).toString()), String(req.headers['idempotency-key'] ?? '')));
        }
        if (req.method === 'GET' && url.pathname === '/api/status') {
          const jobs = actor.role === 'operator-agent' ? [] : (await engine.store.pool.query('SELECT work_id,available_at,locked_until,attempts,error FROM jobs WHERE error IS NOT NULL ORDER BY available_at LIMIT 50')).rows;
          const githubRepository = github ? await github.reviewRepository() : null;
          const githubPermissions = github ? await github.reviewPermissions() : {};
          const dispatchAvailable = !!githubRepository && githubPermissions.pull_requests === 'write' && ['read', 'write'].includes(githubPermissions.issues) && githubPermissions.checks === 'write';
          const observedAt = (await engine.store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
          return send(200, { actor, repository: repository || null, baseBranch: github?.config.base ?? process.env.GITHUB_BASE_BRANCH ?? 'main', github: !!github, check: 'Graphyard / merge', reviewProviders: ['github', ...(dispatchAvailable ? ['codex'] : []), ...(dispatchAvailable && engine.reviewerApps.length ? ['agent'] : [])], reviewerApps: engine.reviewerApps, githubPermissions, githubRepository, githubAppId: github?.config.appId ?? null, githubInstallationId: github?.config.installationId ?? null, jobs, now: observedAt.toISOString() });
        }
        if (req.method === 'GET' && url.pathname === '/api/work-snapshot') { const snapshot = await engine.store.workSnapshot(); const visibleWork = operatorVisible(snapshot.work); return send(200, { ...snapshot, work: visibleWork, jobs: actor.role === 'operator-agent' ? snapshot.jobs.filter(job => visibleWork.some(work => work.id === job.work_id)) : snapshot.jobs }); }
        if (req.method === 'GET' && url.pathname === '/api/work') return send(200, operatorVisible(await engine.store.list()));
        if (req.method === 'GET' && url.pathname === '/api/events') {
          const id = url.searchParams.get('work') ?? undefined;
          if (id) z.string().uuid().parse(id);
          if (actor.role === 'operator-agent') { demand(id, 'Operator-agent history reads require a scoped work item', 403); const item = (await engine.store.list()).find(w => w.id === id); demand(item && operatorVisible([item]).length, 'Work item is outside this operator-agent scope', 403); }
          return send(200, await engine.store.events(id));
        }
        const mergeRoute = url.pathname.match(/^\/api\/work\/([^/]+)\/merge-(acquire|cancel|verify)$/);
        if (req.method === 'POST' && mergeRoute) {
          const data = JSON.parse((await body(req)).toString() || '{}'), key = String(req.headers['idempotency-key'] ?? '');
          if (mergeRoute[2] === 'acquire') return send(200, await engine.acquireMerge(actor, mergeRoute[1], data, key));
          if (mergeRoute[2] === 'cancel') return send(200, await engine.cancelMerge(actor, mergeRoute[1], data, key));
          demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
          demand(github, 'GitHub integration is required for merge verification', 503);
          const work = (await engine.store.list()).find(item => item.id === mergeRoute[1] || item.key === mergeRoute[1]); demand(work?.submission, 'Submitted work item required', 404);
          const replay = await engine.replayMergeVerification(actor, work.id, data, key); if (replay) return send(200, replay);
          const observation = await github.verify(work);
          const before = (await engine.store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
          const providerTime = await github.serverTime();
          const after = (await engine.store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
          // Bound DB minus GitHub time using the request interval and GitHub's
          // whole-second Date precision. Keep all network I/O outside transactions.
          observation.clockOffset = { min: before.getTime() - providerTime - 1000, max: after.getTime() - providerTime };
          return send(200, await engine.verifyMerge(actor, work.id, data, observation, key));
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
  engine.reviewerApps = parseReviewerApps(process.env.GRAPHYARD_REVIEWER_APPS);
  const github = await githubFromEnv();
  const http = server(engine, credentials, github);
  const validation = new Validation(engine, credentials.map(({ token, ...actor }) => actor), github?.config.repository ?? process.env.GITHUB_REPOSITORY ?? '');
  const delivery = new Delivery(validation);
  await validation.expireArtifacts();
  await validation.reconcile(true);
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; running = true;
    // The delivery sweep is bounded per tick and resumes from its persisted cursor, so a
    // backlog of observations drains across ticks without ever skipping one.
    try { await validation.expireArtifacts(); await validation.reconcile(); await engine.reconcile(); await delivery.sweep(); if (github) await Promise.all(Array.from({ length: 4 }, () => processJob(engine, github))); }
    catch (error) { console.error('reconciliation failed', error instanceof Error ? error.message : 'unknown'); }
    finally { running = false; }
  }, 2000);
  http.listen(Number(process.env.PORT ?? 4310), process.env.HOST ?? '127.0.0.1', () => console.log(`Graphyard listening on port ${process.env.PORT ?? 4310}; GitHub ${github ? 'connected' : 'not configured'}`));
  const shutdown = () => { clearInterval(timer); http.close(() => { void store.close().then(() => process.exit(0)); }); setTimeout(() => process.exit(1), 10_000).unref(); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exit(1); });
