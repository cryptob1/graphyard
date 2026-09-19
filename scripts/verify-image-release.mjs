// The release contract of a built control-plane image, exercised over Docker before the
// image is published or promoted: it reports the version and revision it was built from,
// carries the same values as OCI labels, migrates an empty database, and the shipped
// `db backup` / `db restore` commands carry a live ledger — including an assignment under
// lease and its history — into a fresh database that then serves it unchanged.
//
//   node scripts/verify-image-release.mjs IMAGE EXPECTED_VERSION EXPECTED_REVISION
//
// This controller receives no producer token and produces no evidence; it fails the build.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const [image, expectedVersion, expectedRevision] = process.argv.slice(2);
if (!image || !expectedVersion || !expectedRevision) throw new Error('Usage: verify-image-release IMAGE VERSION REVISION');
const scratch = await mkdtemp(join(tmpdir(), 'graphyard-release-'));
const suffix = randomBytes(6).toString('hex'), network = `gy-release-${suffix}`;
const names = { source: `${network}-db1`, target: `${network}-db2`, app: `${network}-app`, restored: `${network}-app2` };
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const operator = { id: 'release-operator', role: 'admin', token: randomBytes(32).toString('hex') };
const worker = { id: 'release-worker', role: 'worker', token: randomBytes(32).toString('hex') };
async function ready(url, describe) {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) }); if (r.ok) return r.json(); } catch { /* startup */ }
    await sleep(1000);
  }
  throw new Error(`${describe} did not become healthy`);
}
async function database(name) {
  docker('run', '-d', '--name', name, '--network', network, '-e', 'POSTGRES_PASSWORD=release-only', '-e', 'POSTGRES_DB=graphyard', 'postgres:17-alpine');
  for (let i = 0; i < 60; i++) { if (spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore' }).status === 0) return; await sleep(1000); }
  throw new Error(`Database ${name} did not become ready`);
}
async function app(name, db) {
  const envFile = join(scratch, `${name}.env`);
  await writeFile(envFile, `DATABASE_URL=postgres://postgres:release-only@${db}:5432/graphyard\nHOST=0.0.0.0\nPORT=4310\nGRAPHYARD_PRINCIPALS=${JSON.stringify([operator, worker])}\n`, { mode: 0o600 });
  docker('run', '-d', '--name', name, '--network', network, '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=1g', '--cpus=2', '--pids-limit=256', '--env-file', envFile, '-p', '127.0.0.1::4310', image);
  const port = docker('port', name, '4310/tcp');
  if (!/^127\.0\.0\.1:\d+$/.test(port)) throw new Error('Unexpected container port');
  return `http://${port}`;
}
async function api(url, path, actor, data) {
  const response = await fetch(`${url}/api/${path}`, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${actor.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200, `Unexpected status for ${path}`); return response.json();
}
const cli = (name, ...args) => docker('exec', name, 'node', 'bin/graphyard.mjs', 'db', ...args);
try {
  // 1. The image is labelled and reports the release it was built as.
  const labels = JSON.parse(docker('image', 'inspect', '--format', '{{json .Config.Labels}}', image));
  assert.equal(labels['org.opencontainers.image.version'], expectedVersion, 'image version label');
  assert.equal(labels['org.opencontainers.image.revision'], expectedRevision, 'image revision label');
  docker('network', 'create', network);
  await database(names.source);
  const url = await app(names.app, names.source);
  const health = await ready(url, 'Candidate image');
  assert.equal(health.version, expectedVersion, '/healthz version'); assert.equal(health.revision, expectedRevision, '/healthz revision');
  assert.ok(Number.isInteger(health.schema) && health.schema >= 1, '/healthz schema generation');
  const status = await api(url, 'status', operator);
  assert.equal(status.release.version, expectedVersion); assert.equal(status.schema, health.schema);
  const migrated = JSON.parse(cli(names.app, 'status'));
  assert.equal(migrated.schema, migrated.expectedSchema, 'the image migrated its database to the generation it expects');

  // 2. A second, empty deployment of the same image, migrated and waiting.
  await database(names.target);
  const restoredUrl = await app(names.restored, names.target);
  await ready(restoredUrl, 'Restored image');

  // 3. A live ledger: an assignment under lease with its history and a second backlog item.
  let work = await api(url, 'work', operator, { title: 'Release exercise', criteria: [{ id: 'AC-1', text: 'Survives restore', proofs: ['integration:release'] }] });
  await api(url, `work/${work.id}/ready`, operator, {});
  work = await api(url, `work/${work.id}/claim`, worker, {});
  await api(url, `work/${work.id}/workspace`, worker, { epoch: 1, host: 'release-host', path: '/srv/worktrees/release', branch: 'graphyard/release-1' });
  await api(url, 'work', operator, { title: 'Backlog item', criteria: [{ id: 'AC-1', text: 'Waits', proofs: ['unit:later'] }] });
  // What a restore must hand back unchanged, independent of clocks the reconciler moves.
  const ledger = items => items.map(w => ({ id: w.id, key: w.key, title: w.title, stage: w.stage, epoch: w.epoch, revision: w.revision, criteria: w.criteria, workspaces: w.workspaces, lease: w.lease && { owner: w.lease.owner, epoch: w.lease.epoch, expiresAt: w.lease.expiresAt }, lastAssignment: w.lastAssignment }));
  const before = ledger(await api(url, 'work', operator));
  const beforeEvents = (await api(url, `events?work=${work.id}`, operator)).map(e => ({ seq: e.seq, actor: e.actor, kind: e.kind }));
  assert.equal(before.find(w => w.id === work.id).lease.owner, worker.id);

  // 4. Backup from the shipped image, restore into the waiting deployment.
  const taken = JSON.parse(cli(names.app, 'backup', '/tmp/ledger.json'));
  assert.equal(taken.rows.work_items, 2);
  assert.equal(JSON.parse(cli(names.app, 'verify', '/tmp/ledger.json')).valid, true);
  docker('cp', `${names.app}:/tmp/ledger.json`, join(scratch, 'ledger.json'));
  // `docker cp` lands the file as root inside the container; the unprivileged image user must still read it.
  await chmod(join(scratch, 'ledger.json'), 0o644);
  docker('cp', join(scratch, 'ledger.json'), `${names.restored}:/tmp/ledger.json`);
  const restored = JSON.parse(cli(names.restored, 'restore', '/tmp/ledger.json'));
  assert.equal(restored.counts.work_items, 2); assert.deepEqual(restored.tablesLeftEmpty, []);
  assert.deepEqual(ledger(await api(restoredUrl, 'work', operator)), before, 'the restored ledger serves the same work, assignments and leases');
  assert.deepEqual((await api(restoredUrl, `events?work=${work.id}`, operator)).map(e => ({ seq: e.seq, actor: e.actor, kind: e.kind })), beforeEvents, 'history is preserved in order');
  // The restored deployment continues from where the ledger stopped: the same epoch still
  // acts, a superseded one still refuses, and new work numbers after the restored items.
  await api(restoredUrl, `work/${work.id}/heartbeat`, worker, { epoch: 1 });
  const stale = await fetch(`${restoredUrl}/api/work/${work.id}/heartbeat`, { method: 'POST', headers: { Authorization: `Bearer ${worker.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ epoch: 2 }) });
  assert.equal(stale.status, 409);
  const next = await api(restoredUrl, 'work', operator, { title: 'After restore', criteria: [{ id: 'AC-1', text: 'Continues', proofs: ['unit:after'] }] });
  assert.equal(next.key, 'GY-3');
  // Restoring again over live state is refused by the shipped command.
  const again = spawnSync('docker', ['exec', names.restored, 'node', 'bin/graphyard.mjs', 'db', 'restore', '/tmp/ledger.json'], { encoding: 'utf8' });
  assert.notEqual(again.status, 0); assert.match(again.stderr, /Restore requires an empty database/);
  console.log(`Release contract verified for ${image}: version ${expectedVersion}, revision ${expectedRevision}, schema ${health.schema}, backup and restore round trip.`);
} catch (error) {
  console.error(`Release contract failed: ${error.message}`); process.exitCode = 1;
} finally {
  spawnSync('docker', ['rm', '-f', names.app, names.restored, names.source, names.target], { stdio: 'ignore' });
  spawnSync('docker', ['network', 'rm', network], { stdio: 'ignore' });
  await rm(scratch, { recursive: true, force: true });
}
