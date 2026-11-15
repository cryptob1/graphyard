import { z } from 'zod';
import { demand } from '../../model.js';
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
const messageKind = 'master.message', replyKind = 'master.reply';

/**
 * Messages to this install's Master, kept in the append-only ledger: a reporter sends one (once per
 * idempotency key) and reads its own with their replies; the Master reads every message, and
 * `master status` raises each one it has not replied to.
 */
export const masterMessageRoutes = defineRoutes('master-messages', [
  { method: 'POST', path: '/api/master/messages', async handle(context) {
    const { actor, services } = context;
    demand(actor.role === 'reporter' || actor.role === 'admin', 'Only a reporter or the operator messages the Master', 403);
    const { text: body } = text.parse(await parseJson(context, 20_000));
    const key = context.idempotencyKey();
    await services.engine.store.pool.query(`INSERT INTO events(work_id,actor,kind,payload) SELECT NULL,$1,$2,$3
      WHERE NOT EXISTS (SELECT 1 FROM events WHERE kind=$2 AND actor=$1 AND payload->>'key'=$4)`, [actor.id, messageKind, JSON.stringify({ text: body, key }), key]);
    const { rows } = await services.engine.store.pool.query(`SELECT seq FROM events WHERE kind=$1 AND actor=$2 AND payload->>'key'=$3`, [messageKind, actor.id, key]);
    return { id: Number(rows[0].seq), sent: true, next: 'Read the Master\'s reply with graphyard messages' };
  } },
  { method: 'GET', path: '/api/master/messages', async handle({ actor, services }) {
    demand(['reporter', 'admin', 'coordinator'].includes(actor.role), 'Only a reporter, the operator or the Master reads Master messages', 403);
    const own = actor.role === 'reporter' ? actor.id : null;
    const { rows } = await services.engine.store.pool.query(`SELECT m.seq, m.actor, m.payload->>'text' AS text, m.created_at,
        COALESCE((SELECT json_agg(json_build_object('by', r.actor, 'text', r.payload->>'text', 'at', r.created_at) ORDER BY r.seq)
          FROM events r WHERE r.kind=$2 AND (r.payload->>'message')::bigint = m.seq), '[]') AS replies
      FROM events m WHERE m.kind=$1 AND ($3::text IS NULL OR m.actor=$3) ORDER BY m.seq DESC LIMIT 100`, [messageKind, replyKind, own]);
    return { messages: rows.map(row => ({ id: Number(row.seq), from: row.actor, text: row.text, at: row.created_at, replies: row.replies })) };
  } },
  { method: 'POST', path: /^\/api\/master\/messages\/(\d+)\/reply$/, async handle(context, [id]) {
    const { actor, services } = context;
    demand(actor.role === 'coordinator' || actor.role === 'admin', 'Only the Master or the operator replies to a Master message', 403);
    const { text: body } = text.parse(await parseJson(context, 20_000));
    const pool = services.engine.store.pool;
    demand((await pool.query('SELECT 1 FROM events WHERE seq=$1 AND kind=$2', [id, messageKind])).rows.length, `There is no Master message ${id}`, 404);
    const key = context.idempotencyKey();
    await pool.query(`INSERT INTO events(work_id,actor,kind,payload) SELECT NULL,$1,$2,$3
      WHERE NOT EXISTS (SELECT 1 FROM events WHERE kind=$2 AND actor=$1 AND payload->>'key'=$4)`, [actor.id, replyKind, JSON.stringify({ message: Number(id), text: body, key }), key]);
    return { replied: Number(id) };
  } },
]);
