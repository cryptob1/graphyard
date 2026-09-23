import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadMasterConfig, setupMaster } from '../master.js';
import { initialFleetProposal } from './master-registry.js';
import { readSecretFromStdin, type CliContext } from './context.js';

/**
 * `master init`: install the operating mode and, in the coordinator checkout, the loop's
 * systemd unit. This is the one command that passes `installSupervisor` to `setupMaster`
 * (GY-114), so the unit under the real user home is written by an operator's explicit
 * action and never as a side effect of another call; `--replace-supervisor` is the only
 * source of `replaceSupervisor`. Setup then proposes the fleet from the agent CLIs already
 * logged in on this host (GY-91); nothing is stored until accepted.
 */
export async function masterInit(context: CliContext, root: string) {
  const { args, base, print } = context;
  const { values } = parseArgs({ args, options: { url: { type: 'string' }, 'token-stdin': { type: 'boolean' }, 'no-auto-merge': { type: 'boolean' }, 'merge-method': { type: 'string' }, 'cli-path': { type: 'string' }, 'host-id': { type: 'string' }, 'herdr-workspace': { type: 'string' }, interval: { type: 'string' }, 'proof-workflow': { type: 'string' }, 'deployment-url': { type: 'string' }, 'deployment-sha-field': { type: 'string' }, 'smoke-workflow': { type: 'string' }, 'dispatch-interval': { type: 'string' }, 'reviewer-profile': { type: 'string' }, 'producer-timeout': { type: 'string' }, 'browser-profile': { type: 'string' }, 'browser-executable': { type: 'string' }, 'replace-supervisor': { type: 'boolean' } }, allowPositionals: false });
  if (!values['token-stdin']) throw new Error('Use master init --token-stdin so the coordinator credential is not stored in shell history');
  const masterToken = await readSecretFromStdin(10_000); if (!masterToken) throw new Error('Master coordinator credential is required; setup made no changes');
  const method = values['merge-method']; if (method && !['merge', 'squash', 'rebase'].includes(method)) throw new Error('Merge method must be merge, squash, or rebase');
  const run = { ...(values.interval ? { intervalSeconds: Number(values.interval) } : {}), ...(values['proof-workflow'] ? { proofWorkflow: values['proof-workflow'] } : {}), ...(values['deployment-url'] ? { deploymentUrl: values['deployment-url'] } : {}), ...(values['deployment-sha-field'] ? { deploymentShaField: values['deployment-sha-field'] } : {}), ...(values['smoke-workflow'] ? { smokeWorkflow: values['smoke-workflow'] } : {}),
    ...(values['dispatch-interval'] ? { dispatchIntervalSeconds: Number(values['dispatch-interval']) } : {}), ...(values['reviewer-profile'] ? { reviewerProfile: values['reviewer-profile'] } : {}), ...(values['producer-timeout'] ? { producerTimeoutMinutes: Number(values['producer-timeout']) } : {}) };
  if (values['browser-executable'] && !values['browser-profile']) throw new Error('--browser-executable requires --browser-profile');
  const browser = values['browser-profile'] ? { profile: values['browser-profile'], ...(values['browser-executable'] ? { executable: values['browser-executable'] } : {}) } : undefined;
  const installed = await setupMaster(root, { url: values.url ?? base, token: masterToken, cliPath: resolve(values['cli-path'] ?? await context.activeCliPath()), hostId: values['host-id'] ?? context.individualHostId(), herdrWorkspace: values['herdr-workspace'], ...(values['no-auto-merge'] ? { autoMerge: false } : {}), ...(method ? { mergeMethod: method as 'merge' | 'squash' | 'rebase' } : {}), ...(Object.keys(run).length ? { run } : {}), ...(browser ? { browser } : {}), installSupervisor: true, replaceSupervisor: !!values['replace-supervisor'] });
  const fleet = await initialFleetProposal(await loadMasterConfig(root), masterToken);
  return print({ ...installed, fleet });
}
