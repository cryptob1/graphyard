import type { Transport } from './transport.js';

export interface GitHubCli { (args: string[], options?: { input?: string; allowFailure?: boolean }): Promise<{ stdout: string; stderr: string; code: number }> }

export function githubCli(transport: Transport): GitHubCli {
  return (args, options = {}) => transport.exec('gh', args, { input: options.input, allowFailure: options.allowFailure, timeout: 180_000 });
}
