// Concern: the base-failure effects (GY-528) — the P0 filing a base failure the merge writer's
// trial proved raises, made as the operator-agent outside any coordination transaction.
import type { MasterConfig } from '../master.js';
import type { Work } from '../model.js';
import type { baseFailureItem } from '../model/base-failure.js';

/** The effects the base-failure step uses; each is absent where the loop cannot perform it. */
export interface BaseFailureEffects {
  /** GY-528. Files the P0 item a base failure raises, as the operator-agent identity, under a key naming the test and base head. */
  fileBaseFailure?: (input: ReturnType<typeof baseFailureItem>, key: string) => Promise<Work>;
}

type OperatorAgentCall = (method: 'GET' | 'POST', path: string, body?: unknown, key?: string) => Promise<unknown>;

/** The base-failure effects over the master's operator-agent identity, while one is provisioned. */
export function baseFailureEffects(current: () => MasterConfig, asOperatorAgent: OperatorAgentCall): BaseFailureEffects {
  return {
    get fileBaseFailure() { return current().operatorAgent ? (input: ReturnType<typeof baseFailureItem>, key: string) => asOperatorAgent('POST', 'work', input, key) as Promise<Work> : undefined; },
  };
}
