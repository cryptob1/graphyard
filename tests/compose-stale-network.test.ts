import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeAdapter, staleComposeEndpoints, type AdapterContext } from '../src/install/adapters.js';
import { fakeTransport } from '../src/install/transport.js';

// GY-1840: a reinstall after the containers and the data volume were removed found the
// project's network still holding their endpoints, and docker refused to start the database.
const installId = 'cryptob1-graphyard-snake-v4';
const network = `graphyard-${installId}_default`;
const workdir = `/config/${installId}/compose`;
const staleFailure = `Error response from daemon: failed to set up container networking: endpoint with name graphyard-${installId}-db-1 already exists in network ${network}`;

const contextFor = (transport: ReturnType<typeof fakeTransport>) => ({ provider: 'compose', installId, workdir, transport }) as unknown as AdapterContext;
const ups = (transport: ReturnType<typeof fakeTransport>) => transport.commands.map((_, index) => transport.line(index)).filter(line => line.includes(' up -d '));

test('unit:compose-stale-endpoint-recovered — compose up naming a stale endpoint in the project network disconnects it and retries once, and any other compose failure is reported unchanged without a retry', async () => {
  // The stale endpoint: the first up fails, the disconnect clears it, and the retry succeeds.
  let attempts = 0;
  const recovering = fakeTransport({ responses: [{ match: ' up -d ', result: () => ++attempts === 1 ? { stdout: '', stderr: staleFailure, code: 1 } : '' }] });
  await composeAdapter.deploy(contextFor(recovering));
  assert.equal(ups(recovering).length, 2, 'compose up is retried exactly once');
  const lines = recovering.commands.map((_, index) => recovering.line(index));
  const disconnect = lines.findIndex(line => line.startsWith('docker network disconnect'));
  assert.equal(lines[disconnect], `docker network disconnect -f ${network} graphyard-${installId}-db-1`);
  assert.ok(disconnect > lines.indexOf(ups(recovering)[0]) && disconnect < lines.lastIndexOf(ups(recovering)[1]), 'the endpoint is cleared between the two attempts');

  // A different compose failure is reported as compose gave it, and never retried.
  const failing = fakeTransport({ responses: [{ match: ' up -d ', result: { stdout: '', stderr: 'Error response from daemon: pull access denied for graphyard', code: 1 } }] });
  await assert.rejects(composeAdapter.deploy(contextFor(failing)), { message: 'docker exited with 1: Error response from daemon: pull access denied for graphyard' });
  assert.equal(ups(failing).length, 1);
  assert.ok(!failing.commands.some(command => command.args[0] === 'network'), 'no network is touched');

  // A stale endpoint that survives the one retry fails with docker's own message.
  const stuck = fakeTransport({ responses: [{ match: ' up -d ', result: { stdout: '', stderr: staleFailure, code: 1 } }] });
  await assert.rejects(composeAdapter.deploy(contextFor(stuck)), { message: `docker exited with 1: ${staleFailure}` });
  assert.equal(ups(stuck).length, 2);

  // An endpoint in another project's network is never disconnected.
  assert.deepEqual(staleComposeEndpoints('endpoint with name other-db-1 already exists in network other_default', `graphyard-${installId}`), []);
  assert.deepEqual(staleComposeEndpoints(`${staleFailure}\n${staleFailure}`, `graphyard-${installId}`), [{ network, endpoint: `graphyard-${installId}-db-1` }]);
});
