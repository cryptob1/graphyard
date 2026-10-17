import { defineCommands } from './registry.js';
import { cliRelease, type Release } from '../release.js';

/** How long `graphyard version` waits for the server's /healthz before reporting it unreachable. */
export const versionProbeTimeoutMs = 5_000;

export interface VersionReport {
  cli: { version: string; commit: string };
  server: { url: string; version: string | null; commit: string | null; error?: string } | null;
}

/**
 * The CLI's own release and, when this invocation is connected (GRAPHYARD_URL or a connection
 * file), the release the server's /healthz reports. An unreachable server is named, not fatal.
 */
export async function versionReport(release: Release, server: string | null, fetchImpl: typeof fetch = fetch): Promise<VersionReport> {
  const cli = { version: release.version, commit: release.revision };
  if (!server) return { cli, server: null };
  try {
    const response = await fetchImpl(`${server}/healthz`, { signal: AbortSignal.timeout(versionProbeTimeoutMs) });
    const body = await response.json() as { version?: unknown; commit?: unknown; revision?: unknown };
    const commit = typeof body.commit === 'string' ? body.commit : typeof body.revision === 'string' ? body.revision : null;
    return { cli, server: { url: server, version: typeof body.version === 'string' ? body.version : null, commit } };
  } catch (error: any) {
    return { cli, server: { url: server, version: null, commit: null, error: String(error?.message ?? error) } };
  }
}

export function renderVersion(report: VersionReport) {
  const lines = [`cli     ${report.cli.version} (commit ${report.cli.commit})`];
  const server = report.server;
  if (!server) lines.push('server  not connected (set GRAPHYARD_URL or run onboard)');
  else if (server.error) lines.push(`server  ${server.url} unreachable: ${server.error}`);
  else lines.push(`server  ${server.version ?? 'unknown'} (commit ${server.commit ?? 'unknown'}) at ${server.url}`);
  if (server && !server.error && server.version !== report.cli.version) lines.push('note    the CLI and the server run different releases');
  return lines.join('\n');
}

export const versionCommands = defineCommands([{
  name: 'version',
  help: [
    '  version [--json]              The CLI\'s release (the dated tag on its commit, else',
    '                                `unreleased <sha>`) and commit, and the connected server\'s',
    '                                release and commit from its /healthz',
  ],
  async run(context) {
    const connected = process.env.GRAPHYARD_URL || context.connection?.url ? context.base : null;
    const report = await versionReport(cliRelease(), connected);
    console.log([context.id, ...context.args].includes('--json') ? JSON.stringify(report, null, 2) : renderVersion(report));
  },
}]);
