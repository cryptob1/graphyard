import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type pg from 'pg';
import { demand } from '../../model.js';
import { readRegistry } from '../../agent-registry.js';
import { connectDefaultRoles, connectProvider, connectProviders } from '../../fleet.js';
import { applyRegistryMutation, executorHostHeader, looksLikeSecret, proposedConcurrency, proposedRuntimes, registryMutationSchemas, fleetRoles, type RegistryMutation } from '../../model/registry.js';
import { defineRoutes, parseJson } from '../routes.js';

const collections = { runtimes: 'runtime', models: 'model', accounts: 'account', roles: 'role' } as const;
/** The executor a read is judged for: `?host=`, or the executor-host header an older server simply ignores. */
export function executorHost(url: URL, req: IncomingMessage) {
  const header = req.headers[executorHostHeader.toLowerCase()];
  const host = (url.searchParams.get('host') ?? (Array.isArray(header) ? header[0] : header))?.trim();
  return host ? host.slice(0, 200) : null;
}

/**
 * The agent registry: the fleet's runtimes, accounts, models and roles, the session an executor's
 * action runs on, and the history of both. Configuration is a POST per collection — set one entry,
 * remove one, mark an account's quota — or one `apply` for a whole proposal.
 */
export const agentRegistryRoutes = defineRoutes('agent-registry', [
  { method: 'GET', path: '/api/agent-registry', handle: ({ actor, req, url, services }) => services.agentRegistry.view(actor, executorHost(url, req)) },
  { method: 'GET', path: '/api/agent-registry/document', handle: ({ actor, services }) => services.agentRegistry.document(actor) },
  { method: 'GET', path: '/api/agent-registry/history', handle: ({ actor, url, services }) => services.agentRegistry.history(actor, Number(url.searchParams.get('limit') ?? 100)) },
  { method: 'POST', path: '/api/agent-registry/apply', handle: async context => context.services.agentRegistry.mutate(context.actor, 'apply', await parseJson(context), context.idempotencyKey()) },
  { method: 'POST', path: '/api/agent-registry/select', handle: async context => context.services.agentRegistry.select(context.actor, await parseJson(context), context.idempotencyKey()) },
  {
    method: 'POST', path: /^\/api\/agent-registry\/sessions\/([0-9a-f-]{36})\/end$/,
    handle: async (context, [id]) => context.services.agentRegistry.endSession(context.actor, id, await parseJson(context), context.idempotencyKey()),
  },
  {
    // POST /api/agent-registry/accounts           {account, reason}  → account.set
    // POST /api/agent-registry/accounts/NAME/remove  {reason}        → account.remove
    // POST /api/agent-registry/accounts/NAME/quota   {quota, reason} → account.quota
    method: 'POST', path: /^\/api\/agent-registry\/(runtimes|models|accounts|roles)(?:\/([^/]+)\/(remove|quota))?$/,
    async handle(context, [collection, name, action]) {
      const entry = collections[collection as keyof typeof collections];
      const kind = `${entry}.${action ?? 'set'}` as RegistryMutation;
      demand(kind in registryMutationSchemas, 'Route not found', 404);
      const data = await parseJson(context);
      return context.services.agentRegistry.mutate(context.actor, kind, name === undefined ? data : { ...data, name: decodeURIComponent(name) }, context.idempotencyKey());
    },
  },
  ...connectAccountRoutes(),
]);

// ---------------------------------------------------------------------------
// Connect an account from the UI (GY-409).
//
// A connect is one aggregate on the append-only event ledger under its own
// `connect-account.` prefix, so it rides every logical backup and keeps its
// attributable history without a table of its own. The browser seals a pasted
// API key to the agent host's public key before it is ever sent, so the control
// plane stores and relays ciphertext only: the sealed payload is served back to
// the owning host's executor alone, never in a browser-facing response, and no
// route here accepts a plaintext credential at all. Every write happens inside
// the store's coordination transaction.
// ---------------------------------------------------------------------------

const connectEventPrefix = 'connect-account.';
const base64 = /^[A-Za-z0-9+/]+={0,2}$/;
const hostKeySchema = z.object({ host: z.string().trim().min(1).max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'A host id cannot contain control characters'),
  publicKey: z.string().trim().regex(base64, 'A public key is base64').length(124, 'A host public key is the 91-byte SPKI of a P-256 key, base64') }).strict();
const sealedSchema = z.object({
  ephemeral: z.string().regex(base64, 'The ephemeral key is base64').length(124, 'The ephemeral key is the 91-byte SPKI of a P-256 key, base64'),
  iv: z.string().regex(base64, 'The nonce is base64').length(16, 'The nonce is 12 bytes, base64'),
  ciphertext: z.string().regex(base64, 'The ciphertext is base64').min(16).max(4096),
}).strict();
const connectSubmitSchema = z.object({
  host: z.string().trim().min(1).max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'A host id cannot contain control characters'),
  provider: z.string().trim().min(1).max(100),
  sealed: sealedSchema.optional(),
  reason: z.string().trim().min(1).max(500).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Control characters are not allowed'),
}).strict();
const progressSchema = z.object({
  state: z.enum(['connecting', 'waiting-login']),
  name: z.string().trim().min(1).max(80).optional(),
  url: z.string().trim().min(1).max(500).optional(),
  code: z.string().trim().min(1).max(100).optional(),
  detail: z.string().trim().min(1).max(500).optional(),
}).strict();
const resultSchema = z.object({
  state: z.enum(['healthy', 'failed']),
  name: z.string().trim().min(1).max(80).optional(),
  home: z.string().trim().min(1).max(500).optional(),
  error: z.string().trim().min(1).max(2000).optional(),
}).strict();

/** How a connect request stands, folded from its events. */
export interface ConnectView {
  id: string; at: string; updatedAt: string; host: string; provider: string;
  state: 'pending' | 'claimed' | 'connecting' | 'waiting-login' | 'healthy' | 'failed' | 'cancelled';
  /** The account name and home the host's executor assigned once it started. */
  name: string | null; home: string | null;
  /** The device or sign-in URL and code the provider's login printed, relayed to the operator. */
  url: string | null; code: string | null;
  error: string | null; detail: string | null;
  /** The roles the account joined by default, by capability (GY-409 AC-4). */
  placement: string[] | null;
  worker: string | null;
  /** The sealed payload, served only to the owning host's executor on its claim. */
  sealed?: { ephemeral: string; iv: string; ciphertext: string };
}
/** How long an open connect may sit before another claim may take it: a subscription login can wait for the operator, so it gets far longer than a key paste. */
export const connectStaleMs = { login: 2 * 3_600_000, work: 30 * 60_000 };
const openState = (state: ConnectView['state']) => state === 'pending' || state === 'claimed' || state === 'connecting' || state === 'waiting-login';

/** The public fields of a connect: the sealed payload never leaves the executor path. */
const withoutSealed = (view: ConnectView): ConnectView => { const { sealed: _sealed, ...rest } = view; return rest; };

/**
 * Fold a newest-first page of `connect-account.*` events into one view per request, oldest first.
 * Events are applied oldest to newest so the latest state wins; every view carries the whole life
 * of the request: the state, what the host's executor reported, and the placement it joined.
 */
export function foldConnectEvents(rows: { actor: string; kind: string; payload: any; created_at: Date }[]): ConnectView[] {
  const byId = new Map<string, ConnectView>();
  for (const row of [...rows].reverse()) {
    const connect = row.payload?.connect;
    if (!connect?.id) continue;
    const at = row.created_at.toISOString();
    const base = byId.get(connect.id);
    if (row.kind === `${connectEventPrefix}request`) {
      byId.set(connect.id, { id: connect.id, at, updatedAt: at, host: connect.host, provider: connect.provider, state: 'pending', name: null, home: null, url: null, code: null, error: null, detail: null, placement: null, worker: null, ...(connect.sealed ? { sealed: connect.sealed } : {}) });
      continue;
    }
    if (!base) continue;
    base.updatedAt = at;
    if (row.kind === `${connectEventPrefix}claimed`) { base.state = 'claimed'; base.worker = row.actor; }
    else if (row.kind === `${connectEventPrefix}progress`) { base.state = connect.state; base.name = connect.name ?? base.name; base.home = connect.home ?? base.home; base.url = connect.url ?? base.url; base.code = connect.code ?? base.code; base.detail = connect.detail ?? base.detail; }
    else if (row.kind === `${connectEventPrefix}result`) { base.state = connect.state; base.name = connect.name ?? base.name; base.home = connect.home ?? base.home; base.error = connect.error ?? null; base.placement = connect.placement ?? base.placement; }
    else if (row.kind === `${connectEventPrefix}cancel`) { base.state = 'cancelled'; }
  }
  return [...byId.values()].sort((a, b) => a.at.localeCompare(b.at));
}

const configurators = ['admin', 'coordinator'] as const;
const readers = ['admin', 'coordinator', 'reader', 'slice-lead'] as const;
/** Read a page of connect events, newest first, inside the caller's transaction. */
const readConnectEvents = (db: Pick<pg.PoolClient, 'query'>) =>
  // The newest 500 requests with every event of each: a long-lived request keeps its claimed,
  // progress and result events however many others (or host-key registrations) came after it.
  db.query(`WITH recent AS (SELECT payload->'connect'->>'id' AS id FROM events WHERE work_id IS NULL AND kind='${connectEventPrefix}request' ORDER BY seq DESC LIMIT 500)
    SELECT seq,actor,kind,payload,created_at FROM events WHERE work_id IS NULL AND kind LIKE '${connectEventPrefix}%' AND kind <> '${connectEventPrefix}host-key' AND payload->'connect'->>'id' IN (SELECT id FROM recent) ORDER BY seq DESC`);

function connectAccountRoutes(): import('../routes.js').Route[] {
  return [
  { method: 'GET', path: '/api/agent-registry/connect/providers', handle: async ({ actor }) => {
      demand((readers as readonly string[]).includes(actor.role), 'Connect providers are readable by admin, coordinator, slice-lead and reader identities', 403);
      return { providers: connectProviders.map(({ id, label, kind, tier, help }) => ({ id, label, kind, tier, help })) };
    } },
  { method: 'GET', path: '/api/agent-registry/connect', handle: async ({ actor, services }) => {
      demand((readers as readonly string[]).includes(actor.role), 'Connect requests are readable by admin, coordinator, slice-lead and reader identities', 403);
      return { connects: (await services.engine.store.transaction(async db => foldConnectEvents((await readConnectEvents(db)).rows))).map(withoutSealed) };
    } },
  { method: 'GET', path: '/api/agent-registry/connect/hosts', handle: async ({ actor, services }) => {
      demand((readers as readonly string[]).includes(actor.role), 'Connect hosts are readable by admin, coordinator, slice-lead and reader identities', 403);
      const rows = (await services.engine.store.transaction(async db => db.query(`SELECT payload->'host' AS host, created_at FROM events WHERE work_id IS NULL AND kind='${connectEventPrefix}host-key' ORDER BY seq DESC`))).rows;
      const seen = new Map<string, string>();
      for (const row of rows) if (!seen.has(row.host) && typeof row.host === 'string') seen.set(row.host, row.created_at.toISOString());
      return { hosts: [...seen.entries()].map(([host, registeredAt]) => ({ host, registeredAt })) };
    } },
  { method: 'GET', path: '/api/agent-registry/connect/requests', handle: async ({ actor, url, services }) => {
      demand((configurators as readonly string[]).includes(actor.role), 'Pending connect requests are read by the host\'s executor identity', 403);
      const host = url.searchParams.get('host')?.trim() || null;
      demand(!!host, 'Name the host with ?host=', 400);
      const connects = await services.engine.store.transaction(async db => foldConnectEvents((await readConnectEvents(db)).rows));
      const now = Date.now();
      // The owning host reads its open requests with their sealed payloads; its own finished ones
      // stay visible for an hour so a report that raced the fold still finds its request.
      return { connects: connects.filter(entry => entry.host === host && (openState(entry.state) || now - Date.parse(entry.updatedAt) < 3_600_000)) };
    } },
  { method: 'GET', path: '/api/agent-registry/connect/host-key', handle: async ({ actor, url, req, services }) => {
      demand((readers as readonly string[]).includes(actor.role), 'Host keys are readable by admin, coordinator, slice-lead and reader identities', 403);
      const host = executorHost(url, req);
      const rows = (await services.engine.store.transaction(async db => db.query(`SELECT payload->'host' AS host, payload->'publicKey' AS "publicKey", created_at FROM events WHERE work_id IS NULL AND kind='${connectEventPrefix}host-key' ORDER BY seq DESC`))).rows;
      const keys = new Map<string, { publicKey: string; registeredAt: string }>();
      for (const row of rows) if (typeof row.host === 'string' && typeof row.publicKey === 'string' && !keys.has(row.host)) keys.set(row.host, { publicKey: row.publicKey, registeredAt: row.created_at.toISOString() });
      const hosts = host ? [...keys.entries()].filter(([name]) => name === host).map(([name, key]) => ({ host: name, ...key })) : [...keys.entries()].map(([name, key]) => ({ host: name, ...key }));
      return { hosts };
    } },
  { method: 'POST', path: '/api/agent-registry/connect/host-key', handle: async context => {
      const { actor, services } = context;
      demand((configurators as readonly string[]).includes(actor.role), 'A host registers its key with its coordinator identity', 403);
      const data = hostKeySchema.parse(await parseJson(context));
      return services.engine.store.transaction(async (db, now) => {
        // The newest registration per host wins; re-registering an unchanged key appends nothing.
        const existing = (await db.query(`SELECT payload->>'publicKey' AS "publicKey" FROM events WHERE work_id IS NULL AND kind='${connectEventPrefix}host-key' AND payload->>'host'=$1 ORDER BY seq DESC LIMIT 1`, [data.host])).rows[0];
        if (existing?.publicKey === data.publicKey) return { host: data.host, registeredAt: true as const };
        await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, `${connectEventPrefix}host-key`, JSON.stringify(data)]);
        return { host: data.host, registeredAt: now.toISOString() };
      });
    } },
  { method: 'POST', path: '/api/agent-registry/connect', handle: async context => {
      const { actor, services } = context;
      demand(actor.role === 'admin', 'Connecting an account is an operator decision; it is made with an admin identity', 403);
      const data = connectSubmitSchema.parse(await parseJson(context));
      const provider = connectProvider(data.provider);
      demand(provider, `Unknown provider ${data.provider}`, 404);
      // The registry holds references, never secrets, and neither does a connect: a pasted key
      // travels sealed to the host's public key, and any field that still looks like a credential
      // in the clear is refused before it is stored.
      demand(provider.kind !== 'api-key' || !!data.sealed, `${provider.label} takes a pasted key, sealed to the host's public key in the browser`, 400);
      demand(provider.kind !== 'subscription' || !data.sealed, `${provider.label} logs in through ${provider.login ? provider.login.command : 'its own login'}; it takes no key`, 400);
      demand(!looksLikeSecret(data.reason) && !looksLikeSecret(data.host), 'That looks like a credential. Paste it into the connect form so the browser seals it to the host.', 400);
      const id = randomUUID();
      return services.engine.store.transaction(async (db, now) => {
        const open = foldConnectEvents((await readConnectEvents(db)).rows).filter(entry => openState(entry.state));
        demand(open.length < 20, 'There are already 20 connect requests under way; cancel one or wait for it to finish', 409);
        demand(open.every(entry => entry.provider !== provider.id || entry.host !== data.host), `A ${provider.label} connect on ${data.host} is already under way`, 409);
        const at = now.toISOString();
        await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, `${connectEventPrefix}request`, JSON.stringify({ connect: { id, at, host: data.host, provider: provider.id, reason: data.reason, ...(data.sealed ? { sealed: data.sealed } : {}) } })]);
        return { id, at, host: data.host, provider: provider.id, state: 'pending' as const };
      });
    } },
  { method: 'POST', path: /^\/api\/agent-registry\/connect\/([0-9a-f-]{36})\/(claim|progress|result|cancel)$/, async handle(context, [id, action]) {
      const { actor, services } = context;
      const data = action === 'cancel' || action === 'claim' ? null : await parseJson(context, undefined, '{}');
      demand((configurators as readonly string[]).includes(actor.role) && (action !== 'cancel' || actor.role === 'admin'), action === 'cancel' ? 'Cancelling a connect is an operator decision' : 'Connect requests are worked by the host\'s executor identity', 403);
      return services.engine.store.transaction(async (db, now) => {
        const at = now.toISOString();
        const connects = foldConnectEvents((await readConnectEvents(db)).rows);
        const connect = connects.find(entry => entry.id === id);
        demand(connect, 'Unknown connect request', 404);
        if (action === 'claim') {
          const stale = now.getTime() - Date.parse(connect.updatedAt) > (connect.state === 'waiting-login' ? connectStaleMs.login : connectStaleMs.work);
          demand(openState(connect.state) && (connect.state === 'pending' || stale), `The connect is ${connect.state}${stale ? '' : ' and is being worked'}`, 409);
          await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, `${connectEventPrefix}claimed`, JSON.stringify({ connect: { id, at } })]);
          return { claimed: true };
        }
        if (action === 'cancel') {
          // Any open connect can be cancelled, a pending one too (its host's executor may be down).
          demand(openState(connect.state), `The connect is already ${connect.state}`, 409);
          await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, `${connectEventPrefix}cancel`, JSON.stringify({ connect: { id, at } })]);
          return { id, state: 'cancelled' as const };
        }
        const working = connect.state === 'claimed' || connect.state === 'connecting' || connect.state === 'waiting-login';
        demand(working, `The connect is ${connect.state}; claim it before working it`, 409);
        if (action === 'progress') {
          const progress = progressSchema.parse(data);
          await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, `${connectEventPrefix}progress`, JSON.stringify({ connect: { id, at, ...progress } })]);
          return { id, state: progress.state, ...(progress.name ? { name: progress.name } : {}) };
        }
        // The result: healthy registers the account in the registry, in the same transaction, with
        // the default placement the provider's capability decides — never one the worker names.
        const result = resultSchema.parse(data);
        const provider = connectProvider(connect.provider)!;
        const placement = connectDefaultRoles(provider.tier);
        demand(result.state !== 'healthy' || !!result.name && !!result.home, 'A healthy connect names the account and its login home', 400);
        await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, `${connectEventPrefix}result`, JSON.stringify({ connect: { id, at, state: result.state, name: result.name, home: result.home, error: result.error, placement } })]);
        if (result.state === 'failed') return { id, state: 'failed' as const, error: result.error };
        const current = await readRegistry(db);
        demand(!current.accounts.some(account => account.name === result.name!), `Account ${result.name} is already registered`, 409);
        const fleetRoleNames = fleetRoles as readonly string[];
        const registryRoles = placement.filter(role => fleetRoleNames.includes(role));
        const proposal = {
          runtimes: current.runtimes.some(runtime => runtime.name === provider.runtime) ? [] : [proposedRuntimes.find(runtime => runtime.name === provider.runtime)!],
          models: current.models.some(model => model.name === provider.model) ? [] : [{ name: provider.model, id: null, cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: provider.tier === 'fast' ? 'fast' as const : 'strong' as const, contextTokens: null, notes: `The ${provider.label} account's own default model; name the real model and its cost with the registry's model editor` } }],
          accounts: [{ name: result.name!, runtime: provider.runtime, model: provider.model, credential: { host: connect.host, home: result.home! }, enabled: true, maxSessions: null }],
          roles: registryRoles.flatMap(roleName => {
            const existing = current.roles.find(role => role.name === roleName);
            if (existing) return existing.accounts.includes(result.name!) ? [] : [{ ...existing, accounts: [...existing.accounts, result.name!] }];
            return [{ name: roleName, accounts: [result.name!], concurrency: proposedConcurrency[roleName as keyof typeof proposedConcurrency] ?? 1 }];
          }),
          reason: `Connected ${provider.label} from Settings › Agents (GY-409): joined ${placement.join(', ')}`,
        };
        const applied = applyRegistryMutation(current, 'apply', proposal, { actor: actor.id, at });
        await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, 'agent-registry.apply', JSON.stringify({ change: { ...proposal, removed: applied.removed }, registry: applied.registry })]);
        return { id, state: 'healthy' as const, name: result.name, placement };
      });
    } },
  ];
}
