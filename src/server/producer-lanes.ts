// Concern: the routes a lane-only producer reaches, derived from its grants alone (GY-1879, GY-1912).
import { demand, type Principal } from '../model.js';
import { laneOnlyProducer, type PrincipalGrant } from './principals.js';
import { readImports } from '../validation-import.js';
import { readGrant } from '../proof-grants.js';
import { Next, type Route, type RouteContext, type RouteModule, type Services } from './routes.js';

/**
 * Whether `actor` is confined to its lanes under effective proof authority.
 * A grant record (including an empty revoke) supersedes the environment `proofs` seed, so a
 * producer configured with both proofs and a lane grant is re-confined once those proofs are
 * fully revoked; with no record yet, the seed decides (matching proof-grants.ts `effectiveAuthority`).
 */
export async function confinedLaneProducer(services: Pick<Services, 'engine'>, actor: Principal): Promise<boolean> {
  if (actor.role !== 'producer') return false;
  const record = await services.engine.store.transaction(db => readGrant(db, actor.id));
  return laneOnlyProducer(actor, record ? record.patterns : undefined);
}

type Lane = { may: string; answer(context: RouteContext): unknown };
/**
 * Each grant's routes. `answer` returns Next to pass the request on to the route's own handler,
 * a response to answer it here, or undefined when the request is not one of the lane's.
 */
const lanes: Record<PrincipalGrant, Lane> = {
  'external-runs:import': {
    may: 'import a run, read its own imports',
    answer({ req, url, actor, services }) {
      if (req.method === 'POST' && url.pathname === '/api/validation/import') return Next;
      const head = req.method === 'GET' ? /^\/api\/validation\/import\/([a-f0-9]{40})$/.exec(url.pathname) : null;
      // Only the runs this principal imported itself.
      return head ? readImports({ store: services.engine.store }, head[1], url.searchParams.get('candidate'), actor.id) : undefined;
    },
  },
  // GY-1912: the GY-1861 observation by commit, and nothing beside it: no import, proof, verification or digest observation.
  'delivery:observe-sha': {
    may: 'record a deployment observation by commit (POST /api/delivery/observe-sha)',
    answer: ({ req, url }) => req.method === 'POST' && url.pathname === '/api/delivery/observe-sha' ? Next : undefined,
  },
};

/**
 * A lane-only producer (role producer whose only authority is its lane grants) is held to the
 * routes those grants name, until the grant store records proof authority for it (a producer
 * holding proof grants keeps a producer's access). This guard is the first authenticated route
 * (src/server/index.ts dispatches it ahead of the table), so nothing else runs first: each grant
 * passes or answers its own routes, GET /api/principals answers with its own entry alone, and
 * every other route is refused before any effect.
 */
export const laneProducerRouteGuard: Route = {
  method: '*', path: /^\/api\//,
  async handle(context) {
    const { actor, url, req, services } = context;
    // Read the grant store before any env-seed early return: a revoked seed must re-confine.
    if (!await confinedLaneProducer(services, actor)) return Next;
    const grants = (actor.grants ?? []) as PrincipalGrant[];
    for (const grant of grants) {
      const answer = await lanes[grant].answer(context);
      if (answer !== undefined) return answer;
    }
    if (req.method === 'GET' && url.pathname === '/api/principals')
      return { principals: [{ id: actor.id, role: actor.role, sessionKind: actor.sessionKind ?? null, grants, leases: [] }] };
    demand(false, `${req.method} ${url.pathname} is outside the ${grants.join(' and ')} lane of producer ${actor.id}: it may ${grants.map(grant => lanes[grant].may).join(', ')} and read its own principal`, 403);
    return Next;
  },
};
export const laneProducerScope: RouteModule = { name: 'lane-producer-scope', routes: [laneProducerRouteGuard] };
