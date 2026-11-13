import { defineRoutes, parseJson } from '../routes.js';
import { demand } from '../../model.js';
import { productBriefSchema } from '../../model-boundary/project-memory.js';

/** The install's product brief, mirrored from project memory so the dashboard's Product page shows it read-only (GY-3274). */
export const productBriefRoutes = defineRoutes('product-brief', [
  { method: 'GET', path: '/api/product-brief', async handle({ services }) {
    const row = (await services.engine.store.pool.query('SELECT data FROM product_brief WHERE id = 1')).rows[0];
    return { brief: row?.data ?? null };
  } },
  { method: 'POST', path: '/api/product-brief', async handle(context) {
    demand(context.actor.role === 'coordinator' || context.actor.role === 'operator-agent' || context.actor.role === 'admin', 'The product brief is published by the install master', 403);
    const brief = productBriefSchema.parse(await parseJson(context, 100_000));
    await context.services.engine.store.pool.query(`INSERT INTO product_brief(id, data, updated_at) VALUES (1, $1, now())
      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [JSON.stringify(brief)]);
    return { saved: true };
  } },
]);
