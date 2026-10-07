import { agentOwner, herdrWorkspaceHealth, humanOwner, type AttentionItem, type MasterConfig } from '../master.js';
import { reviewerBindingHealth } from '../reviewer.js';
import { loopSupervision, loopSupervisionAttention, type LoopSupervisorEvidence, type LoopSupervisorHost } from '../supervisor.js';
import { readDaemonState } from '../master-daemon.js';
import { detectLoopSupervisorUnit } from '../daemon/upgrade.js';
import type { MainGuardReadiness } from '../main-guard.js';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { CliContext } from './context.js';
import { deploymentTarget, derivedFrom, derivedVariables, installIdFor, prepareInstall, providers, revertApproverFromFile, selfProvision, type DerivedVariable, type PendingRedeploy, type PendingSetup, type Provider, type SelfProvisionAudit } from '../install/index.js';
import type { AdapterContext, ProviderAdapter } from '../install/adapters.js';
import { installDirectory, readInstallRecord } from '../install/secrets.js';

/**
 * The `setup` section of master status: installation state that silently stops every launch or
 * leaves the loop unsupervised — an App registered but never bound, a bound App whose credential
 * is gone, a Herdr workspace that no longer exists, and (GY-114) the loop's supervisor, read from
 * the host on every run rather than assumed. Each condition is also an attention item addressed
 * to the master, naming the command that repairs it; `attention` lists them in that order. A
 * missing browser profile is the operator's to give (it lends the master their signed-in GitHub
 * session), so it is recorded here for them rather than asked for in the master's chat (GY-184).
 * An armed main guard without its revert approver App (GY-1335), read from the control plane's
 * status, is named here too: every revert it opens would be refused by main's last-push-approval
 * rule, so it is raised before a merge breaks main, not after.
 */
export const browserProfileMissing = 'No browser profile is configured: App permission updates, installation acceptance, and page-only protection changes cannot run through master browser until the operator lends the master a signed-in Chrome profile';
/**
 * A deployment variable the install plan derives from a credential saved on this host is the
 * master's, never the human's (GY-1416): `master setup --apply` sets it, and the loop runs that
 * itself whenever the provider adapter can apply variables in place.
 */
export const setupApplyNext = 'graphyard master setup --apply: sets GRAPHYARD_REVERT_APPROVER_APP_ID, GRAPHYARD_REVERT_APPROVER_INSTALLATION_ID and GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY from the reviewer App registration saved on this host, and every other derived deployment variable the deployment lacks, through the provider adapter, then redeploys; the loop runs it itself when the adapter can apply variables. graphyard doctor then shows revert-approver ready';
export const browserProfileNext = (cliPath: string) => `node ${cliPath} master init --token-stdin --browser-profile PROFILE`;
/**
 * What the loop's cursor records of its own supervision (GY-1400), for a probe that could not reach
 * the user manager: the unit the reading process runs under, when it is the loop or its child, and
 * whether the loop's last self-upgrade re-executed it through its unit.
 */
export async function loopSupervisorEvidence(root: string, master: MasterConfig, unit = detectLoopSupervisorUnit()): Promise<LoopSupervisorEvidence> {
  const state = await readDaemonState(root, master).catch(() => null);
  return { unit, reexecuted: state?.upgrade?.last?.self === true };
}

export async function setupHealth(root: string, master: MasterConfig, supervisorHost?: LoopSupervisorHost, coordinator?: { mainGuard?: MainGuardReadiness | null } | null,
  evidence: (root: string, master: MasterConfig) => Promise<LoopSupervisorEvidence | null> = loopSupervisorEvidence) {
  // What the loop's own setup step last did (GY-1416), from this process or the file it keeps.
  const selfProvisioned = await lastLoopSelfProvision(root);
  const reviewer = await reviewerBindingHealth(master);
  const supervisor = await loopSupervision({ root, cliPath: master.cliPath }, supervisorHost);
  // The cursor is read only when this vantage could not reach the user manager.
  const supervisorAttention = loopSupervisionAttention(supervisor, supervisor.unreachable ? await evidence(root, master).catch(() => null) : null);
  const herdrWorkspace = await herdrWorkspaceHealth(master);
  const mainGuard = coordinator?.mainGuard ?? null, revertApprover = mainGuard?.attention ?? null;
  const setup = { reviewer, supervisor, herdrWorkspace, mainGuard, selfProvision: selfProvisioned,
    attention: [...reviewer.attention, ...supervisorAttention.map(item => item.text), ...(herdrWorkspace.exists === false ? [herdrWorkspace.reason!] : []), ...(revertApprover ? [revertApprover] : [])] };
  // An unsupervised loop stays stopped; each supervisor state names its own repair.
  const attention: AttentionItem[] = supervisorAttention.map(item => ({ subject: 'setup', text: item.text, ...agentOwner('master', item.next) }));
  for (const text of reviewer.attention) attention.push({ subject: 'setup', text, ...agentOwner('master', 'graphyard master reviewer setup (or graphyard master reviewer bind FILE --key-stdin) to bind the reviewer App') });
  if (herdrWorkspace.exists === false) attention.push({ subject: 'setup', text: herdrWorkspace.reason!, ...agentOwner('master', 'Set herdrWorkspace in .graphyard/master.json to a workspace herdr workspace list shows; master run adopts it on its next tick') });
  if (revertApprover) attention.push({ subject: 'setup', text: revertApprover, ...agentOwner('master', setupApplyNext) });
  if (selfProvisioned?.failed) attention.push({ subject: 'setup', text: `The loop's master setup --apply ${selfProvisioned.outcome} (${selfProvisioned.at})`, ...agentOwner('master', setupApplyNext) });
  if (!master.browser) attention.push({ subject: 'setup', text: browserProfileMissing, ...humanOwner('issuing credentials to people', browserProfileNext(master.cliPath)) });
  return { setup, attention };
}

/** The loop's latest own run of `master setup --apply`: when it started and what it did (`running` until it settles). */
export interface LoopSelfProvision { at: string; outcome: string; failed: boolean }
const loopProvisionIntervalMs = 3_600_000, loopProvisionRetryMs = 600_000, loopProvisionRetryCapMs = 86_400_000;
/** The wait before the next run: an hour after a success; after the Nth failure in a row 10 min × 2^(N-1), at most a day, so a setup or redeploy that keeps failing is retried a bounded number of times a day. */
export const loopProvisionDelay = (failures: number) => failures ? Math.min(loopProvisionRetryMs * 2 ** (failures - 1), loopProvisionRetryCapMs) : loopProvisionIntervalMs;
const loopProvisionRuns = new Map<string, { at: number; running: boolean; outcome: string; failed: boolean; failures: number; reported: boolean }>();
/** Where the loop's latest run is kept, so `master status` in another process reads its outcome. */
export const loopProvisionFile = (root: string) => resolve(root, '.graphyard', 'setup-self-provision.json');
/**
 * The loop's setup step (GY-1416 AC-2, src/daemon/cycle.ts): `master setup --apply` runs beside
 * the cycle (a redeploy outlasts a cycle) at most once an hour; after failures in a row it backs off
 * from ten minutes, doubling to at most a day (`loopProvisionDelay`). It sets
 * variables only where the provider adapter applies them in place; elsewhere it plans, and the setup
 * attention keeps naming the command. A failed run is thrown on the next step, so the cycle records
 * the failed config action, and its outcome is kept for `master status`, which never runs it.
 */
export async function loopSelfProvision(root: string, master: Pick<MasterConfig, 'repository' | 'reviewer'>, options: { now?: number; setup?: typeof masterSetup } = {}): Promise<LoopSelfProvision> {
  const now = options.now ?? Date.now(), last = loopProvisionRuns.get(root);
  // A failed run is reported once, after its retry starts when due: reporting never costs the retry a step.
  const unreported = last && !last.running && last.failed && !last.reported ? last : null;
  if (unreported) unreported.reported = true;
  if (!last || (!last.running && now - last.at >= loopProvisionDelay(last.failures))) {
    const entry = { at: now, running: true, outcome: 'running', failed: false, failures: last?.failures ?? 0, reported: false };
    loopProvisionRuns.set(root, entry);
    void (options.setup ?? masterSetup)(root, master, { apply: true })
      .then(report => { entry.failures = 0; entry.outcome = report.set.length ? `set ${report.set.join(', ')}` : report.redeployed.length ? `redeployed ${report.redeployed.join(', ')}` : report.next ?? 'every derived variable is present'; },
        error => { entry.outcome = `failed: ${error instanceof Error ? error.message : String(error)}`; entry.failed = true; entry.failures++; })
      .finally(async () => {
        entry.running = false;
        await writeAtomically(loopProvisionFile(root), { at: new Date(entry.at).toISOString(), outcome: entry.outcome, failed: entry.failed }).catch(() => undefined);
      });
  }
  if (unreported) throw new Error(`setup self-provision ${unreported.outcome}`);
  return (await lastLoopSelfProvision(root))!;
}
export async function lastLoopSelfProvision(root: string): Promise<LoopSelfProvision | null> {
  const current = loopProvisionRuns.get(root);
  if (current) return { at: new Date(current.at).toISOString(), outcome: current.outcome, failed: current.failed };
  // A missing or unreadable file is no report: it is a diagnostic, and `master status` never fails on it.
  return readFile(loopProvisionFile(root), 'utf8').then(text => JSON.parse(text) as LoopSelfProvision).catch(() => null);
}
/** Replaces a small state file whole, so a process killed mid-write leaves the old file or the new one, never a partial one. */
async function writeAtomically(file: string, value: unknown) {
  await mkdir(resolve(file, '..'), { recursive: true });
  const staged = `${file}.${process.pid}.tmp`;
  await writeFile(staged, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(staged, file);
}

/** Where `master setup --apply` appends one audit line per variable it set: name, source and fingerprint, never a value. */
export const setupAuditFile = (root: string) => resolve(root, '.graphyard', 'setup-audit.jsonl');
export interface MasterSetupOptions { apply: boolean; provider?: Provider; service?: string; linkDirectory?: string; workspace?: string }
export interface MasterSetupDependencies {
  /** The deployment and the variables its install record derives; the install record's by default (`recordedDeployment`). */
  locate?: (root: string, master: Pick<MasterConfig, 'repository'>, options: MasterSetupOptions) => Promise<{ adapter: ProviderAdapter; context: AdapterContext; derived: DerivedVariable[] } | null>;
  now?: () => number;
}

/**
 * The deployment this host installed, from its install record (`graphyard install`), or the one
 * named by --provider, --service and --link-dir. Null when neither names one.
 */
export async function recordedDeployment(root: string, master: Pick<MasterConfig, 'repository'>, options: MasterSetupOptions) {
  if (options.provider) return { ...deploymentTarget({ provider: options.provider, repository: master.repository, service: options.service ?? 'graphyard', linkDirectory: resolve(options.linkDirectory ?? root), workspace: options.workspace ?? null }), derived: [] as DerivedVariable[] };
  const record = await readInstallRecord(installDirectory(installIdFor(master.repository)));
  if (!record) return null;
  // The service install named (--server-name) is recorded; --service names it for a record written before it was.
  const serverName = options.service ?? record.service ?? undefined;
  const session = await prepareInstall(root, { repository: record.repository, provider: record.provider, baseBranch: record.baseBranch, reviewPolicy: record.reviewPolicy, ...(record.domain ? { domain: record.domain } : {}), ...(serverName ? { serverName } : {}),
    workers: record.principals.filter(principal => principal.role === 'worker').length || undefined, producerProofs: record.principals.flatMap(principal => principal.proofs ?? []), ...(record.selfContained ? { selfContained: true } : {}) }, {}, 'plan');
  return { adapter: session.adapter, context: session.context, derived: await derivedVariables(session) };
}

/**
 * `master setup [--apply]` (GY-1416): every deployment variable derived from credentials saved on
 * this host that the running deployment lacks — the install record's, and the revert approver from
 * the reviewer App bound in .graphyard/master.json — planned, or set with --apply through the
 * provider adapter with one audit entry each. Nothing is printed but names and fingerprints.
 */
export async function masterSetup(root: string, master: Pick<MasterConfig, 'repository' | 'reviewer'>, options: MasterSetupOptions, deps: MasterSetupDependencies = {}) {
  const located = await (deps.locate ?? recordedDeployment)(root, master, options);
  if (!located) return { mode: options.apply ? 'apply' as const : 'plan' as const, target: null, observed: false, canApply: false, missing: [], set: [], redeployed: [] as string[], pendingRedeploy: [] as string[], audit: [],
    next: `No deployment is recorded for ${master.repository} on this host (no graphyard install record): name it with graphyard master setup --provider railway --service NAME --link-dir DIR${options.apply ? ' --apply' : ''}` };
  const reviewer = master.reviewer ? derivedFrom(await revertApproverFromFile(master.reviewer.credentialFile), `the reviewer App ${master.reviewer.slug} registration ${master.reviewer.credentialFile}`) : [];
  const audit = async (entry: SelfProvisionAudit) => { await mkdir(resolve(root, '.graphyard'), { recursive: true }); await appendFile(setupAuditFile(root), `${JSON.stringify(entry)}\n`, { mode: 0o600 }); };
  const pendingFile = resolve(root, '.graphyard', `setup-redeploy-${located.context.provider}-${located.context.service}.json`);
  const pending: PendingRedeploy = {
    read: () => readFile(pendingFile, 'utf8').then(text => JSON.parse(text) as PendingSetup, () => ({ redeploy: [], audit: [] })),
    write: async staged => { await (staged.redeploy.length || staged.audit.length ? writeAtomically(pendingFile, staged) : rm(pendingFile, { force: true })); },
  };
  // The reviewer bound now comes first: the first occurrence of a name wins, and the install record's reviewer may since have been replaced.
  return { target: { provider: located.context.provider, service: located.context.service }, ...await selfProvision(located, [...reviewer, ...located.derived], { apply: options.apply, audit, now: deps.now, pending }) };
}

export async function masterSetupCommand(context: CliContext, root: string, master: Pick<MasterConfig, 'repository' | 'reviewer'>) {
  const { values } = parseArgs({ args: context.args, options: { apply: { type: 'boolean' }, provider: { type: 'string' }, service: { type: 'string' }, 'link-dir': { type: 'string' }, workspace: { type: 'string' } }, allowPositionals: false });
  if (values.provider && !providers.includes(values.provider as Provider)) throw new Error(`--provider is one of ${providers.join(', ')}`);
  return context.print(await masterSetup(root, master, { apply: !!values.apply, ...(values.provider ? { provider: values.provider as Provider } : {}), ...(values.service ? { service: values.service } : {}), ...(values['link-dir'] ? { linkDirectory: values['link-dir'] } : {}), ...(values.workspace ? { workspace: values.workspace } : {}) }));
}
