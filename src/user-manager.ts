// Concern: the host's systemd user manager as one condition (GY-1428) — revived by the loop when it stops answering, and the executor slots it left down started again.
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { executorSupervisionStatus, systemctl, systemdUserManager, type SystemctlRunner } from './repository-setup.js';
import { slotDown } from './cli/executor-report.js';
import { loopUnitName } from './supervisor.js';

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
/** What the loop's step allows this repair: whether logind may be asked now, and which down slot may be started now. */
export interface UserSupervisionAllowance { revive: boolean; restart: (unit: string) => boolean }
/** A declared slot found down: started, withheld by the step, or left alone because an operator disabled it. */
export interface DownSlot { unit: string; slot: number; active: string; outcome: 'started' | 'withheld' | 'disabled' }
export interface UserSupervisionHeal {
  performed: string[];
  reason: string | null;
  /** Whether logind was asked to start the manager this time. */
  revived: boolean;
  /** Declared slots found active: a slot the loop gave up on is cleared once it is seen running again. */
  up: string[];
  down: DownSlot[];
  /** The loop's own unit as systemd reports it, once the manager answers. */
  loop: string | null;
}

const loginctl = (args: string[]) => execFileSync('loginctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim();
const firstLine = (error: unknown) => `${(error as { stderr?: unknown })?.stderr ?? ''}`.trim().split('\n')[0] || (error instanceof Error ? error.message.split('\n')[0] : String(error));
const answer = (run: SystemctlRunner, args: string[]) => { try { return run(args) || 'unknown'; } catch (error) { return `${(error as { stdout?: unknown })?.stdout ?? ''}`.trim() || 'unreachable'; } };

/**
 * One loop step's repair of the host's supervision. A user manager that stopped answering takes
 * every user unit with it — the declared executor slots, the loop's own unit — and every reader
 * then reported its own symptom: each slot "inactive", each worker blocker quoting the refused bus.
 * When the step allows it, the loop asks logind to start the manager (`loginctl enable-linger`
 * starts `user@UID` as it sets lingering, over the system bus, which a dead user bus does not
 * touch) and waits a few seconds for it to answer; a manager still silent is read again next cycle.
 * It then starts with `enable --now` every declared slot found down that the step allows and an
 * operator has not disabled. The loop's own unit is only read: a loop running outside it (started
 * by hand) would meet a second loop if it were started, so the step reports it unresolved instead.
 * Nothing is done on a host that declares no slot, off Linux, or from inside a masked bus.
 */
export async function healUserSupervision(root: string, deps: UserSupervisionDeps = {}, allow: UserSupervisionAllowance = { revive: true, restart: () => true }): Promise<UserSupervisionHeal> {
  const heal: UserSupervisionHeal = { performed: [], reason: null, revived: false, up: [], down: [], loop: null };
  if ((deps.platform ?? process.platform) !== 'linux') return heal;
  const run = deps.systemctl ?? systemctl;
  let status = await executorSupervisionStatus(root, run);
  if (!status.declaration?.count) return heal;
  if (!status.supervised) {
    if ((deps.masked ?? userBusMasked)()) return { ...heal, reason: `this loop runs behind a masked user bus (a sandbox), so it cannot reach the host's user manager: ${status.reason}` };
    if (!allow.revive) return { ...heal, reason: `the systemd user manager does not answer: ${status.reason}` };
    heal.revived = true;
    try { (deps.loginctl ?? loginctl)(['enable-linger']); heal.performed.push('loginctl enable-linger, to start the systemd user manager that stopped answering'); }
    catch (error) { return { ...heal, reason: `the systemd user manager does not answer and logind refused to start it: ${firstLine(error)}` }; }
    const wait = deps.wait ?? delay;
    for (let attempt = 0; attempt < (deps.attempts ?? 3) && !systemdUserManager(run).available; attempt++) await wait(1000);
    status = await executorSupervisionStatus(root, run);
    if (!status.supervised) return { ...heal, reason: `the systemd user manager still does not answer after loginctl enable-linger: ${status.reason}` };
  }
  heal.up = status.units.filter(unit => !slotDown(unit.active)).map(unit => unit.unit);
  heal.down = status.units.filter(unit => slotDown(unit.active)).map(unit => ({ unit: unit.unit, slot: unit.slot, active: unit.active,
    outcome: answer(run, ['is-enabled', unit.unit]) !== 'enabled' ? 'disabled' as const : allow.restart(unit.unit) ? 'started' as const : 'withheld' as const }));
  const units = heal.down.filter(slot => slot.outcome === 'started').map(slot => slot.unit);
  if (units.length) {
    try { run(['enable', '--now', ...units]); heal.performed.push(`systemctl --user enable --now ${units.join(' ')} (${heal.down.filter(slot => slot.outcome === 'started').map(slot => `slot ${slot.slot} was ${slot.active}`).join(', ')})`); }
    catch (error) { for (const slot of heal.down) if (slot.outcome === 'started') slot.outcome = 'withheld'; return { ...heal, reason: `systemctl --user enable --now ${units.join(' ')} failed: ${firstLine(error)}` }; }
  }
  return { ...heal, loop: answer(run, ['is-active', loopUnitName]) };
}
