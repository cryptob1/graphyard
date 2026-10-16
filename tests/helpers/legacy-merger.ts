import type { Store } from '../../src/store.js';
import { mergerEventKind } from '../../src/merger-mode.js';

/**
 * GY-1833: a plane with no recorded merger reads as control-plane, the shipped default. A test of the
 * github-mode (legacy) path records `github` on its fresh database first, as `graphyard up --merger
 * github` does on an install, so pull-request submissions and the GitHub gates apply.
 */
export async function recordLegacyMerger(store: Pick<Store, 'pool'>) {
  await store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)',
    ['test-fixture', mergerEventKind, JSON.stringify({ merger: 'github', reason: 'this test exercises the legacy github merger', previous: null })]);
}
