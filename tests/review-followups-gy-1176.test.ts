import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Refusal } from '../src/model/refusal.js';
import { followUpShipReceiptKey, idempotencyKeyLimit } from '../src/model/followups-held.js';

const parent = { pendingFollowUps: { at: '2026-10-02T12:00:00.000Z', findings: [{ path: 'src/a.ts', text: 'f1' }] } } as any;

test('manual:review-followups-triaged GY-1176.1: the ship route refuses a raw Idempotency-Key past the limit before scoping it (findings 2, 6, 9)', () => {
  const tooLong = 'k'.repeat(idempotencyKeyLimit + 1);
  for (const held of [parent, { pendingFollowUps: null }]) {
    assert.throws(() => followUpShipReceiptKey(tooLong, held), (error: unknown) => error instanceof Refusal && error.status === 400);
  }
  assert.throws(() => followUpShipReceiptKey('', parent), (error: unknown) => error instanceof Refusal && error.status === 400);
  const atLimit = 'k'.repeat(idempotencyKeyLimit);
  assert.ok(followUpShipReceiptKey(atLimit, parent).length <= idempotencyKeyLimit, 'a key at the limit is accepted and scoped within it');
});

test('manual:review-followups-triaged GY-1176.2: receipt() and the ship route share one key limit (findings 4, 7, 10)', () => {
  assert.equal(idempotencyKeyLimit, 200);
  const decisions = readFileSync(new URL('../src/server/decisions.ts', import.meta.url), 'utf8');
  assert.match(decisions, /key\.length <= idempotencyKeyLimit/);
  const held = readFileSync(new URL('../src/model/followups-held.ts', import.meta.url), 'utf8');
  const body = held.slice(held.indexOf('export function followUpShipReceiptKey'), held.indexOf('/** The ledger kind'));
  assert.doesNotMatch(body, /\b200\b/, 'the scoped key reads the shared limit');
});

test('manual:review-followups-triaged GY-1176.3: workerSlotWait keeps its JSDoc (findings 3, 5, 8)', () => {
  const source = readFileSync(new URL('../src/model/action-kinds.ts', import.meta.url), 'utf8');
  assert.match(source, /stalls on the standard threshold\.\n \*\/\nexport function workerSlotWait/);
});

test('manual:review-followups-triaged GY-1176.4: the protocol documents the key bound and the ship route scoping (finding 1)', () => {
  const doc = readFileSync(new URL('../docs/protocol/work-commands.md', import.meta.url), 'utf8');
  assert.match(doc, /`Idempotency-Key` of at most 200 characters/);
  assert.match(doc, /scopes the key to the hold/);
});
