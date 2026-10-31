// Concern: session and worker harness permissions, and starting the master session.
import { lstat, mkdir } from 'node:fs/promises';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve, basename } from 'node:path';
import { type ChildRun, defaultChildRun } from '../child-runner.js';
import { nameForLaunch } from '../session-name.js';
import { launchAuthorization } from '../repository-setup.js';
import { type HarnessPlan, type HarnessRule, writeHarnessPermissions, masterHarnessPlan, harnessDecision, claudeRuleProblem, bashRuleMatches } from '../harness.js';
import { foreignUnitText, initialiseUnitsCommand, userUnitDirectory, installUnitsFile, type InstallUnits, LegacyUnitRefusal, legacyLoopUnit, perInstallUnits, proposedInstallUnits, readInstallUnits, recordInstallUnits, resolveInstallUnits, unitCheckout } from '../install/units.js';
import type { Work } from '../model.js';
import type { MasterConfig, WorkerProfile } from './profiles.js';
import { coordinatorCheckoutRoot, promotionCommand, workerConfinementRefusal } from './profiles.js';
import { atomicPrivateText, loadMasterConfig } from './config.js';
import { accountLaunch } from './environments.js';
import { type RequestDelivery, startAgentSession } from './launch.js';
import { createdHerdrTab, type HerdrAgent, herdrJson, stopCreatedHerdrTab } from './herdr.js';
import type { PreparedWorker } from './dispatch.js';
import { worktreeRoot } from '../install/worktree-root.js';
import { verificationEnvironment, verificationSlotsDirectory } from './verification-slots.js';

/**
 * The master's harness rules cover everything the master owns, not only the coordination loop:
 * tuning its own configuration through the CLI's owned fields (`master config` — a direct edit of
 * master.json would reach autoMerge and the credential and identity paths onboarding owns, so it
 * is not granted), restarting and reading the durable loop's exact unit, administering the
 * deployment it verifies, and re-running CI for a candidate. None of these reaches a merge, a
 * verdict, evidence, or a credential; the enforced boundaries are unchanged.
 */
function withMasterOwnedRules(plan: HarnessPlan, config: MasterConfig, root: string, unitDirectory: string): HarnessPlan {
  if (plan.harness === 'codex') return { ...plan, manual: `${plan.manual}# The master's own commands reach GitHub, Graphyard, the deployment and its private state beside\n# its credential, so start it with its broadest approval mode (master start codex adds these):\n#   --ask-for-approval never --sandbox workspace-write -c sandbox_workspace_write.network_access=true --add-dir ${JSON.stringify(dirname(config.credentialFile))}\n` };
  if (plan.harness !== 'claude') return plan;
  const workflows = [config.run.proofWorkflow, config.run.smokeWorkflow].filter((name): name is string => !!name);
  const units = installUnitRules(root, unitDirectory);
  const owned: HarnessRule[] = [
    { rule: 'Read(./.graphyard/master.json)', why: 'Read the master configuration the loop runs from: profiles, agent environments, run settings. It holds paths to credentials, never their values. Changing it goes through master config, which writes only the fields the master owns.' },
    ...units.allow,
    { rule: 'Bash(railway status:*)', why: 'Read which release the deployment serves while verifying a delivery.' },
    { rule: 'Bash(railway logs:*)', why: 'Read deployment logs when a release does not serve a delivery.' },
    { rule: 'Bash(railway deployment:*)', why: 'List deployments and their commits to find the exact release to verify or redeploy.' },
    { rule: 'Bash(railway redeploy:*)', why: 'Redeploy the current release after an infrastructure failure; it builds only what the base branch already holds.' },
    { rule: 'Bash(gh run list:*)', why: 'Find the CI and workflow runs of a candidate or delivery.' },
    { rule: 'Bash(gh run view:*)', why: 'Read a run\'s jobs and logs when a gate reports a failing check.' },
    { rule: 'Bash(gh run watch:*)', why: 'Follow a run the loop is waiting on.' },
    { rule: 'Bash(gh run rerun:*)', why: 'Re-run a flaky or infrastructure-failed run on the same commit; the check still has to pass on that exact head.' },
    ...workflows.map(name => ({ rule: `Bash(gh workflow run ${name}:*)`, why: `Request the configured ${name} workflow by hand, as master run does; the provider runs it with its own trusted secret.` })),
  ];
  return { ...plan, allow: [...plan.allow, ...owned.filter(entry => !plan.allow.some(existing => existing.rule === entry.rule))],
    deny: [...plan.deny, ...units.deny.filter(entry => !plan.deny.some(existing => existing.rule === entry.rule))] };
}

/**
 * The master's unit rules (GY-1441): every systemctl command it may run names this install's own
 * loop unit exactly, and every other Graphyard unit on the host is denied, so a master started from
 * a second install can never restart another install's loop. A glob cannot say "every
 * graphyard-* unit but mine", so the denies are the shapes that can never be this install's (the
 * legacy names for a per-install unit, the per-install names for a legacy alias) plus every other
 * install's unit found installed beside it; a deny that would match one of the install's own
 * commands is dropped, since in Claude Code a deny beats the allow.
 */
export function installUnitRules(root: string, unitDirectory: string): { allow: HarnessRule[]; deny: HarnessRule[] } {
  const units = readInstallUnits(root), master = units.master;
  const allow: HarnessRule[] = [
    { rule: `Bash(systemctl --user restart ${master})`, why: 'Restart the durable loop after a configuration or CLI change; it resumes from its persisted cursors. The unit is this install\'s own, exact, so no other unit can be named.' },
    { rule: `Bash(systemctl --user start ${master})`, why: 'Start the durable loop when master status reports it is not running.' },
    { rule: `Bash(systemctl --user enable --now ${master})`, why: 'Re-enable and start the loop\'s own supervisor when master status reports the unit installed but disabled; without it nothing restarts the loop after a crash or a reboot. The unit is exact, so no other unit can be enabled.' },
    { rule: `Bash(systemctl --user stop ${master})`, why: 'Stop the durable loop before an upgrade; nothing is lost, its cursors are persisted before every action.' },
    { rule: `Bash(systemctl --user status ${master})`, why: 'Read whether the durable loop is running.' },
    { rule: 'Bash(systemctl --user daemon-reload)', why: 'Reload the loop\'s user unit after it is edited.' },
    { rule: `Bash(journalctl --user -u ${master}:*)`, why: 'Read the loop\'s launch, failover and refusal log; the unit is pinned to the loop\'s own.' },
  ];
  const why = 'Another Graphyard installation on this host owns this unit; restarting, stopping or enabling it would disrupt that install\'s loop (GY-1441).';
  const shapes = units.alias ? ['graphyard-master-*'] : [`${legacyLoopUnit}*`, 'graphyard-master'];
  const others: string[] = [];
  try {
    for (const name of readdirSync(unitDirectory)) {
      if (name === master) continue;
      if (/^graphyard-master[A-Za-z0-9._-]*\.service$/.test(name)) others.push(name, `${name} *`, name.replace(/\.service$/, ''));
    }
  } catch { /* no unit directory: only the structural shapes apply */ }
  const own = allow.map(entry => /^Bash\((.*)\)$/.exec(entry.rule)![1].replace(/:\*$/, ''));
  const deny = [...new Set([...shapes, ...others])].map(target => ({ rule: `Bash(systemctl --user * ${target})`, why }))
    .filter(entry => !claudeRuleProblem(entry.rule) && !own.some(command => bashRuleMatches(entry.rule, command)));
  return { allow, deny };
}

/**
 * Role-scoped harness rules for the sessions the master launches. The master's own rules live in
 * the repository's .claude/settings.local.json, and Claude Code loads that file for every session
 * started anywhere under the repository — assigned worktrees included — so a master deny such as
 * `git push` would otherwise refuse a worker's push to its own branch. Each Claude session the
 * master launches under a repository that carries project settings therefore starts with only the
 * operator's user settings plus its own role file (`--setting-sources user --settings FILE`), and
 * never the master's. Like the master's rules these are a prompt policy, not authority: the
 * lease, the session's own credential and branch protection remain the enforcement.
 */
export type SessionRole = 'worker' | 'reviewer' | 'producer';
export interface SessionHarnessInput { role: SessionRole; kind: string | undefined; cliPath: string; repository: string; baseBranch: string; credentialHome: string; credentialDirectories: string[]; branch?: string; pr?: number;
  /** The detached checkout Graphyard allocated for a reviewer session under the managed worktree root. */
  checkout?: string }
export function sessionHarnessPlan(input: SessionHarnessInput): HarnessPlan {
  if (input.kind !== 'claude') return { harness: input.kind ?? 'unknown', file: null, allow: [], deny: [], manual: null, note: `${input.kind ?? 'This runtime'} does not load the repository's Claude Code settings, so it inherits no master rule; its own approval configuration applies.` };
  const cli = `node ${input.cliPath}`;
  const secrets: HarnessRule[] = [
    ...[...new Set(input.credentialDirectories)].sort().map(directory => ({ rule: `Read(/${directory}/**)`, why: 'Graphyard credentials live here; the session uses its own through the CLI and never reads their bytes.' })),
    { rule: 'Read(./.graphyard/connection.json)', why: 'Holds an individual Graphyard credential.' },
    { rule: 'Read(./.graphyard/credentials.json)', why: 'Holds local principal credentials.' },
    { rule: 'Read(./.graphyard/github-app.json)', why: 'Holds the control-plane App private key.' },
    { rule: 'Read(**/*.pem)', why: 'App private keys are never read into a session transcript.' },
    { rule: 'Read(**/*.token)', why: 'Token files are never read into a session transcript.' },
    { rule: 'Bash(gh pr merge:*)', why: 'Delivery happens only through the guarded merge.' },
    // Scoped to the merge endpoints, not the word: a reviewer's verdict body often says "merge", and
    // in Claude Code a deny beats the allow for its one review call.
    { rule: 'Bash(gh api *pulls/*/merge*)', why: 'A raw pull-request merge call is an administrative merge bypass.' },
    { rule: 'Bash(gh api *repos/*/merges*)', why: 'A raw branch-merge call is an administrative merge bypass.' },
    { rule: 'Bash(gh api graphql*)', why: 'GraphQL reaches merge and merge-queue mutations; no session needs it.' },
    { rule: 'Bash(agent-browser *)', why: "The operator's browser profile is driven only by the master's recorded flows." },
  ];
  const noVerdict: HarnessRule[] = [
    { rule: 'Bash(gh pr review:*)', why: 'Only the independent reviewer posts a verdict.' },
    { rule: 'Bash(gh api *pulls/*/reviews*)', why: 'Only the independent reviewer posts a verdict.' },
  ];
  const noPush: HarnessRule[] = [
    { rule: 'Bash(git push:*)', why: 'This session implements nothing and pushes nothing.' },
    { rule: 'Bash(git commit:*)', why: 'This session changes nothing in the candidate.' },
    { rule: `Bash(${cli} claim:*)`, why: 'Claiming work would make this principal an implementer.' },
  ];
  let allow: HarnessRule[], deny: HarnessRule[];
  if (input.role === 'worker') {
    if (!input.branch) throw new Error('A worker harness names the assigned branch it may push');
    // The same worker rules installWorkerHarness writes into the worktree, plus the shared secret
    // and verdict denies: loaded through --settings they apply even though the worktree's own
    // settings file is not loaded.
    const worker = workerHarnessPlan({ cliPath: input.cliPath, branch: input.branch, baseBranch: input.baseBranch, credentialHome: input.credentialHome });
    const extra = [...secrets, ...noVerdict, { rule: `Bash(${cli} evidence:*)`, why: 'Implementation workers never submit trusted evidence.' }];
    allow = worker.allow;
    deny = [...worker.deny, ...extra.filter(entry => !worker.deny.some(existing => existing.rule === entry.rule))];
  } else if (input.role === 'reviewer') {
    allow = [
      { rule: 'Bash(gh pr diff:*)', why: 'Read the candidate diff.' },
      { rule: 'Bash(gh pr view:*)', why: 'Read the pull request and poll its mergeability before posting.' },
      // GY-1492: the verdict goes through review post, which checks the launch's binding, the head,
      // mergeability and the thread lines before its one POST; a raw review call is denied below.
      { rule: `Bash(${cli} review post:*)`, why: 'Post the one verdict this session was launched for, checked against its launch binding; the master itself is denied every review call.' },
      // Surrounding code is read from a detached checkout under the managed worktree root, which
      // Graphyard allocates for the session and removes when it ends.
      ...(input.checkout ? [{ rule: 'Bash(git fetch:*)', why: 'Fetch the exact head under review.' },
        { rule: `Bash(git worktree add --detach ${input.checkout}:*)`, why: 'Check the exact head out, read-only, in the checkout Graphyard allocated for this session.' }] : []),
    ];
    deny = [...secrets, ...noPush,
      { rule: `Bash(${cli} evidence:*)`, why: 'A reviewer never submits evidence.' },
      { rule: 'Bash(gh api *pulls/*/reviews*)', why: 'The verdict is posted only through review post, which checks it first.' },
      { rule: 'Edit(./**)', why: 'The review session is read-only.' },
      { rule: 'Write(./**)', why: 'The review session is read-only.' },
    ];
  } else {
    allow = [
      { rule: `Bash(${cli} evidence:*)`, why: 'Submit the evidence of the proof group this session was launched for, under its own producer credential.' },
      { rule: `Bash(${cli} status:*)`, why: 'Read the acceptance criteria the proofs establish.' },
      { rule: 'Bash(git fetch:*)', why: 'Fetch the exact head.' },
      { rule: 'Bash(git worktree add:*)', why: 'Check the exact head out in a detached worktree of its own.' },
      { rule: 'Bash(git worktree remove:*)', why: 'Remove that worktree once every proof is submitted.' },
    ];
    deny = [...secrets, ...noPush, ...noVerdict];
  }
  return { harness: 'claude', file: null, allow, deny, manual: null, note: `Role-scoped ${input.role} rules; the session loads these and the operator's user settings, never the repository's project or local settings where the master's rules live.` };
}

/** Where a session's role file lives: beside the ledgers, ignored by Git, never inside a worktree it is launched for. */
export const sessionHarnessFile = (root: string, role: SessionRole, profile: string) => resolve(root, '.graphyard/harness', `${role}-${profile}.json`);
async function repositoryCarriesClaudeSettings(root: string) {
  for (const name of ['settings.json', 'settings.local.json']) {
    try { await lstat(resolve(root, '.claude', name)); return true; } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  return false;
}
/**
 * Writes the role file and returns the runtime arguments that load it instead of the repository's
 * settings. A Claude session under a repository that carries no project settings inherits nothing
 * and is launched with its profile arguments unchanged. Loading only the user settings also leaves
 * out the repository's AGENTS.md, so such a session carries the launch authorization written there
 * (repository-setup.ts launchAuthorization) as its role text, loaded from the session's role file.
 */
/** A session's verification slot variables (GY-612), or none when the managed worktree root cannot be written: master status reports that root. */
export function sessionVerificationEnvironment(root: string, config: Pick<MasterConfig, 'repository' | 'run'>): Record<string, string> {
  try { return verificationEnvironment(worktreeRoot(root, config)); } catch { return {}; }
}
/**
 * The lock directory every session must be able to write to take a slot, created now so a sandboxed
 * runtime (Codex under workspace-write) can be granted it with `--add-dir`: without the grant its
 * `mkdir slot-N` is refused and the run goes ahead unbounded. None when the root cannot be written.
 */
export function sessionSlotsGrant(root: string, config: Pick<MasterConfig, 'repository' | 'run'>): string[] {
  // Only under a managed root that exists: setup creates and verifies it, and a launch never makes one.
  let directory: string;
  try { directory = verificationSlotsDirectory(worktreeRoot(root, config)); } catch { return []; }
  try { mkdirSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return []; }
  return [directory];
}
export async function prepareSessionHarness(root: string, config: MasterConfig, input: Omit<SessionHarnessInput, 'cliPath' | 'repository' | 'baseBranch' | 'credentialHome' | 'credentialDirectories'> & { profile: string; credentialFiles?: string[] }) {
  const plan = sessionHarnessPlan({ ...input, cliPath: config.cliPath, repository: config.repository, baseBranch: config.baseBranch, credentialHome: dirname(dirname(config.credentialFile)),
    credentialDirectories: [dirname(config.credentialFile), ...(config.reviewer ? [dirname(config.reviewer.credentialFile)] : []), ...(input.credentialFiles ?? []).map(file => dirname(file))] });
  // Every session's heavy verification runs share the host's slots (GY-612): its tab carries the
  // lock directory under the managed worktree root, the bound, and the wrappers first on its PATH.
  // A root that cannot be written leaves the session unbounded rather than unlaunched.
  const environment = sessionVerificationEnvironment(root, config);
  if (input.kind !== 'claude' || !await repositoryCarriesClaudeSettings(root)) return { plan, file: null, args: [] as string[], role: null as string | null, environment };
  const file = sessionHarnessFile(root, input.role, input.profile);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await atomicPrivateText(file, `${JSON.stringify({ permissions: { allow: plan.allow.map(entry => entry.rule), deny: plan.deny.map(entry => entry.rule) } }, null, 2)}\n`);
  // The authorization is the session's role text: startAgentSession writes it to the session's
  // role file and the command line loads that file (GY-121), never the text itself.
  return { plan, file, args: ['--setting-sources', 'user', '--settings', file], role: launchAuthorization.replace(/\s+/g, ' ') as string | null, environment };
}
/**
 * The master session's own first request (GY-93): the role, its boundaries and its commands, shared
 * verbatim by the human launch (`master start`) and the loop's launch (GY-898). A replacement
 * started by the loop carries the same request plus the handover the loop composes from
 * control-plane truth (master-session.ts masterRequest), so both paths start the same session.
 */
export function masterPrompt(config: MasterConfig): string {
  // GY-1501: a supervised install has no operator-agent identity by design; that is its mode, not an onboarding fault.
  const supervised = config.supervision === 'supervised';
  const supervisedInstruction = `This install is supervised: an agent reviewer reviews each head and the control plane merges it, but supervised mode provisions no operator-agent identity; that is the mode the operator chose, not an onboarding fault, so do not report the missing identity. Record what needs the operator in master status and leave it there; promotion to autonomy (${promotionCommand}) is the operator's choice.`;
  const prompt = `You are the dedicated Graphyard master agent for ${config.repository}.${config.forPerson ? ` Work only items whose human owner is ${config.forPerson}.` : ' Skip owned items.'} Do not implement product work, claim worker leases, submit evidence, weaken requirements, or bypass gates. Read AGENTS.md, run node ${config.cliPath} master guide, then run node ${config.cliPath} master status; guide master holds the loop's own procedure. Use Graphyard as assignment and progression truth and Herdr only for session health and control. Route ready work to configured worker profiles, require workers to claim for themselves, preserve handoffs, and leave dispatch, review, proof production and routine merge to node ${config.cliPath} master run, whose loop performs each; the master CLI refuses those hand actions on system-driven items. Act without asking: only goals and priorities, spending money or opening third-party accounts, and issuing credentials to people belong to the human. ${supervised ? supervisedInstruction : `Every decision is yours to apply at once with your own identity: node ${config.cliPath} master create, release, unblock, requirements, rework, attest or close.${config.operatorAgent ? '' : ` Your operator-agent identity is not provisioned yet; report that onboarding must run node ${config.cliPath} master autonomy --admin-token-stdin --apply once.`}`}`;
  const reviewInstruction = supervised
    ? `Independent review starts on its own: when a candidate passes the build gate, node ${config.cliPath} master run launches a reviewer session for its exact head and the control plane merges it once every gate passes. It launches no other session; never review or approve a candidate yourself, never launch a reviewer, and never submit evidence.`
    : config.reviewer
    ? `Independent review and proof collection start on their own: when a candidate passes the build gate the control plane records a review request and producer requests bound to its exact head, and node ${config.cliPath} master run launches the reviewer identity ${config.reviewer.slug}[bot] and one producer session per proof group for them within 30 seconds. Read the findings, route rework, and merge; never launch reviews or producers by hand, never review a candidate yourself, and never submit evidence. master status shows what is running per candidate and since when, and node ${config.cliPath} master review GY-N is only the recovery of a review request the loop has stopped relaunching: its session settled without answering it, its automatic sessions are exhausted, or its launch reached the dispatch failure limit with no request-review row still queued; on a system-driven item it is refused before then.`
    : `No reviewer identity is registered yet: run node ${config.cliPath} master reviewer setup before routing work that needs independent review; master run launches reviews and producers on its own once registered. Never approve a candidate yourself.`;
  const administrationInstruction = config.browser
    ? `GitHub administration of ${config.repository} is yours: when only a GitHub page can do it run node ${config.cliPath} master browser app-permissions or installation-accept, which drive the operator's browser profile ${config.browser.profile} headless, record every step, verify through the API, and append an audit entry. Report a pending sudo code from master status; the operator only approves it on their device. Never ask the operator to click through what those flows cover.`
    : `No browser profile is configured: App permission updates and installation acceptance stay with the operator, and master status records that as a setup attention item naming node ${config.cliPath} master init --token-stdin --browser-profile PROFILE; never ask the operator in chat, leave the item to master status.`;
  return `${prompt} ${reviewInstruction} ${administrationInstruction}`;
}

export async function startMaster(root: string, kind: WorkerProfile['kind'], agentArgs: string[], agents: HerdrAgent[], run?: ChildRun) {
  if (!kind) throw new Error('Choose a supported master agent kind');
  const config = await loadMasterConfig(root);
  const masterRetry = `graphyard master start ${kind}, once masterAgentName in .graphyard/master.json is a name Herdr can launch`;
  const name = nameForLaunch(masterRetry, () => config.masterAgentName);
  if (agents.some(agent => agent.name === name)) throw new Error(`Master agent ${name} is already visible in Herdr; the loop supervises the live master session (master status, daemon.master) — close it there or in Herdr before starting another`);
  // Installation, not operator memory: the harness the master runs under learns the master's own
  // commands before the session starts, so a routine status or review never waits on a keypress.
  const harness = await writeHarnessPermissions(root, masterHarness(root, config, kind), true);
  let pane: string | undefined, tabId: string | undefined, delivery: RequestDelivery | undefined;
  try {
    // The master runs with its runtime's broadest approval mode too; the harness rules above, not
    // runtime prompts, say what it may do. Codex's sandbox is widened to the private state the
    // master's own commands write beside its credential, and its tab carries the recipe's variables.
    const launch = accountLaunch({ kind, approvals: 'auto', agentArgs, environment: {} }, null, { writable: [dirname(config.credentialFile)] });
    const created = createdHerdrTab(await herdrJson(['tab', 'create', ...(config.herdrWorkspace ? ['--workspace', config.herdrWorkspace] : []), '--cwd', root, '--label', `Graphyard master · ${config.repository}`, '--env', 'GRAPHYARD_MASTER=1', ...Object.entries(launch.environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--no-focus'], run));
    pane = created.pane; tabId = created.tab;
    // The master starts on its own request too; a runtime without that contract is prompted
    // after start, with the text last and the confirmation following it. The request is the
    // shared master prompt (GY-898), the same one the loop's launch carries with its handover.
    // The master is confined like every other launched session (GY-1658): its configuration,
    // administration and browser-flow commands run from the coordinator root with the checkout
    // read-only, its managed .graphyard state writable; a host that cannot confine it refuses.
    ({ delivery } = await startAgentSession(name, kind, created.pane, launch.args, masterPrompt(config), run, { directory: root, confirm: 'follow', retry: masterRetry, environment: launch.environment, confinement: 'master' }));
  } catch (error) {
    const malformedTab = (error as any)?.herdrTab as string | undefined;
    if (pane || tabId || malformedTab) try { await stopCreatedHerdrTab(pane, tabId ?? malformedTab, run); }
    catch { throw new Error(`${error instanceof Error ? error.message : 'Master startup failed'}; Herdr could not confirm cleanup of the created tab`); }
    throw error;
  }
  return { agentName: name, kind, pane: pane!, status: delivery === 'request' ? 'started on its request' : 'started and prompted', delivery, focusChanged: false, harness };
}

// ---- Autonomy ----------------------------------------------------------------------------------
// Humans set goals; agents run the loop. Everything a human used to approve the master applies with
// its own operator-agent identity. What stays human is this list, and nothing else.
export const humanOnlyDecisions = ['goals and priorities', 'spending money or opening third-party accounts', 'issuing credentials to people'] as const;
export const masterOperatorCapabilities = ['policy:requirements', 'policy:review-provider', 'e2e:record'] as const;
export const autonomyReason = 'Master autonomy onboarding: the master\'s operator-agent identity';
/** The one agent identity onboarding provisions: the master's own, which applies every decision. */
export function autonomyPlan(config: MasterConfig) {
  const name = config.repository.split('/').at(-1)!.replace(/[^a-zA-Z0-9._-]/g, '-');
  const directory = dirname(config.credentialFile), stem = basename(config.credentialFile, '.token');
  const scope = { repositories: [config.repository], workItems: ['*'] };
  return {
    operatorAgent: { id: config.operatorAgent?.id ?? `graphyard-master-${name}-operator`.slice(0, 100), displayName: `Graphyard master for ${config.repository}`.slice(0, 100), capabilities: [...masterOperatorCapabilities], scope,
      credentialFile: config.operatorAgent?.credentialFile ?? resolve(directory, `${stem}-operator.token`), role: 'Applies every decision the master makes (create, release, unblock, requirements, rework, close, attest) under its own name' },
  };
}

/** Rules every master session gets on top of its loop rules: it cannot borrow another identity. */
const autonomyDeny = (credentialHome: string): HarnessRule[] => [
  { rule: 'Bash(*GRAPHYARD_TOKEN_FILE=*)', why: 'The master acts only as its own identities; pointing a command at a worker\'s or producer\'s credential file would let it borrow another identity.' },
  { rule: `Edit(//${credentialHome}/**)`, why: 'Agent credentials are issued by onboarding and rotated through the API, never edited in place.' },
];
/** Thrown when the checkout a harness apply resolved is not one it may apply against (GY-1662); `unit` is the unit file to update, when one names the right checkout elsewhere. */
export class HarnessCheckoutRefusal extends Error {
  override readonly name = 'HarnessCheckoutRefusal';
  constructor(readonly root: string, readonly unit: string | null, detail: string) { super(detail); }
}
/**
 * GY-1662: the checkout the loop applies the Claude harness contract against, checked before any
 * write. A loop's research effect names its scratch worktree, which records no units, so an apply
 * resolved from it met the legacy unit refusal every cycle; the loop's own checkout is what it
 * applies against. ROOT is refused, naming it and the `master init` remedy, when it records no units
 * (naming too the legacy unit that runs another checkout, when one does); and when the unit serving this loop (SERVINGUNIT, in
 * UNITDIRECTORY) runs a checkout other than ROOT, cannot be read, or is not the master unit ROOT
 * records, naming that unit to update rather than applying against the wrong checkout.
 */
/**
 * The checkout a master unit with no WorkingDirectory launches, when it is not ROOT (GY-1662):
 * foreignUnitText reads a master unit's checkout only from its WorkingDirectory, so one that omits
 * it and runs another checkout's bin/graphyard.mjs passed. Without a WorkingDirectory the CLI its
 * ExecStart runs is the only evidence of the checkout, so one naming no CLI under ROOT is refused;
 * a unit whose WorkingDirectory is ROOT may run an external launcher (a private CLI path).
 */
function launchedCheckout(text: string, root: string, home: string): string | null {
  const { workingDirectory, execStart } = unitCheckout(text, home);
  if (workingDirectory) return null;
  const real = (path: string) => { const absolute = resolve(path); try { return realpathSync(absolute); } catch { return absolute; } };
  const cli = execStart?.split(/\s+/).map(part => part.replace(/^"|"$/g, '')).find(part => /\/bin\/graphyard\.mjs$/.test(part));
  if (!cli) return `a command with no WorkingDirectory and no ${root}/bin/graphyard.mjs in its ExecStart (${execStart ?? 'none'})`;
  const checkout = dirname(dirname(cli));
  return real(checkout) === real(root) ? null : checkout;
}
/**
 * GY-1692 (GY-1666): the unit record `master init` writes, written by the loop itself when the
 * evidence `harnessApplyCheckout` asks for is in hand — the unit serving this loop is read and runs
 * ROOT, and its name is the master unit ROOT would record (the legacy alias when every legacy unit
 * installed runs ROOT, else the per-install name). GY-1662 refused every units-less checkout because
 * with no serving unit a separate launcher checkout could pass; a serving unit that runs ROOT is that
 * proof, so waiting on a person to run `master init` for it asked them for the loop's own job. Returns
 * the units recorded now, or null when nothing was recorded: a record exists, no serving unit is known,
 * its file cannot be read or runs elsewhere, or its name is not the one ROOT would record.
 */
export async function recordServingUnits(root: string, repository: string, options: { servingUnit?: string | null; unitDirectory?: string; home?: string } = {}): Promise<InstallUnits | null> {
  const unitDirectory = options.unitDirectory ?? userUnitDirectory(), home = options.home ?? homedir();
  if (!options.servingUnit || existsSync(resolve(root, installUnitsFile))) return null;
  let text: string;
  try { text = readFileSync(resolve(unitDirectory, options.servingUnit), 'utf8'); } catch { return null; }
  if (foreignUnitText(text, root, home) ?? launchedCheckout(text, root, home)) return null;
  if (proposedInstallUnits(root, repository, unitDirectory, home).master !== options.servingUnit) {
    // GY-1745: a leftover legacy-named unit that also runs ROOT makes the proposal the legacy alias, though the unit serving the loop, which runs ROOT, is this install's own per-install unit: that name is what the install records.
    const own = perInstallUnits(repository);
    return own.master === options.servingUnit ? recordInstallUnits(root, own) : null;
  }
  return resolveInstallUnits(root, repository, unitDirectory, home);
}
export function harnessApplyCheckout(root: string, options: { servingUnit?: string | null; unitDirectory?: string; home?: string } = {}) {
  const unitDirectory = options.unitDirectory ?? userUnitDirectory(), home = options.home ?? homedir();
  let units: InstallUnits;
  try { units = readInstallUnits(root, unitDirectory, home); }
  catch (error) {
    if (!(error instanceof LegacyUnitRefusal)) throw error;
    throw new HarnessCheckoutRefusal(root, error.unitPath, `The harness contract was not applied: ${root} records no units (${installUnitsFile} is absent) and the legacy unit ${error.unitPath} runs another checkout (${error.checkout}). Run ${initialiseUnitsCommand} in ${root} to record its own units, or update ${error.unitPath} if ${root} is the checkout it should run`);
  }
  // The legacy alias readInstallUnits falls back to is no proof ROOT is this install's checkout: with no serving unit detected, a separate launcher checkout would pass and receive the managed repository's plan.
  if (!existsSync(resolve(root, installUnitsFile))) throw new HarnessCheckoutRefusal(root, null, `The harness contract was not applied: ${root} records no units (${installUnitsFile} is absent), so it is not established that it is this install's checkout. Run ${initialiseUnitsCommand} in ${root} to record its own units`);
  if (options.servingUnit) {
    const path = resolve(unitDirectory, options.servingUnit);
    // Only an absent unit file names no checkout; one that exists but cannot be read cannot show it runs ROOT, so it is refused.
    let text: string | null = null;
    try { text = readFileSync(path, 'utf8'); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code !== 'ENOENT') throw new HarnessCheckoutRefusal(root, path, `The harness contract was not applied: the unit serving this loop, ${path}, could not be read (${code ?? (error instanceof Error ? error.message : String(error))}), so it is not established that it runs ${root}, the checkout this apply targets. Make ${path} a readable unit file that runs ${root}, then systemctl --user daemon-reload and restart it`);
    }
    const other = text === null ? null : foreignUnitText(text, root, home) ?? launchedCheckout(text, root, home);
    if (other) throw new HarnessCheckoutRefusal(root, path, `The harness contract was not applied: the unit serving this loop, ${path}, runs ${other}, not ${root}, the checkout this apply targets. Update ${path} (its WorkingDirectory and ExecStart) to run ${root}, then systemctl --user daemon-reload and restart it, rather than apply against the wrong checkout`);
    if (options.servingUnit !== units.master) throw new HarnessCheckoutRefusal(root, path, `The harness contract was not applied: the unit serving this loop, ${options.servingUnit}, is not the master unit ${root} records (${units.master} in ${installUnitsFile}), so the contract built from the recorded units would misclassify the unit actually serving it. Serve the loop from ${units.master}, or record ${options.servingUnit} as the master unit in ${root}/${installUnitsFile} if it is this checkout's own`);
  }
  return { root, units };
}
export function masterHarness(root: string, config: MasterConfig, harness: string, options: { unitDirectory?: string } = {}) {
  const credentialHome = dirname(dirname(config.credentialFile));
  const plan = withMasterOwnedRules(masterHarnessPlan({ harness, root, cliPath: config.cliPath, repository: config.repository, baseBranch: config.baseBranch, credentialHome }), config, root, options.unitDirectory ?? userUnitDirectory());
  return plan.file ? { ...plan, deny: [...plan.deny, ...autonomyDeny(credentialHome)] } : plan;
}

/**
 * A worker session's own rules, written into its assigned worktree: it runs its item's commands,
 * pushes its assigned branch and opens the pull request without a keypress, and is denied pushing
 * the base branch, force-pushing, deleting a ref, rebasing, merging, reviewing and reading a
 * credential, in every spelling a rule names; a spelling no rule names is unmatched, not denied.
 *
 * The one history rewrite it may make goes through `restore-branch GY-N EPOCH`, never a raw push:
 * the recovery of a contaminated branch resets the assigned branch to the item's reviewed
 * head, syncs it onto the base and pushes, and the rework the control plane authorizes must be
 * executable by the session it dispatches (GY-128). A permission glob cannot say "this ref and no
 * other", and a Claude worker runs under bypassPermissions, where a command no rule matches runs.
 * So every raw `--force*` push is denied, the lease push included, and the CLI makes the one lease
 * push itself: to the branch registered for the caller's live lease, conditional on the tip it
 * fetched (`--force-with-lease=refs/heads/BRANCH:TIP`), so it replaces only what it saw.
 */
/**
 * GY-853: the submission policy every worker request carries, verbatim, so the rule is stated once
 * and the launch prompt (dispatch.ts workerPrompt) delivers it to every worker runtime. Workers
 * submit when their own criteria pass: the full test suite is CI's gate, so a worker runs the
 * build and the tests for its own criteria — graphyard verify runs exactly those — and when they
 * pass it submits with complete, naming in the pull request any full-suite failures that come only
 * from its sandbox and lie outside the files it changed, instead of recording a blocker. graphyard
 * verify reports a run whose own proof cases all passed but which failed around them as left to
 * CI; a failure of a criterion's own test cases always blocks.
 */
export const submissionPolicyRule = 'The full test suite is CI\'s gate, not yours: run the build and the tests for your own criteria (graphyard verify GY-N runs exactly those), and when they pass, submit with complete, naming in the commit message any full-suite failures that come only from your sandbox and lie outside the files you changed, instead of recording a blocker; a failure of your own criteria\'s tests always blocks. ';
/** Every character an empty-source refspec's name can start with as typed: a ref name's first character, a quote, or an expansion. */
export const emptySourceStarts = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', ...'_.-/@\'"$`{~'];
/**
 * The coordinator checkout's own files, denied to a worker session's Edit and Write (GY-857).
 * That checkout runs the loop, and worker sessions once wrote their
 * half-finished work there by absolute path; a restart then loaded it. Every area the loaded
 * code lives in is denied in both files the worker reads — its worktree's settings and its role
 * file — while the worktree itself, and the managed state beside it under `.graphyard/`, stay
 * its to write. A harness rule is a prompt policy; the lease, the worktree's own Git isolation
 * and branch protection remain the enforcement.
 */
const checkoutAreas = ['src', 'tests', 'scripts', 'bin', 'docs', 'examples', 'integrations', 'web', 'browser-tests', 'design', 'deploy', 'docker'];
export function coordinatorWriteDenials(coordinatorRoot: string): HarnessRule[] {
  if (!coordinatorRoot || coordinatorRoot === '/') return [];
  const absolute = `//${coordinatorRoot.replace(/^\//, '')}`;
  const why = (area: string) => `The coordinator checkout runs the loop; this session writes only its assigned worktree, never ${area}/ there (GY-857).`;
  return checkoutAreas.flatMap(area => [{ rule: `Edit(${absolute}/${area}/**)`, why: why(area) }, { rule: `Write(${absolute}/${area}/**)`, why: why(area) }]);
}
export function workerHarnessPlan(input: { cliPath: string; branch: string; baseBranch: string; credentialHome: string }): HarnessPlan {
  const cli = `node ${input.cliPath}`;
  // GY-1835: the session opens no pull request — it submits the head with `complete GY-N EPOCH
  // --head` — so its harness allows no `gh pr` command.
  const allow: HarnessRule[] = [
    ...['status', 'sync', 'restore-branch', 'complete', 'blocked', 'heartbeat', 'events', 'diagnose'].map(command => ({ rule: `Bash(${cli} ${command}:*)`, why: `The worker's own ${command} command on its claimed item; the server checks the lease epoch.` })),
    { rule: `Bash(git push origin ${input.branch})`, why: 'Push the assigned branch; Graphyard observes it as the candidate head.' },
    { rule: `Bash(git push -u origin ${input.branch})`, why: 'Publish the assigned branch the first time.' },
    { rule: `Bash(git push origin HEAD:${input.branch})`, why: 'Push the current head to the assigned branch.' },
    { rule: 'Bash(git fetch origin)', why: 'Read the remote tips restore-branch and sync compare against.' },
    { rule: 'Bash(git reset --hard *)', why: 'Move the assigned branch back to the reviewed head before sync; it changes only this worktree.' },
    { rule: `Bash(git merge origin/${input.baseBranch})`, why: 'sync merges the base branch; the worker never rebases.' },
  ];
  // Every rewrite, in each spelling a rule can name: `--force`, `--force-with-lease` (bare or
  // `=REF:SHA`) and `--force-if-includes` alike, and the abbreviations git accepts for them. The
  // lease push of the assigned branch is restore-branch's, which checks the ref itself; no rule may
  // end in `:*` or ` *` where the bare prefix would match an allowed push, because Claude Code reads
  // both as "this prefix, with or without more". Nor may `:*` stand anywhere but at the end: Claude
  // Code skips such a rule and stops the session on a settings warning before it starts
  // (claudeRuleProblem), so the empty-source refspec is spelled once per character its name can
  // start with (` :g*`, ` :r*`, …), plus the bare ` :` that pushes every matching branch. Each rule
  // also has a twin for a push behind git's global options (`git -C DIR push`, `git -c KEY=VALUE push`).
  const push: [string, string][] = [
    ['*--force*', 'A raw force push, the lease form included, could rewrite any ref: a glob cannot limit it to the assigned branch. The one restoration push is restore-branch.'],
    ['*--f*', 'Any abbreviation git accepts for --force, --force-with-lease or --force-if-includes.'],
    ['-f*', 'Short form of a force push.'],
    ['* -f*', 'Short form of a force push.'],
    ['*-*f *', 'A force flag bundled with other short flags (-uf).'],
    ['*-*f', 'A force flag bundled with other short flags, last on the line.'],
    ['*+*', 'A leading + refspec is a force push.'],
    ['*--mirror*', 'Mirroring rewrites every ref on the remote.'],
    ['*--m*', 'An abbreviation of --mirror.'],
    ['*--all*', 'The worker pushes its assigned branch, never every branch.'],
    ['*--al*', 'An abbreviation of --all.'],
    ['*--delete*', 'Deleting a remote ref is never part of an attempt.'],
    ['*--de*', 'An abbreviation of --delete.'],
    ['*--pru*', 'Pruning deletes every remote ref the local side lacks.'],
    ['-d*', 'Short form of deleting a remote ref, alone or first in a bundle (-du).'],
    ['* -d*', 'Short form of deleting a remote ref, alone or first in a bundle (-du).'],
    ['*-*d *', 'A delete flag bundled with other short flags (-ud).'],
    ['*-*d', 'A delete flag bundled with other short flags, last on the line.'],
    ...emptySourceStarts.map((start): [string, string] => [`* :${start}*`, 'An empty source refspec deletes the ref it names, whatever the name.']),
    ['* :', 'A bare ":" refspec pushes every matching branch, the base branch included.'],
    [`*:${input.baseBranch}*`, 'The base branch moves only through the guarded merge.'],
    [`origin ${input.baseBranch}*`, 'The base branch moves only through the guarded merge.'],
    [`* ${input.baseBranch}`, 'The base branch moves only through the guarded merge.'],
    [`* ${input.baseBranch} *`, 'The base branch moves only through the guarded merge.'],
    [`*refs/heads/${input.baseBranch}*`, 'The base branch moves only through the guarded merge, in its full ref spelling too.'],
  ];
  const deny: HarnessRule[] = [
    ...push.flatMap(([form, why]) => [{ rule: `Bash(git push ${form})`, why }, { rule: `Bash(git -* push ${form})`, why: `${why} Also behind git's global options.` }]),
    ...coordinatorWriteDenials(coordinatorCheckoutRoot(input.cliPath)),
    { rule: 'Bash(git rebase:*)', why: 'sync merges the base branch; a rebase would re-resolve files already merged.' },
    { rule: 'Bash(gh pr merge:*)', why: 'Workers never merge; the control plane\'s merge gate decides.' },
    { rule: 'Bash(gh pr review:*)', why: 'Workers never review their own work.' },
    { rule: 'Bash(*GRAPHYARD_TOKEN_FILE=*)', why: 'A worker acts only as its own principal.' },
    { rule: `Read(//${input.credentialHome}/**)`, why: 'Credentials are used through the CLI, never read into a transcript.' },
    { rule: 'Read(**/*.token)', why: 'Token files are never read into a session transcript.' },
  ];
  return { harness: 'claude', file: '.claude/settings.local.json', allow, deny, manual: null, note: 'Worker rules for one assigned worktree: its own commands and its own branch. A harness rule is a prompt policy; branch protection, leases and the merge gate remain the enforcement.' };
}
/**
 * How a worker restores its assigned branch after it was contaminated, as the exact
 * commands a rework reason carries: fetch, reset to the item's reviewed head, sync onto the base,
 * restore-branch (the lease push of the leased branch), complete. Every one is permitted by the
 * worker's own harness, so the rework the control plane authorizes is carried out by the attempt it
 * dispatches, with no human shell.
 */
export function branchRestoration(input: { cliPath: string; key: string; epoch: number; pr: number; reviewedHead: string }) {
  const cli = `node ${input.cliPath}`;
  return ['git fetch origin', `git reset --hard ${input.reviewedHead}`, `${cli} sync ${input.key}`, `${cli} restore-branch ${input.key} ${input.epoch}`, `${cli} complete ${input.key} ${input.epoch} ${input.pr}`];
}
/**
 * The shell commands a blocker names: each backtick-quoted command line, or, in a blocker that
 * quotes none, each `git push …` clause. The worker's blocker instruction asks for the exact
 * command that was refused, so this is where it is written.
 */
export function blockerCommands(text: string) {
  const quoted = [...text.matchAll(/`([^`\n]+)`/g)].map(match => match[1].trim()).filter(command => /^[a-z][\w.-]*\s+\S/.test(command));
  const found = quoted.length ? quoted : [...text.matchAll(/\bgit push\b[^\n;,'"]*/g)].map(match => match[0].replace(/\s+(?:was|were|is|failed|fails|because|but)\b.*$/, '').trim().replace(/[.:]$/, ''));
  return [...new Set(found)];
}
export interface UnrunnableRemedy { key: string; epoch: number; command: string; role: 'worker'; rule: string; why: string; deniedBy: { role: string; rule: string }[]; text: string }
/**
 * A blocker whose remedy no session Graphyard launches may run is a defect of Graphyard, not a
 * wait on a human shell (GY-128): Graphyard authorized work that none of its own sessions can
 * carry out. Every command a blocker names is judged against each launched role's harness —
 * the item's worker on its assigned branch, reviewer, producer and master — and reported when
 * every one of them denies it, naming the command, the role that would need it (the worker that
 * raised the blocker) and the rule in that role's harness that denies it.
 */
export function unrunnableRemedies(work: Work[], input: { cliPath: string; baseBranch: string; repository?: string; workerKinds?: string[] }): UnrunnableRemedy[] {
  const shared = { cliPath: input.cliPath, repository: input.repository ?? 'OWNER/REPOSITORY', baseBranch: input.baseBranch, credentialHome: '/graphyard-credentials', credentialDirectories: [] as string[] };
  const others = [
    { role: 'reviewer', plan: sessionHarnessPlan({ ...shared, role: 'reviewer', kind: 'claude' }) },
    { role: 'producer', plan: sessionHarnessPlan({ ...shared, role: 'producer', kind: 'claude' }) },
    { role: 'master', plan: masterHarnessPlan({ ...shared, harness: 'claude', root: '/repository' }) },
  ];
  // A worker runtime other than Claude loads no generated rules, so a rework dispatched to it may
  // run the command: only when every configured worker runtime denies it is the remedy unrunnable.
  const workerKinds = [...new Set(input.workerKinds?.length ? input.workerKinds : ['claude'])];
  if (workerKinds.some(kind => kind !== 'claude')) return [];
  return work.filter(item => item.stage !== 'done' && item.blocker).flatMap(item => {
    const epoch = item.workspaces.at(-1)?.epoch ?? item.epoch;
    const branch = item.workspaces.at(-1)?.branch ?? `graphyard/${item.key.toLowerCase()}-${epoch}`;
    const worker = sessionHarnessPlan({ ...shared, role: 'worker', kind: 'claude', branch });
    return blockerCommands(item.blocker!).flatMap(command => {
      const own = harnessDecision(worker, command);
      if (own.decision !== 'deny') return [];
      const deniedBy = others.map(({ role, plan }) => ({ role, judged: harnessDecision(plan, command) }));
      if (deniedBy.some(entry => entry.judged.decision !== 'deny')) return [];
      return [{ key: item.key, epoch, command, role: 'worker' as const, rule: own.rule!.rule, why: own.rule!.why,
        deniedBy: deniedBy.map(entry => ({ role: entry.role, rule: entry.judged.rule!.rule })),
        text: `${item.key}'s blocker names \`${command}\`, which no session Graphyard launches may run: the worker that needs it is denied by its harness rule ${own.rule!.rule} (${own.rule!.why}), and ${deniedBy.map(entry => `the ${entry.role} by ${entry.judged.rule!.rule}`).join(', ')}. This is a Graphyard defect, not a wait on a human shell` }];
    });
  });
}
/** Install the worker rules in a freshly prepared worktree, only where Git already ignores them. */
export async function installWorkerHarness(config: MasterConfig, profile: WorkerProfile, key: string, prepared: PreparedWorker) {
  // GY-857: a profile whose own settings would turn its runtime's write confinement off is
  // refused here, at the launch, whatever its kind — the worker never starts able to write
  // outside its assigned worktree.
  const refusal = workerConfinementRefusal(profile);
  if (refusal) throw new Error(refusal);
  if (profile.kind !== 'claude') return { applied: false, reason: `No generated worker rules for ${profile.kind}` };
  try { await defaultChildRun('git', ['check-ignore', '--quiet', '--', '.claude/settings.local.json'], { cwd: prepared.path }); }
  catch { return { applied: false, reason: 'The worktree does not ignore .claude/settings.local.json, so no rules were written into it' }; }
  const plan = workerHarnessPlan({ cliPath: config.cliPath, branch: `graphyard/${key.toLowerCase()}-${prepared.epoch}`, baseBranch: config.baseBranch, credentialHome: dirname(dirname(config.credentialFile)) });
  const written = await writeHarnessPermissions(prepared.path, plan, true);
  return { applied: written.applied, reason: null, added: written.added.length };
}
