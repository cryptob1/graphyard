// Concern: session and worker harness permissions, and starting the master session.
import { lstat, mkdir } from 'node:fs/promises';
import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { type ChildRun, defaultChildRun } from '../child-runner.js';
import { nameForLaunch } from '../session-name.js';
import { executorUnitDirectory, launchAuthorization } from '../repository-setup.js';
import { type HarnessHook, type HarnessPlan, type HarnessRule, writeHarnessPermissions, mergeHarnessHooks, masterHarnessPlan, harnessDecision, claudeRuleProblem, bashRuleMatches } from '../harness.js';
import { executorInstance, legacyLoopUnit, readInstallUnits } from '../install/units.js';
import type { Work } from '../model.js';
import type { MasterConfig, WorkerProfile } from './profiles.js';
import { coordinatorCheckoutRoot, workerConfinementRefusal } from './profiles.js';
import { atomicPrivateText, loadMasterConfig } from './config.js';
import { accountLaunch } from './environments.js';
import { type RequestDelivery, startAgentSession } from './launch.js';
import { createdHerdrTab, type HerdrAgent, herdrJson, stopCreatedHerdrTab } from './herdr.js';
import type { PreparedWorker } from './dispatch.js';
import { worktreeRoot } from '../install/worktree-root.js';
import { scopeGuardCommand, scopeGuardMatcher } from '../scope-guard.js';
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
 * a second install can never restart another install's loop or executors. A glob cannot say "every
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
  const why = 'Another Graphyard installation on this host owns this unit; restarting, stopping or enabling it would disrupt that install\'s loop or executors (GY-1441).';
  const shapes = units.alias ? ['graphyard-master-*', 'graphyard-executor-*'] : [`${legacyLoopUnit}*`, 'graphyard-master', 'graphyard-executor@*'];
  const others: string[] = [];
  try {
    for (const name of readdirSync(unitDirectory)) {
      if (name === master || name === units.executorTemplate) continue;
      if (/^graphyard-master[A-Za-z0-9._-]*\.service$/.test(name)) others.push(name, `${name} *`, name.replace(/\.service$/, ''));
      else if (/^graphyard-executor[A-Za-z0-9._-]*@\.service$/.test(name)) others.push(name.replace('@.service', '@*'));
    }
  } catch { /* no unit directory: only the structural shapes apply */ }
  const own = [...allow.map(entry => /^Bash\((.*)\)$/.exec(entry.rule)![1].replace(/:\*$/, '')), ...[1, 2, 32].map(slot => `systemctl --user restart ${executorInstance(units, slot)}`)];
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
export type SessionRole = 'worker' | 'reviewer' | 'producer' | 'docs-sync';
export interface SessionHarnessInput { role: SessionRole; kind: string | undefined; cliPath: string; repository: string; baseBranch: string; credentialHome: string; credentialDirectories: string[]; branch?: string; pr?: number;
  /** A worker's own item and epoch, which its scope-guard hook names (GY-1494). */
  key?: string; epoch?: number;
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
  let allow: HarnessRule[], deny: HarnessRule[], hooks: HarnessHook[] = [];
  if (input.role === 'worker') {
    if (!input.branch) throw new Error('A worker harness names the assigned branch it may push');
    // The same worker rules installWorkerHarness writes into the worktree, plus the shared secret
    // and verdict denies: loaded through --settings they apply even though the worktree's own
    // settings file is not loaded.
    const worker = workerHarnessPlan({ cliPath: input.cliPath, branch: input.branch, baseBranch: input.baseBranch, credentialHome: input.credentialHome, key: input.key, epoch: input.epoch });
    hooks = worker.hooks ?? [];
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
  } else if (input.role === 'docs-sync') {
    if (!input.branch) throw new Error('A docs-sync harness names the item branch it may push');
    const push = `git push ${docsSyncPushTarget(input.branch)}`;
    allow = [
      { rule: 'Bash(git merge:*)', why: 'Merge the conflicting base tip into the reviewed head, or abort that merge.' },
      { rule: 'Bash(git add:*)', why: 'Stage the resolved docs pages.' },
      { rule: 'Bash(git commit:*)', why: 'Commit the resolved merge.' },
      { rule: `Bash(${push})`, why: 'Push the resolved merge to the item\'s own branch: a plain push, never forced, refused by GitHub when the branch moved.' },
      { rule: 'Bash(npm ci)', why: 'Install dependencies when the checkout has none linked.' },
      { rule: 'Bash(npm test:*)', why: 'Rerun the docs obligation and word-budget tests.' },
    ];
    const forced = workerHarnessPlan({ cliPath: input.cliPath, branch: input.branch, baseBranch: input.baseBranch, credentialHome: input.credentialHome }).deny
      .filter(entry => entry.rule.startsWith('Bash(git push ') || entry.rule.startsWith('Bash(git -* push '));
    deny = [...secrets, ...noVerdict, ...forced, ...docsSyncPushDenials(input.branch).filter(entry => !forced.some(existing => existing.rule === entry.rule)),
      { rule: 'Bash(git rebase:*)', why: 'The session merges the base tip; a rebase would rewrite the reviewed history.' },
      ...['claim', 'complete', 'evidence'].map(command => ({ rule: `Bash(${cli} ${command}:*)`, why: `A docs-sync session never runs ${command}: the control plane observes the pushed head and runs the proofs again.` })),
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
  return { harness: 'claude', file: null, allow, deny, manual: null, ...(hooks.length ? { hooks } : {}), note: `Role-scoped ${input.role} rules; the session loads these and the operator's user settings, never the repository's project or local settings where the master's rules live.` };
}

/** The one push a docs-sync session makes, after `git push`: the resolved merge to the item's own branch. */
export const docsSyncPushTarget = (branch: string) => `origin HEAD:refs/heads/${branch}`;
/**
 * Denies every `git push` but the docs-sync session's own one, in each spelling a rule can name. A
 * permission glob cannot say "this ref and no other", and the session runs under bypassPermissions,
 * where an unmatched command runs; so the push is fenced by where its text departs from the own
 * command: a character the own command never contains, anywhere (`*` excepted: a rule cannot name
 * it, and Git refuses a refspec whose destination alone is a pattern); a different character at any
 * position; text after the own refspec; a strict prefix (a shorter branch name); a flag or a push
 * behind git's global options. A `:` followed by `*` would read as Claude Code's prefix marker
 * (claudeRuleProblem), so a departure to `:` is spelled out one character further.
 */
export function docsSyncPushDenials(branch: string): HarnessRule[] {
  const own = docsSyncPushTarget(branch);
  const used = new Set(own), afterColon = own[own.indexOf(':') + 1];
  const why = 'A docs-sync session pushes only its resolved merge to the item\'s own branch.';
  const rules = new Map<string, HarnessRule>();
  const add = (body: string, reason = why) => { const rule = `Bash(git push${body ? ` ${body}` : ''})`; if (!claudeRuleProblem(rule) && !rules.has(rule)) rules.set(rule, { rule, why: reason }); };
  add('', 'A bare push reaches the upstream or every matching branch.');
  rules.set('Bash(git -* push*)', { rule: 'Bash(git -* push*)', why: `${why} Never behind git's global options.` });
  // A character the own command never contains, anywhere. A backslash is among them: bash drops
  // the escape, so `refs/heads/\main` would otherwise reach the base ref through a text no rule names.
  for (const character of new Set([...emptySourceStarts, ...'+=,%^#!?[]}\\<>()\t'])) if (!used.has(character)) add(`*${character}*`, `${why} The own push never contains ${JSON.stringify(character)}.`);
  // A colon followed by anything but what follows the own one (a rule may not put `*` right after `:`).
  for (const character of used) if (character !== afterColon && character !== ':' && character !== ' ') add(`*:${character}*`);
  add('*:'); add('*: *');
  for (let index = 0; index <= own.length; index++) {
    const prefix = own.slice(0, index);
    if (index > 0 && index < own.length && !prefix.endsWith(' ')) add(prefix, `${why} A shorter refspec names another ref.`);
    for (const character of used) {
      if (character === own[index]) continue;
      if (character === ':') add(`${prefix}:${afterColon}*`);
      else if (character !== ' ') add(`${prefix}${character}*`);
      else if (index > 0 && index < own.length && !prefix.endsWith(' ')) add(`${prefix} *`, `${why} Arguments after this point name another ref.`);
    }
  }
  // After the own refspec nothing follows: `OWN *` would read as a prefix rule matching the push itself.
  for (const character of used) if (character !== ' ' && character !== ':') add(`${own} *${character}*`, `${why} Nothing follows the own refspec.`);
  return [...rules.values()];
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
  await atomicPrivateText(file, `${JSON.stringify({ permissions: { allow: plan.allow.map(entry => entry.rule), deny: plan.deny.map(entry => entry.rule) },
    ...(plan.hooks?.length ? { hooks: mergeHarnessHooks({}, plan.hooks) } : {}) }, null, 2)}\n`);
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
  const prompt = `You are the dedicated Graphyard master agent for ${config.repository}. Do not implement product work, claim worker leases, submit evidence, weaken requirements, or bypass gates. Read AGENTS.md, run node ${config.cliPath} master guide, then run node ${config.cliPath} master status. Use Graphyard as assignment and progression truth and Herdr only for session health and control. Route ready work to configured worker profiles, require workers to claim for themselves, preserve handoffs, and leave dispatch, review, proof production and routine merge of system-driven items (every item not created with "systemDriven": false) to node ${config.cliPath} master run, whose loop performs each; the master CLI refuses those hand actions on them. The loop drives an item created with "systemDriven": false the same way; opting out only also allows those hand actions, so take one only where master status shows the loop has not, and merge by hand only through graphyard master merge after every exact-candidate gate passes. Act without asking: only goals and priorities, spending money or opening third-party accounts, and issuing credentials to people belong to the human. Create, release, unblock and add requirements with node ${config.cliPath} master create, release, unblock, or requirements; request every other decision with node ${config.cliPath} master decide GY-N ACTION REASON and launch its independent approver with node ${config.cliPath} master approver GY-N DECISION.${config.operatorAgent ? '' : ` Your operator-agent and approver identities are not provisioned yet; report that onboarding must run node ${config.cliPath} master autonomy --admin-token-stdin --apply once.`}`;
  const reviewInstruction = config.reviewer
    ? `Independent review and proof collection start on their own: when a candidate passes the build gate the control plane records a review request and producer requests bound to its exact head, and node ${config.cliPath} master run launches the reviewer identity ${config.reviewer.slug}[bot] and one producer session per proof group for them within 30 seconds. Read the findings, route rework, and merge; never launch reviews or producers by hand, never review a candidate yourself, and never submit evidence. master status shows what is running per candidate and since when, and node ${config.cliPath} master review GY-N is only the recovery of a review request the loop has stopped relaunching: its session settled without answering it, its automatic sessions are exhausted, or its launch reached the dispatch failure limit with no request-review row still queued; on a system-driven item it is refused before then.`
    : `No reviewer identity is registered yet. Run node ${config.cliPath} master reviewer setup before routing work that needs independent review; once it is registered, master run launches reviews and producers for every submitted head on its own. Never approve a candidate yourself.`;
  const administrationInstruction = config.browser
    ? `GitHub administration of ${config.repository} is yours: reconcile protection with node ${config.cliPath} master protection --apply, and when only a GitHub page can do it run node ${config.cliPath} master browser app-permissions, installation-accept, or protection, which drive the operator's browser profile ${config.browser.profile} headless, record every step, verify through the API, and append an audit entry. Report a pending sudo code from master status; the operator only approves it on their device. Never ask the operator to click through what those flows cover.`
    : `No browser profile is configured, so App permission updates, installation acceptance, and page-only protection changes are not yet yours: master status records that as a setup attention item owned by the operator, naming node ${config.cliPath} master init --token-stdin --browser-profile PROFILE as what makes them yours. Never ask the operator for it in chat; leave that item to master status and keep routing the rest of the work.`;
  const mergeInstruction = `GitHub merges: a pull request whose build, review and required checks pass on its head is merged by GitHub on its branch protection, and the loop's merge step only records what GitHub merged. There is no Graphyard merge to run; a merge of a head whose gates had not passed is held as a violation until a two-party merge decision reconciles it.`;
  return `${prompt} ${reviewInstruction} ${administrationInstruction} ${mergeInstruction}`;
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
    // The master is not one of the confined roles (GY-888): it runs the loop's own configuration,
    // administration and browser-flow commands from the coordinator root, and its harness rules
    // above remain what bounds it. Every other launched session carries the OS-level confinement.
    ({ delivery } = await startAgentSession(name, kind, created.pane, launch.args, masterPrompt(config), run, { directory: root, confirm: 'follow', retry: masterRetry, environment: launch.environment, confinement: false }));
  } catch (error) {
    const malformedTab = (error as any)?.herdrTab as string | undefined;
    if (pane || tabId || malformedTab) try { await stopCreatedHerdrTab(pane, tabId ?? malformedTab, run); }
    catch { throw new Error(`${error instanceof Error ? error.message : 'Master startup failed'}; Herdr could not confirm cleanup of the created tab`); }
    throw error;
  }
  return { agentName: name, kind, pane: pane!, status: delivery === 'request' ? 'started on its request' : 'started and prompted', delivery, focusChanged: false, harness };
}

// ---- Autonomy ----------------------------------------------------------------------------------
// Humans set goals; agents run the loop. Everything a human used to approve is either the master's
// own operator-agent capability (non-weakening intent) or a two-party decision that a separate
// approver agent approves. What stays human is this list, and nothing else.
export const humanOnlyDecisions = ['goals and priorities', 'spending money or opening third-party accounts', 'issuing credentials to people'] as const;
export const masterOperatorCapabilities = ['intent:create', 'intent:ready', 'intent:unblock', 'policy:requirements', 'policy:review-provider',
  'decision:resolve', 'decision:attest', 'decision:merge', 'decision:rework', 'decision:grant'] as const;
export const approverAgentCapabilities = ['decision:approve'] as const;
export const autonomyReason = 'Master autonomy onboarding: agent identities for the master and its independent approver';

/** The two agent identities onboarding provisions, and where their credentials live. */
export function autonomyPlan(config: MasterConfig) {
  const name = config.repository.split('/').at(-1)!.replace(/[^a-zA-Z0-9._-]/g, '-');
  const directory = dirname(config.credentialFile), stem = basename(config.credentialFile, '.token');
  const scope = { repositories: [config.repository], workItems: ['*'] };
  return {
    operatorAgent: { id: config.operatorAgent?.id ?? `graphyard-master-${name}-operator`.slice(0, 100), displayName: `Graphyard master for ${config.repository}`.slice(0, 100), capabilities: [...masterOperatorCapabilities], scope,
      credentialFile: config.operatorAgent?.credentialFile ?? resolve(directory, `${stem}-operator.token`), role: 'Requests two-party decisions and applies non-weakening intent (create, release, unblock, add requirements) alone' },
    approver: { id: config.approver?.id ?? `graphyard-approver-${name}`.slice(0, 100), displayName: `Graphyard approver for ${config.repository}`.slice(0, 100), capabilities: [...approverAgentCapabilities], scope,
      credentialFile: config.approver?.credentialFile ?? resolve(directory, `${stem}-approver.token`), role: 'Approves the master\'s decisions from its own session; never requests, implements, or produces evidence' },
  };
}

/** Rules every master session gets on top of its loop rules: it cannot borrow another identity. */
const autonomyDeny = (credentialHome: string): HarnessRule[] => [
  { rule: 'Bash(*GRAPHYARD_TOKEN_FILE=*)', why: 'The master acts only as its own identities; pointing a command at the approver\'s or a worker\'s credential file would let one agent approve its own decision.' },
  { rule: 'Bash(*GRAPHYARD_APPROVER=*)', why: 'Only a launched approver session carries the approver marker; the master never claims it.' },
  { rule: `Edit(//${credentialHome}/**)`, why: 'Agent credentials are issued by onboarding and rotated through the API, never edited in place.' },
];
export function masterHarness(root: string, config: MasterConfig, harness: string, options: { unitDirectory?: string } = {}) {
  const credentialHome = dirname(dirname(config.credentialFile));
  const plan = withMasterOwnedRules(masterHarnessPlan({ harness, root, cliPath: config.cliPath, repository: config.repository, baseBranch: config.baseBranch, credentialHome }), config, root, options.unitDirectory ?? executorUnitDirectory());
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
 * from its sandbox and lie outside its planned files, instead of recording a blocker. graphyard
 * verify reports a run whose own proof cases all passed but which failed around them as left to
 * CI; a failure of a criterion's own test cases always blocks.
 */
export const submissionPolicyRule = 'The full test suite is CI\'s gate, not yours: run the build and the tests for your own criteria (graphyard verify GY-N runs exactly those), and when they pass, submit with complete, naming in the pull request any full-suite failures that come only from your sandbox and lie outside your planned files, instead of recording a blocker. graphyard verify reports a run whose own proof cases all passed but which failed around them as left to CI; a failure of your own criteria\'s tests always blocks. ';
/** Every character an empty-source refspec's name can start with as typed: a ref name's first character, a quote, or an expansion. */
export const emptySourceStarts = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', ...'_.-/@\'"$`{~'];
/**
 * The coordinator checkout's own files, denied to a worker session's Edit and Write (GY-857).
 * That checkout runs the loop and the executors, and worker sessions once wrote their
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
  const why = (area: string) => `The coordinator checkout runs the loop and the executors; this session writes only its assigned worktree, never ${area}/ there (GY-857).`;
  return checkoutAreas.flatMap(area => [{ rule: `Edit(${absolute}/${area}/**)`, why: why(area) }, { rule: `Write(${absolute}/${area}/**)`, why: why(area) }]);
}
/**
 * GY-1494. The worker's scope guard: before every file edit Claude Code runs scope-guard for the
 * worker's own item and epoch, which denies an edit complete would refuse as outside plannedFiles
 * and names the scope-request command. Its read is bounded at five seconds and it fails open.
 */
export const scopeGuardHook = (cliPath: string, key: string, epoch: number): HarnessHook => ({ event: 'PreToolUse', matcher: scopeGuardMatcher, command: scopeGuardCommand(cliPath, key, epoch), timeout: 30,
  why: 'Deny an edit outside plannedFiles when it happens, naming scope-request, instead of at complete; complete stays the authority.' });
export function workerHarnessPlan(input: { cliPath: string; branch: string; baseBranch: string; credentialHome: string; key?: string; epoch?: number }): HarnessPlan {
  const cli = `node ${input.cliPath}`;
  const allow: HarnessRule[] = [
    ...['status', 'sync', 'restore-branch', 'complete', 'blocked', 'heartbeat', 'events', 'diagnose'].map(command => ({ rule: `Bash(${cli} ${command}:*)`, why: `The worker's own ${command} command on its claimed item; the server checks the lease epoch.` })),
    { rule: `Bash(git push origin ${input.branch})`, why: 'Push the assigned branch; Graphyard observes it as the candidate head.' },
    { rule: `Bash(git push -u origin ${input.branch})`, why: 'Publish the assigned branch the first time.' },
    { rule: `Bash(git push origin HEAD:${input.branch})`, why: 'Push the current head to the assigned branch.' },
    { rule: 'Bash(git fetch origin)', why: 'Read the remote tips restore-branch and sync compare against.' },
    { rule: 'Bash(git reset --hard *)', why: 'Move the assigned branch back to the reviewed head before sync; it changes only this worktree.' },
    { rule: 'Bash(gh pr create:*)', why: 'Open the pull request the worker submits with complete.' },
    { rule: 'Bash(gh pr view:*)', why: 'Read the pull request number and state before submitting.' },
    { rule: 'Bash(gh pr checks:*)', why: 'Read CI results for the worker\'s own candidate.' },
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
    { rule: 'Bash(git rebase:*)', why: 'sync merges the base branch; a rebase would re-resolve files outside the planned files.' },
    { rule: 'Bash(gh pr merge:*)', why: 'Workers never merge; the control plane\'s merge gate decides.' },
    { rule: 'Bash(gh pr review:*)', why: 'Workers never review their own work.' },
    { rule: 'Bash(*GRAPHYARD_TOKEN_FILE=*)', why: 'A worker acts only as its own principal.' },
    { rule: `Read(//${input.credentialHome}/**)`, why: 'Credentials are used through the CLI, never read into a transcript.' },
    { rule: 'Read(**/*.token)', why: 'Token files are never read into a session transcript.' },
  ];
  const hooks = input.key && input.epoch ? [scopeGuardHook(input.cliPath, input.key, input.epoch)] : [];
  return { harness: 'claude', file: '.claude/settings.local.json', allow, deny, manual: null, ...(hooks.length ? { hooks } : {}), note: 'Worker rules for one assigned worktree: its own commands and its own branch. A harness rule is a prompt policy; branch protection, leases and the merge gate remain the enforcement.' };
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
  const plan = workerHarnessPlan({ cliPath: config.cliPath, branch: `graphyard/${key.toLowerCase()}-${prepared.epoch}`, baseBranch: config.baseBranch, credentialHome: dirname(dirname(config.credentialFile)), key, epoch: prepared.epoch });
  const written = await writeHarnessPermissions(prepared.path, plan, true);
  return { applied: written.applied, reason: null, added: written.added.length };
}
