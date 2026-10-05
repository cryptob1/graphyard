// Concern: probing the secrets bus and keyring endpoints a launched session reaches through its confinement.
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { type ChildRun, childRunner, defaultChildRun } from '../child-runner.js';
import { assertSessionName, SessionNameRefusedError } from '../session-name.js';
import { requestPlaceholder, type RegisteredLaunch, assertLaunchable, LaunchRefusedError, nonInteractiveLaunch } from '../harness.js';
import { withAutonomyContract } from '../autonomy.js';
import { underTestRunner } from '../supervisor.js';
import type { PartialWork } from '../model/capacity.js';
import { type ConsentPrompt, detectConsentPrompt, settingsWarning, type ConsentAnswer, sameConsentPrompt } from '../consent-prompt.js';
import { bwrapOnPath, checkoutGitDirectory, checkoutGitProblem, checkoutWorktreeAdminDirectory, confinementRefusalText, coordinatorCheckoutRoot, coordinatorConfinement, coordinatorConfinementRefusal, mountNamespaceProbeResult, isSocketPath, readOnlyMountWrapper, secretsBusPath, type CoordinatorConfinement, type ConfinementInput } from './profiles.js';
import type { MasterRun } from './profiles.js';
import { type HerdrAgent, herdrJson, herdrRun, stopCreatedHerdrTab } from './herdr.js';

/** secretsBusEndpointProblem's answer when the user manager could not judge the endpoint. */
export const secretsBusUnjudged = 'unjudged' as const;
export const secretsBusMigration = 'copy deploy/systemd/graphyard-secrets-bus.socket, graphyard-secrets-bus.service and graphyard-secrets-bus-filter.service to ~/.config/systemd/user/, then systemctl --user daemon-reload && systemctl --user disable --now graphyard-secrets-bus.service && systemctl --user enable --now graphyard-secrets-bus.socket';
/**
 * The keyring endpoint when `graphyard-secrets-bus.socket` does not hold it (GY-1039): an install
 * that enabled the earlier `graphyard-secrets-bus.service` has `xdg-dbus-proxy` listen at the path
 * itself, and every restart of that proxy replaces the socket a confined session has bind-mounted,
 * leaving the session on a dead listener. Null when the socket unit holds it or there is nothing to
 * judge — no endpoint, or a path that is not a socket. `secretsBusUnjudged` when the systemd user
 * manager does not answer or its answer is unreadable: the endpoint may still be unheld, so a caller
 * that remembers verdicts must ask again later rather than keep this one — never a guess.
 */
export async function secretsBusEndpointProblem(run: ChildRun | undefined, path: string | null = secretsBusPath()): Promise<{ text: string; next: string } | typeof secretsBusUnjudged | null> {
  if (!path || !isAbsolute(path) || !isSocketPath(path)) return null;
  // The suite never asks the real user manager about the real runtime directory.
  if (!run && underTestRunner()) return null;
  let shown: string;
  try { shown = String(await (run ?? defaultChildRun)('systemctl', ['--user', 'show', '--property=ActiveState', '--property=Listen', 'graphyard-secrets-bus.socket'], { timeoutMs: 10_000 })); } catch { return secretsBusUnjudged; }
  const lines = shown.split(/\r?\n/);
  const state = lines.find(line => line.startsWith('ActiveState='))?.slice('ActiveState='.length);
  if (!state) return secretsBusUnjudged;
  const canonical = (candidate: string) => { try { return realpathSync(candidate); } catch { return candidate; } };
  const listens = lines.filter(line => line.startsWith('Listen=')).map(line => line.slice('Listen='.length).replace(/ \([^)]*\)$/, ''));
  if (state === 'active' && listens.some(listen => canonical(listen) === canonical(path))) return null;
  const held = state === 'active' ? `listens at ${listens.join(', ') || 'nothing'} instead` : `is ${state}`;
  return { text: `The keyring endpoint ${path} is a socket graphyard-secrets-bus.socket does not hold (the socket unit ${held}), so a restart of the proxy listening there replaces the socket confined sessions have bind-mounted and strands them on a dead listener`, next: secretsBusMigration };
}
/**
 * The line a launch logs when the session it confines reaches the keyring through an endpoint
 * graphyard-secrets-bus.socket does not hold (GY-1039): an install that enabled the earlier
 * graphyard-secrets-bus.service has its proxy listen at the path itself, so a restart of that proxy
 * strands the session on a dead listener. The line names the endpoint and the migration. Each
 * endpoint socket is judged once per launcher process, keyed by its device, inode and change time
 * (an unlinked socket's inode number may be reused at once): later launches binding the same socket
 * neither probe the user manager again nor repeat the line, and a socket replaced at the path — the
 * socket unit binding it after a migration, or a restarted proxy — is judged afresh. `verdicts`
 * keeps only the latest socket's verdict per endpoint path, so replaced incarnations leave nothing
 * behind. Null when the confinement binds no endpoint (an unconfined session, a runtime's own
 * sandbox, a session with a credential of its own), the endpoint is held or cannot be judged, or
 * this socket was already judged. A probe that cannot judge the socket — no user manager answers,
 * or its answer is unreadable — is not remembered, so a later launch, and any launch that was
 * awaiting that probe, asks again and still reports an unmigrated endpoint once the user manager
 * answers. Given a `backoff` (the launcher passes keyringProbeBackoff), an unjudged probe opens a
 * window on that socket in which no launch asks again — it logs nothing — so a user manager that
 * stays unreachable costs one probe per window rather than one per confined launch; each further
 * unjudged probe doubles the window up to its cap, and a judged one closes it (GY-1206). The line
 * is the launch's own: when `started` settles false (the launch failed and its
 * pane was closed) nothing is returned under that session's name. A racing launch that succeeds
 * reports the endpoint instead of staying silent, and the verdict is forgotten only when every
 * racing launch has failed without reporting it, so the next launch reports it.
 */
export async function keyringEndpointWarning(name: string, confinement: CoordinatorConfinement | null, run?: ChildRun, path: string | null = secretsBusPath(), verdicts: Map<string, KeyringEndpointVerdict> = keyringEndpointVerdicts, started: Promise<boolean> = Promise.resolve(true), backoff: KeyringProbeBackoff | null = null): Promise<string | null> {
  if (!confinement || !path) return null;
  let endpoint: string, socket: string;
  try { endpoint = realpathSync(path); const stat = statSync(endpoint, { bigint: true }); socket = `${stat.dev}:${stat.ino}:${stat.ctimeNs}`; } catch { return null; }
  if (!confinement.wrapper.includes(endpoint)) return null;
  const judging = () => { const held = verdicts.get(endpoint); return held?.socket === socket ? held : undefined; };
  // A launch that finds a probe in flight or already judged shares it, logging the warning if it
  // succeeds and no racing launch has yet reported it. If that probe could not judge the socket,
  // its entry is gone by then, so this launch asks again itself.
  for (let held = judging(); held; held = judging()) {
    const outcome = await held.claim(name, started);
    if (outcome !== undefined) return outcome;
  }
  const waiting = backoff?.windows.get(endpoint);
  if (waiting?.socket === socket && backoff!.now() < waiting.retryAt) return null;
  let waiters = 0;
  let reported = false;
  let problemResult: string | null | undefined;
  const forget = () => { if (verdicts.get(endpoint)?.verdict === verdict) verdicts.delete(endpoint); return undefined; };
  const unjudged = () => {
    if (backoff) {
      const last = backoff.windows.get(endpoint);
      const delayMs = last?.socket === socket ? Math.min(last.delayMs * 2, keyringProbeBackoffMaxMs) : keyringProbeBackoffMs;
      backoff.windows.set(endpoint, { socket, delayMs, retryAt: backoff.now() + delayMs });
    }
    return forget();
  };
  const judged = (line: string | null) => { backoff?.windows.delete(endpoint); return line; };
  const verdict: Promise<string | null | undefined> = secretsBusEndpointProblem(run, path).then(problem => problem === secretsBusUnjudged ? unjudged() : judged(problem ? `${problem.text}; migrate: ${problem.next}` : null), unjudged);
  const claim = async (sessionName: string, sessionStarted: Promise<boolean>): Promise<string | null | undefined> => {
    waiters++;
    try {
      const problem = await verdict;
      problemResult = problem;
      if (problem === undefined) return undefined;
      if (!problem) return null;
      if (reported) return null;
      let ok: boolean;
      try { ok = await sessionStarted; } catch { ok = false; }
      if (ok && !reported) {
        reported = true;
        return `graphyard: ${sessionName}: ${problem}`;
      }
      return null;
    } finally {
      waiters--;
      if (waiters === 0 && !reported && problemResult) forget();
    }
  };
  // The endpoint's earlier socket, if any, is replaced: only the latest incarnation is kept.
  verdicts.set(endpoint, { socket, verdict, claim });
  return (await claim(name, started)) ?? null;
}
/** One keyring endpoint path's latest socket (`dev:inode:ctime`) and its verdict (keyringEndpointWarning). */
export interface KeyringEndpointVerdict {
  socket: string;
  verdict: Promise<string | null | undefined>;
  claim: (name: string, started: Promise<boolean>) => Promise<string | null | undefined>;
}
/** The latest socket's verdict per keyring endpoint path in this process (keyringEndpointWarning). */
const keyringEndpointVerdicts = new Map<string, KeyringEndpointVerdict>();
/** The window an unjudged keyring probe opens before a launch asks the user manager again, and its cap as it doubles (GY-1206). */
export const keyringProbeBackoffMs = 30_000;
export const keyringProbeBackoffMaxMs = 300_000;
/** Per keyring endpoint path, the socket whose last probe went unjudged and when a launch may ask again (keyringEndpointWarning). */
export interface KeyringProbeBackoff {
  windows: Map<string, { socket: string; delayMs: number; retryAt: number }>;
  now: () => number;
}
/** The launcher's backoff on unjudged keyring probes in this process. */
export const keyringProbeBackoff: KeyringProbeBackoff = { windows: new Map(), now: () => Date.now() };
