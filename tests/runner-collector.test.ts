import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash, generateKeyPairSync, randomUUID, sign as signBytes } from 'node:crypto';
import { assembleResult, attestationBytes, attributeExecution, collectArtifacts, collectionBinding, collectionInputs, deriveSettlement, executionAttestationPayload, grantDigest, selfReportedObservation, verifyExecutionAttestation, type TargetObservation } from '../src/runner-collector.js';
import { containerNames, type AttemptGrant, type ExecutionRecord } from '../src/runner-executor.js';

const run = promisify(execFile);
const bundle = `sha256:${'a'.repeat(64)}`, image = `sha256:${'b'.repeat(64)}`;
const attestor = generateKeyPairSync('ed25519');
const grant: AttemptGrant = { requestId: randomUUID(), attemptId: randomUUID(), epoch: 1, runner: { id: 'preview-runner', revision: 1 },
  executionHost: 'unix:///var/run/docker.sock', attestationPublicKey: attestor.publicKey.export({ type: 'spki', format: 'pem' }).toString(), executionNetwork: 'gy-isolated',
  bundleDigest: bundle, runnerImageDigest: image, targetUrl: 'https://preview.example.test/', deadline: '2026-09-16T01:00:00.000Z', testAccountDigest: null };
const startedAt = '2026-09-16T00:00:00.000Z', finishedAt = '2026-09-16T00:01:00.000Z';
const expected = { instance: 'preview-7f3a', artifacts: [{ service: 'api', digest: `sha256:${'c'.repeat(64)}` }] };
const seen = (at: string, over: Partial<TargetObservation> = {}): TargetObservation => ({ at, measurement: 'provider', ...expected, ...over });
const covering = [seen(startedAt), seen('2026-09-16T00:00:30.000Z'), seen(finishedAt)];
const outputPath = '/srv/graphyard/attempts/current';
// The containers this attempt was allowed to start, named from the attempt alone.
const absent = containerNames(grant.attemptId).map(name => ({ name, state: 'absent' as const }));
const record = (over: Partial<ExecutionRecord> = {}): ExecutionRecord => ({
  grant, startedAt, finishedAt,
  phases: [{ phase: 'enumerate', exitCode: 0, timedOut: false, durationMs: 10 }, { phase: 'execute', exitCode: 0, timedOut: false, durationMs: 100 }],
  bundleDigestBefore: bundle, bundleDigestAfter: bundle, runnerImageDigest: image,
  outcome: 'completed', refusals: [], outputPath, settlement: { settled: true, containers: absent }, ...over });

const id = (n: string) => createHash('sha256').update(n).digest('hex');
const declaration = (n: string) => ({ id: id(n), expected: 'passed', location: { file: 'suite.spec.ts', line: 1, column: 1 } });
const inventoryOf = (names: string[]) => ({ format: 'graphyard-playwright-v1', declared: names.map(declaration).sort((a, b) => a.id.localeCompare(b.id)), executions: [], steps: [], errors: 0, overflow: false, status: 'passed' });
const executionOf = (names: string[], status = 'passed') => ({ ...inventoryOf(names), executions: names.map(n => ({ id: id(n), status, retry: 0 })), status: status === 'passed' ? 'passed' : 'failed' });
const collectedOf = (inventory: unknown, execution: unknown, reasons: string[] = []) =>
  ({ artifacts: [{ name: 'inventory', digest: `sha256:${'1'.repeat(64)}`, document: inventory }, { name: 'report', digest: `sha256:${'2'.repeat(64)}`, document: execution }], reasons });
const uploadedOf = (collected: ReturnType<typeof collectedOf>) => collected.artifacts.map(a => ({ name: a.name, digest: a.digest, url: `graphyard-artifact://owner/repo/${grant.requestId}/${a.name}` }));
const required = ['inventory', 'report'];
// These tests stand in for the operator's host attestor: they hold its private key and
// sign the payload for an execution they describe. There is deliberately no production
// helper that signs a submitted record — `superviseAttempt` signs only what it ran.
function attestation(execution: ExecutionRecord, collected: { artifacts: { name: string; digest: string }[] }) {
  const payload = executionAttestationPayload({ grant, execution, artifacts: collected.artifacts });
  return { payload, signature: signBytes(null, attestationBytes(payload), attestor.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()).toString('base64') };
}
function assemble(over: Partial<Parameters<typeof assembleResult>[0]> = {}) {
  const collected = collectedOf(inventoryOf(['books']), executionOf(['books']));
  const execution = (over.execution as ExecutionRecord | undefined) ?? record();
  const selected = (over.collected as typeof collected | undefined) ?? collected;
  return assembleResult({ grant, execution, collectedFrom: outputPath, expected, observations: covering, maxGapMs: 30_000,
    collected: selected, uploaded: uploadedOf(collected), settlementObservations: absent, requiredArtifacts: required,
    executionAttestation: attestation(execution, selected), ...over });
}

test('whole-run attribution refuses A -> B -> A rollouts and uncovered intervals', () => {
  const other = { instance: 'preview-7f3a', artifacts: [{ service: 'api', digest: `sha256:${'d'.repeat(64)}` }] };
  assert.equal(attributeExecution({ expected, observations: covering, startedAt, finishedAt, maxGapMs: 30_000 }).attribution, 'matched');

  // Identical boundary probes hide a mid-run rollout; only continuous coverage decides.
  const boundaryOnly = attributeExecution({ expected, observations: [seen(startedAt), seen(finishedAt)], startedAt, finishedAt, maxGapMs: 30_000 });
  assert.equal(boundaryOnly.attribution, 'unknown');
  assert.equal(boundaryOnly.coversEntireRun, false);
  assert.ok(boundaryOnly.reasons.some(r => /not continuously covered/.test(r)));

  const rollout = attributeExecution({ expected, observations: [seen(startedAt), seen('2026-09-16T00:00:30.000Z', other), seen(finishedAt)], startedAt, finishedAt, maxGapMs: 30_000 });
  assert.equal(rollout.attribution, 'changed');
  assert.ok(rollout.reasons.some(r => /different artifacts during the execution interval/.test(r)));

  assert.equal(attributeExecution({ expected, observations: [seen(startedAt), seen('2026-09-16T00:00:30.000Z'), seen(finishedAt, other)], startedAt, finishedAt, maxGapMs: 30_000 }).attribution, 'mismatched');
  assert.equal(attributeExecution({ expected, observations: covering.slice(1), startedAt, finishedAt, maxGapMs: 30_000 }).attribution, 'unknown');
  assert.equal(attributeExecution({ expected, observations: covering.slice(0, 2), startedAt, finishedAt, maxGapMs: 30_000 }).attribution, 'unknown');
  assert.equal(attributeExecution({ expected, observations: [], startedAt, finishedAt, maxGapMs: 30_000 }).attribution, 'unknown');

  // An application-served version string is a diagnostic, never runtime identity.
  const selfReported = attributeExecution({ expected, observations: [seen(startedAt), selfReportedObservation('2026-09-16T00:00:30.000Z', expected.instance), seen(finishedAt)], startedAt, finishedAt, maxGapMs: 30_000 });
  assert.equal(selfReported.attribution, 'unknown');
  assert.equal(selfReported.measurement, 'unknown');
  assert.ok(selfReported.reasons.some(r => /application self-reports do not count/.test(r)));
  assert.equal(attributeExecution({ expected, observations: covering.map(o => ({ ...o, measurement: 'host-attestation' as const })), startedAt, finishedAt, maxGapMs: 30_000 }).measurement, 'host-attestation');

  // Provider histories reach past the run on both sides. Only the execution interval is
  // judged: an older measurement is not a coverage gap, and a later rollout is not this
  // attempt's change. The nearest measurement on each side is the boundary.
  const wide = attributeExecution({ expected, observations: [seen('2026-09-15T23:00:00.000Z'), ...covering, seen('2026-09-16T02:00:00.000Z', other)], startedAt, finishedAt, maxGapMs: 30_000 });
  assert.equal(wide.attribution, 'matched');
  assert.equal(wide.boundary.before!.at, startedAt);
  assert.equal(wide.boundary.after!.at, finishedAt);
  // Coverage inside the interval is still required: a wider history cannot supply it.
  assert.equal(attributeExecution({ expected, observations: [seen('2026-09-15T23:00:00.000Z'), seen(startedAt), seen(finishedAt), seen('2026-09-16T02:00:00.000Z')], startedAt, finishedAt, maxGapMs: 30_000 }).attribution, 'unknown');
  // A measurement before the run does not bracket its end, however recent it is.
  assert.equal(attributeExecution({ expected, observations: [seen('2026-09-15T23:59:59.000Z'), seen(startedAt)], startedAt, finishedAt, maxGapMs: 30_000 }).attribution, 'unknown');
});

test('measurements sharing a boundary instant are all judged, so a disagreement cannot be dropped', () => {
  const other = { instance: 'preview-7f3a', artifacts: [{ service: 'api', digest: `sha256:${'d'.repeat(64)}` }] };
  const middle = seen('2026-09-16T00:00:30.000Z');
  // Providers commonly stamp observations at whole-second precision, so several can carry
  // the same boundary timestamp. Keeping one of them by array position would let a
  // disagreeing measurement be discarded — ordered before the match at the start, or
  // after it at the finish — and leave an ambiguous identity reading as `matched`, which
  // is the only attribution `reportReasons` accepts.
  const openingConflict = attributeExecution({ expected, observations: [seen(startedAt, other), seen(startedAt), middle, seen(finishedAt)], startedAt, finishedAt, maxGapMs: 30_000 });
  assert.notEqual(openingConflict.attribution, 'matched');
  assert.equal(openingConflict.attribution, 'changed');
  const closingConflict = attributeExecution({ expected, observations: [seen(startedAt), middle, seen(finishedAt), seen(finishedAt, other)], startedAt, finishedAt, maxGapMs: 30_000 });
  assert.notEqual(closingConflict.attribution, 'matched');
  // Which of the two the array happens to end on must not decide it: an identity that is
  // no longer unambiguous at the finish is not the expected one.
  assert.equal(closingConflict.attribution, 'mismatched');
  assert.equal(attributeExecution({ expected, observations: [seen(startedAt), middle, seen(finishedAt, other), seen(finishedAt)], startedAt, finishedAt, maxGapMs: 30_000 }).attribution, 'mismatched');
  // Agreeing measurements at one instant are not a conflict, and the extra one is not a
  // coverage gap either.
  assert.equal(attributeExecution({ expected, observations: [seen(startedAt), seen(startedAt), middle, seen(finishedAt), seen(finishedAt)], startedAt, finishedAt, maxGapMs: 30_000 }).attribution, 'matched');

  // A zero-length interval still cannot be bracketed by one measurement counted twice,
  // and two distinct ones at that instant are judged together rather than against
  // each other's position.
  const instant = { startedAt, finishedAt: startedAt, maxGapMs: 30_000 };
  assert.equal(attributeExecution({ expected, observations: [seen(startedAt)], ...instant }).attribution, 'unknown');
  assert.equal(attributeExecution({ expected, observations: [seen(startedAt), seen(startedAt)], ...instant }).attribution, 'matched');
  assert.equal(attributeExecution({ expected, observations: [seen(startedAt), seen(startedAt, other)], ...instant }).attribution, 'mismatched');
  assert.equal(attributeExecution({ expected, observations: [seen(startedAt, other), seen(startedAt)], ...instant }).attribution, 'mismatched');
});

test('a mismatched authority binding produces no publishable result at all', () => {
  assert.equal(assemble({ execution: record({ grant: { ...grant, attemptId: randomUUID() } }) }).report, null);
  assert.equal(assemble({ execution: record({ grant: { ...grant, epoch: 2 } }) }).report, null);
  assert.equal(assemble({ execution: record({ grant: { ...grant, runner: { id: 'other-runner', revision: 1 } } }) }).report, null);
  assert.ok(assemble().report);

  // A live grant plus an older attempt's successful output directory is not this
  // attempt's behaviour, so the boundary is bound before anything is read or published.
  const stale = assemble({ collectedFrom: '/srv/graphyard/attempts/previous' });
  assert.equal(stale.report, null);
  assert.ok(stale.refusals.some(r => /not the output boundary this execution recorded/.test(r)));
  assert.deepEqual(collectionBinding({ grant, execution: record(), collectedFrom: `${outputPath}/` }).reasons, []);
  assert.ok(collectionBinding({ grant, execution: record({ outputPath: '/srv/graphyard/attempts/previous' }), collectedFrom: outputPath }).reasons.length);
  // A record is data, not authority: a malformed one refuses rather than being trusted.
  for (const malformed of [{ ...record(), refusals: undefined }, { ...record(), settlement: undefined }, { ...record(), outcome: 'partly' }, { ...record(), bundleDigestAfter: 'not-a-digest' }, { ...record(), extra: true }]) {
    assert.throws(() => assemble({ execution: malformed as never }));
  }
});

test('collected facts become an independently computed result, and refusals never become a pass', () => {
  const clean = assemble();
  assert.deepEqual(clean.refusals, []);
  assert.deepEqual(clean.report, { requestId: grant.requestId, attemptId: grant.attemptId, epoch: 1, execution: 'completed', behavior: 'passed',
    executed: 1, skipped: 0, inventoryComplete: true,
    target: { instance: expected.instance, artifacts: expected.artifacts, measurement: 'provider', coversEntireRun: true, attribution: 'matched' },
    bundleDigest: bundle, runnerImageDigest: image,
    artifacts: [{ name: 'inventory', digest: `sha256:${'1'.repeat(64)}`, url: `graphyard-artifact://owner/repo/${grant.requestId}/inventory` }, { name: 'report', digest: `sha256:${'2'.repeat(64)}`, url: `graphyard-artifact://owner/repo/${grant.requestId}/report` }],
    artifactState: 'verified', executionSettled: true });

  // A product failure and an infrastructure block are different states; neither passes.
  const failing = assemble({ collected: collectedOf(inventoryOf(['books']), executionOf(['books'], 'failed')) });
  assert.equal(failing.report!.behavior, 'failed');
  const blocked = assemble({ execution: record({ refusals: ['Approved oracle bundle changed during the attempt'], outcome: 'failed' }) });
  assert.equal(blocked.report!.behavior, 'blocked');
  assert.ok(blocked.refusals.includes('Approved oracle bundle changed during the attempt'));
  const timedOut = assemble({ execution: record({ outcome: 'timed_out' }) });
  assert.equal(timedOut.report!.execution, 'timed_out');
  assert.equal(timedOut.report!.behavior, 'blocked');
  assert.equal(assemble({ cancelled: true }).report!.execution, 'cancelled');

  // The collector re-derives boundary facts from the grant rather than trusting the record.
  for (const tampered of [{ bundleDigestAfter: `sha256:${'e'.repeat(64)}` }, { bundleDigestBefore: `sha256:${'e'.repeat(64)}` }, { runnerImageDigest: `sha256:${'e'.repeat(64)}` }, { phases: [{ phase: 'execute' as const, exitCode: 0, timedOut: false, durationMs: 1 }] }]) {
    const claimed = assemble({ execution: record({ ...tampered, refusals: [], outcome: 'completed' }) });
    assert.equal(claimed.report!.behavior, 'blocked');
    assert.ok(claimed.refusals.length);
  }

  // Unsettled execution keeps the resource barrier closed rather than releasing a retry.
  const unsettled = assemble({ execution: record({ settlement: { settled: false, containers: absent.map(c => ({ ...c, state: 'unknown' as const })) }, refusals: ['Execution settlement is unverified; the execution-resource barrier stays closed'], outcome: 'failed' }),
    settlementObservations: absent.map(c => ({ ...c, state: 'unknown' as const })) });
  assert.equal(unsettled.report!.executionSettled, false);
  assert.equal(unsettled.report!.behavior, 'blocked');
});

test('worker-authored output cannot pass without the pinned host attestor', () => {
  const clean = assemble();
  assert.equal(clean.report!.behavior, 'passed');
  const forged = assemble({ executionAttestation: { ...attestation(record(), collectedOf(inventoryOf(['books']), executionOf(['books']))), signature: Buffer.alloc(64).toString('base64') } });
  assert.equal(forged.report!.behavior, 'blocked');
  assert.ok(forged.refusals.some(r => /signature is invalid/.test(r)));
  const signed = attestation(record(), collectedOf(inventoryOf(['books']), executionOf(['books'])));
  const wrongHost = { ...signed, payload: { ...signed.payload, executionHost: 'unix:///var/run/other-docker.sock' } };
  const redirected = assemble({ executionAttestation: wrongHost });
  assert.equal(redirected.report!.behavior, 'blocked');
  assert.ok(redirected.refusals.some(r => /execution host pinned/.test(r)));
});

test('an attestation obtained for a substituted grant does not verify against the real authority', () => {
  // The attack this closes: a compromised runner hands the attestor a schema-valid plan
  // whose grant names its own target or Docker network, gets a real signature over that
  // run, and then presents the collector with the record carrying the authority the
  // server actually issued. Binding the attempt by id alone would let it through, because
  // the request, attempt and epoch never changed.
  const sign = (over: Partial<AttemptGrant>) => {
    const substituted = { ...grant, ...over };
    const collected = collectedOf(inventoryOf(['books']), executionOf(['books']));
    const payload = executionAttestationPayload({ grant: substituted, execution: record({ grant: substituted }), artifacts: collected.artifacts });
    return { payload, signature: signBytes(null, attestationBytes(payload), attestor.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()).toString('base64') };
  };
  for (const [over, pattern] of [
    [{ targetUrl: 'https://attacker.example.test/' }, /different approved target or execution network/],
    [{ executionNetwork: 'gy-internal' }, /different approved target or execution network/],
    // Every other grant field is covered too, through the digest of the whole authority.
    [{ bundleDigest: `sha256:${'f'.repeat(64)}` }, /whole dispatch authority/],
    [{ deadline: '2026-09-16T02:00:00.000Z' }, /whole dispatch authority/],
    [{ runner: { id: 'other-runner', revision: 1 } }, /whole dispatch authority/],
  ] as [Partial<AttemptGrant>, RegExp][]) {
    // The record's own grant is put back to the authority the collector re-read, which is
    // exactly what `collectionBinding` requires and what made the swap survive before.
    const reasons = verifyExecutionAttestation(grant, record(), { artifacts: [] }, sign(over)).reasons;
    assert.ok(reasons.some(r => pattern.test(r)), `${JSON.stringify(over)}: ${reasons.join('; ')}`);
    const laundered = assemble({ executionAttestation: sign(over) });
    assert.equal(laundered.report!.behavior, 'blocked');
  }
  // The digest identifies the authority, not the key order it happened to arrive in.
  const reordered = Object.fromEntries(Object.entries(grant).reverse());
  assert.equal(grantDigest(reordered), grantDigest(grant));
  assert.notEqual(grantDigest({ ...grant, targetUrl: 'https://other.example.test/' }), grantDigest(grant));
});

test('a signature obtained for one execution cannot be reused after its conclusions change', () => {
  // Everything assembleResult acts on is signed, so a worker holding a valid attestation
  // for the run that actually happened cannot rewrite the record it hands the collector.
  const blocked = record({ outcome: 'timed_out', refusals: ['Approved oracle bundle changed during the attempt'], bundleDigestAfter: `sha256:${'e'.repeat(64)}` });
  const signed = attestation(blocked, collectedOf(inventoryOf(['books']), executionOf(['books'])));
  for (const rewritten of [{ outcome: 'completed' as const }, { refusals: [] }, { bundleDigestAfter: bundle }, { phases: [{ phase: 'execute' as const, exitCode: 0, timedOut: false, durationMs: 1 }] }]) {
    const laundered = assemble({ execution: record({ ...blocked, ...rewritten }), executionAttestation: signed });
    assert.equal(laundered.report!.behavior, 'blocked');
    assert.ok(laundered.refusals.some(r => /does not bind the execution outcome, refusals, phase results and measured digests/.test(r)));
  }
  // The same attestation still verifies against the record it was actually signed for.
  const honest = assemble({ execution: blocked, executionAttestation: signed });
  assert.ok(!honest.refusals.some(r => /does not bind the execution outcome/.test(r)));
  assert.equal(honest.report!.execution, 'timed_out');
});

test('settlement is the collector\'s own observation, never the runner\'s assertion', () => {
  // The record's boolean cannot release a protected resource: a runner claiming
  // settlement the collector cannot see leaves the barrier closed.
  for (const state of ['present', 'unknown'] as const) {
    const claimed = assemble({ settlementObservations: absent.map(c => ({ ...c, state })) });
    assert.equal(claimed.report!.executionSettled, false);
    assert.equal(claimed.report!.behavior, 'blocked');
    assert.ok(claimed.refusals.some(r => /did not independently observe every container/.test(r)));
  }
  // An empty or partial claim is not settlement either, however the record is shaped.
  for (const observations of [[], absent.slice(0, 1), [{ name: 'graphyard-execute-someone-elses-attempt', state: 'absent' as const }], [...absent, { name: 'graphyard-execute-other', state: 'absent' as const }]]) {
    assert.equal(assemble({ settlementObservations: observations }).report!.executionSettled, false);
  }
  assert.equal(deriveSettlement(grant.attemptId, absent).settled, true);
  assert.deepEqual(deriveSettlement(grant.attemptId, absent).expected, [`graphyard-enumerate-${grant.attemptId}`, `graphyard-execute-${grant.attemptId}`]);
  assert.throws(() => deriveSettlement(grant.attemptId, [{ name: 'x', state: 'gone' }]));

  // A record that does not account for exactly this attempt's containers is refused
  // even when the collector's own observation is clean.
  const miscounted = assemble({ execution: record({ settlement: { settled: true, containers: [] } }) });
  assert.equal(miscounted.report!.behavior, 'blocked');
  assert.ok(miscounted.refusals.some(r => /does not account for exactly the containers/.test(r)));
});

test('missing, skipped, inconsistent and unstored artifacts never produce success', () => {
  const missing = assemble({ collected: { artifacts: [], reasons: ['Required artifact report is missing or unreadable at the execution boundary'] }, uploaded: [] });
  assert.equal(missing.report!.artifactState, 'missing');
  assert.equal(missing.report!.behavior, 'blocked');
  assert.equal(missing.report!.inventoryComplete, false);

  const collected = collectedOf(inventoryOf(['books']), executionOf(['books']));
  const badUpload = assemble({ collected, uploaded: uploadedOf(collected).map(a => a.name === 'report' ? { ...a, digest: `sha256:${'f'.repeat(64)}` } : a) });
  assert.equal(badUpload.report!.artifactState, 'upload-failed');
  assert.ok(badUpload.refusals.some(r => /not durably stored/.test(r)));

  const skipped = assemble({ collected: collectedOf(inventoryOf(['books']), executionOf(['books'], 'skipped')) });
  assert.equal(skipped.report!.skipped, 1);
  assert.notEqual(skipped.report!.behavior, 'passed');

  const partial = assemble({ collected: collectedOf(inventoryOf(['books', 'checkout']), executionOf(['books'])) });
  assert.equal(partial.report!.inventoryComplete, false);
  assert.equal(partial.report!.behavior, 'failed');

  const unparseable = assemble({ collected: collectedOf(inventoryOf(['books']), { not: 'a report' }) });
  assert.equal(unparseable.report!.behavior, 'unmeasured');
  assert.ok(unparseable.refusals.some(r => /could not be verified against the enumerated inventory/.test(r)));
});

test('collection accepts only approved reporter output from the attempt boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-collect-'));
  try {
    const output = join(root, 'output'); await mkdir(output, { mode: 0o700 });
    await writeFile(join(output, 'inventory.json'), JSON.stringify(inventoryOf(['books'])));
    await writeFile(join(output, 'report.json'), JSON.stringify(executionOf(['books'])));
    const collected = await collectArtifacts(output, required);
    assert.equal(collected.complete, true);
    assert.deepEqual(collected.artifacts.map(a => a.name), ['inventory', 'report']);
    assert.ok(collected.artifacts.every(a => a.mediaType === 'application/json' && /^sha256:[a-f0-9]{64}$/.test(a.digest)));

    // Rich captures that cannot yet meet the protection policy are refused, not uploaded.
    const unprotected = await collectArtifacts(output, [...required, 'trace']);
    assert.equal(unprotected.complete, false);
    assert.ok(unprotected.reasons.some(r => /no collector implementation meeting the capture policy/.test(r)));
    assert.ok(!unprotected.artifacts.some(a => a.name === 'trace'));

    await writeFile(join(output, 'stray.json'), '{}');
    assert.ok((await collectArtifacts(output, required)).reasons.some(r => /the approved reporter did not write/.test(r)));
    await rm(join(output, 'stray.json'));

    await rm(join(output, 'report.json'));
    await writeFile(join(root, 'elsewhere.json'), JSON.stringify(executionOf(['books'])));
    await symlink(join(root, 'elsewhere.json'), join(output, 'report.json'));
    assert.ok((await collectArtifacts(output, required)).reasons.some(r => /missing or unreadable/.test(r)));
    await rm(join(output, 'report.json'));

    await writeFile(join(output, 'report.json'), JSON.stringify({ passed: true, note: 'candidate-authored proof' }));
    assert.ok((await collectArtifacts(output, required)).reasons.some(r => /not an approved data-minimised report/.test(r)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('publishing a subset of the artifacts still verifies the whole boundary', async () => {
  // `requiredArtifacts` configures what this collector uploads, not what it checks. The
  // approved reporter writes both files whatever the upload list says, so reading only
  // the subset would leave the other one looking like output nobody approved and would
  // leave behaviour unverifiable — a supported configuration that could never pass.
  assert.deepEqual(collectionInputs(['report']), ['inventory', 'report']);
  assert.deepEqual(collectionInputs(['report', 'trace']), ['inventory', 'report', 'trace']);

  const root = await mkdtemp(join(tmpdir(), 'graphyard-subset-'));
  try {
    const output = join(root, 'output'); await mkdir(output, { mode: 0o700 });
    await writeFile(join(output, 'inventory.json'), JSON.stringify(inventoryOf(['books'])));
    await writeFile(join(output, 'report.json'), JSON.stringify(executionOf(['books'])));
    const collected = await collectArtifacts(output, collectionInputs(['report']));
    assert.deepEqual(collected.reasons, []);
    assert.deepEqual(collected.artifacts.map(a => a.name), ['inventory', 'report']);

    const boundary = await realpath(output);
    const execution = record({ outputPath: boundary });
    const uploaded = uploadedOf(collected as never).filter(a => a.name === 'report');
    const published = assembleResult({ grant, execution, collectedFrom: boundary, expected, observations: covering, maxGapMs: 30_000,
      collected, uploaded, settlementObservations: absent, requiredArtifacts: ['report'],
      executionAttestation: attestation(execution, collected) });
    assert.deepEqual(published.refusals, []);
    assert.equal(published.report!.behavior, 'passed');
    assert.equal(published.report!.artifactState, 'verified');
    // Only the configured subset is published, and only bytes the attestor measured.
    assert.deepEqual(published.report!.artifacts.map(a => a.name), ['report']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a real Playwright attempt is collected end to end, and a broken assertion fails acceptance', async () => {
  // Locally authored trusted fixtures stand in for an approved oracle bundle; no
  // untrusted repository code executes here.
  const root = await mkdtemp(resolve('.graphyard-collector-test-'));
  try {
    const config = join(root, 'playwright.config.ts'), spec = join(root, 'suite.spec.ts');
    await writeFile(config, `export default { testDir: '.', retries: 0, workers: 1, reporter: [[${JSON.stringify(resolve('src/playwright-reporter.ts'))}]] };`);
    const output = join(root, 'output'); await mkdir(output, { mode: 0o700 });
    async function phase(file: string, list: boolean) {
      try { await run(process.execPath, [fileURLToPath(import.meta.resolve('@playwright/test/cli')), 'test', '--config', config, ...(list ? ['--list'] : [])], { env: { ...process.env, GRAPHYARD_REPORT_FILE: join(output, file) }, timeout: 60_000 }); } catch { /* behaviour is read from the report, not the exit code */ }
    }
    await writeFile(spec, `import { test, expect } from '@playwright/test'; test('books are listed', async () => { await test.step('private-step-marker', async () => { expect(1).toBe(1); }); });`);
    await phase('inventory.json', true);
    await phase('report.json', false);
    const collected = await collectArtifacts(output, required);
    assert.equal(collected.complete, true);
    const boundary = await realpath(output);
    const passed = assembleResult({ grant, execution: record({ outputPath: boundary }), collectedFrom: boundary, expected, observations: covering, maxGapMs: 30_000,
      collected, uploaded: uploadedOf(collected as never), settlementObservations: absent, requiredArtifacts: required,
      executionAttestation: attestation(record({ outputPath: boundary }), collected) });
    assert.deepEqual(passed.refusals, []);
    assert.equal(passed.report!.behavior, 'passed');
    assert.equal(passed.report!.executed, 1);
    assert.equal(passed.report!.target.attribution, 'matched');
    assert.ok(!JSON.stringify(passed.report).includes('private-step-marker'));

    await rm(join(output, 'report.json'));
    await writeFile(spec, `import { test, expect } from '@playwright/test'; test('books are listed', async () => { await test.step('assert listing', async () => { expect('private-error-marker').toBe('listed'); }); });`);
    await phase('report.json', false);
    const brokenCollected = await collectArtifacts(output, required);
    const broken = assembleResult({ grant, execution: record({ outputPath: boundary }), collectedFrom: boundary, expected, observations: covering, maxGapMs: 30_000,
      collected: brokenCollected, uploaded: uploadedOf(brokenCollected as never), settlementObservations: absent, requiredArtifacts: required,
      executionAttestation: attestation(record({ outputPath: boundary }), brokenCollected) });
    assert.equal(broken.report!.behavior, 'failed');
    assert.ok(broken.refusals.length);
    // The trace locates the failing test and step without echoing candidate strings.
    const trace = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
    assert.ok(trace.steps.some((s: { failed: boolean }) => s.failed));
    assert.ok(!JSON.stringify(broken.report).includes('private-error-marker'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
