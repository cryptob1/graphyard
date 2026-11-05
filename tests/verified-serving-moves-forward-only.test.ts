import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapGate, gateRecordPath, writeGateRecord } from '../src/batch-gate.js';
import { deployOnce, deployRecordPath, readDeployRecord, type DeployWatchPorts } from '../src/deploy-watch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3137: serving only moves forward; a verified commit older than the served one deploys nothing.

test('unit:verified-serving-moves-forward-only — a served commit that contains the latest verified commit keeps serving; the next verified commit containing it deploys', async () => {
  const history = ['a', 'b', 'c', 'd'].map(letter => letter.repeat(40));
  const [a, b, c, d] = history as [string, string, string, string];
  const root = await temporaryDirectory('verified-forward-only');
  const file = deployRecordPath(root);
  const verify = (commit: string) => writeGateRecord(gateRecordPath(root), { ...bootstrapGate('owner/project', commit) });
  const deployed: string[] = [];
  const ports: DeployWatchPorts = {
    fetch: async () => d, head: async () => c, checkout: async () => {}, build: async commit => { deployed.push(commit); }, restart: async () => {}, health: async () => {},
    pin: async () => {}, prune: async () => {}, schema: async () => 1, database: async () => 1,
    contains: async (ancestor, commit) => history.indexOf(ancestor) <= history.indexOf(commit),
  };
  await verify(a);
  assert.equal(await deployOnce(file, ports, () => {}, 'owner/project'), 'unchanged', 'the served c contains the verified a');
  await verify(b);
  assert.equal(await deployOnce(file, ports, () => {}, 'owner/project'), 'unchanged', 'the served c contains the verified b');
  assert.deepEqual(deployed, []);
  await verify(d);
  assert.equal(await deployOnce(file, ports, () => {}, 'owner/project'), 'deployed');
  assert.deepEqual([deployed, readDeployRecord(file)?.tip], [[d], d]);
});
