import { failedStatement } from '../store/statements.js';

/**
 * The log line of a request that failed with an unexpected error (GY-422): the route, the error,
 * and — for a database failure — the SQL statement that failed. A log that repeated "request failed
 * canceling statement due to statement timeout" without naming the route or the query left the
 * slow read to be found by timing every route from outside; this line names both.
 */
export function requestFailure(method: string | undefined, target: string | undefined, error: unknown) {
  const route = `${method ?? 'GET'} ${new URL(target ?? '/', 'http://localhost').pathname}`;
  const statement = failedStatement(error);
  return `request failed ${route}: ${error instanceof Error ? error.message : 'unknown'}${statement ? ` (statement: ${statement.replace(/\s+/g, ' ').trim().slice(0, 600)})` : ''}`;
}
