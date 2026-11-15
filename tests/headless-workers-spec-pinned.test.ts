import test from 'node:test';
import assert from 'node:assert/strict';
import { suiteRunEnvironment } from './helpers/run-tests.js';

// GY-3356: the batch gate's browser run failed browser-tests/headless-workers.spec.ts once on main
// (9486206a04b2) and passed its re-run, beside two other specs' own caps in the same loaded run.
// The gate keeps no output of a flaky run, so the pin holds the structure the cause was read from:
// the spec's budget went first to copying the template and booting an embedded-Postgres cluster
// inside its own worker process — the part of its boot that scales worst under load — while the
// Node suite already ran on one shared warm cluster per run. The browser suite names that same
// cluster now. This test fails on the base, where the browser run's environment names no cluster
// (and the helper does not exist), and whenever either suite's run stops naming it.
test(`unit:test-browser-tests-headless-workers-spec-ts-pinned — both suites' runs name one shared Postgres cluster, so headless-workers.spec.ts spends its budget on the page it proves and boots no cluster of its own`, () => {
  const clusterUrl = 'postgres://graphyard:testing-only@127.0.0.1:15440/postgres';
  const browser = suiteRunEnvironment({ browser: true, browserPort: 4319, clusterPort: 15440, clusterUrl, dataHome: '/suite/test-data', tmpRoot: null });
  assert.equal(browser.GRAPHYARD_TEST_DATABASE_URL, clusterUrl, 'the browser run hands its database-backed specs one shared cluster, as the Node run does');
  assert.equal(browser.GRAPHYARD_BROWSER_PORT, '4319', 'the browser run still names the port its web server builds on');
  const node = suiteRunEnvironment({ browser: false, browserPort: 4319, clusterPort: 15440, clusterUrl, dataHome: '/suite/test-data', tmpRoot: null });
  assert.equal(node.GRAPHYARD_TEST_DATABASE_URL, clusterUrl, 'the Node run keeps its shared cluster');
  assert.equal(node.GRAPHYARD_TEST_PORT, '15440', 'the Node run keeps its own port window');
});
