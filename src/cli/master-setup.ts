import type { MasterConfig } from '../master.js';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { CliContext } from './context.js';
import { derivedVariables, installIdFor, prepareInstall, selfProvision, type DerivedVariable, type PendingRedeploy, type PendingSetup, type SelfProvisionAudit } from '../install/index.js';
import type { AdapterContext, ProviderAdapter } from '../install/adapters.js';
import { installDirectory, readInstallRecord } from '../install/secrets.js';

/** Replaces a small state file whole, so a process killed mid-write leaves the old file or the new one, never a partial one. */
async function writeAtomically(file: string, value: unknown) {
  await mkdir(resolve(file, '..'), { recursive: true });
  const staged = `${file}.${process.pid}.tmp`;
  await writeFile(staged, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(staged, file);
}

/** Where `master setup --apply` appends one audit line per variable it set: name, source and fingerprint, never a value. */
export const setupAuditFile = (root: string) => resolve(root, '.graphyard', 'setup-audit.jsonl');
export interface MasterSetupOptions { apply: boolean; service?: string }
export interface MasterSetupDependencies {
  /** The deployment and the variables its install record derives; the install record's by default (`recordedDeployment`). */
  locate?: (root: string, master: Pick<MasterConfig, 'repository'>, options: MasterSetupOptions) => Promise<{ adapter: ProviderAdapter; context: AdapterContext; derived: DerivedVariable[] } | null>;
  now?: () => number;
}

/** The deployment this host installed, from its install record (`graphyard install`); null without one. */
export async function recordedDeployment(root: string, master: Pick<MasterConfig, 'repository'>, options: MasterSetupOptions) {
  const record = await readInstallRecord(installDirectory(installIdFor(master.repository)));
  if (!record) return null;
  // The service install named (--server-name) is recorded; --service names it for a record written before it was.
  const serverName = options.service ?? record.service ?? undefined;
  const session = await prepareInstall(root, { repository: record.repository, provider: record.provider, baseBranch: record.baseBranch, reviewPolicy: record.reviewPolicy, ...(record.domain ? { domain: record.domain } : {}), ...(serverName ? { serverName } : {}),
    workers: record.principals.filter(principal => principal.role === 'worker').length || undefined, producerProofs: record.principals.flatMap(principal => principal.proofs ?? []) }, {}, 'plan');
  return { adapter: session.adapter, context: session.context, derived: await derivedVariables(session) };
}

/**
 * `master setup [--apply]` (GY-1416): every deployment variable derived from credentials saved on
 * this host that the running deployment lacks — the install record's — planned, or set with --apply through the
 * provider adapter with one audit entry each. Nothing is printed but names and fingerprints.
 */
export async function masterSetup(root: string, master: Pick<MasterConfig, 'repository' | 'reviewer' | 'url'>, options: MasterSetupOptions, deps: MasterSetupDependencies = {}) {
  const audit = async (entry: SelfProvisionAudit) => { await mkdir(resolve(root, '.graphyard'), { recursive: true }); await appendFile(setupAuditFile(root), `${JSON.stringify(entry)}\n`, { mode: 0o600 }); };
  const located = await (deps.locate ?? recordedDeployment)(root, master, options);
  if (!located) return { mode: options.apply ? 'apply' as const : 'plan' as const, target: null, observed: false, canApply: false, missing: [], set: [], redeployed: [] as string[], pendingRedeploy: [] as string[], audit: [],
    next: `No deployment is recorded for ${master.repository} on this host (no graphyard install record): run graphyard install --provider compose|local --repo ${master.repository} --apply first` };
  const pendingFile = resolve(root, '.graphyard', `setup-redeploy-${located.context.provider}-${located.context.service}.json`);
  const pending: PendingRedeploy = {
    read: () => readFile(pendingFile, 'utf8').then(text => JSON.parse(text) as PendingSetup, () => ({ redeploy: [], audit: [] })),
    write: async staged => { await (staged.redeploy.length || staged.audit.length ? writeAtomically(pendingFile, staged) : rm(pendingFile, { force: true })); },
  };
  return { target: { provider: located.context.provider, service: located.context.service }, ...await selfProvision(located, located.derived, { apply: options.apply, audit, now: deps.now, pending }) };
}

export async function masterSetupCommand(context: CliContext, root: string, master: Pick<MasterConfig, 'repository' | 'reviewer' | 'url'>) {
  const { values } = parseArgs({ args: context.args, options: { apply: { type: 'boolean' }, service: { type: 'string' } }, allowPositionals: false });
  return context.print(await masterSetup(root, master, { apply: !!values.apply, ...(values.service ? { service: values.service } : {}) }));
}
