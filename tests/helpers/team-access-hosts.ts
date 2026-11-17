import { syncTeamAccess, type TeamAccessOptions } from '../../src/master/team-access.js';

/**
 * GY-3411: every install's master loop on one shared host, run until what any install's owner saved
 * shows on all of them. A loop reads the machine and reports it in one pass, so an install whose
 * loop ran before the saving install's sees the change only on its next pass: two passes in turn
 * settle any order. Callers then read once, with no retry loop racing the loops.
 */
export async function settleHostLoops(installs: { url: string; credentialFile: string }[], options: TeamAccessOptions) {
  for (let pass = 0; pass < 2; pass++) for (const { url, credentialFile } of installs) await syncTeamAccess({ url, credentialFile }, options);
}
