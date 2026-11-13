import { z } from 'zod';
import { demand, Refusal } from '../../model.js';
import { defineRoutes, parseJson } from '../routes.js';
import { emblemByteLimit, emblemEventKind, readEmblem, validateEmblem } from '../../model/emblem.js';

/**
 * The project's emblem (GY-3273): `master emblem set FILE` POSTs the SVG here with the master's
 * own coordinator credential. The control plane judges the drawing (validateEmblem) and records it
 * on the event ledger with the actor that drew it; setting the same emblem again appends nothing.
 * The dashboard reads the result at `/favicon.svg` (static.ts), which the header's `<img>` and the
 * page's icon link already point at, so an emblem needs no new client path.
 */
export const emblemRoutes = defineRoutes('emblem', [
  {
    // `master emblem` reads this to know whether the project has an emblem yet, and whose.
    method: 'GET', path: '/api/emblem',
    async handle({ services }) {
      const emblem = await readEmblem(services.engine.store.pool);
      return emblem ? { set: true, drawnBy: emblem.drawnBy, at: emblem.at, bytes: Buffer.byteLength(emblem.svg, 'utf8'), svg: emblem.svg } : { set: false };
    },
  },
  {
    method: 'POST', path: '/api/emblem',
    async handle(context) {
      const { actor, services } = context;
      demand(actor.role === 'coordinator' || actor.role === 'admin', 'The emblem is drawn by the master (a coordinator identity) or the operator', 403);
      const { svg: candidate } = z.object({ svg: z.string().max(emblemByteLimit * 4) }).strict().parse(await parseJson(context));
      const validated = validateEmblem(candidate);
      if (!validated.ok) throw new Refusal(validated.reason, 400);
      return services.engine.store.transaction(async (db, now) => {
        if ((await readEmblem(db))?.svg === validated.svg) return { set: false, bytes: Buffer.byteLength(validated.svg, 'utf8') };
        await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, emblemEventKind, JSON.stringify({ emblem: { svg: validated.svg, at: now.toISOString() } })]);
        return { set: true, bytes: Buffer.byteLength(validated.svg, 'utf8') };
      });
    },
  },
]);
