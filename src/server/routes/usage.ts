import { z } from 'zod';
import { demand } from '../../model.js';
import { defineRoutes, parseJson } from '../routes.js';
import { readRegistry } from '../../agent-registry.js';
import { costSummary, type UsageRow } from '../../model/token-costs.js';

const tokens = z.number().int().min(0).max(1e13);
const rowSchema = z.object({
  id: z.string().min(1).max(300), work: z.string().min(1).max(80).nullable(), role: z.enum(['worker', 'reviewer', 'producer', 'master']),
  account: z.string().max(80).nullable(), runtime: z.string().min(1).max(40), model: z.string().min(1).max(200).nullable(), reported: z.boolean(),
  input: tokens, output: tokens, cacheRead: tokens, cacheWrite: tokens, at: z.string().datetime(),
}).strict();

/**
 * What the project's agents spent (GY-3289). The loop reports each session's tokens as its runtime
 * printed them; the dashboard's Costs section, the item page and `master usage` read them priced
 * from the registry's price sheet as it stands, so a corrected price reprices what was spent.
 */
export const usageRoutes = defineRoutes('usage', [
  {
    method: 'POST', path: '/api/usage',
    async handle(context) {
      const { actor, services } = context;
      demand(actor.role === 'coordinator' || actor.role === 'admin', 'Session usage is reported by the loop (a coordinator identity)', 403);
      const { rows } = z.object({ rows: z.array(rowSchema).max(5000) }).strict().parse(await parseJson(context));
      const pool = services.engine.store.pool, registry = await readRegistry(pool);
      for (const row of rows) {
        // A runtime that named no model ran its account's own.
        const own = registry.models.find(model => model.name === registry.accounts.find(account => account.name === row.account)?.model);
        await pool.query(`INSERT INTO session_usage(id,work,role,account,runtime,model,reported,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (id) DO UPDATE SET reported=EXCLUDED.reported, input_tokens=EXCLUDED.input_tokens, output_tokens=EXCLUDED.output_tokens, cache_read_tokens=EXCLUDED.cache_read_tokens, cache_write_tokens=EXCLUDED.cache_write_tokens, at=EXCLUDED.at`,
          [row.id, row.work, row.role, row.account, row.runtime, row.model ?? own?.id ?? own?.name ?? null, row.reported, row.input, row.output, row.cacheRead, row.cacheWrite, row.at]);
      }
      return { recorded: rows.length };
    },
  },
  {
    // The project's Costs view, or one item's with `?work=KEY`; `?days=N` bounds the breakdowns.
    method: 'GET', path: '/api/costs',
    async handle({ url, services }) {
      const pool = services.engine.store.pool, work = url.searchParams.get('work'), days = Number(url.searchParams.get('days')) || null;
      const read = await pool.query(`SELECT id, work, role, account, runtime, model, reported, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, at, clock_timestamp() AS now FROM session_usage${work ? ' WHERE work = $1' : ''}`, work ? [work] : []);
      const rows: UsageRow[] = read.rows.map(row => ({ id: row.id, work: row.work, role: row.role, account: row.account, runtime: row.runtime, model: row.model, reported: row.reported,
        input: Number(row.input_tokens), output: Number(row.output_tokens), cacheRead: Number(row.cache_read_tokens), cacheWrite: Number(row.cache_write_tokens), at: new Date(row.at).toISOString() }));
      const shipped = new Set<string>((await pool.query(`SELECT key FROM work_index WHERE stage = 'done' AND key = ANY($1::text[])`, [[...new Set(rows.flatMap(row => row.work ?? []))]])).rows.map(row => row.key));
      return costSummary(rows, await readRegistry(pool), shipped, read.rows[0] ? new Date(read.rows[0].now).getTime() : Date.now(), days);
    },
  },
]);
