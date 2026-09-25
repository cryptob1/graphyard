// Concern: the authenticated master session every `graphyard master` subcommand after init runs in.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertMasterBinding, loadMasterConfig, mergeProtocolSkew, readCredentialFile } from '../../master.js';
import { cliCommit } from '../../protocol-version.js';
import { executorHostHeader } from '../../model/registry.js';
import type { CliContext } from '../context.js';

/** What a subcommand group returns when the id is not one of its own, so the next group is asked. */
export const unhandled = Symbol('unhandled master subcommand');

/** Every master subcommand authenticates with the coordinator credential the master keeps for itself, never the repository connection file. */
export async function openMasterSession(context: CliContext, root: string) {
  const { id, args, print } = context;
  const master = await loadMasterConfig(root);
  const masterToken = await readCredentialFile(master.credentialFile);
  const masterApi = async (path: string, credential = masterToken, timeoutMs = 30_000, headers: Record<string, string> = {}) => {
    const response = await fetch(`${master.url}/api/${path}`, { headers: { ...headers, Authorization: `Bearer ${credential}` }, signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json(); if (!response.ok) throw new Error(JSON.stringify(body)); return body;
  };
  const masterMutation = async (path: string, data: unknown, requestId: string = randomUUID(), credential: string = masterToken) => {
    const response = await fetch(`${master.url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': requestId }, body: JSON.stringify(data), signal: AbortSignal.timeout(30_000) });
    const result = await response.json(); if (!response.ok) { const error = new Error(JSON.stringify(result)); (error as any).confirmedRefusal = response.status >= 400 && response.status < 500; throw error; } return result;
  };
  // The host is named so the control plane judges fleet placement for this executor.
  const coordinator = await masterApi('status', masterToken, 30_000, { [executorHostHeader]: master.hostId }); assertMasterBinding(master, coordinator);
  // The CLI's own commit, for the version-skew guard.
  const cli = { commit: cliCommit(fileURLToPath(new URL('../../..', import.meta.url))) };
  const assertProtocol = (status: any) => { const skew = mergeProtocolSkew(status, cli); if (skew) throw new Error(skew); };
  return { context, id, args, print, root, master, masterToken, masterApi, masterMutation, coordinator, cli, assertProtocol };
}
export type MasterSession = Awaited<ReturnType<typeof openMasterSession>>;
