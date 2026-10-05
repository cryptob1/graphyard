import type { Work } from './work.js';

/**
 * GitHub delivery (`GRAPHYARD_DELIVERY=github` on the server): the merge into the base branch is
 * GitHub's, not Graphyard's. A candidate whose build, review and required checks pass is handed
 * to GitHub auto-merge, bound to its head, by the observation that saw it pass; branch protection
 * decides the merge. There is no merge queue, no acceptance-proof gate and no observation-age
 * rule, and the master loop does not run the guarded merge. End-to-end validation happens after
 * the merge, in UAT, before the release is promoted to production (docs/delivery.md).
 */
export const githubDeliveryGate = 'github-delivery';
export const githubDelivery = (env: NodeJS.ProcessEnv = process.env) => env.GRAPHYARD_DELIVERY?.trim() === 'github';
/** Whether the server evaluated this item under GitHub delivery: it carries the marker gate. */
export const deliveredByGitHub = (work: Pick<Work, 'gates'>) => (work.gates ?? []).some(gate => gate.name === githubDeliveryGate);
