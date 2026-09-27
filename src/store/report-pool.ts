import pg from 'pg';
import { namedStatements } from './statements.js';
import { trackedPool } from './pools.js';

/**
 * The report pool (GY-491): the reports — interventions, flow and attribution analytics, the
 * shipping pulse — run on their own few connections under a shorter statement timeout, so a slow
 * report waits for its own connections and fails on its own clock, and never takes a connection
 * an observation job, a lease renewal or a merge needs.
 *
 * One write runs here by design (GY-718): the flow read's bounded projection catch-up
 * (`pooledFlowReport` → `projectFlow`) inserts flow_facts and advances flow_projection. Its
 * batches are advisory-locked, idempotent and transactional, so one that times out under this
 * pool's clock rolls back whole and the next read, or the background tick on the coordination
 * pool, resumes from the same checkpoint. Keeping it here keeps a read's catch-up off the
 * coordination pool; no other report writes.
 */
export const reportPoolConnections = 3, reportStatementTimeoutMs = 20_000;
export interface ReportPoolOptions { reportMax?: number; reportStatementTimeoutMs?: number }
/** A tracked pool whose failed statements name their SQL (`namedStatements`, GY-422; tracking, GY-483). */
export const namedPool = (url: string, max: number, connectionTimeoutMillis: number, statementTimeoutMs: number) =>
  trackedPool(namedStatements(new pg.Pool({ connectionString: url, max, connectionTimeoutMillis, statement_timeout: statementTimeoutMs })));
/** The report pool for `url`; its statement timeout never exceeds the coordination pool's `ceilingMs`. */
export const reportPool = (url: string, options: ReportPoolOptions, connectionTimeoutMillis: number, ceilingMs: number) =>
  namedPool(url, Math.max(1, Math.floor(options.reportMax ?? reportPoolConnections)), connectionTimeoutMillis, Math.min(ceilingMs, options.reportStatementTimeoutMs ?? reportStatementTimeoutMs));
