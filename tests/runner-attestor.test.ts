import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, writeFile, rename, rm, realpath, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { oracleBundleDigest } from '../src/runner-setup.js';
import { superviseAttempt, supervisionRequestSchema } from '../src/runner-attestor.js';
import { collectArtifacts, verifyExecutionAttestation } from '../src/runner-collector.js';
import { attemptBoundaryPath, type ExecutionPlan, type ExecutionRecord, type Runner, type Settler } from '../src/runner-executor.js';

const attestor = generateKeyPairSync('ed25519');
const privateKey = attestor.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const attestationPublicKey = attestor.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const image = `sha256:${'1'.repeat(64)}`;
const containerUid = process.getuid!() === 10001 ? 10002 : 10001;
const runAsUser = `${containerUid}:${process.getgid!()}`;
const absent: Settler = async () => 'absent';

const testId = createHash('sha256').update('books are listed').digest('hex');
const inventory = { format: 'graphyard-playwright-v1', declared: [{ id: testId, expected: 'passed', location: { file: 'suite.spec.ts', line: 1, column: 1 } }], executions: [], steps: [], errors: 0, overflow: false, status: 'passed' };
const passing = { ...inventory, executions: [{ id: testId, status: 'passed', retry: 0 }], steps: [{ test: testId, sequence: 1, durationMs: 4, failed: false }] };

/** A container that writes the approved reporter's structure into the attempt boundary. */
const reporting = (plan: ExecutionPlan, report: unknown = passing): Runner => async command => {
  const phase = command.argv.at(-1);
  await writeFile(join(attemptBoundaryPath(plan), phase === 'enumerate' ? 'inventory.json' : 'report.json'), JSON.stringify(phase === 'enumerate' ? inventory : report));
  return { exitCode: 0, timedOut: false };
};

async function boundary(run: (paths: { oracle: string; collection: string; output: string; plan: ExecutionPlan }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-attestor-'));
  const oracle = join(root, 'oracle'), collection = join(root, 'output');
  await mkdir(oracle, { mode: 0o755 }); await mkdir(collection, { mode: 0o755 });
  await writeFile(join(oracle, 'suite.spec.ts'), 'approved assertion');
  const bundle = await oracleBundleDigest(oracle);
  const plan: ExecutionPlan = {
    grant: { requestId: randomUUID(), attemptId: randomUUID(), epoch: 1, runner: { id: 'preview-runner', revision: 1 },
      executionHost: 'unix:///var/run/docker.sock', attestationPublicKey, executionNetwork: 'gy-isolated',
      bundleDigest: bundle.digest, runnerImageDigest: image, targetUrl: 'https://preview.example.test/', deadline: new Date(Date.now() + 600_000).toISOString(),
      reportFormat: 'graphyard-playwright-v1', testAccountDigest: null },
    imageRepository: 'ghcr.io/example/graphyard-runner', oraclePath: await realpath(oracle), outputPath: await realpath(collection),
    timeoutMs: 60_000, memoryMb: 2048, cpus: 2, pidsLimit: 256, runAsUser };
  // The attestor provisions this attempt's own boundary under the collection root, so a
  // retry or a second assignment never meets the previous attempt's leftover artifacts.
  const output = attemptBoundaryPath(plan);
  try { await run({ oracle, collection, output, plan }); } finally { await rm(root, { recursive: true, force: true }); }
}

test('the attestor signs the attempt it ran, so a fabricated record cannot borrow its signature', async () => boundary(async ({ output, plan }) => {
  const supervised = await superviseAttempt({ plan }, { privateKey, run: reporting(plan), settle: absent });
  // The signed boundary is this attempt's own directory beneath the configured root.
  assert.equal(supervised.record.outputPath, await realpath(output));
  // Every signed fact is this process's own observation: it started the containers,
  // measured the approved bytes, settled the containers and read the boundary itself.
  assert.deepEqual(supervised.record.phases.map(p => p.phase), ['enumerate', 'execute']);
  assert.deepEqual(supervised.record.refusals, []);
  assert.equal(supervised.record.outcome, 'completed');
  const collected = await collectArtifacts(supervised.record.outputPath, ['inventory', 'report']);
  assert.deepEqual(verifyExecutionAttestation(plan.grant, supervised.record, collected, supervised.attestation).reasons, []);

  // What a compromised runner can still do: fabricate a record, and fabricate a report to
  // match it. What it cannot do is obtain a signature over either. The attestation it was
  // given covers the execution that actually happened, and nothing else.
  const forged: ExecutionRecord = { ...supervised.record, startedAt: '2026-09-16T00:00:00.000Z', finishedAt: '2026-09-16T00:00:30.000Z' };
  assert.ok(verifyExecutionAttestation(plan.grant, forged, collected, supervised.attestation).reasons.some(r => /not bound to this execution interval/.test(r)));
  // A blocked attempt cannot be laundered into a clean one either: the conclusions the
  // collector acts on — the outcome, the refusals, the phase results and the measured
  // digests — are signed alongside the interval.
  await rm(join(supervised.record.outputPath, 'inventory.json')); await rm(join(supervised.record.outputPath, 'report.json'));
  const blocked = await superviseAttempt({ plan: { ...plan, grant: { ...plan.grant, bundleDigest: `sha256:${'9'.repeat(64)}` } } },
    { privateKey, run: reporting(plan), settle: absent });
  assert.ok(blocked.record.refusals.some(r => /differ from the pinned digest/.test(r)));
  assert.deepEqual(blocked.record.phases, [], 'a bundle that is not the approved one never reaches a container');
  const invented = [{ phase: 'enumerate' as const, exitCode: 0, timedOut: false, durationMs: 1 }, { phase: 'execute' as const, exitCode: 0, timedOut: false, durationMs: 2 }];
  for (const over of [{ outcome: 'completed' as const }, { refusals: [] }, { phases: invented }, { bundleDigestBefore: blocked.record.grant.bundleDigest }]) {
    const rewritten = { ...blocked.record, ...over } as ExecutionRecord;
    assert.ok(verifyExecutionAttestation(blocked.record.grant, rewritten, { artifacts: [] }, blocked.attestation).reasons.length > 0, JSON.stringify(over));
  }
}));

test('no execution fact crosses the boundary into the attestor', async () => boundary(async ({ plan }) => {
  // The runner sends a plan and nothing else. An interval, an exit code, a measured digest
  // or a container state arriving from the worker would be exactly the fabrication the
  // signature exists to exclude, so the request schema has no place to put one.
  assert.deepEqual(Object.keys(supervisionRequestSchema.shape), ['plan']);
  for (const smuggled of [{ record: {} }, { startedAt: '2026-09-16T00:00:00.000Z' }, { settlement: { settled: true, containers: [] } }, { refusals: [] }]) {
    assert.throws(() => supervisionRequestSchema.parse({ plan, ...smuggled }));
  }
  // The signing key is the attestor's own, never part of the request.
  assert.throws(() => supervisionRequestSchema.parse({ plan, privateKey }));

  // Where the deployment makes the requesting identity knowable, the container may not run
  // as it: the output boundary is private to the container user, so sharing it would let
  // the runner replace the report between the last phase and the measurement.
  await assert.rejects(superviseAttempt({ plan: { ...plan, runAsUser: `${process.getuid!()}:${process.getgid!()}` } },
    { privateKey, run: reporting(plan), settle: absent, callerUid: process.getuid!() + 1 }),
    /dedicated account, not as the supervising attestor identity/);
  await assert.rejects(superviseAttempt({ plan }, { privateKey, run: reporting(plan), settle: absent, callerUid: containerUid }),
    /dedicated account, not as the identity that requested supervision/);
  await assert.doesNotReject(superviseAttempt({ plan }, { privateKey, run: reporting(plan), settle: absent, callerUid: process.getuid!() + 1 }));
}));

test('preflight completes before acknowledgement, and an unacknowledged attempt starts nothing', async () => boundary(async ({ oracle, output, plan }) => {
  const started: string[] = [];
  const watching: Runner = async command => { started.push(String(command.argv.at(-1))); return { exitCode: 0, timedOut: false }; };

  // The attestor preflights, then hands back to the runner to acknowledge. Only after the
  // acknowledgement does the first container start.
  let acknowledgedAfter: string[] | undefined;
  await superviseAttempt({ plan }, { privateKey, run: watching, settle: absent, ready: async () => { acknowledgedAfter = [...started]; } });
  assert.deepEqual(acknowledgedAfter, [], 'nothing runs before the attempt is acknowledged');
  assert.deepEqual(started, ['enumerate', 'execute']);

  // A refusal to acknowledge stops the attempt where it is: no container, no attestation.
  started.length = 0;
  await assert.rejects(superviseAttempt({ plan }, { privateKey, run: watching, settle: absent, ready: async () => { throw new Error('lease superseded'); } }), /lease superseded/);
  assert.deepEqual(started, []);

  // A preflight refusal never reaches the acknowledgement at all, so the attempt expires
  // and releases its runner, environment and external reservations.
  started.length = 0;
  let asked = false;
  await writeFile(join(output, 'planted.json'), '{}');
  await assert.rejects(superviseAttempt({ plan }, { privateKey, run: watching, settle: absent, ready: async () => { asked = true; } }), /must be empty/);
  assert.equal(asked, false);
  assert.deepEqual(started, []);
  assert.ok(oracle);
}));

test('a key that cannot produce this attempt\'s signature is refused before acknowledgement', async () => boundary(async ({ output, plan }) => {
  const started: string[] = [];
  const watching: Runner = async command => { started.push(String(command.argv.at(-1))); return { exitCode: 0, timedOut: false }; };
  const unusable = async (key: string, expected: RegExp) => {
    started.length = 0;
    let asked = false;
    await assert.rejects(superviseAttempt({ plan }, { privateKey: key, run: watching, settle: absent, ready: async () => { asked = true; } }), expected);
    // Nothing was acknowledged and nothing was provisioned, so the attempt expires and
    // releases its reservations instead of holding them for an operator to settle.
    assert.equal(asked, false, 'an attempt that cannot be attested is never acknowledged');
    assert.deepEqual(started, []);
    assert.deepEqual(await readdir(output).catch(() => []), [], 'no attempt boundary is provisioned');
  };

  // Malformed, and the right kind of key but not the one this attempt authority pins.
  await unusable('-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----\n', /cannot produce an Ed25519 signature/);
  await unusable(generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    /does not correspond to the attestation public key/);
  // An RSA key signs, but never what the collector will verify with the pinned key.
  await unusable(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), /Ed25519|does not correspond/);

  // The key the grant pins still supervises the attempt, and the probe leaves nothing
  // behind that could be replayed: the signature the collector accepts is over this
  // attempt's own attestation payload.
  const supervised = await superviseAttempt({ plan }, { privateKey, run: reporting(plan), settle: absent });
  const collected = await collectArtifacts(supervised.record.outputPath, ['inventory', 'report']);
  assert.deepEqual(verifyExecutionAttestation(plan.grant, supervised.record, collected, supervised.attestation).reasons, []);
}));

test('a boundary swapped out from under the measurement is never signed', async () => boundary(async ({ collection, output, plan }) => {
  // The attestor measures the output boundary by pathname. A runner that can redirect
  // that pathname could otherwise have an older attempt's passing report measured and
  // signed as this execution's own bytes, so the identity preflight approved is checked
  // again before anything is attested — and nothing is signed when it no longer holds.
  const displaced = join(collection, 'displaced');
  const swapping: Runner = async command => {
    if (command.argv.at(-1) === 'execute') {
      await rename(output, displaced);
      await mkdir(output); await chmod(output, 0o2770);
      await writeFile(join(output, 'report.json'), JSON.stringify(passing));
      await writeFile(join(output, 'inventory.json'), JSON.stringify(inventory));
    }
    return { exitCode: 0, timedOut: false };
  };
  await assert.rejects(superviseAttempt({ plan }, { privateKey, run: swapping, settle: absent }), /collection boundary was replaced .* not attested/);
  await rm(output, { recursive: true, force: true });
  await rename(displaced, output);
}));

test('the attestation covers every artifact kind the boundary held, whatever the collector publishes', async () => boundary(async ({ output, plan }) => {
  const supervised = await superviseAttempt({ plan }, { privateKey, run: reporting(plan), settle: absent });
  assert.deepEqual(supervised.collection.artifacts.map(a => a.name), ['inventory', 'report']);

  // A collector configured to publish only the report still publishes bytes this attestor
  // measured, so the subset verifies.
  const subset = await collectArtifacts(output, ['report']);
  assert.deepEqual(verifyExecutionAttestation(plan.grant, supervised.record, subset, supervised.attestation).reasons, []);

  // Bytes rewritten after the attestation are not the bytes that were observed.
  await writeFile(join(output, 'report.json'), JSON.stringify({ ...passing, steps: [] }));
  const rewritten = await collectArtifacts(output, ['inventory', 'report']);
  assert.ok(verifyExecutionAttestation(plan.grant, supervised.record, rewritten, supervised.attestation).reasons.some(r => /differ from the host-attested boundary/.test(r)));
}));

test('each attempt is given its own boundary, so a retry never meets the last one\'s artifacts', async () => boundary(async ({ collection, output, plan }) => {
  const first = await superviseAttempt({ plan }, { privateKey, run: reporting(plan), settle: absent });
  assert.deepEqual(first.collection.artifacts.map(a => a.name), ['inventory', 'report']);

  // Nothing removes a completed attempt's `inventory.json` and `report.json` — the
  // collector still has to read them, possibly from another host and well after the run.
  // A single static output directory would therefore refuse the emptiness check on every
  // later attempt, and the packaged runner could not process a second one without manual
  // filesystem work. The attempt the grant authorizes names its own directory instead.
  const retry: ExecutionPlan = { ...plan, grant: { ...plan.grant, attemptId: randomUUID() } };
  const second = await superviseAttempt({ plan: retry }, { privateKey, run: reporting(retry), settle: absent });
  assert.deepEqual(second.record.refusals, []);
  assert.equal(second.record.outcome, 'completed');
  assert.notEqual(second.record.outputPath, first.record.outputPath);
  assert.equal(second.record.outputPath, join(await realpath(collection), retry.grant.attemptId));
  // The first attempt's bytes are still where its collector will look for them.
  assert.deepEqual((await collectArtifacts(output, ['inventory', 'report'])).artifacts.map(a => a.name), ['inventory', 'report']);

  // Reusing one attempt's own boundary is still refused: a leftover report must never be
  // measured and signed as a later execution's behaviour.
  await assert.rejects(superviseAttempt({ plan }, { privateKey, run: reporting(plan), settle: absent }), /must be empty before an attempt/);
}));
