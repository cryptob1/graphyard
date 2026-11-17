// Concern: doctor's host-readiness lines (GY-3351) — each registry account's runtime executable and
// PATH entries on this host, the Herdr plugin the install needs, and one read of the git remote.
// On a new host each of these surfaced only as a failed launch; doctor names them up front, one line
// with the fix each. Doctor reports, it never blocks the loop.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, sep } from 'node:path';
import { onSearchPath } from './runtime-binary.js';
import { launchRecipe } from './harness.js';
import { herdrPluginEnabled } from './repository-setup.js';
import type { SetupCheck } from './setup-from-zero.js';

/** The part of the agent registry these lines read. */
export interface HostRegistry {
  runtimes: readonly { name: string; launch: { kind: string; environment?: Record<string, string> } }[];
  accounts: readonly { name: string; runtime: string; enabled?: boolean; credential: { host: string } }[];
}

/** A missing directory under mise's installs (`…/mise/installs/<tool>/<version>/bin`) is put back by installing its tool. */
const miseTool = (path: string) => /(?:^|\/)mise\/installs\/([^/]+)\//.exec(`${path}${sep}`)?.[1] ?? null;

/** One line per missing PATH entry and per unresolved executable of every enabled account on HOST; one PASS per account otherwise. */
export function accountRuntimeChecks(registry: HostRegistry, host: string, hostPath: string): SetupCheck[] {
  const lines: SetupCheck[] = [];
  for (const account of registry.accounts) {
    if (account.credential.host !== host || account.enabled === false) continue;
    const runtime = registry.runtimes.find(entry => entry.name === account.runtime);
    const fail = (detail: string, step: string) => lines.push({ id: 'account-runtime', status: 'fail', detail, step });
    if (!runtime) { fail(`account ${account.name} names runtime ${account.runtime}, which the registry does not hold`, `graphyard master registry runtime set ${account.runtime} --kind KIND --reason "account ${account.name} runs it"`); continue; }
    const path = runtime.launch.environment?.PATH ?? hostPath, entries = path.split(delimiter).filter(Boolean);
    const missing = runtime.launch.environment?.PATH ? entries.filter(entry => !existsSync(entry)) : [];
    for (const entry of missing) {
      const tool = miseTool(entry), rest = entries.filter(other => other !== entry).join(delimiter);
      fail(`account ${account.name}: PATH entry ${entry} of runtime ${runtime.name} does not exist on this host`,
        tool ? `mise install ${tool}@latest` : `install what ${entry} held, or drop it: graphyard master registry runtime set ${runtime.name} --env=PATH=${rest} --reason "drop ${entry}, absent on ${host}"`);
    }
    const program = launchRecipe(runtime.launch.kind)?.program ?? runtime.launch.kind, found = onSearchPath(program, path);
    if (!found) fail(`account ${account.name}: runtime ${runtime.name}'s executable ${program} is not on its PATH (${path || 'empty'})`, `install ${program} on this host into a directory on runtime ${runtime.name}'s PATH`);
    else if (!missing.length) lines.push({ id: 'account-runtime', status: 'pass', detail: `account ${account.name} runs ${found}`, step: '' });
  }
  return lines;
}

/** Whether Herdr on this host has the graphyard plugin enabled; no line when herdr itself is not on PATH (the herdr line says so). */
export async function herdrPluginCheck(path: string): Promise<SetupCheck | null> {
  const herdr = onSearchPath('herdr', path);
  if (!herdr) return null;
  const enabled = await herdrPluginEnabled(args => execFileSync(herdr, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000, env: { ...process.env, PATH: path } }));
  const step = 'rerun graphyard up from this checkout; its Herdr step links and enables the graphyard plugin';
  return enabled ? { id: 'herdr-plugin', status: 'pass', step, detail: `Herdr has the graphyard plugin enabled (${herdr})` }
    : { id: 'herdr-plugin', status: 'fail', step, detail: enabled === false ? 'Herdr has no enabled graphyard plugin' : `${herdr} plugin list could not say whether the graphyard plugin is installed` };
}

/** The git-remote line from the remote probe's answer: null when origin answered, else git's failure text. */
export const gitRemoteCheck = (failure: string | null): SetupCheck => failure
  ? { id: 'git-remote', status: 'fail', detail: `git ls-remote origin failed: ${failure}`, step: 'make git fetch from origin work on this host: its credential (ssh key or https helper), its network, or git remote set-url origin URL to a URL this host can reach' }
  : { id: 'git-remote', status: 'pass', detail: 'git ls-remote origin answered', step: '' };
