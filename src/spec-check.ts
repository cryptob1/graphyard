// Concern: GY-2992 — the spec check's launcher, prompt and session. When a released feature item
// owes its spec check, the loop launches one session under a reviewer identity, fresh context: a
// goldfish with no conversation history and no filer's knowledge, reading only the item and the
// files and docs it names, answering in one report through `spec-check post`. The reviewer prompts
// it judges by are vendored from Google's Elephant-Goldfish Model (Apache-2.0) under vendor/egm/,
// rather than installed as a plugin; the report gates dispatch (model/spec-check.ts).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildRun } from './child-runner.js';
import type { FleetProbe } from './fleet.js';
import type { SandboxExec } from './worker-sandbox.js';
import {
  accountLaunch, allocateManagedCheckout, autonomousSession, closeHerdrPane, createdHerdrTab,
  herdrJson, launchStartMs, loadMasterConfig, onSelectedSession, prepareSessionHarness, readCredentialFile,
  profileAtLimit, profileSessions, selectAccount, sessionAgentName, startAgentSession,
  type PromptDelivery, type StartBounds,
} from './master.js';
import { selectReviewerProfile } from './auto-dispatch.js';
import { anchorSessionCheckout as anchorCheckout, readReviewLedger, reviewerCredentialDirectory, sessionWritable, simplicityParagraph, verifySessionSandbox } from './reviewer.js';
import { withVerificationPath } from './master/verification-slots.js';
import { credentialMaskFor } from './master/confinement.js';
import { runtimeLoginHomes } from './master/profiles.js';
import { writeSpecCheckBinding } from './spec-check-post.js';
import { needsSpecCheck, specCheckCurrent, specCheckLaunchMs } from './model/spec-check.js';
import type { Work } from './model.js';

/** The vendored EGM reviewer prompts, read from the Graphyard install that runs the loop — never the managed project, which carries none. */
export async function readVendorPrompts(): Promise<{ comprehension: string; readiness: string }> {
  const read = async (file: string) => {
    const path = fileURLToPath(new URL(`../vendor/egm/${file}`, import.meta.url));
    try { return await readFile(path, 'utf8'); }
    catch { throw new Error(`The vendored Elephant-Goldfish prompt ${path} is missing from this Graphyard install; restore it to launch a spec check`); }
  };
  return { comprehension: await read('egm-comprehension.md'), readiness: await read('egm-implementation-readiness.md') };
}

/**
 * The spec-check request: the item in full, the two vendored EGM reviewer prompts, and the one
 * report to post. `worktree` and `baseTip` name the detached checkout the session makes of the
 * base branch tip, where the item's named files are read as they stand before any worker starts.
 */
export function specCheckPrompt(config: { repository: string; cliPath?: string; baseBranch: string }, work: Work, vendor: { comprehension: string; readiness: string }, worktree?: string, baseTip?: string): string {
  const criteria = work.criteria.map(criterion => `[${criterion.id}] ${criterion.text} (proofs: ${criterion.proofs.join(', ')})`).join(' ');
  const read = worktree && baseTip
    ? `The item names files and docs; read them from a detached checkout of the base branch tip, created only at the path Graphyard allocated for this session under its managed worktree root and never under a temporary directory: git fetch --no-write-fetch-head origin ${config.baseBranch} && git worktree add --detach ${worktree} ${baseTip}. Read there and change nothing; Graphyard removes its checkout when this session ends. `
    : 'Judge the item from its text alone; no checkout is allocated. ';
  return `You are the Graphyard spec checker for ${config.repository}: a fresh-context reviewer restating the released feature item ${work.key} (policy revision ${work.policyRevision}) and naming its gaps before a worker starts, so design faults surface before code. You have no conversation history and none of the filer's context: judge exactly what the item says, nothing else. `
    + `The item, in full. Title: ${work.title}. Type: ${work.type}. Description: ${work.description || '(none)'} Acceptance criteria: ${criteria || '(none)'} Dependencies: ${work.dependencies.length ? work.dependencies.join(', ') : 'none'}. `
    + read
    + `Judge by these two Elephant-Goldfish Model reviewer prompts, vendored from github.com/google/elephant-goldfish-model (Apache-2.0), applied to the item as the document under audit:\n\n===== vendored: egm-comprehension =====\n${vendor.comprehension.trim()}\n\n===== vendored: egm-implementation-readiness =====\n${vendor.readiness.trim()}\n\n`
    + `Answer in exactly one report: (1) the comprehension test — your paraphrase of what will be built and how each acceptance criterion will be proven; (2) the implementation-readiness gaps — ambiguous or contradictory criteria, a proof that cannot fail or cannot run, a missing dependency, a file the change will need that the item does not name; (3) the verdict — ready when a worker can start as the item stands, gaps when any gap stands. `
    + `Post it as this session's one action, only through Graphyard: node ${config.cliPath} spec-check post --verdict ready|gaps --paraphrase "YOUR PARAPHRASE" [--gap "ONE GAP" ...]. A gaps verdict needs at least one --gap; a ready verdict takes none. The paraphrase and gaps become the item's spec check and show on its dashboard panel. `
    + 'This session is read-only: do not edit, stage, commit, push, rebase, or merge anything, do not run the project\'s build, tests, or servers, do not claim Graphyard work, and do not submit evidence. '
    + `Posting that report is granted to this session's role, not a permission to request: post it as soon as you have judged the item, without asking for confirmation. `
    + `The post sends it to the Graphyard control plane at GRAPHYARD_URL with this launch's one-time token from GH_CONFIG_DIR. `
    + 'Once posted, stop; Graphyard closes this session once it observes your report. '
    + `${simplicityParagraph}`
    + autonomousSession('post the report yourself, --verdict ready or --verdict gaps, as soon as you have judged the item', 'record a blocker as a final line starting BLOCKED:');
}

/** What a launch hands the loop back, recorded beside the launch action. */
export interface SpecCheckLaunchResult { work: string; profile: string; agentName: string; reviewer: string; pane: string | null; checkout: string | null; tokenExpiresAt: string }

/**
 * `launchSpecCheck` — the loop's one fresh-context reviewer session for a released feature item's
 * spec check (GY-2992). Registers the launch on the item (one stands per item, so no second
 * session launches while it stands), allocates the checkout of the base branch tip the session
 * reads named files from, and starts the reviewer session with the vendored EGM prompts.
 */
export async function launchSpecCheck(root: string, work: Work, profileName: string | undefined, agents: { name?: string }[], observedAt: string, dependencies: {
  run?: ChildRun; probe?: FleetProbe; prompt?: PromptDelivery; start?: StartBounds; sandbox?: SandboxExec;
  registerLaunch?: (work: Work, launch: { reviewer: string; tokenHash: string; expiresAt: string; policyRevision: number }) => Promise<{ launch: string }>;
} = {}): Promise<SpecCheckLaunchResult> {
  const now = Date.parse(observedAt);
  if (!Number.isFinite(now)) throw new Error('A spec-check launch requires a valid Graphyard snapshot clock');
  if (!needsSpecCheck(work)) throw new Error(`${work.key} owes no spec check: bugs and chores skip it`);
  if (specCheckCurrent(work)) throw new Error(`${work.key}'s spec check already reported for policy revision ${work.policyRevision}`);
  const config = await loadMasterConfig(root);
  const { profile, reason } = profileName
    ? (selected => selected ? { profile: selected, reason: null } : { profile: null, reason: `no configured reviewer profile is named ${profileName}` })(config.reviewers.find(item => item.name === profileName))
    : selectReviewerProfile(config, 'control-plane');
  if (!profile) throw new Error(`No reviewer profile to launch ${work.key}'s spec checker from: ${reason}. Write one with graphyard master environments --apply`);
  // A spec checker takes one of the reviewer profile's sessions: its pending reviews and live panes hold the rest.
  const sessions = profileSessions(profile, agents, (await readReviewLedger(root)).reviews);
  if (!sessions.free) throw new Error(`${profileAtLimit('Reviewer', profile, sessions)}; ${work.key}'s spec check launches when a session ends`);
  const run = dependencies.run;
  // The base branch tip the dispatch cycle last fetched: what the item's named files look like before any worker starts.
  let baseTip: string;
  try {
    baseTip = String(await Promise.resolve(run?.('git', ['-C', root, 'rev-parse', '--verify', `refs/remotes/origin/${config.baseBranch}^{commit}`]))).trim();
    if (!/^[0-9a-f]{40}$/.test(baseTip)) throw new Error(`git rev-parse refs/remotes/origin/${config.baseBranch} answered ${baseTip || 'nothing'}`);
  } catch (error) { throw new Error(`Reading the base branch tip for ${work.key}'s spec check failed: ${error instanceof Error ? error.message : String(error)}`); }
  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
  const expiresAt = new Date(now + specCheckLaunchMs).toISOString();
  const checkout = await allocateManagedCheckout(root, config, 'review', work.key, baseTip, id);
  try { await anchorCheckout(root, checkout.directory, run); } catch { /* the session still starts */ }
  const agentName = sessionAgentName(profile, { id });
  if (agents.some(agent => agent.name === agentName)) throw new Error(`Reviewer agent ${agentName} is already visible in Herdr; the spec-check launch is retried next cycle`);
  const selected = await selectAccount(config, 'reviewer', profile, { ...dependencies.probe, work: work.key });
  return onSelectedSession(selected, `spec-check launch for ${work.key} failed`, async () => {
    let pane: string | null = null;
    const sessionDirectory = resolve(reviewerCredentialDirectory(config), 'sessions', id);
    try {
      // The control plane registers the launch before the session starts: the reviewer, the token
      // hash, the expiry. A launch it refuses starts nothing and writes no credential.
      await (dependencies.registerLaunch ?? registerControlPlaneLaunch(config))(work, { reviewer: profile.agentName, tokenHash, expiresAt, policyRevision: work.policyRevision });
      await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
      await writeSpecCheckBinding(sessionDirectory, { repository: config.repository, key: work.key, workId: work.id, policyRevision: work.policyRevision, reviewer: profile.agentName, url: config.url, token });
      const writable = await sessionWritable(root, config, checkout.directory);
      const launch = accountLaunch(profile, selected.account, { writable });
      const harness = await prepareSessionHarness(root, config, { role: 'reviewer', kind: launch.kind, profile: profile.name, checkout: checkout.worktree });
      // The same mask every reviewer launch runs under: the operator's config home and the loop's credentials stay hidden.
      const credentialMask = credentialMaskFor(config, { runtimeHomes: runtimeLoginHomes(launch.environment, launch.contract?.homeVariable) });
      await verifySessionSandbox('reviewer', { ...launch, args: [...launch.args, ...harness.args] }, checkout.directory, writable, dependencies.sandbox, true, credentialMask);
      const environment = { ...withVerificationPath(harness.environment, launch.environment), GH_CONFIG_DIR: sessionDirectory, GRAPHYARD_URL: config.url, GRAPHYARD_SPEC_CHECK: work.key };
      const created = createdHerdrTab(await herdrJson(['tab', 'create', ...(config.herdrWorkspace ? ['--workspace', config.herdrWorkspace] : []), '--cwd', checkout.directory,
        '--label', `${work.key} spec check · ${agentName}`, ...Object.entries(environment).flatMap(([name, value]) => ['--env', `${name}=${value}`]), '--no-focus'], run));
      pane = created.pane;
      await startAgentSession(agentName, launch.kind!, created.pane, [...launch.args, ...harness.args],
        specCheckPrompt(config, work, await readVendorPrompts(), checkout.worktree, baseTip), run,
        { ...dependencies.prompt, ...dependencies.start, timeoutMs: dependencies.start?.timeoutMs ?? launchStartMs(config), directory: checkout.directory, cwd: checkout.directory, environment, ownGitHubCredential: true, role: harness.role, contract: launch.contract, credentialMask });
      return { work: work.key, profile: profile.name, agentName, reviewer: profile.agentName, pane, checkout: checkout.directory, tokenExpiresAt: expiresAt };
    } catch (error) {
      // A launch that never became a session leaves no pane and no token material behind; the checkout is the sweep's.
      if (pane) await closeHerdrPane(pane, run).catch(() => {});
      await rm(sessionDirectory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  });
}

/** The default registration: `POST /api/work/:id/spec-check-launch` with the loop's coordinator credential, keyed on the launch so a retry replays. */
function registerControlPlaneLaunch(config: { url: string; credentialFile: string }) {
  return async (work: Work, launch: { reviewer: string; tokenHash: string; expiresAt: string; policyRevision: number }): Promise<{ launch: string }> => {
    const token = await readCredentialFile(config.credentialFile);
    const response = await fetch(`${config.url}/api/work/${encodeURIComponent(work.id)}/spec-check-launch`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': `spec-check-launch:${launch.tokenHash}` }, body: JSON.stringify(launch), signal: AbortSignal.timeout(30_000) });
    const result = await response.json().catch(() => ({})) as { launch?: string; error?: string };
    if (!response.ok) throw new Error(`The control plane refused the spec-check launch of ${work.key} (${response.status}): ${result?.error ?? 'no reason given'}`);
    if (typeof result.launch !== 'string') throw new Error(`The control plane registered the spec-check launch of ${work.key} without a launch id`);
    return { launch: result.launch };
  };
}
