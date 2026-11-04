import type pg from 'pg';
import { demand, type Principal } from '../model.js';
import type { Services } from './routes.js';
type Db = pg.PoolClient;
/** The caller as the server knows it: an operator agent is re-read from its registry row. */
export async function authenticated(services: Services, db: Db, now: Date, actor: Principal) {
  if (actor.role !== 'operator-agent') return actor;
  demand(services.engine.operatorAuthorizer, 'Operator-agent authorization is unavailable', 503);
  return services.engine.operatorAuthorizer!(db, now, actor);
}
