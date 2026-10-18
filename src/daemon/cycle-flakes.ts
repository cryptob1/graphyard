// Concern: the flake ledger (GY-1498) — the loop's step, beside the base-failure step. Each merge
// trial flake the writer recorded on an item's merge ledger (GY-1834) is taken once with its tests
// named; its tests are kept in the bounded ledger file, and a test gets one
// fix item — on its first flake when it is no criterion proof of its item, else once it flakes repeatedly — filed as the operator-agent through
// fileFaultClass as the docs trim item is. It only reads the items: no rerun count, revert or gate
// reads the ledger. The pure half is model/flake-ledger.ts, the file flake-ledger.ts.
import { createHash } from 'node:crypto';
import { flakyItem, flakyItemTitle, flakyTests, mayFile, noteClosedFlakyItems, openFlakyItem, recordTrialFlake, trialFlakes, type FlakeLedger } from '../model/flake-ledger.js';
import type { FlakeLedgerStore } from '../flake-ledger.js';
import { readyToRetry } from './sessions.js';
import { message } from './state.js';
import { record } from './effects.js';
import type { Cycle } from './cycle.js';

// The ledger a store last read or wrote, kept across this loop's cycles.
const ledgers = new WeakMap<FlakeLedgerStore, FlakeLedger>();
const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
/** The loop's action key for the fix item of one test. */
export const flakyActionKey = (test: string) => `fault:flaky-test:${digest(test)}`;

/** Step 3b. Read new flakes into the ledger and file one fix item per repeatedly flaky test. */
export async function flakeStep(cycle: Cycle) {
  const { state, effects, snapshot, clock, now, performed } = cycle;
  const store = effects.flakeLedger;
  if (!store) return;
  let ledger = ledgers.get(store);
  if (!ledger) ledgers.set(store, ledger = await store.read());
  let changed = false;

  // 1. The merge writer's trial flakes (GY-1834), kept on each item's merge ledger, name their tests already: each merge commit is recorded once.
  for (const flake of trialFlakes(snapshot.work)) if (recordTrialFlake(ledger, flake, clock)) changed = true;

  // 2. A filed item the snapshot shows closed starts its quiet period; an open one the ledger lost is adopted.
  if (noteClosedFlakyItems(ledger, snapshot.work, clock)) changed = true;
  for (const flaky of flakyTests(ledger, clock)) {
    const standing = openFlakyItem(snapshot.work, flaky.test);
    if (standing && ledger.filed[flaky.test]?.key !== standing.key) { ledger.filed[flaky.test] = { key: standing.key, at: new Date(clock).toISOString(), closedAt: null }; changed = true; }
  }

  // 3. One fix item per flaky test; nothing more while it is open, nor within the quiet period after it closes.
  if (effects.fileFaultClass) for (const flaky of flakyTests(ledger, clock)) {
    if (!mayFile(ledger, snapshot.work, flaky.test, clock)) continue;
    const key = flakyActionKey(flaky.test), previous = state.actions[key];
    if (previous?.state === 'failed' && !readyToRetry(previous, state.cycle)) continue;
    const attempts = previous?.state === 'failed' ? previous.attempts + 1 : 1;
    // One key per test and the oldest flake in its window, so a retry after a lost reply returns the item already filed.
    const idempotency = `flaky-test:${digest(flaky.test)}:${flaky.flakes[0].failedRunId || flaky.flakes[0].sha.slice(0, 12)}`;
    try {
      const filed = await effects.fileFaultClass(flakyItem(flaky), idempotency);
      ledger.filed[flaky.test] = { key: filed.key, at: new Date(clock).toISOString(), closedAt: null };
      changed = true;
      const why = flaky.flakes.some(entry => entry.ownProof === false) ? 'it passed only on rerun of a head it is no criterion proof of' : `it passed only on rerun ${flaky.flakes.length} times on ${flaky.shas.length} commits within 7 days`;
      performed.push(await record(state, key, { kind: 'fault', work: filed.key, principal: null, state: 'done', detail: `Filed ${filed.key} (${flakyItemTitle(flaky.test)}): ${why}; nothing more is filed for it while it is open or for 7 days after it closes`.slice(0, 2000), attempts, cycle: state.cycle }, now(), effects.persist));
    } catch (error) {
      performed.push(await record(state, key, { kind: 'fault', work: null, principal: null, state: 'failed', detail: `Could not file the fix item for the flaky test "${flaky.test}": ${message(error)}`.slice(0, 2000), attempts, cycle: state.cycle }, now(), effects.persist));
    }
  }
  if (changed) await store.write(ledger);
}
