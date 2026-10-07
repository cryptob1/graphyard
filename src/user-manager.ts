// Concern: the host's systemd user manager as one condition (GY-1428) — revived by the loop when it stops answering, and the executor slots it left down started again.
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { executorSupervisionStatus, systemctl, systemdUserManager, type SystemctlRunner } from './repository-setup.js';
import { slotDown } from './cli/executor-report.js';

/**
 * Whether this process sees the user bus masked: the socket path exists but is not a socket. A
 * worker sandbox binds /dev/null over it, so `systemctl --user` there answers "Connection refused"
 * while the host's manager runs; nothing this process asks logind for changes that.
 */
export function userBusMasked(runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`): boolean {
  try { return !statSync(`${runtime}/bus`).isSocket(); } catch { return false; }
}

export interface UserSupervisionDeps {
  systemctl?: SystemctlRunner;
  loginctl?: (args: string[]) => string;
  masked?: () => boolean;
  wait?: (ms: number) => Promise<unknown>;
  /** How many one-second waits the revived manager is given to answer. */
  attempts?: number;
  platform?: NodeJS.Platform;
}
export interface UserSupervisionHeal { performed: string[]; reason: string | null }

const loginctl = (args: string[]) => execFileSync('loginctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim();
const firstLine = (error: unknown) => `${(error as { stderr?: unknown })?.stderr ?? ''}`.trim().split('\n')[0] || (error instanceof Error ? error.message.split('\n')[0] : String(error));

/**
 * One loop step's repair of the host's supervision. A user manager that stopped answering takes
 * every user unit with it — the declared executor slots, the loop's own unit — and every reader
 * then reported its own symptom: each slot "inactive", each worker blocker quoting the refused bus.
 * The loop asks logind to start the manager (`loginctl enable-linger` starts `user@UID` as it sets
 * lingering, over the system bus, which a dead user bus does not touch), waits for it to answer,
 * and starts with `enable --now` every declared slot it finds down. Nothing is done on a host that
 * declares no slot, off Linux, or from inside a masked bus, where the host is not what failed.
 */
export async function healUserSupervision(root: string, deps: UserSupervisionDeps = {}): Promise<UserSupervisionHeal> {
  const performed: string[] = [];
  if ((deps.platform ?? process.platform) !== 'linux') return { performed, reason: null };
  let status = await executorSupervisionStatus(root, deps.systemctl);
  if (!status.declaration?.count) return { performed, reason: null };
  if (!status.supervised) {
    if ((deps.masked ?? userBusMasked)()) return { performed, reason: `this loop runs behind a masked user bus (a sandbox), so it cannot reach the host's user manager: ${status.reason}` };
    try { (deps.loginctl ?? loginctl)(['enable-linger']); performed.push('loginctl enable-linger, to start the systemd user manager that stopped answering'); }
    catch (error) { return { performed, reason: `the systemd user manager does not answer and logind refused to start it: ${firstLine(error)}` }; }
    const wait = deps.wait ?? delay;
    for (let attempt = 0; attempt < (deps.attempts ?? 10) && !systemdUserManager(deps.systemctl).available; attempt++) await wait(1000);
    status = await executorSupervisionStatus(root, deps.systemctl);
    if (!status.supervised) return { performed, reason: `the systemd user manager still does not answer after loginctl enable-linger: ${status.reason}` };
  }
  const down = status.units.filter(unit => slotDown(unit.active));
  if (!down.length) return { performed, reason: null };
  const units = down.map(unit => unit.unit);
  try { (deps.systemctl ?? systemctl)(['enable', '--now', ...units]); }
  catch (error) { return { performed, reason: `systemctl --user enable --now ${units.join(' ')} failed: ${firstLine(error)}` }; }
  performed.push(`systemctl --user enable --now ${units.join(' ')} (${down.map(unit => `slot ${unit.slot} was ${unit.active}`).join(', ')})`);
  return { performed, reason: null };
}
