import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportPool, reportPoolConnections, reportPoolOptionsFromEnv, reportStatementTimeoutMs } from '../src/store/report-pool.js';
import { storeStatementTimeoutMs, Store } from '../src/store.js';

// GY-743. The report pool's size and statement timeout are operator-tunable through the
// environment: REPORT_POOL_MAX and REPORT_STATEMENT_TIMEOUT_MS, without a code change, while
// the explicit Store options stay above the environment and the coordination ceiling above both.

const url = 'postgres://graphyard:graphyard@localhost:5/graphyard';
const connectionTimeoutMs = 5_000, ceilingMs = 30_000;

test('reportPoolOptionsFromEnv parses integer knobs of at least 1 and ignores everything else', () => {
  assert.equal(reportPoolOptionsFromEnv({}).reportMax, undefined);
  assert.equal(reportPoolOptionsFromEnv({}).reportStatementTimeoutMs, undefined);
  assert.deepEqual(reportPoolOptionsFromEnv({ REPORT_POOL_MAX: '7', REPORT_STATEMENT_TIMEOUT_MS: '9000' }), { reportMax: 7, reportStatementTimeoutMs: 9000 });
  for (const max of ['', '0', '-3', '2.5', 'several']) assert.equal(reportPoolOptionsFromEnv({ REPORT_POOL_MAX: max }).reportMax, undefined, `REPORT_POOL_MAX=${JSON.stringify(max)}`);
  for (const timeout of ['', '0', '-1', '1.5', 'soon']) assert.equal(reportPoolOptionsFromEnv({ REPORT_STATEMENT_TIMEOUT_MS: timeout }).reportStatementTimeoutMs, undefined, `REPORT_STATEMENT_TIMEOUT_MS=${JSON.stringify(timeout)}`);
});

test('reportPool falls back to the constants when neither the options nor the environment name values', async () => {
  const pool = reportPool(url, {}, connectionTimeoutMs, ceilingMs, {});
  try {
    assert.equal(pool.options.max, reportPoolConnections);
    assert.equal(pool.options.statement_timeout, reportStatementTimeoutMs);
  } finally { await pool.end(); }
});

test('reportPool sizes and times out from the environment when the constructor passes no options', async () => {
  const pool = reportPool(url, {}, connectionTimeoutMs, ceilingMs, { REPORT_POOL_MAX: '9', REPORT_STATEMENT_TIMEOUT_MS: '7000' });
  try {
    assert.equal(pool.options.max, 9);
    assert.equal(pool.options.statement_timeout, 7000);
  } finally { await pool.end(); }
});

test('reportPool keeps the explicit options above the environment and the ceiling above both', async () => {
  const explicit = reportPool(url, { reportMax: 2, reportStatementTimeoutMs: 1500 }, connectionTimeoutMs, ceilingMs, { REPORT_POOL_MAX: '9', REPORT_STATEMENT_TIMEOUT_MS: '7000' });
  try {
    assert.equal(explicit.options.max, 2);
    assert.equal(explicit.options.statement_timeout, 1500);
  } finally { await explicit.end(); }
  const capped = reportPool(url, {}, connectionTimeoutMs, 6_000, { REPORT_STATEMENT_TIMEOUT_MS: '7000' });
  try {
    assert.equal(capped.options.max, reportPoolConnections);
    assert.equal(capped.options.statement_timeout, 6_000);
  } finally { await capped.end(); }
});

test('a Store built like the production wiring takes its report pool from the process environment', async () => {
  const previousMax = process.env.REPORT_POOL_MAX, previousTimeout = process.env.REPORT_STATEMENT_TIMEOUT_MS;
  process.env.REPORT_POOL_MAX = '11'; process.env.REPORT_STATEMENT_TIMEOUT_MS = '4321';
  const store = new Store(url);
  try {
    assert.equal(store.reportPool.options.max, 11);
    assert.equal(store.reportPool.options.statement_timeout, Math.min(storeStatementTimeoutMs, 4321));
  } finally {
    await store.close();
    if (previousMax === undefined) delete process.env.REPORT_POOL_MAX; else process.env.REPORT_POOL_MAX = previousMax;
    if (previousTimeout === undefined) delete process.env.REPORT_STATEMENT_TIMEOUT_MS; else process.env.REPORT_STATEMENT_TIMEOUT_MS = previousTimeout;
  }
});
