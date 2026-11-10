import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { availableRuntimes, describeMergeGate, discover, installedOnboarding } from '../onboarding.js';
import { type DeliveryMode } from '../model/delivery-policy.js';
import { applyProposal, loadAppliedSetup, loadProposal, saveProposal, scanProposal, setupDrift, setupRepository } from '../repository-setup.js';
import { acquireApplyLock, applyInstall, applyRosterChange, buildPlan, installIdFor, installRequestFromArgs, prepareInstall, repositoryRoot, type InstallDependencies } from '../install/index.js';
import { importPrincipalToken, installDirectory, readInstallRecord, recordedRoster, removeRosterEntry, rosterEntry, upsertRosterEntry } from '../install/secrets.js';
import { defineCommands } from './registry.js';
import { readSecretFromStdin } from './context.js';
import { upCommand } from '../up.js'; import { runDoctor } from './install-doctor.js';

/** GY-2009: install registers no GitHub App, so `up --reuse-app` would reuse nothing; it is refused rather than silently ignored. */
export const upAppReuseRefusal = 'graphyard up --reuse-app is refused: install registers no GitHub App and the merge writer\'s deploy key is its only GitHub access (GY-2009); rerun without --reuse-app';
export function refuseUpAppReuse(args: readonly (string | undefined)[]): void {
  if (args.some(arg => arg === '--reuse-app' || arg?.startsWith('--reuse-app='))) throw new Error(upAppReuseRefusal);
}

/**
 * `graphyard principal add|remove` (GY-1879): one entry of this host's installation roster. The
 * install.json record is the roster; `add` judges the entry as the planner judges its own
 * (`rosterEntry`: a producer needs an explicit lane grant or proof seed), and `applyRosterChange`
 * writes its credential, hands the deployment GRAPHYARD_PRINCIPALS alone and reads the served
 * roster back. `--token-file` restores a former credential so existing dispatcher files keep
 * working (GY-1998); `--proof` reads back the producer's recorded grant, which a roster edit never widens.
 * The installer's own principals are refused: `install --apply` plans them.
 * Repeating either command changes nothing and only reads the roster back.
 */
export async function principalCommand(args: string[], dependencies: InstallDependencies & { cwd: string }) {
  const [action, id, ...rest] = args;
  const { values } = parseArgs({ args: rest, options: { role: { type: 'string' }, 'session-kind': { type: 'string' }, grant: { type: 'string', multiple: true }, proof: { type: 'string', multiple: true }, 'token-file': { type: 'string' }, repo: { type: 'string' } }, allowPositionals: false });
  if ((action !== 'add' && action !== 'remove') || !id) throw new Error('Use principal add ID --role ROLE [--session-kind ai|human] [--grant NAME]... [--proof PATTERN]... [--token-file PATH] [--repo OWNER/NAME], or principal remove ID [--repo OWNER/NAME]');
  if (action === 'remove' && (values.role || values['session-kind'] || values.grant?.length || values.proof?.length || values['token-file'])) throw new Error('principal remove takes only ID and --repo');
  const entry = action === 'add' ? rosterEntry({ id, role: values.role, sessionKind: values['session-kind'], grants: values.grant, proofs: values.proof }) : null;
  const root = repositoryRoot(dependencies.cwd);
  const repository = values.repo ?? (await discover(root)).repository;
  if (!repository) throw new Error('Use --repo OWNER/NAME, or run from a checkout whose origin is the managed repository');
  const directory = installDirectory(installIdFor(repository), dependencies.configHome);
  if (!await readInstallRecord(directory)) throw new Error(`No installation of ${repository} is recorded under ${directory}; run graphyard install --apply first`);
  // The edit holds the installation's apply lock from reading the roster until it is persisted and read back,
  // so two edits, or an edit and an install --apply, never each deploy a roster missing the other's entry.
  const release = await acquireApplyLock(directory, (dependencies.now ?? Date.now)());
  try { return await editRoster(root, directory, id, entry, dependencies, values['token-file'] ? resolve(values['token-file']) : null); } finally { await release(); }
}
async function editRoster(root: string, directory: string, id: string, entry: ReturnType<typeof rosterEntry> | null, dependencies: InstallDependencies & { cwd: string }, tokenSource: string | null = null) {
  const record = await readInstallRecord(directory);
  if (!record) throw new Error(`No installation is recorded under ${directory}; run graphyard install --apply first`);
  const { roster, changed } = entry ? upsertRosterEntry(recordedRoster(record), entry) : removeRosterEntry(recordedRoster(record), id);
  // GY-1998: --token-file is judged only after the edit is: a refused edit imports nothing.
  // The deployment is reached where install --apply reached it: its port and image.
  const at = record.deployment;
  const imported = tokenSource ? await importPrincipalToken(directory, id, tokenSource, record.principals?.find(principal => principal.id === id)?.fingerprint ?? null) : null;
  try {
    const session = await prepareInstall(root, { repository: record.repository, provider: record.provider, baseBranch: record.baseBranch, reviewPolicy: record.reviewPolicy, ...(record.domain ? { domain: record.domain } : {}), ...(record.service ? { serverName: record.service } : {}),
    ...(at ? { ...(at.port ? { port: at.port } : {}), ...(at.image ? { image: at.image } : {}) } : {}) }, dependencies, 'apply');
    return await applyRosterChange(session, record, roster, { id, changed, entry });
  } catch (error) {
    // A credential imported for an edit that never reached install.json leaves with it, so no later add reuses it unasked.
    if (imported?.created && !(await readInstallRecord(directory))?.principals?.some(principal => principal.id === id)) await rm(imported.path, { force: true });
    throw error;
  }
}
/** Repository onboarding: install a control plane, propose and apply the delivery workflow, inspect readiness. */
export const installCommands = defineCommands([
  {
    name: 'up',
    help: [
      '  up --repo OWNER/NAME [--base-branch NAME] [--provider compose|local] [--port N]',
      '     [--local] [--master claude|codex] [--agent] [--wait MINUTES]',
      '     [--share-tailnet] [--url URL] [--merge-token-stdin] [--json]',
      '                                First-run setup in one command: preflight, control plane, host supervisor and',
      '                                Herdr, the merge writer\'s deploy key, master autonomy, onboarding, agent',
      '                                accounts, harness and master loop, resumable (.graphyard/up.json;',
      '                                a rerun reuses its --repo/--provider). Ctrl-C stops the install too. Onboarding files are',
      '                                published on graphyard/onboarding and filed as a work item; setup waits for the loop',
      '                                to merge them; no pull request is opened.',
      '                                A step that needs a person prints one one-time link that signs in to the',
      '                                dashboard Setup page, and waits for it to turn green. Accounts registers host agent',
      '                                logins first (registry propose --apply), asking only for an empty role. A green run',
      '                                ends with one fresh sign-in link (signIn). A Tailscale host prints its tailnet-only',
      '                                `tailscale serve` URL; --share-tailnet runs it, links use it (reachableUrl); never public.',
      '                                --agent runs every step non-interactively (JSON events on stderr). No GitHub App is',
      '                                registered: up creates the repository when missing and registers the merge writer\'s deploy',
      '                                key with the gh login. --url URL names the control plane\'s address before master init',
      '                                records one (HTTPS, or HTTP on loopback); --json prints the result as JSON.',
      '                                --merge-token-stdin pipes a fine-grained token (Contents read/write on the repository) to',
      '                                the install instead of a deploy key, where the organization disables deploy keys.',
      '                                --base-branch NAME builds on that branch (default: the repository\'s default branch);',
      '                                a rerun without the flag keeps the branch the install recorded.',
      '                                --port N serves the control plane on 127.0.0.1:N (default: the first free port from',
      '                                4310); a rerun without the flag keeps the port the install recorded.',
      '                                --wait MINUTES bounds a wait (agent: 20). Exit codes: 0 green, 1 a step failed, 2 a',
      '                                machine prerequisite needs a person, 3 still waiting on a person.',
    ],
    // `up` installs the control plane and records the connection; it never reads a stale one.
    readsConnection: () => false,
    async run(context) {
      refuseUpAppReuse([context.id, ...context.args]);
      const result = await upCommand(context.repositoryRoot(), () => context.activeCliPath(), [context.id, ...context.args].filter((value): value is string => value !== undefined));
      context.print(result);
      if ('exitCode' in result) process.exitCode = result.exitCode;
    },
  },
  {
    name: 'install',
    help: [
      '  install --provider compose|local --repo OWNER/NAME',
      '          [--plan|--apply] [--domain HOST] [--workers N]',
      '          [--producer-proof PROOF] [--port N] [--image REF]',
      '          [--source-root DIR] [--merge-token-stdin]',
      '          [--create-environments] [--no-herdr]',
      '                                Install or reconcile a complete control plane on this machine:',
      '                                compose runs it as containers, local on embedded Postgres.',
      '                                No GitHub App, webhook or branch protection is set up: the',
      '                                merge writer\'s deploy key is registered read-write with the',
      '                                gh login, and it alone pushes. Where deploy keys are disabled,',
      '                                pipe a fine-grained token (Contents read/write on the one',
      '                                repository) to --merge-token-stdin instead.',
      '                                --plan prints every action with secrets redacted and',
      '                                changes nothing; --apply executes the same plan. UAT and',
      '                                production resources that cost money are created only with --create-environments.',
    ],
    // The installer creates the connection file; it must never read a stale one.
    readsConnection: () => false,
    async run(context) {
      const { values, request: inputs } = installRequestFromArgs(context.rest);
      const mergeToken = values['merge-token-stdin'] ? await readSecretFromStdin(10000) : undefined;
      if (values['merge-token-stdin'] && !mergeToken) throw new Error('--merge-token-stdin requires a nonempty token on stdin');
      const session = await prepareInstall(process.cwd(), inputs, {
        ...(mergeToken ? { mergeToken } : {}),
        cliPath: await context.activeCliPath(), hostId: context.individualHostId(), log: line => console.error(line),
        // GY-2168: a redeploy names the checkout the deployed commit's tree stands in; without the
        // flag the session builds from the checkout this command's own code was loaded from.
        ...(values['source-root'] ? { sourceRoot: resolve(values['source-root']) } : {}),
      }, values.apply ? 'apply' : 'plan');
      const plan = await buildPlan(session);
      if (!values.apply) return context.print(plan);
      return context.print(await applyInstall(session, plan));
    },
  },
  {
    name: 'init',
    help: [
      '  init [--scan] [--apply] [--url URL] [--herdr] [--token-stdin]',
      '       [--delivery local] [--candidate-cron CRON|off]',
      '                                Print the proposed delivery workflow, writing nothing (--scan), or apply it (--scan --apply);',
      '                                the scan shows the merge-gate split (pre-merge vs per-candidate checks) before anything is applied;',
      '                                after graphyard install, --apply reuses the install\'s identities and writes no principals file',
    ],
    async run(context) {
      const { base, connection, print } = context;
      const root = context.repositoryRoot();
      const { values } = parseArgs({ args: context.rest, options: { url: { type: 'string' }, herdr: { type: 'boolean' }, 'token-stdin': { type: 'boolean' }, 'host-id': { type: 'string' }, 'cli-path': { type: 'string' }, scan: { type: 'boolean' }, apply: { type: 'boolean' },
        delivery: { type: 'string' }, 'candidate-cron': { type: 'string' } }, allowPositionals: false });
      if (values.delivery !== undefined && values.delivery !== 'local') throw new Error('Use --delivery local');
      if ((values.delivery !== undefined || values['candidate-cron'] !== undefined) && !values.scan && !values.apply) throw new Error('--delivery and --candidate-cron choose the proposal; pass them with init --scan');
      const cron = values['candidate-cron'];
      const choices = { ...(values.delivery ? { mode: values.delivery as DeliveryMode } : {}), ...(cron !== undefined ? { candidateSchedule: cron === 'off' ? null : cron } : {}) };
      if (values.scan || values.apply) {
        if (values.herdr || values['token-stdin']) throw new Error('--scan/--apply propose and apply the delivery workflow; run them as the operator before any worker credential setup');
        const stored = values.apply ? await loadProposal(root) : null;
        // Applying rescans with the choices the operator reviewed, so a confirmed opt-out or cadence
        // is compared with the checkout rather than read back as a difference.
        const reviewed = stored?.proposal.delivery ? { mode: stored.proposal.delivery.mode, candidateSchedule: stored.proposal.delivery.candidateSchedule } : undefined;
        // GY-1901: the control plane is the merge writer, which chooses the default model.
        const fresh = await scanProposal(root, { url: values.url ?? null, runtimes: availableRuntimes(), delivery: { ...(values.apply ? { ...reviewed, ...choices } : choices), merger: 'control-plane' } });
        if (values.apply) {
          // Applying saves the scan it applies; a scan without --apply writes nothing (GY-3222).
          const { file } = await saveProposal(root, fresh);
          // An install that owns this repository supplies the identities (GY-1413), only for the
          // server it installed, so the selected server must be that one.
          const selected = values.url ?? stored?.proposal.server ?? null;
          const installed = await installedOnboarding(root, fresh.repository, selected);
          const url = selected ?? installed?.url;
          if (!url) throw new Error('Applying requires the Graphyard server URL; pass --url');
          if (installed) {
            const result = await applyProposal(root, fresh, { url, installed });
            return print({ proposal: file, ...result, installed: installed.directory });
          }
          return print({ proposal: file, ...await applyProposal(root, fresh, { url }) });
        }
        const applied = await loadAppliedSetup(root);
        return print({ proposal: fresh,
          mergeGate: fresh.delivery ? describeMergeGate(fresh.delivery) : [],
          applied: applied ? { at: applied.appliedAt, githubApp: applied.artifacts.githubApp } : null,
          drift: setupDrift(applied, fresh),
          wroteNothing: true,
          next: 'Review the proposal and the mergeGate split above (move a check by editing delivery.mergeGate in graphyard.json and rescanning), then rerun init --scan --apply --url SERVER_URL to apply it' });
      }
      let workerToken = await context.individualToken();
      if (values['token-stdin']) {
        workerToken = await readSecretFromStdin(10000);
        if (!workerToken) throw new Error("--token-stdin requires a nonempty worker credential; setup has not changed local configuration");
      }
      if (workerToken !== undefined && !workerToken.trim()) throw new Error('Worker credential must be nonempty; setup has not changed local configuration');
      const selectedUrl = values.url ?? base;
      // Never silently send a saved credential to a newly selected server.
      if (values.url && connection && new URL(values.url).origin !== connection.url && !process.env.GRAPHYARD_TOKEN && !values['token-stdin']) workerToken = undefined;
      return print(await setupRepository(root, { url: selectedUrl, cliPath: resolve(values['cli-path'] ?? await context.activeCliPath()), hostId: values['host-id'] ?? context.individualHostId(), ...(workerToken ? { token: workerToken } : {}) }, { herdr: values.herdr }));
    },
  },
  {
    name: 'doctor',
    help: [
      '  doctor [--profile PROFILE]   Inspect local discovery, live integration readiness and the',
      '                                readiness checklist for a completion profile',
    ],
    async run(context) { return runDoctor(context); },
  },
  { name: 'principal', help: ['  principal add ID --role admin|coordinator|worker|reader|producer [--session-kind ai|human]',
    '              [--grant external-runs:import|delivery:observe-sha] [--proof unit:*|integration:*|e2e:*|manual:*]...',
    '              [--token-file PATH] [--repo OWNER/NAME]',
    '  principal remove ID [--repo OWNER/NAME]',
    '                                Add or remove one principal of this host\'s installation: writes its credential and its',
    '                                install.json roster entry, sets GRAPHYARD_PRINCIPALS alone on the deployment, and reads the',
    '                                roster back from the control plane. A producer needs an explicit --grant or --proof; --token-file',
    '                                restores an existing credential instead of minting one; delivery:observe-sha is held alone, by a',
    '                                dedicated observer principal; a later install --apply keeps the entry. Repeating either command',
    '                                changes nothing.'], readsConnection: () => false,
    async run(context) { context.print(await principalCommand([context.id, ...context.args].filter((value): value is string => value !== undefined), { cwd: process.cwd(), cliPath: await context.activeCliPath(), hostId: context.individualHostId(), log: line => console.error(line) })); } },
]);
