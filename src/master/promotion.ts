// Concern: promoting a supervised install to autonomy (GY-1502) — its preconditions, the autonomy apply it reuses, the supervision flip and its audit entry.
import { appendFile, chmod, mkdir } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { resolve } from 'node:path';
import { runChild } from '../child-runner.js';
import { actionsDirectory } from '../master-browser.js';
import { loadStoredMasterConfig, recordSupervision } from './config.js';
import { setupAutonomy } from './autonomy.js';
import { autonomyPlan } from './harness.js';
import type { MasterConfig } from './profiles.js';

export const promoteCommand = 'graphyard master promote --admin-token-stdin';
/** Recorded on every control-plane identity the promotion creates, configures or rotates, ahead of the autonomy apply's own reason. */
export const promotionReason = `Promotion of a supervised install to autonomy (${promoteCommand})`;
/** The append-only audit of promotions, beside the master's other administration records. */
export const promotionAuditFile = (root: string) => resolve(actionsDirectory(root), 'promotions.jsonl');

/** One step a promotion still needs, and the command that takes it. */
export interface PromotionStep { missing: string; command: string }
export class PromotionRefusedError extends Error {
  constructor(readonly steps: PromotionStep[]) {
    super(`master promote refused; the install stays supervised until each step is done: ${steps.map(step => `${step.missing} (run ${step.command})`).join('; ')}`);
  }
}

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
/**
 * What a supervised install lacks before agents may review for it: a registered reviewer App, a
 * reviewer profile to launch its sessions, and a reviewer bot login that is neither the operator's
 * own GitHub login nor any worker's identity — otherwise a review would not be independent of the
 * person or agent whose work it judges. Empty when promotion may proceed.
 */
export function promotionPreconditions(config: Pick<MasterConfig, 'reviewer' | 'reviewers' | 'workers' | 'githubAppId'>, operatorLogin: string | null, recordedLogin?: string | null): PromotionStep[] {
  const steps: PromotionStep[] = [];
  if (!config.reviewer) steps.push({ missing: 'no reviewer App is registered', command: 'graphyard master reviewer setup (or graphyard master reviewer bind FILE --key-stdin)' });
  if (!config.reviewers.length) steps.push({ missing: 'no reviewer profile is configured', command: 'graphyard master reviewer add PROFILE.json' });
  // The login gh holds now decides; the one up recorded may be stale, so it is checked as well, never instead.
  if (!operatorLogin) steps.push({ missing: 'the operator\'s current GitHub login is unknown, so the reviewer App cannot be shown to differ from it', command: 'gh auth login' });
  if (config.reviewer) {
    const bot = `${config.reviewer.slug}[bot]`;
    const own = [operatorLogin, recordedLogin].find(login => login && (same(bot, login) || same(config.reviewer!.slug, login)));
    if (own) steps.push({ missing: `the reviewer App's bot login ${bot} is the operator's own GitHub login ${own}`, command: 'graphyard master reviewer setup, registering a reviewer App of its own' });
    // Every worker commits and opens pull requests through the worker App and claims under its principal.
    if (config.reviewer.appId === config.githubAppId) steps.push({ missing: `the reviewer App (${config.reviewer.appId}) is the worker App every worker pushes with`, command: 'graphyard master reviewer setup, registering a reviewer App distinct from the worker App' });
    const workers = config.workers.filter(worker => [worker.principal, worker.agentName].some(name => same(name, bot) || same(name, config.reviewer!.slug)));
    if (workers.length) steps.push({ missing: `the reviewer App's bot login ${bot} is the identity of worker ${workers.map(worker => worker.name).join(', ')}`, command: 'graphyard master reviewer setup, registering a reviewer App no worker claims under' });
  }
  return steps;
}

/**
 * `master autonomy --apply` on a supervised install: refused, so the plain apply never skips the
 * promotion's checks and audit. The promotion calls the apply itself, past this guard.
 */
export function assertPromotionRoute(config: Pick<MasterConfig, 'supervision'>, args: readonly string[]) {
  if (config.supervision === 'supervised' && args.includes('--apply')) throw new Error(`This install is supervised; it becomes autonomous only through ${promoteCommand}, which checks the reviewer App's independence and audits the transition`);
}

/** The operator's GitHub login as gh reads it; only the name is read, gh's token stays in gh (GY-1501). */
export async function ghLogin(): Promise<string | null> {
  try { return (await runChild('gh', ['api', 'user', '--jq', '.login'], { timeoutMs: 30_000 })).trim() || null; } catch { return null; }
}

/** A fetcher that records the promotion as the reason of every identity write the autonomy apply makes. */
function reasoned(fetcher: typeof fetch): typeof fetch {
  return (input, init) => {
    if (init?.method !== 'POST' || typeof init.body !== 'string' || !/\/api\/operator-agents(\/|$)/.test(String(input))) return fetcher(input, init);
    const body = JSON.parse(init.body);
    return fetcher(input, { ...init, body: JSON.stringify(typeof body.reason === 'string' ? { ...body, reason: `${promotionReason}: ${body.reason}` } : body) });
  };
}

export interface PromotionDependencies { fetcher?: typeof fetch; operatorLogin?: () => string | null | Promise<string | null>; now?: () => Date; harness?: string }
/**
 * `graphyard master promote --admin-token-stdin`: the operator's one audited transition from
 * supervised to autonomous. It refuses, naming each missing step, until the reviewer preconditions
 * hold against the login gh holds now; then appends an audit entry under .graphyard/master-actions,
 * and only once that is durable provisions the operator-agent and approver identities through the
 * existing autonomy apply, which sets `supervision: autonomous` in master.json. An audit that cannot
 * be written changes nothing, so the install is never autonomous without its entry; a failed apply
 * leaves it supervised for a rerun, which audits its own run. On an install already autonomous it
 * changes nothing. There is no demotion.
 */
export async function promoteToAutonomy(root: string, adminToken: string | undefined, deps: PromotionDependencies = {}) {
  const config = await loadStoredMasterConfig(root);
  if (config.supervision !== 'supervised') return { promoted: false, supervision: 'autonomous' as const, changes: [] as string[], audit: null, next: 'This install is already autonomous; nothing changed' };
  const operatorLogin = await (deps.operatorLogin ?? ghLogin)() ?? null;
  const steps = promotionPreconditions(config, operatorLogin, config.operatorLogin);
  if (steps.length) throw new PromotionRefusedError(steps);
  if (!adminToken || adminToken.length < 32) throw new Error(`Promotion is the operator's decision and needs the admin credential once, on stdin: ${promoteCommand}`);
  const fetcher = deps.fetcher ?? fetch;
  const response = await fetcher(`${config.url}/api/status`, { headers: { Authorization: `Bearer ${adminToken}` }, signal: AbortSignal.timeout(30_000) });
  const actor = response.ok ? (await response.json())?.actor : null;
  if (actor?.role !== 'admin') throw new Error('Promotion needs the admin credential; the control plane did not identify an admin');
  const plan = autonomyPlan(config);
  const entry = { action: 'promote', at: (deps.now?.() ?? new Date()).toISOString(), from: 'supervised', to: 'autonomous',
    by: { actor: actor.id, githubLogin: operatorLogin, user: userInfo().username, host: hostname() },
    reviewer: { app: `${config.reviewer!.slug}[bot]`, appId: config.reviewer!.appId, profiles: config.reviewers.map(profile => profile.name) },
    identities: { operatorAgent: plan.operatorAgent.id, approver: plan.approver.id }, reason: promotionReason };
  const file = promotionAuditFile(root);
  await mkdir(actionsDirectory(root), { recursive: true, mode: 0o700 });
  await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 }); await chmod(file, 0o600);
  const applied = await setupAutonomy(root, { adminToken, apply: true, ...(deps.harness ? { harness: deps.harness } : {}) }, reasoned(fetcher));
  // The autonomy apply already writes autonomous; recorded again so the flip never depends on it.
  const { supervision } = await recordSupervision(root, 'autonomous');
  return { promoted: true, supervision, changes: applied.changes, audit: { file, entry }, harness: applied.harness,
    next: `Autonomous: the loop launches ${entry.reviewer.app}'s reviewer for the next build-passing candidate, and the master requests two-party decisions as ${entry.identities.operatorAgent}. There is no demotion command.` };
}
