import { access, lstat, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { protectionPlan, protectionRun, readProtection, type ProtectionRun } from './protection.js';
import { checkAgentEnvironment, discoverAgentEnvironments } from './master/environments.js';
import type { AgentEnvironment } from './master/profiles.js';
import { sharedGitPaths, workerPaths } from './worker-sandbox.js';

/**
 * The prerequisites docs/setup-from-zero.md depends on that `graphyard doctor` can check from this
 * machine (GY-1352). Each is a named pass/fail line naming the checklist step that fixes it, so an
 * agent setting Graphyard up from nothing reads the next step off doctor's output instead of guessing.
 */
export const setupSteps = {
  install: 'docs/setup-from-zero.md step 3 (install the control plane)',
  app: 'docs/setup-from-zero.md step 4 (register the GitHub App)',
  reviewer: 'docs/setup-from-zero.md step 5 (reviewer and revert-approver Apps)',
  protection: 'docs/setup-from-zero.md step 7 (branch protection)',
  environments: 'docs/setup-from-zero.md step 8 (agent environments)',
  sandbox: 'docs/setup-from-zero.md step 9 (worker sandbox)',
} as const;

export interface SetupCheck { id: string; status: 'pass' | 'fail'; detail: string; step: string }

export interface SetupFromZeroInput {
  /** The managed repository's checkout doctor runs in. */
  root: string;
  env?: NodeJS.ProcessEnv;
  /** The server's GET /api/status answer, or null with the failure when it did not answer. */
  status: any | null;
  failure?: string;
  /** Where the agent environments live (`~/.coding_agents` unless GRAPHYARD_AGENT_ENVIRONMENTS). */
  environments: string;
  /** `gh` for the branch-protection read; tests pass a fixture. */
  github?: ProtectionRun;
  /** Probes that the worker confinement can write PATHS; null when it can, else the reason. */
  sandbox?: (paths: string[]) => string | null;
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

async function credentialsCheck(root: string, env: NodeJS.ProcessEnv): Promise<SetupCheck> {
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
 * The reviewer App is bound either on the server (GRAPHYARD_REVIEWER_APPS, for agent review
 * policies) or to the master (`master reviewer setup`/`bind`, recorded in .graphyard/master.json
 * with its 0600 credential outside the repository); either is a separate identity that can review.
 */
async function reviewerCheck(root: string, status: any): Promise<SetupCheck> {
  const check = (pass: boolean, detail: string): SetupCheck => ({ id: 'reviewer-app', status: pass ? 'pass' : 'fail', detail, step: setupSteps.reviewer });
  const served = Array.isArray(status?.reviewerApps) ? status.reviewerApps : [];
  if (served.length) return check(true, `GRAPHYARD_REVIEWER_APPS names ${served.map((app: any) => `${app.id} (App ${app.appId})`).join(', ')}`);
  const bound = (await readJson(resolve(root, '.graphyard/master.json')))?.reviewer;
  if (!bound?.credentialFile) return check(false, 'no reviewer App: GRAPHYARD_REVIEWER_APPS is empty and .graphyard/master.json binds no reviewer');
  const info = await lstat(bound.credentialFile).catch(() => null);
  if (!info?.isFile()) return check(false, `the bound reviewer App ${bound.slug ?? bound.appId}'s credential ${bound.credentialFile} is missing`);
  if (info.mode & 0o077) return check(false, `the bound reviewer App's credential ${bound.credentialFile} has mode 0${(info.mode & 0o777).toString(8)}; it must be 0600`);
  return check(true, `reviewer App ${bound.slug ?? ''} (App ${bound.appId}) is bound to the master`);
}

function protectionCheck(status: any, github: ProtectionRun): SetupCheck {
  const check = (pass: boolean, detail: string): SetupCheck => ({ id: 'branch-protection', status: pass ? 'pass' : 'fail', detail, step: setupSteps.protection });
  const repository = status?.githubRepository?.fullName ?? status?.githubRepository, baseBranch = status?.baseBranch ?? 'main', githubAppId = status?.githubAppId;
  if (!repository || !githubAppId) return check(false, 'depends on the GitHub App: the server reports no bound App');
  let current;
  try { current = readProtection({ repository, baseBranch }, github); } catch (error: any) { return check(false, `${repository} ${baseBranch} protection is unreadable (none, or gh is not a repository admin): ${String(error.message).split('\n')[0]}`); }
  const plan = protectionPlan(current, { repository, baseBranch, githubAppId }, [], undefined, []);
  const gaps = [...plan.blockers, ...(plan.landableCheck ? [] : ['graphyard/landable is not a required check'])];
  return check(!gaps.length, gaps.length ? gaps.join('; ') : `${baseBranch} requires Graphyard / merge and graphyard/landable from App ${githubAppId}`);
}

/** One printable line per check: `PASS id: detail`, or `FAIL id: detail (fix: step)`. */
export const setupLine = (check: SetupCheck) => check.status === 'pass' ? `PASS ${check.id}: ${check.detail}` : `FAIL ${check.id}: ${check.detail} (fix: ${check.step})`;

/** Every setup-from-zero line for this machine and installation, in checklist order. */
export async function setupFromZeroChecks(input: SetupFromZeroInput): Promise<SetupCheck[]> {
  const env = input.env ?? process.env, status = input.status;
  const lines: SetupCheck[] = [];
  lines.push({ id: 'control-plane', status: status ? 'pass' : 'fail', step: setupSteps.install, detail: status ? `answered as role ${status.actor?.role ?? 'unknown'}` : `not reachable: ${input.failure ?? 'no answer'}` });
  lines.push(await credentialsCheck(input.root, env));
  const missing = status?.appPermissions?.missing ?? [];
  const appBound = !!status?.github, verified = !!status?.appPermissions?.verifiedAt;
  lines.push({ id: 'github-app', status: appBound && verified && !missing.length ? 'pass' : 'fail', step: setupSteps.app,
    detail: !status ? 'depends on the control plane' : !appBound ? 'the server reports no bound GitHub App' : !verified ? 'the App-permission preflight has not run' : missing.length ? `missing permissions: ${missing.map((entry: any) => `${entry.permission} ${entry.required}`).join(', ')}` : `App ${status.githubAppId} is bound with every permission the plan needs` });
  lines.push(await reviewerCheck(input.root, status));
  lines.push(status ? protectionCheck(status, input.github ?? protectionRun) : { id: 'branch-protection', status: 'fail', detail: 'depends on the control plane', step: setupSteps.protection });
  lines.push(...await environmentChecks(input.environments));
  lines.push(await sandboxCheck(input.root, input.sandbox ?? bubblewrapProbe));
  return lines;
}
