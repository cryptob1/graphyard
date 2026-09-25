// Concern: `master scope` — applying a scope request the loop refused as an additive requirements revision.
import { randomUUID } from 'node:crypto';
import { agentToken, broadScopeFlag, guardBroadScope, type MasterConfig } from '../master.js';
import type { Work } from '../model/work.js';

/**
 * `master scope`: apply an open scope request of the lease-holding epoch as an additive
 * requirements revision; a root-level directory needs --allow-broad-scope.
 */
export async function approveScopeRequest(root: string, config: MasterConfig, args: string[], deps: { coordinator: (path: string) => Promise<any>; fetcher?: typeof fetch; operatorToken?: () => Promise<string> }) {
  const allowBroad = args.includes(broadScopeFlag); args = args.filter(flag => flag !== broadScopeFlag);
  if (!args[0]) throw new Error(`Use master scope GY-N [${broadScopeFlag}] [REASON]`);
  const work = ((await deps.coordinator('work-snapshot')).work as Work[]).find(item => item.id === args[0] || item.key === args[0]);
  if (!work) throw new Error(`Unknown work item ${args[0]}`);
  const request = work.scopeRequest;
  if (!request) throw new Error(`${work.key} has no open scope request to approve`);
  if (!work.lease || work.lease.epoch !== request.epoch) throw new Error(`${work.key}'s scope request belongs to epoch ${request.epoch}, which no longer holds the lease; ask the live worker to request again`);
  const token = await (deps.operatorToken ? deps.operatorToken() : agentToken(root, config, 'operatorAgent')), fetcher = deps.fetcher ?? fetch;
  const plannedFiles = [...new Set([...work.plannedFiles, ...request.paths])];
  const reason = guardBroadScope({ ...work, plannedFiles }, args.slice(1).join(' ').trim() || `Approve ${request.requestedBy}'s scope request: ${request.reason}`, { allow: allowBroad, command: 'master scope', existing: work.plannedFiles });
  const response = await fetcher(`${config.url}/api/work/${work.id}/requirements`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': process.env.GRAPHYARD_REQUEST_ID ?? randomUUID() }, body: JSON.stringify({ expectedPolicyRevision: work.policyRevision, criteria: work.criteria, dependencies: work.dependencies, plannedFiles, exclusiveResources: work.exclusiveResources ?? [], producerProofs: work.producerProofs ?? [], reason }), signal: AbortSignal.timeout(30_000) });
  const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result;
}
