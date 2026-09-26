import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { Transport } from './transport.js';

export interface RuntimeDescriptor { kind: string; program: string; credentials: string[]; environment?: Record<string, string> }

/**
 * A detection table, not an authority: a runtime counts as usable only when its launcher is
 * on PATH and it already holds its own provider login. Graphyard never stores agent logins,
 * so an unlisted runtime is added by hand with `master worker add`.
 */
export const knownRuntimes: RuntimeDescriptor[] = [
  { kind: 'claude', program: 'claude', credentials: ['.claude/.credentials.json', '.claude.json', '.config/claude/.credentials.json'] },
  { kind: 'codex', program: 'codex', credentials: ['.codex/auth.json'] },
  { kind: 'cursor', program: 'cursor-agent', credentials: ['.cursor/cli-config.json', '.config/cursor-agent/config.json'] },
  { kind: 'opencode', program: 'opencode', credentials: ['.local/share/opencode/auth.json', '.config/opencode/auth.json'] },
  { kind: 'gemini', program: 'gemini', credentials: ['.gemini/oauth_creds.json'] },
  { kind: 'copilot', program: 'copilot', credentials: ['.config/github-copilot/apps.json', '.config/github-copilot/hosts.json'] },
  { kind: 'amp', program: 'amp', credentials: ['.config/amp/settings.json'] },
  { kind: 'droid', program: 'droid', credentials: ['.factory/auth.json'] },
  { kind: 'qwen', program: 'qwen', credentials: ['.qwen/oauth_creds.json'] },
  { kind: 'pi', program: 'pi', credentials: ['.pi/agent/auth.json'] },
];

/** `command -v` is a shell builtin, so PATH lookup runs through the target's shell. */
async function locate(transport: Transport, program: string) {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(program)) throw new Error('Runtime launcher names are restricted to simple identifiers');
  return transport.exec('sh', ['-c', `command -v ${program}`], { allowFailure: true, timeout: 30_000 }).catch(() => ({ stdout: '', stderr: '', code: 1 }));
}

export interface DetectedRuntime { kind: string; program: string; path: string; authenticated: boolean; reason: string }

export async function detectRuntimes(transport: Transport, home = homedir(), table = knownRuntimes): Promise<DetectedRuntime[]> {
  const detected: DetectedRuntime[] = [];
  for (const runtime of table) {
    const located = await locate(transport, runtime.program);
    const path = located.code === 0 ? located.stdout.trim().split('\n')[0] ?? '' : '';
    if (!path) continue;
    let authenticated = false;
    for (const candidate of runtime.credentials) {
      try { await access(resolve(home, candidate), constants.R_OK); authenticated = true; break; } catch { /* next candidate */ }
    }
    detected.push({ kind: runtime.kind, program: runtime.program, path, authenticated, reason: authenticated ? 'launcher on PATH with a stored provider login' : `launcher on PATH but no stored login under ${runtime.credentials[0]}; sign in to ${runtime.program} first` });
  }
  return detected;
}

export interface WorkerProfileDraft { name: string; principal: string; agentName: string; mode: 'launch'; kind: string; credentialFile: string; agentArgs: string[]; environment: Record<string, string> }
export interface ReviewerProfileDraft { name: string; runtime: string; reviewerApp: string; timeoutSeconds: number }

/** One worker principal to one runtime, round-robin, so no two sessions share a credential. */
export function workerProfiles(installId: string, principals: string[], runtimes: DetectedRuntime[], tokenFileFor: (principal: string) => string): WorkerProfileDraft[] {
  const usable = runtimes.filter(runtime => runtime.authenticated);
  if (!usable.length) return [];
  return principals.map((principal, index) => {
    const runtime = usable[index % usable.length];
    return { name: `${runtime.kind}-${index + 1}`, principal, agentName: `${installId}-${runtime.kind}-${index + 1}`, mode: 'launch' as const, kind: runtime.kind, credentialFile: tokenFileFor(principal), agentArgs: [], environment: {} };
  });
}

export function reviewerProfiles(runtimes: DetectedRuntime[], reviewer: string | null): ReviewerProfileDraft[] {
  if (!reviewer) return [];
  const usable = runtimes.filter(runtime => runtime.authenticated);
  return usable.slice(0, 1).map(runtime => ({ name: `${reviewer}-reviewer`, runtime: runtime.kind, reviewerApp: reviewer, timeoutSeconds: 1800 }));
}

export function masterRuntime(runtimes: DetectedRuntime[]) {
  return runtimes.find(runtime => runtime.authenticated) ?? null;
}

export interface HerdrState { available: boolean; version: string | null; reason: string }

export async function detectHerdr(transport: Transport): Promise<HerdrState> {
  const located = await locate(transport, 'herdr');
  if (located.code !== 0 || !located.stdout.trim()) return { available: false, version: null, reason: 'herdr is not on PATH; Graphyard runs without it and workers start from the CLI' };
  const version = await transport.exec('herdr', ['--version'], { allowFailure: true, timeout: 30_000 }).catch(() => ({ stdout: '', stderr: '', code: 1 }));
  return { available: true, version: version.code === 0 ? version.stdout.trim().split('\n')[0] ?? null : null, reason: 'herdr is available; repository setup links and enables the Graphyard plugin' };
}
