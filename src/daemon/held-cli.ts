// Concern: GY-1585 — the held-cli snapshot pin: the release the checkout's launcher runs while a
// restart is held (GY-1585) or a dirty checkout is upgraded by snapshot (GY-1773), the snapshot's
// launcher the supervisor units start under it (GY-1790), and what master status says of the
// checkout left behind. Split out of upgrade.ts, which re-exports it.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildRun } from '../child-runner.js';
import { readCommit, shortCommit } from '../executor-fleet.js';
import { agentOwner, type AttentionItem } from '../master/attention.js';

/** The launcher files the checkout's own starts run (GY-1790): named on the attention when dirty. */
export const launcherFiles = ['bin/graphyard.mjs', 'bin/held-release-hooks.mjs'];
/** Whether two commits name the same one, either abbreviated. */
export const sameCommit = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));

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
 * Pins the CLI the checkout's launcher runs to `commit` while a restart is held (GY-1585), or lifts
 * the pin (null). The checkout already holds the merged tip, but every process `bin/graphyard.mjs`
 * starts — watch, claim, heartbeat, the credential push the loop and the executors spawn — must
 * speak the protocol of the release production serves: a shared clone of that release is checked
 * out under `.graphyard/held-cli/`, and the pointer naming it is written by rename, so a launcher
 * reads the old pin or the new one. Snapshots other than the new pin and the one it replaces (a
 * process started under it may still be loading modules) are removed. The executor entry reads the
 * same pointer, so a supervised executor loads the snapshot and takes its commit for the checkout's.
 */
export async function holdCliAt(root: string, run: ChildRun, commit: string | null): Promise<void> {
  const pointer = heldCliPointer(root);
  if (!commit) { await rm(pointer, { force: true }); return; }
  let current: { commit?: unknown; root?: unknown } | null = null;
  try { current = JSON.parse(readFileSync(pointer, 'utf8')); } catch { /* no pin yet */ }
  const snapshots = heldCliSnapshots(root), target = heldCliSnapshotAt(root, commit);
  if (current?.commit === commit && current.root === target && existsSync(join(target, 'src', 'cli.ts'))) return;
  await rm(target, { recursive: true, force: true });
  await run('git', ['clone', '-q', '--shared', '--no-checkout', root, target]);
  await run('git', ['-C', target, 'checkout', '-q', '--detach', commit]);
  // `loop`: whether a loop restarted onto the snapshot reads the hold's cursor and keeps holding — a
  // release from before GY-1585 would refuse its `release-lagged` stall, so the launcher keeps such a
  // restarted loop on the checkout's code instead.
  let loop = false;
  try { loop = readFileSync(join(target, 'src', 'daemon', 'state.ts'), 'utf8').includes("'release-lagged'"); } catch { /* no state module: not a loop that holds */ }
  await mkdir(dirname(pointer), { recursive: true });
  await writeFile(`${pointer}.tmp`, `${JSON.stringify({ commit, root: target, loop })}\n`);
  await rename(`${pointer}.tmp`, pointer);
  for (const entry of await readdir(snapshots)) {
    const path = join(snapshots, entry);
    if (path !== target && path !== current?.root) await rm(path, { recursive: true, force: true });
  }
}

/**
 * GY-1790: the launcher a supervisor unit starts while the pin stands — the held snapshot's own
 * bin/graphyard.mjs, so launcher files the checkout holds dirty (bin/graphyard.mjs,
 * bin/held-release-hooks.mjs) are never the code that boots the loop or an executor. The unit hands
 * the checkout to it in the environment (GRAPHYARD_CHECKOUT_ROOT), so the snapshot's launcher reads
 * the checkout's pin and configuration while its own code loads. Null when no pin stands: the
 * checkout's launcher (config.cliPath) runs, as it always has.
 */
export const heldLauncherOf = (root: string, held = readHeldCli(root)): string | null =>
  held ? join(heldCliSnapshotAt(root, held), 'bin', 'graphyard.mjs') : null;
/**
 * GY-1790: the entry a supervised executor slot starts while the pin stands — the held snapshot's
 * own scripts/graphyard-executor.mjs, the unit handing it the checkout as it hands the launcher —
 * so an entry the checkout holds dirty never boots a slot. Null when no pin stands: the checkout's.
 * The one definition the restart and an executor reinstall (`installExecutorSupervision`) share.
 */
export const heldExecutorEntryOf = (root: string, held = readHeldCli(root)): string | null =>
  held ? join(heldCliSnapshotAt(root, held), 'scripts', 'graphyard-executor.mjs') : null;

/**
 * GY-1773: the commit of the held snapshot this process's modules were loaded from — the launcher
 * pinned `master run` to it — or null for a process loaded from the checkout. The loop's checkout
 * guard reads it at startup: such a loop runs the snapshot, never the dirty checkout beside it, so
 * that checkout refuses it nothing; its cursor records the snapshot's commit as its release.
 */
export function loadedHeldSnapshot(root: string, loadedFrom = fileURLToPath(import.meta.url), read: (directory: string) => string | null = directory => readCommit(directory)): string | null {
  const snapshot = relative(heldCliSnapshots(root), loadedFrom).split(sep)[0];
  if (!snapshot || snapshot === '..' || isAbsolute(snapshot)) return null;
  try { return read(join(heldCliSnapshots(root), snapshot)); } catch { return null; }
}

/**
 * GY-1773: what `master status` names while the loop and the executors run a held snapshot of a
 * merged commit because the coordinator checkout stood dirty when the self-upgrade ran and was
 * left where it stands — only while the pin stands at that commit (`held`, from readHeldCli):
 * the dirty paths, and the move onto the commit that lifts it.
 */
export function leftBehindCheckoutAttention(left: { at: string; commit: string; checkout: string | null; dirty: string[] } | null | undefined, held: string | null, root: string): AttentionItem[] {
  if (!left || !sameCommit(held, left.commit)) return [];
  const named = left.dirty.length ? ` (dirty: ${left.dirty.slice(0, 8).join(', ')}${left.dirty.length > 8 ? `; and ${left.dirty.length - 8} more` : ''})` : '';
  // The checkout since moved onto the commit, but still dirty: the pin stays until it is clean there.
  const onto = sameCommit(left.checkout, left.commit);
  // GY-1790: the supervised starts run the launcher held in the snapshot, never the checkout's; a
  // command started through the checkout's launcher (config.cliPath) still runs its bin/graphyard.mjs,
  // which reads the pin without loading the checkout's hooks module and registers the snapshot's.
  const launcher = left.dirty.filter(path => launcherFiles.includes(path));
  const bootstrap = launcher.length ? ` The checkout's launcher (${launcher.join(', ')}) is dirty too: the loop and the executors start the launcher held in the snapshot, so their starts never run those edits; ${launcher.includes('bin/graphyard.mjs') ? 'every command started through the checkout\'s launcher still runs its edited bin/graphyard.mjs before the pin redirects any module, so return it to the commit first' : 'the checkout\'s launcher reads the pin without loading its own bin/held-release-hooks.mjs and registers the snapshot\'s, so the edit loads nowhere while the pin stands'}.` : '';
  // A clean detached checkout moved by hand to a foreign commit while the pin stands (recorded with no dirty paths): named where it stands, never taken for the lift.
  const where = onto ? `holds that commit but is still dirty${named}` : left.dirty.length ? `stood dirty at ${shortCommit(left.checkout)}${named} when the self-upgrade ran at ${left.at} and was left where it stands` : `stands clean at ${shortCommit(left.checkout)}, moved there by hand while the pin stands, which is neither the commit the loop runs nor where the self-upgrade at ${left.at} left it`;
  return [{ subject: 'upgrade', text: `The loop and the executors run ${shortCommit(left.commit)} from its held snapshot under ${root}/.graphyard/held-cli, not from the coordinator checkout, which ${where}; every command the checkout's launcher starts loads the snapshot while the pin stands.${bootstrap}`,
    ...agentOwner('master', onto ? `Return the checkout's tracked files to the commit, which lifts the pin: git -C ${root} status --porcelain names them (graphyard master checkout-restore REASON saves the dirty paths and returns them to HEAD)`
      : `Move the checkout onto the commit the loop runs and clean it there, which lifts the pin: git -C ${root} status --porcelain names what is in it, and git -C ${root} checkout --detach ${left.commit} moves it (graphyard master checkout-restore REASON saves the dirty paths and returns them to HEAD first)`) }];
}
