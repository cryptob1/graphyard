import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { assertAncestryFixed } from '../../src/runner-executor.js';

// The host attestor refuses an oracle bundle or collection boundary unless every directory
// above it belongs to the attestor's own account or to root (`assertAncestryFixed`). A worker
// sandbox — bubblewrap, or any user namespace that maps only the session's account — stats
// root's /tmp and /home as the overflow uid 65534, so no fixture a test can create there is
// attestable, and a test that needs an attested run would fail for the host, not the code
// (GY-966). tests/helpers/unprivileged-stat.mjs simulates that sandbox on any host.

/** The refusal the attestor raises for the directories above PATH on this host, or null when they hold. */
export async function ancestryRefusal(path: string, uid = process.getuid!()) {
  try { await assertAncestryFixed(path, uid, 'approved oracle bundle'); return null; } catch (error) { return (error as Error).message; }
}

/**
 * Whether the fixture under ROOT can be attested here. When it can, the test runs in full.
 * When this host's ancestry fails the ownership rule, `refuses` — the attestor's own check of
 * the fixture — must reject with an ownership refusal of a directory above it, the test records an
 * environment note, and the caller stops: what the host allows is asserted, and nothing that
 * needs an attested run is claimed.
 */
export async function attestable(t: TestContext, root: string, refuses: () => Promise<unknown>) {
  const uid = process.getuid!();
  if (!await ancestryRefusal(root, uid)) return true;
  const error = await refuses().then(() => null, (failure: Error) => failure);
  assert.ok(error, `the attestor accepted ${root} although a directory above it fails the ownership rule`);
  assert.match(error.message, /Every directory leading to the .+ must be owned by the supervising attestor identity or by root: /);
  // The attestor names the deepest foreign ancestor it sees. A child attestor may see a
  // different one than this process does (a simulated sandbox follows each process's own
  // temporary directory), so the refusal must name some directory above the fixture that
  // this process, too, sees owned by neither this account nor root.
  const unowned = error.message.slice(error.message.lastIndexOf(': ') + 2).trim();
  const above = relative(unowned, resolve(root));
  assert.ok(isAbsolute(unowned) && above !== '' && !above.startsWith('..') && !isAbsolute(above), `the attestor refused ${unowned}, which is not above ${root}: ${error.message}`);
  const owner = (await lstat(unowned)).uid;
  assert.ok(owner !== uid && owner !== 0, `the attestor refused ${unowned}, which this process sees owned by uid ${owner}: ${error.message}`);
  t.diagnostic(`environment note (GY-966): ${unowned} stats as uid ${owner}, an account that is neither this one nor root, as a worker sandbox reports root-owned /tmp and /home; the attestor's ownership refusal of this fixture was asserted in place of an attested run`);
  return false;
}
