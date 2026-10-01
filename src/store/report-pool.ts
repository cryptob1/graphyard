import pg from 'pg';
import { namedStatements } from './statements.js';
import { trackedPool } from './pools.js';

/**
 * The report pool (GY-491): the read-only reports — interventions, flow analytics, the shipping
 * pulse — run on their own few connections under a shorter statement timeout, so a slow report
 * waits for its own connections and fails on its own clock, and never takes a connection an
 * observation job, a lease renewal or a merge needs.
 */
export const reportPoolConnections = 3, reportStatementTimeoutMs = 20_000;
export interface ReportPoolOptions { reportMax?: number; reportStatementTimeoutMs?: number }
/**
 * The operator's knobs (GY-743): `REPORT_POOL_MAX` and `REPORT_STATEMENT_TIMEOUT_MS`, integers of
 * at least 1; anything unset or out of range keeps the constant, so a typo never widens the pool
 * past its isolation contract or un-bounds its statements.
 */
export const reportPoolOptionsFromEnv = (env: NodeJS.ProcessEnv = process.env): ReportPoolOptions => {
  const option = (value: string | undefined) => { const parsed = Number(value); return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined; };
  return { reportMax: option(env.REPORT_POOL_MAX), reportStatementTimeoutMs: option(env.REPORT_STATEMENT_TIMEOUT_MS) };
};
/** A tracked pool whose failed statements name their SQL (`namedStatements`, GY-422; tracking, GY-483). */
export const namedPool = (url: string, max: number, connectionTimeoutMillis: number, statementTimeoutMs: number) =>
  trackedPool(namedStatements(new pg.Pool({ connectionString: url, max, connectionTimeoutMillis, statement_timeout: statementTimeoutMs })));
/**
 * The report pool for `url`; its statement timeout never exceeds the coordination pool's `ceilingMs`.
 * Size and timeout resolve from the explicit `options`, else the operator's environment
 * (`reportPoolOptionsFromEnv`; production wiring passes no options, so this is what an install
 * sets), else the constants.
 */
export const reportPool = (url: string, options: ReportPoolOptions, connectionTimeoutMillis: number, ceilingMs: number, env: NodeJS.ProcessEnv = process.env) => {
  const fromEnv = reportPoolOptionsFromEnv(env);
  return namedPool(url, Math.max(1, Math.floor(options.reportMax ?? fromEnv.reportMax ?? reportPoolConnections)), connectionTimeoutMillis, Math.min(ceilingMs, options.reportStatementTimeoutMs ?? fromEnv.reportStatementTimeoutMs ?? reportStatementTimeoutMs));
};
