import { z } from 'zod';
import { demand } from '../../model.js';
import { once } from '../../store/mutations.js';
import { Next, defineRoutes, parseJson } from '../routes.js';

/**
 * GY-3344: a reporter is another install's Master. With a URL and its token file it files items,
 * messages this install's Master and reads back its own items and the Master's replies; every other
 * route is refused here, ahead of the route table, with the same plain reason.
 */
export const reporterScope = defineRoutes('reporter-scope', [{
  method: '*', path: /^\/api\//,
  async handle({ actor, req, url }) {
    if (actor.role !== 'reporter') return Next;
    // Who the credential is, and nothing of the install beside it.
    if (req.method === 'GET' && url.pathname === '/api/status') return { actor: { id: actor.id, role: actor.role } };
    const route = `${req.method} ${url.pathname}`;
    demand(route === 'POST /api/work' || /^GET \/api\/work\/[^/]+$/.test(route) || /^(GET|POST) \/api\/master\/messages$/.test(route),
      `Reporter ${actor.id} may only file items, message this install's Master and read back its own items and the Master's replies; ${route} is none of those`, 403);
    return Next;
  },
}]);

const text = z.object({ text: z.string().trim().min(1).max(4000) }).strict();
/** GY-3345: a peer install's message carries the thread both sides file it under; this Master's record of one it sent names the peer it went `to`. */
const message = text.extend({ thread: z.string().regex(/^[\w-]{1,100}$/).optional(), to: z.string().regex(/^[\w.-]{1,60}$/).optional() }).strict();
const messageKind = 'master.message', replyKind = 'master.reply';

/**
 * Messages to this install's Master, kept in the append-only ledger: a reporter sends one (once per
 * idempotency key) and reads its own with their replies; the Master reads every message, and
 * `master status` raises each one it has not replied to.
 */
export const masterMessageRoutes = defineRoutes('master-messages', [
  { method: 'POST', path: '/api/master/messages', async handle(context) {
    const { actor, services } = context;
    const input = message.parse(await parseJson(context, 20_000));
    // A reporter or the operator messages the Master; the Master itself records only what it sent a peer.
    demand(input.to ? actor.role === 'coordinator' || actor.role === 'admin' : actor.role === 'reporter' || actor.role === 'admin', input.to ? 'Only the Master records a message it sent a peer' : 'Only a reporter or the operator messages the Master', 403);
    return services.engine.store.transaction(db => once(db, actor, context.idempotencyKey(), { command: 'master.message', ...input }, async () => {
      const row = (await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3) RETURNING seq', [actor.id, messageKind, JSON.stringify(input)])).rows[0];
      return { id: Number(row.seq), sent: true, next: 'Read the Master\'s reply with graphyard messages' };
    }));
  } },
  { method: 'GET', path: '/api/master/messages', async handle({ actor, services }) {
    demand(['reporter', 'admin', 'coordinator', 'reader'].includes(actor.role), 'Only a reporter, the operator, a viewer or the Master reads Master messages', 403);
    const own = actor.role === 'reporter' ? actor.id : null;
    // Unanswered messages come first: they are what wakes the Master session once and what master
    // status raises, so a busy exchange of answered messages never pushes one out of the window —
    // its wake subject would drop and it could be delivered a second time on re-entry.
    const { rows } = await services.engine.store.pool.query(`SELECT m.seq, m.actor, m.payload->>'text' AS text, m.payload->>'thread' AS thread, m.payload->>'to' AS "to", m.created_at,
        COALESCE((SELECT json_agg(json_build_object('id', r.seq, 'by', r.actor, 'text', r.payload->>'text', 'at', r.created_at) ORDER BY r.seq)
          FROM events r WHERE r.kind=$2 AND (r.payload->>'message')::bigint = m.seq), '[]') AS replies
      FROM events m WHERE m.kind=$1 AND ($3::text IS NULL OR m.actor=$3)
      ORDER BY EXISTS (SELECT 1 FROM events r WHERE r.kind=$2 AND (r.payload->>'message')::bigint = m.seq), m.seq DESC LIMIT 100`, [messageKind, replyKind, own]);
    // GY-3345: a message without a thread is its own; `to` marks one this Master sent a peer.
    return { messages: rows.map(row => ({ id: Number(row.seq), from: row.actor, ...(row.to ? { to: row.to } : {}), thread: row.thread ?? String(row.seq), text: row.text, at: row.created_at, replies: row.replies })) };
  } },
  { method: 'POST', path: /^\/api\/master\/messages\/(\d+)\/reply$/, async handle(context, [id]) {
    const { actor, services } = context;
    demand(actor.role === 'coordinator' || actor.role === 'admin', 'Only the Master or the operator replies to a Master message', 403);
    const { text: body } = text.parse(await parseJson(context, 20_000));
    return services.engine.store.transaction(db => once(db, actor, context.idempotencyKey(), { command: 'master.reply', message: Number(id), text: body }, async () => {
      demand((await db.query('SELECT 1 FROM events WHERE seq=$1 AND kind=$2', [id, messageKind])).rows.length, `There is no Master message ${id}`, 404);
      await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, replyKind, JSON.stringify({ message: Number(id), text: body })]);
      return { replied: Number(id) };
    }));
  } },
]);
