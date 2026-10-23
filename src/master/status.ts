
import { MERGE_PROTOCOL } from '../protocol-version.js';

/**
 * The version-skew guard the broker runs before touching a merge. The CLI and the server
 * each declare the merge protocol they speak; a server behind the CLI — main merged, the
 * deployment never served it — is reported as exactly that, with both commits, instead of
 * the broker failing later on a reply shape it does not recognize. A server that reports no
 * protocol predates the exchange and is version 1.
 */
export function mergeProtocolSkew(status: { build?: { commit?: string | null; protocol?: number | null } | null } | undefined, cli: { commit: string | null; protocol?: number }): string | null {
  const serverProtocol = status?.build?.protocol ?? 1, cliProtocol = cli.protocol ?? MERGE_PROTOCOL;
  if (serverProtocol === cliProtocol) return null;
  const serverCommit = status?.build?.commit ?? 'an unknown commit', cliCommit = cli.commit ?? 'an unknown commit';
  return `server runs ${serverCommit}, CLI expects ${cliCommit}: deploy main first (server merge protocol ${serverProtocol}, CLI merge protocol ${cliProtocol}${serverProtocol < cliProtocol ? '; the deployment has not served the commit the CLI runs' : '; update the CLI checkout to the deployed commit'})`;
}
/** Hold ages and bounds read in hours to one decimal: `1.5h`, `2h`. */
export const hours = (ms: number) => `${Math.round(ms / 360_000) / 10}h`;
