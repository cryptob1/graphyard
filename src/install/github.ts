import type { Transport } from './transport.js';

export interface GitHubCli { (args: string[], options?: { input?: string; allowFailure?: boolean }): Promise<{ stdout: string; stderr: string; code: number }> }

export function githubCli(transport: Transport): GitHubCli {
  return (args, options = {}) => transport.exec('gh', args, { input: options.input, allowFailure: options.allowFailure, timeout: 180_000 });
}

export async function ghJson(gh: GitHubCli, args: string[], fallback: unknown = null) {
  const result = await gh(args, { allowFailure: true });
  if (result.code !== 0) return fallback;
  try { return JSON.parse(result.stdout); } catch { return fallback; }
}

export async function headSha(gh: GitHubCli, repository: string, branch: string) {
  const reference = await ghJson(gh, ['api', `repos/${repository}/commits/${branch}`], null) as any;
  const sha = String(reference?.sha ?? '');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Cannot read the head commit of ${repository}@${branch}`);
  return sha;
}
