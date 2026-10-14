// A serve entry that stops the checkout's writers and never reaches its own thaw (review of GY-1680),
// for tests/checkout-restore-release.test.ts: the loop's timeout on the snapshot's CLI ends it with
// SIGTERM, which runs no `finally`, so what it stopped stays stopped unless the loop continues it from
// the freeze ledger the freeze wrote before each SIGSTOP. It freezes the pids GRAPHYARD_TEST_HANG_WRITERS
// names (recording the signals instead of sending them) with the ledger at GRAPHYARD_TEST_FREEZE_LEDGER,
// writes what it did and the ledger as written to GRAPHYARD_TEST_SERVE_RECORD, then sleeps.
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { freezeCheckoutWriters } from '../../src/cli/checkout-writers.js';

const ledger = process.env.GRAPHYARD_TEST_FREEZE_LEDGER!, record = process.env.GRAPHYARD_TEST_SERVE_RECORD!;
const pids = (process.env.GRAPHYARD_TEST_HANG_WRITERS ?? '').split(',').filter(Boolean).map(Number);
const sent: string[] = [];
const frozen = await freezeCheckoutWriters(process.env.GRAPHYARD_TEST_HANG_ROOT ?? process.cwd(), {
  ledger, scan: () => pids, signal: (pid, name) => { sent.push(`${name}:${pid}`); }, state: pid => sent.includes(`SIGSTOP:${pid}`) ? 'T' : 'S', settleMs: 50, pollMs: 1,
});
writeFileSync(record, JSON.stringify({ pid: process.pid, sent, stopped: frozen.stopped, ledger: JSON.parse(readFileSync(ledger, 'utf8')) }));
await delay(Number(process.env.GRAPHYARD_TEST_HANG_MS ?? 60_000));
frozen.thaw();
