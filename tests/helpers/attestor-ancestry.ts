import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
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
 * the fixture — must reject with exactly that ownership refusal, the test records an
 * environment note, and the caller stops: what the host allows is asserted, and nothing that
 * needs an attested run is claimed.
 */
export async function attestable(t: TestContext, root: string, refuses: () => Promise<unknown>) {
  const refusal = await ancestryRefusal(root);
  if (!refusal) return true;
  const unowned = refusal.slice(refusal.lastIndexOf(': ') + 2);
  await assert.rejects(refuses(), (error: Error) => {
    assert.match(error.message, /Every directory leading to the .+ must be owned by the supervising attestor identity or by root: /);
    assert.ok(error.message.includes(`: ${unowned}`), `the attestor refused ${unowned}: ${error.message}`);
    return true;
  });
  t.diagnostic(`environment note (GY-966): ${unowned} stats as uid ${(await lstat(unowned)).uid}, an account that is neither this one nor root, as a worker sandbox reports root-owned /tmp and /home; the attestor's ownership refusal of this fixture was asserted in place of an attested run`);
  return false;
}

