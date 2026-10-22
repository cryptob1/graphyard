// Concern: GY-1585 — the held-cli snapshot pin: the release the checkout's launcher runs while a
// restart is held (GY-1585) or a dirty checkout is upgraded by snapshot (GY-1773), the snapshot's
// launcher the supervisor units start under it (GY-1790), and what master status says of the
// checkout left behind. Split out of upgrade.ts, which re-exports it.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where the launcher reads the release a held restart pins the CLI to (GY-1585): `{ commit, root, loop }`. */
export const heldCliPointer = (root: string) => join(root, '.graphyard', 'held-cli.json');
/** The directory held snapshots are checked out under; the loop reads whether its own modules came from one. */
export const heldCliSnapshots = (root: string) => join(root, '.graphyard', 'held-cli');
/** The directory a held snapshot of `commit` is checked out under. */
export const heldCliSnapshotAt = (root: string, commit: string) => join(heldCliSnapshots(root), commit.slice(0, 12));
/**
 * The commit a held restart pins the CLI to now, or null when no pin stands, it is unreadable, or
 * the launcher would not load it (its snapshot has no `src/cli.ts`, as bin/held-release-hooks.mjs
 * reads it). GY-1619: the fleet report reads it, and corroborates it with the cursor's held restart.
 */
export function readHeldCli(root: string): string | null {
  try {
    const pin = JSON.parse(readFileSync(heldCliPointer(root), 'utf8'));
    return typeof pin?.commit === 'string' && pin.commit && typeof pin.root === 'string' && existsSync(join(pin.root, 'src', 'cli.ts')) ? pin.commit : null;
  } catch { return null; }
}

/**
 * GY-1790: the launcher a supervisor unit starts while the pin stands — the held snapshot's own
 * bin/graphyard.mjs, so launcher files the checkout holds dirty (bin/graphyard.mjs,
 * bin/held-release-hooks.mjs) are never the code that boots the loop. The unit hands
 * the checkout to it in the environment (GRAPHYARD_CHECKOUT_ROOT), so the snapshot's launcher reads
 * the checkout's pin and configuration while its own code loads. Null when no pin stands: the
 * checkout's launcher (config.cliPath) runs, as it always has.
 */
export const heldLauncherOf = (root: string, held = readHeldCli(root)): string | null =>
  held ? join(heldCliSnapshotAt(root, held), 'bin', 'graphyard.mjs') : null;
