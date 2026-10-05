import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// GY-1157 AC-1: src/cli/master-status.ts sits at 27,984 of its 28,000-byte module budget, so any
// item that adds a status line fails CI. It is split by concern into modules under src/cli/ so that
// it and every new module are at most 22,000 bytes and 260 lines; the master status output is unchanged.

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFile(join(root, path), 'utf8');
const lines = (text: string) => text.split('\n').length;
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

const MAX_BYTES = 22_000;
const MAX_LINES = 260;

const splitModules = [
  'src/cli/master-status.ts',
  'src/cli/master-status-pipeline.ts',
  'src/cli/master-status-sections.ts',
];

test('unit:master-status-headroom — src/cli/master-status.ts and every new module are at most 22,000 bytes and 260 lines', async () => {
  for (const file of splitModules) {
    const text = await read(file);
    const lineCount = lines(text);
    const byteCount = bytes(text);
    assert.ok(
      byteCount <= MAX_BYTES,
      `${file} is ${byteCount} bytes; budget is at most ${MAX_BYTES} bytes (AC-1)`,
    );
    assert.ok(
      lineCount <= MAX_LINES,
      `${file} has ${lineCount} lines; budget is at most ${MAX_LINES} lines (AC-1)`,
    );
  }
  // Check that every new module defines its concern in the header comment
  for (const file of splitModules.slice(1)) {
    const text = await read(file);
    const header = text.split('\n')[0];
    assert.match(
      header,
      /^\/\/ Concern: \S.{10,}$/,
      `${file} opens with a "// Concern: …" header naming what it owns`,
    );
  }
});

test('unit:master-status-headroom — master status exports and report interface are preserved', async () => {
  const masterStatus = await import('../src/cli/master-status.js');
  assert.equal(typeof masterStatus.masterStatusReport, 'function', 'masterStatusReport is exported');
  assert.equal(typeof masterStatus.reportedAttention, 'function', 'reportedAttention is exported');
  assert.equal(typeof masterStatus.actionReport, 'function');
  assert.equal(typeof masterStatus.cycleBudget, 'function');
  assert.equal(typeof masterStatus.approveScopeRequest, 'function');
  assert.equal(typeof masterStatus.observationThroughputStatus, 'function');
  assert.equal(typeof masterStatus.mergeStallAttention, 'function');
  assert.equal(typeof masterStatus.nameOrphanSupervisors, 'function');
  assert.equal(typeof masterStatus.unansweredRequestAttention, 'function');
  assert.equal(typeof masterStatus.unobtainableReviewAttention, 'function');
});
