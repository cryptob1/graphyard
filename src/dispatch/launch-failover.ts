import { type ChildRun } from '../child-runner.js';
import { withReviewerDefaults, type MasterConfig, type ReviewerProfile } from '../master/profiles.js';
import { herdrErrorCode, SessionStartError, sessionWords, type StartBounds } from '../master/launch.js';
import { detectExhaustion, type ExhaustionSignal } from '../model/capacity.js';
import { herdrSubcommand, isHerdrCommand } from '../master/herdr.js';
import { capacityRefusal } from '../fleet.js';
import { instantExitReason } from './attempts.js';
/**
 * The reviewer profile that answers automatic requests: the configured one, else the only one.
 * The configured one runs `automaticReviewerConcurrency` sessions when it declares none (GY-1072).
 */
export function selectReviewerProfile(input: MasterConfig): { profile: ReviewerProfile | null; reason: string | null } {
  // Every review posts through the API under a one-time token (GY-1525): it needs a profile, not a reviewer App.
  const config = withReviewerDefaults(input);
  if (config.run.reviewerProfile) {
    const profile = config.reviewers.find(item => item.name === config.run.reviewerProfile) ?? null;
    return profile ? { profile, reason: null } : { profile: null, reason: `run.reviewerProfile names ${config.run.reviewerProfile}, which is not a configured reviewer profile` };
  }
  if (config.reviewers.length === 1) return { profile: config.reviewers[0], reason: null };
  return { profile: null, reason: config.reviewers.length ? 'more than one reviewer profile is configured; set run.reviewerProfile in .graphyard/master.json to the one automatic dispatch launches' : 'no reviewer profile is configured; add one with master reviewer add' };
}
/**
 * A launched session Herdr cannot find within seconds of its launch. The launcher types the
 * launch into the pane and reads it until the runtime is ready (master.ts, `awaitRuntimeStart`):
 * `herdr agent get` answers `agent_not_found` while the runtime is not there, which says nothing
 * about why, and `herdr pane read` shows what the runtime printed. A runtime that printed its
 * provider's limit notice and exited leaves the notice under its banner, and the banner alone
 * would hold the launcher's start bound to its ceiling before the refusal. The dispatcher watches
 * each launch's reads of its own pane (GY-120): a provider limit notice on the pane is account
 * exhaustion — the launch is refused at the next pause between the launcher's polls, the account
 * is held and the request launches on the profile's next account exactly as a mid-session
 * exhaustion does — and any other refusal is the launcher's own, which names the case it saw and
 * the pane's last words rather than the CLI's JSON error.
 */
export interface InstantExit { pane: string; words: string; notice: ExhaustionSignal }
export class InstantExitError extends Error {
  constructor(readonly instantExit: InstantExit, override readonly cause: unknown) {
    super(`${instantExitReason} on its provider's limit notice: ${instantExit.notice.reason}`);
  }
}
/** How many times one profile launches again on its next account within a single tick after such exits. */
export const instantExitRelaunchLimit = 4;
export interface InstantExitWatch {
  /** The launcher's Herdr calls, with each read of the pane it typed the launch into remembered. */
  run: ChildRun;
  /** The launcher's pause between polls of that pane: a pane already showing the notice is refused here, never waited out. */
  start: StartBounds;
  /** A refusal the launcher raised at its bound, classified from the pane's last read; any other error as it came. */
  classify: (error: unknown) => unknown;
}
/**
 * One watch per launch: it remembers the pane `pane run` typed the launch into and that pane's
 * last screen, and touches nothing else the launcher runs. The screen is read from the launcher's
 * own `pane read`, so the pane is read no more often than the launcher reads it and never after
 * the launcher closed it.
 */
export function watchInstantExit(run: ChildRun, now: () => number = Date.now): InstantExitWatch {
  let pane: string | null = null, screen: string | null = null, missing: unknown = null;
  const exit = () => { const notice = pane && screen !== null ? detectExhaustion(screen, now()) : null; return notice ? new InstantExitError({ pane: pane!, words: sessionWords(screen), notice }, missing) : null; };
  return {
    run: (command, given, options) => {
      // The instance's `--session NAME` (GY-1511) is not part of what the watch reads.
      const herdr = isHerdrCommand(command), args = herdr ? herdrSubcommand(given) : given;
      if (herdr && args[0] === 'pane' && args[1] === 'run') { pane = args[2] ?? null; screen = null; missing = null; }
      const read = (result: string) => { if (herdr && pane && args[0] === 'pane' && args[1] === 'read' && args[2] === pane) screen = String(result); return result; };
      const refused = (error: unknown): never => { if (herdr && pane && args[0] === 'agent' && args[1] === 'get' && args[2] === pane && herdrErrorCode(error) === 'agent_not_found') missing = error; throw error; };
      // The runner's answer is passed on as it came: a test's table answers at once, the process's
      // bounded runner (GY-125) answers on the event loop, and the watch notes the read either way.
      let result: Promise<string> | string;
      try { result = run(command, given, options); } catch (error) { return refused(error); }
      return typeof result === 'string' ? read(result) : result.then(read, refused);
    },
    // A pane already showing the notice is refused before the pause; otherwise the pause is a timer
    // the launcher awaits, never a blocking sleep, so the cycle's reads beside it are served.
    start: { wait: ms => { const exited = exit(); if (exited) throw exited; return new Promise<void>(resolve => setTimeout(resolve, ms)); } },
    classify: error => error instanceof SessionStartError && error.pane === pane && error.startCase !== 'blocked' ? exit() ?? error : error,
  };
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Launch on the first profile that can: a profile none of whose agent accounts is logged in with
 * quota left is skipped for the next, with its reason kept for the tick, and a session whose runtime
 * never accepted its prompt (the launcher closed it) is launched once more before the request is
 * refused. A session that exited at launch on its provider's limit notice is handed to
 * `exhaustedAtLaunch`, which holds the account, and the same profile launches again on its next
 * account; a profile with no account left then fails over through `selectAccount`'s refusal like
 * any other. Any other refusal stops at the profile that raised it.
 */
export async function launchWithFailover<P extends { name: string }>(profiles: P[], launch: (profile: P) => Promise<unknown>, exhaustedAtLaunch?: (profile: P, exit: InstantExit) => Promise<string>) {
  const failover: string[] = [];
  // Whether every profile so far was passed over for spent quota alone. A logged-out account or an
  // unconfigured environment also fails over, but it is a fault a master can fix now, so it must
  // not turn the role's launches into a wait for a provider reset (GY-89).
  let capacity = true;
  // The registry's refusal when a profile was passed over because its role is at its concurrency
  // limit (GY-205), and whether every other pass-over was a wait too (spent quota, no free slot).
  let full: string | null = null, waiting = true;
  for (const profile of profiles) {
    let dropped = false, exits = 0;
    for (;;) {
      try { return { profile, failover, relaunched: dropped, result: await launch(profile) }; }
      catch (error: any) {
        if (error?.promptDropped && !dropped) { dropped = true; continue; }
        if (error?.instantExit?.notice && exhaustedAtLaunch && exits < instantExitRelaunchLimit) { exits++; failover.push(await exhaustedAtLaunch(profile, error.instantExit)); continue; }
        if (error?.accountsExhausted) {
          failover.push(`${profile.name}: ${message(error)}`); capacity &&= !!error.capacityExhausted;
          const refusal = capacityRefusal(error);
          if (refusal) full ??= refusal; else waiting &&= !!error.capacityExhausted;
          break;
        }
        throw error;
      }
    }
  }
  // `accountsExhausted` still means only that every profile was passed over; `capacityExhausted`
  // means the role has no quota left, which is the one case that waits rather than refuses; and
  // `roleAtCapacity` means the registry had no free slot for the role, which waits for one to free.
  throw Object.assign(new Error(failover.join('; ') || 'no profile could launch'), { accountsExhausted: failover.length > 0, capacityExhausted: failover.length > 0 && capacity, ...(full && waiting ? { roleAtCapacity: full } : {}) });
}
