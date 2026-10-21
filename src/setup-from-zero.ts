import { access, lstat, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { checkAgentEnvironment, discoverAgentEnvironments } from './master/environments.js';
import type { AgentEnvironment } from './master/profiles.js';
import { sharedGitPaths, workerPaths } from './worker-sandbox.js';
import { mergerNotRequired } from './model/setup-checklist.js';
import type { LoopCodeReading } from './repository-setup.js';
import { installUnitsFile, parseInstallUnits } from './install/units.js';
import { defaultChildRun } from './child-runner.js';
import type { UserSystemctl } from './master/loop-restart.js';
import { herdrServerUnit } from './herdr-host.js';
import { installIdFor } from './install/types.js';

/**
 * The prerequisites docs/setup-from-zero.md depends on that `graphyard doctor` can check from this
 * machine (GY-1352). Each is a named pass/fail line naming the checklist step that fixes it, so an
 * agent setting Graphyard up from nothing reads the next step off doctor's output instead of guessing.
 */
export const setupSteps = {
  install: 'docs/setup-from-zero.md step 3 (install the control plane)',
  app: 'docs/setup-from-zero.md step 4 (register the GitHub App)',
  reviewer: 'docs/setup-from-zero.md step 4 (reviewer and revert-approver Apps)',
  environments: 'docs/setup-from-zero.md step 8 (agent environments)',
  sandbox: 'docs/setup-from-zero.md step 9 (worker sandbox)',
  releaseFiling: 'issue GRAPHYARD_RELEASE_TOKEN to an operator agent holding only intent:create (graphyard operator-agent setup FILE --token-stdin)',
  loopCode: 'rerun graphyard up --agent from this checkout (docs/setup-from-zero.md step 10, start the master)',
  unitOverrides: 'docs/setup-from-zero.md#troubleshooting-manual-steps (remove the drop-in)',
} as const;

export interface SetupCheck { id: string; status: 'pass' | 'fail'; detail: string; step: string }

export interface SetupFromZeroInput {
  /** The managed repository's checkout doctor runs in. */
  root: string;
  env?: NodeJS.ProcessEnv;
  /** The server's GET /api/status answer, or null with the failure when it did not answer. */
  status: any | null;
  failure?: string;
  /** Whether the plane's unauthenticated /healthz answered, so a missing or refused credential is not read as an unreachable plane. */
  reachable?: boolean;
  /** The master credential file doctor read with (`masterCredential`), when GRAPHYARD_TOKEN(_FILE) is unset. */
  masterCredential?: string | null;
  /** Where the agent environments live (`~/.coding_agents` unless GRAPHYARD_AGENT_ENVIRONMENTS). */
  environments: string;
  /** Probes that the worker confinement can write PATHS; null when it can, else the reason. */
  sandbox?: (paths: string[]) => string | null;
  /** GY-1614: the `/api/status` answer to GRAPHYARD_RELEASE_TOKEN, or the failure it met; read from the plane when unset here. */
  releaseFiling?: { status: any | null; failure?: string };
  /** GY-1859: what the install's loop and executor units run against this CLI; read beside the install when unset here. */
  loopCode?: LoopCodeReading | null;
  /** GY-2159: `systemctl --user ARGS` for the unit-overrides line; the user manager when unset here. */
  systemctl?: UserSystemctl;
  platform?: NodeJS.Platform;
}

const writable = async (path: string) => { try { await access(path, constants.W_OK); return true; } catch { return false; } };
const readJson = async (file: string) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };
/** A config file the launcher must rewrite (folder trust) is writable, or absent from a writable home. */
const rewritable = async (file: string) => { try { await stat(file); return writable(file); } catch { return writable(dirname(file)); } };

/** Bubblewrap's own probe, as the worker confinement runs it, with PATHS bound writable. */
export function bubblewrapProbe(paths: string[]): string | null {
  const binds = paths.flatMap(path => ['--bind', path, path]);
  try {
    execFileSync('bwrap', ['--ro-bind', '/', '/', ...binds, '--dev', '/dev', '--proc', '/proc', '--unshare-all', '--share-net', '--die-with-parent', '--', 'sh', '-c', paths.map(path => `test -w '${path.replace(/'/g, `'\\''`)}'`).join(' && ')], { stdio: 'ignore', timeout: 20_000 });
    return null;
  } catch (error: any) { return error.code === 'ENOENT' ? 'bubblewrap (bwrap) is not installed' : `bwrap could not write them: ${error.message.split('\n')[0]}`; }
}

/**
 * The master (coordinator) credential `install --apply` or `master init` recorded in
 * .graphyard/master.json for this server (GY-1412): the identity a setup agent drives doctor with,
 * so no step hands an agent the human operator's credential. Null when GRAPHYARD_TOKEN(_FILE)
 * already chose a credential, or no 0600 master credential is recorded for this server.
 */
export async function masterCredential(root: string, base: string, env: NodeJS.ProcessEnv = process.env): Promise<{ file: string; token: string } | null> {
  if (env.GRAPHYARD_TOKEN_FILE || env.GRAPHYARD_TOKEN) return null;
  try {
    const config = JSON.parse(await readFile(resolve(root, '.graphyard/master.json'), 'utf8'));
    if (new URL(config.url).origin !== new URL(base).origin) return null;
    const file = resolve(config.credentialFile), info = await lstat(file);
    const token = (await readFile(file, 'utf8')).trim();
    return info.isFile() && !(info.mode & 0o077) && token.length >= 32 ? { file, token } : null;
  } catch { return null; }
}

/** An authenticated GET against the control plane, as the CLI's own requests make it. */
export const planeRequest = (base: string, token: string) => async (path: string) => {
  const response = await fetch(`${base}/api/${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  const body = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(body));
  return body;
};

/** Whether the plane's unauthenticated /healthz answers: reachable, whatever the credential. */
export async function planeAnswers(base: string): Promise<boolean> {
  try { return (await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(10_000) })).ok; } catch { return false; }
}

/**
 * Doctor's next action (GY-1412): the readiness checklist's, except that while the control plane
 * itself fails, the line naming the step that installs or connects it comes first, so a fresh
 * machine is never sent to `init --url SERVER --token-stdin` before any server exists.
 */
export function setupNext(readiness: { next: string; items: { id: string; status: string }[] }, checks: SetupCheck[]) {
  const firstGap = readiness.items.find(item => item.status !== 'ready');
  const plane = checks.find(check => check.status === 'fail' && check.step === setupSteps.install);
  return plane && firstGap && ['server', 'credential-role'].includes(firstGap.id) ? setupLine(plane) : readiness.next;
}

async function credentialsCheck(root: string, env: NodeJS.ProcessEnv, master?: string | null): Promise<SetupCheck> {
  if (master) return { id: 'credentials-file', status: 'pass', step: setupSteps.install, detail: `the master credential ${master} (.graphyard/master.json) is present with mode 0600` };
  const named = env.GRAPHYARD_TOKEN_FILE ? resolve(env.GRAPHYARD_TOKEN_FILE) : null;
  const file = named ?? resolve(root, '.graphyard/connection.json');
  const check = (status: SetupCheck['status'], detail: string): SetupCheck => ({ id: 'credentials-file', status, detail, step: setupSteps.install });
  let info;
  try { info = await lstat(file); } catch {
    return check('fail', named ? `GRAPHYARD_TOKEN_FILE ${file} does not exist` : env.GRAPHYARD_TOKEN ? 'the credential is only in GRAPHYARD_TOKEN; no credentials file holds it' : `${file} does not exist and GRAPHYARD_TOKEN_FILE is unset`);
  }
  if (!info.isFile()) return check('fail', `${file} is not a regular file`);
  if (info.mode & 0o077) return check('fail', `${file} has mode 0${(info.mode & 0o777).toString(8)}; it must be 0600`);
  if (!named && !(await readJson(file))?.token) return check('fail', `${file} holds no credential; store one with init --url SERVER --token-stdin`);
  return check('pass', `${file} is present with mode 0600`);
}

async function environmentChecks(directory: string): Promise<SetupCheck[]> {
  let found: AgentEnvironment[];
  try { found = await discoverAgentEnvironments(directory); } catch (error: any) { return [{ id: 'agent-environments', status: 'fail', detail: `${directory} is unreadable: ${error.message}`, step: setupSteps.environments }]; }
  if (!found.length) return [{ id: 'agent-environments', status: 'fail', detail: `no agent environment (claude-a, codex-a, ...) under ${directory}`, step: setupSteps.environments }];
  return Promise.all(found.map(async environment => {
    const gaps: string[] = [];
    const health = await checkAgentEnvironment(environment, { quota: false, cacheMs: 0 });
    if (!health.loggedIn) gaps.push('not logged in');
    if (environment.kind === 'claude') {
      if ((await readJson(resolve(environment.home, 'settings.json')))?.skipDangerousModePermissionPrompt !== true) gaps.push('the bypass-permissions consent is not recorded (settings.json skipDangerousModePermissionPrompt)');
      if ((await readJson(resolve(environment.home, '.claude.json')))?.hasCompletedOnboarding !== true) gaps.push('first-run onboarding is not complete (.claude.json hasCompletedOnboarding)');
      if (!(await rewritable(resolve(environment.home, '.claude.json')))) gaps.push('.claude.json is not writable, so folder trust cannot be recorded at launch');
    }
    if (environment.kind === 'codex' && !(await rewritable(resolve(environment.home, 'config.toml')))) gaps.push('config.toml is not writable, so folder trust cannot be recorded at launch');
    return { id: `agent-environment:${environment.name}`, status: gaps.length ? 'fail' : 'pass', step: setupSteps.environments,
      detail: gaps.length ? `${environment.kind} at ${environment.home}: ${gaps.join('; ')}` : `${environment.kind} at ${environment.home} is logged in and past its first-run prompts` } satisfies SetupCheck;
  }));
}

async function sandboxCheck(root: string, probe: (paths: string[]) => string | null): Promise<SetupCheck> {
  const check = (status: SetupCheck['status'], detail: string): SetupCheck => ({ id: 'worker-sandbox', status, detail, step: setupSteps.sandbox });
  const paths = workerPaths(root);
  if (!paths.commonDir) return check('fail', `${root} is not a Git checkout`);
  const shared = sharedGitPaths(paths.commonDir);
  const existing = (await Promise.all(shared.map(async path => (await stat(path).then(entry => entry.isDirectory(), () => false)) ? path : null))).filter((path): path is string => !!path);
  const unwritable = (await Promise.all(existing.map(async path => (await writable(path)) ? null : path))).filter(Boolean);
  if (unwritable.length) return check('fail', `this user cannot write ${unwritable.join(', ')}`);
  const refused = probe(existing);
  return refused ? check('fail', `the worker confinement cannot write the shared Git paths: ${refused}`) : check('pass', `the worker confinement writes ${existing.length} shared Git paths under ${paths.commonDir}`);
}

/**
 * Pure: why the control plane would refuse to create work as `actor`, the principal a filing
 * credential names (its `/api/status` actor), or null when it is admitted.
 */
export function followUpFilingRefusal(actor: { id?: string; role?: string; capabilities?: string[]; scope?: { repositories?: string[]; workItems?: string[] } } | null | undefined, repository: string | null | undefined) {
  if (!actor?.role) return 'the filing credential names no principal';
  if (actor.role === 'admin') return null;
  if (actor.role !== 'operator-agent') return `${actor.id} has role ${actor.role}, which cannot create work (Operator permission required)`;
  if (!actor.capabilities?.includes('intent:create')) return `operator agent ${actor.id} lacks intent:create`;
  if (!repository || !actor.scope?.repositories?.includes(repository)) return `operator agent ${actor.id}'s scope does not include ${repository ?? 'the repository'}`;
  if (!actor.scope?.workItems?.includes('*')) return `operator agent ${actor.id} lacks wildcard work scope, which creating work requires`;
  return null;
}
/** Pure: what `actor` holds beyond `intent:create` over `repository` alone, or null when nothing. */
export function followUpFilingExcess(actor: { id?: string; role?: string; capabilities?: string[]; scope?: { repositories?: string[] } }, repository?: string | null) {
  if (actor.role === 'admin') return `${actor.id} is an admin, which can claim, approve and administer far beyond filing`;
  const extra = (actor.capabilities ?? []).filter(capability => capability !== 'intent:create');
  if (extra.length) return `operator agent ${actor.id} also holds ${extra.join(', ')}; the filing credential holds only intent:create`;
  const otherRepositories = repository ? (actor.scope?.repositories ?? []).filter(other => other !== repository) : [];
  return otherRepositories.length ? `operator agent ${actor.id} can also create work in ${otherRepositories.join(', ')}; the filing credential is scoped to ${repository} alone` : null;
}

/**
 * GY-1614: whether the control plane would admit the follow-up a failed release candidate files
 * with GRAPHYARD_RELEASE_TOKEN, judged from the principal that token authenticates as, and whether
 * that principal holds more than the filing identity's `intent:create`.
 */
export function releaseFilingCheck(filing: NonNullable<SetupFromZeroInput['releaseFiling']>, repository: string | null): SetupCheck {
  const filingRepository = repository ?? filing.status?.repository;
  const refusal = filing.status ? followUpFilingRefusal(filing.status.actor, filingRepository) : `the control plane did not accept the credential: ${filing.failure ?? 'no answer'}`;
  const excess = refusal ? null : followUpFilingExcess(filing.status.actor, filingRepository);
  return { id: 'release-filing', status: refusal || excess ? 'fail' : 'pass', step: setupSteps.releaseFiling,
    detail: refusal ? `GRAPHYARD_RELEASE_TOKEN would be refused filing a failed candidate's follow-up: ${refusal}`
      : excess ? `GRAPHYARD_RELEASE_TOKEN is broader than filing needs: ${excess}` : `GRAPHYARD_RELEASE_TOKEN files follow-ups as ${filing.status.actor.id}` };
}

/** The plane's answer to GRAPHYARD_RELEASE_TOKEN, at the server the CLI addresses (src/cli/context.ts), or undefined when it is unset. */
async function readReleaseFiling(root: string, env: NodeJS.ProcessEnv) {
  const token = env.GRAPHYARD_RELEASE_TOKEN;
  if (!token) return undefined;
  const base = env.GRAPHYARD_URL ?? (await readJson(resolve(root, '.graphyard/connection.json')))?.url ?? 'http://127.0.0.1:4310';
  return planeRequest(base, token)('status').then(status => ({ status }), (error: any) => ({ status: null, failure: String(error.message) }));
}

/** One printable line per check: `PASS id: detail`, or `FAIL id: detail (fix: step)`. */
export const setupLine = (check: SetupCheck) => check.status === 'pass' ? `PASS ${check.id}: ${check.detail}` : `FAIL ${check.id}: ${check.detail} (fix: ${check.step})`;

/**
 * GY-1859: the loop-code line. A loop or executor unit on another checkout or commit — a slot's
 * own registration commit included — is one FAIL naming both paths and the rerun that rewrites the
 * units to this CLI; an install whose units record is unreadable fails too, and a host holding no
 * unit of this install records no line at all, since there is nothing on it to judge.
 */
async function loopCodeCheck(root: string, injected: LoopCodeReading | null | undefined): Promise<SetupCheck | null> {
  // Read where the units run (up's readInstallLoopCode): a self-contained host's on that host, never this machine's.
  const code = injected !== undefined ? injected : await (await import('./up.js')).readInstallLoopCode(root).catch(() => null);
  const check = (status: SetupCheck['status'], detail: string): SetupCheck => ({ id: 'loop-code', status, step: setupSteps.loopCode, detail });
  if (!code) return check('fail', 'the units this install runs could not be read');
  if (code.error) return check('fail', `the units this install records are unreadable: ${code.error}`);
  if (!code.loop) return null;
  const stale = code.loopStale;
  if (stale) return check('fail', `${stale}: rerun graphyard up${code.repository ? ` --repo ${code.repository}` : ''} --agent from this checkout (${code.cli.root}); its master-loop step rewrites the units to it and restarts them`);
  return check('pass', `the loop${code.loop ? ` (${code.loop.unit} at ${code.loop.path})` : ''}${code.loopCommit ? ` at ${code.loopCommit.slice(0, 12)}` : ''} runs this checkout (${code.cli.root})`);
}

/**
 * GY-2159: the unit-overrides line. The install renders its loop and Herdr units whole and writes
 * no drop-in, so every drop-in systemd applies to one of them — a stopgap a person left on the host —
 * is one FAIL naming its path, the unit and the Environment it sets; none is one PASS. A checkout
 * recording no units (or not on Linux) prints no line; a manager that cannot be asked fails.
 */
async function unitOverridesChecks(root: string, systemctl: UserSystemctl, platform: NodeJS.Platform): Promise<SetupCheck[]> {
  if (platform !== 'linux') return [];
  let units;
  try { units = parseInstallUnits(await readFile(resolve(root, installUnitsFile), 'utf8'), installUnitsFile, () => { throw new Error('absent'); }); } catch { return []; }
  const check = (status: SetupCheck['status'], detail: string): SetupCheck => ({ id: 'unit-overrides', status, step: setupSteps.unitOverrides, detail });
  // The Herdr server this install runs: its own instance's unit when master.json records one, else the host's default.
  const master = await readFile(resolve(root, '.graphyard/master.json'), 'utf8').then(JSON.parse).catch(() => null);
  const herdr = herdrServerUnit(master?.herdrInstance && typeof master.repository === 'string' ? installIdFor(master.repository) : null);
  const overrides = new Map<string, string>();
  try {
    for (const unit of [units.master, herdr]) {
      const shown = String(await systemctl(['show', '--property=LoadState', '--property=DropInPaths', unit]));
      if (/^LoadState=not-found$/m.test(shown)) continue;
      for (const path of /^DropInPaths=(.*)$/m.exec(shown)?.[1].trim().split(/\s+/).filter(Boolean) ?? []) if (!overrides.has(path)) overrides.set(path, unit);
    }
  } catch (error: any) { return [check('fail', `systemctl --user could not be asked for the drop-ins on ${units.master} and ${herdr}: ${String(error.message).split('\n')[0]}`)]; }
  if (!overrides.size) return [check('pass', `no drop-in overrides ${units.master} or ${herdr}`)];
  return Promise.all([...overrides].map(async ([path, unit]) => {
    const sets = (await readFile(path, 'utf8').catch(() => '')).split(/\r?\n/).filter(line => /^\s*Environment(File)?=/.test(line)).map(line => line.trim());
    return check('fail', `${path} overrides ${unit}, which the install did not write${sets.length ? ` (${sets.join('; ')})` : ''}: rm ${path} && systemctl --user daemon-reload && systemctl --user restart ${unit}`);
  }));
}
const userManager: UserSystemctl = (args, timeoutMs = 30_000) => defaultChildRun('systemctl', ['--user', ...args], { timeoutMs });

/** Every setup-from-zero line for this machine and installation, in checklist order. */
export async function setupFromZeroChecks(input: SetupFromZeroInput): Promise<SetupCheck[]> {
  const env = input.env ?? process.env, status = input.status;
  const lines: SetupCheck[] = [];
  // Reachable and authenticated are separate facts (GY-1412): a plane whose /healthz answered is
  // never reported as unreachable because the credential is missing or refused.
  const credential = env.GRAPHYARD_TOKEN_FILE || env.GRAPHYARD_TOKEN || input.masterCredential ? 'refused' : 'missing';
  lines.push({ id: 'control-plane', status: status ? 'pass' : 'fail', step: setupSteps.install,
    detail: status ? `answered as role ${status.actor?.role ?? 'unknown'}` : `${input.reachable ? `reachable, credential ${credential}` : 'not reachable'}: ${input.failure ?? 'no answer'}` });
  lines.push(await credentialsCheck(input.root, env, input.masterCredential));
  // GY-1553: the control plane is the merge writer, so no App or reviewer App is needed: both lines
  // pass as not required, in the same words the Setup checklist uses.
  for (const [id, step] of [['github-app', setupSteps.app], ['reviewer-app', setupSteps.reviewer]] as const) lines.push({ id, status: 'pass', detail: mergerNotRequired, step });
  lines.push(...await environmentChecks(input.environments));
  lines.push(await sandboxCheck(input.root, input.sandbox ?? bubblewrapProbe));
  const loopCode = await loopCodeCheck(input.root, input.loopCode);
  if (loopCode) lines.push(loopCode);
  lines.push(...await unitOverridesChecks(input.root, input.systemctl ?? userManager, input.platform ?? process.platform));
  const releaseFiling = input.releaseFiling ?? await readReleaseFiling(input.root, env);
  if (releaseFiling) lines.push(releaseFilingCheck(releaseFiling, status?.repository ?? null));
  return lines;
}
