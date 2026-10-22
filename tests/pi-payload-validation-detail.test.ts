import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decompositionPayloadSchema, graphyardTools } from '../src/runner/payloads.js';
import { piRunner } from '../src/runner/pi.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1661 AC-4: a Pi tool payload that fails Graphyard's validation is reported with the validation
// error and at most the first 1000 characters of the payload, so the operator sees what the model sent.
const fakePi = `import { readFileSync } from 'node:fs';
const steps = JSON.parse(readFileSync(process.argv[2], 'utf8'));
for (const line of steps) process.stdout.write(JSON.stringify(line) + '\\n');
`;
const decompose = (details: unknown) => ({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: graphyardTools.decompose, result: { content: [{ type: 'text', text: 'recorded' }], details }, isError: false });
const settled = [{ type: 'agent_end', messages: [], willRetry: false }, { type: 'agent_settled' }];

test('unit:pi-payload-validation-detail — a payload failing validation is reported with the error and at most 1000 characters of the payload', async () => {
  const directory = await temporaryDirectory('pi-payload-detail');
  try {
    const script = join(directory, 'fake-pi.mjs'), scenario = join(directory, 'scenario.json');
    await writeFile(script, fakePi);
    const payload = { reason: `the item is broad ${'x'.repeat(1500)}`, children: 'none' };
    await writeFile(scenario, JSON.stringify([{ type: 'agent_start' }, decompose(payload), ...settled]));
    const runner = piRunner({ command: process.execPath, commandArgs: [script, scenario], model: 'zai/glm-5.3-flash', extension: '/extensions/graphyard.ts', exitGraceMs: 2_000 });
    const result = await runner.start('Split GY-1', { cwd: directory, tool: graphyardTools.decompose, validate: (value: unknown) => decompositionPayloadSchema.parse(value), timeoutMs: 5_000 }).result();
    assert.equal(!result.ok && result.failure.reason, 'invalid-payload');
    const detail = !result.ok ? result.failure.detail : '';
    assert.match(detail, new RegExp(`^the ${graphyardTools.decompose} payload failed validation: `));
    assert.match(detail, /children/, 'the validation error names the field it refused');
    const shown = detail.slice(detail.indexOf('; payload: ') + '; payload: '.length);
    assert.equal(shown, JSON.stringify(payload).slice(0, 1000), 'the first 1000 characters of the payload, and no more');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unit:pi-payload-validation-detail — a short or unserialisable payload is named whole, never throwing', async () => {
  // Loaded inside the test, so a tree without it fails here as a test case.
  const { payloadValidationFailure, rejectedPayloadChars } = await import('../src/runner/pi.js');
  assert.equal(rejectedPayloadChars, 1000);
  assert.equal(payloadValidationFailure('graphyard_plan', new Error('goal is required'), { note: 'n' }), 'the graphyard_plan payload failed validation: goal is required; payload: {"note":"n"}');
  assert.equal(payloadValidationFailure('graphyard_plan', 'bad', undefined), 'the graphyard_plan payload failed validation: bad; payload: undefined');
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.match(payloadValidationFailure('graphyard_plan', new Error('bad'), cyclic), /payload: \[object Object\]$/);
  assert.equal(payloadValidationFailure('graphyard_plan', new Error('bad'), 'y'.repeat(5000)).split('; payload: ')[1].length, 1000);
});

test('unit:pi-payload-validation-detail — the run\'s injected secrets and credential-shaped tokens are redacted before the payload is cut', async () => {
  const { payloadValidationFailure } = await import('../src/runner/pi.js');
  // Fake credentials are assembled at runtime so the secrets scan never sees a literal key.
  const key = `zai-key-${'x'.repeat(16)}`, ghp = `ghp_${'A'.repeat(36)}`;
  const detail = payloadValidationFailure('graphyard_decompose', new Error(`bad value ${key}`), { reason: `leaked ${key} and ${ghp}`, auth: 'Bearer abc.def.ghi', note: 'api_key=s3cr3tvalue' }, [key, 'short']);
  for (const secret of [key, ghp, 'abc.def.ghi', 's3cr3tvalue']) assert.ok(!detail.includes(secret), `${secret} is not shown`);
  assert.match(detail, /payload failed validation: bad value \[redacted\]; payload: \{"reason":"leaked \[redacted\] and \[redacted\]"/);
  // A secret straddling the cut is redacted before the cut, so no prefix of it survives.
  const cut = payloadValidationFailure('graphyard_decompose', new Error('bad'), { reason: `${'x'.repeat(980)}${key}` }, [key]);
  assert.ok(!cut.includes(key.slice(0, 10)));
});

test('unit:pi-payload-validation-detail — a registry runner\'s environment key never appears in an invalid-payload failure', async () => {
  const directory = await temporaryDirectory('pi-payload-redact');
  try {
    const script = join(directory, 'fake-pi.mjs'), scenario = join(directory, 'scenario.json');
    const key = 'provider-key-9f8e7d6c5b4a3210';
    await writeFile(script, fakePi);
    await writeFile(scenario, JSON.stringify([{ type: 'agent_start' }, decompose({ reason: `env says ${key}`, children: 'none' }), ...settled]));
    const runner = piRunner({ command: process.execPath, commandArgs: [script, scenario], model: 'zai/glm-5.3-flash', extension: '/extensions/graphyard.ts', exitGraceMs: 2_000, environment: { ZAI_API_KEY: key } });
    const result = await runner.start('Split GY-1', { cwd: directory, tool: graphyardTools.decompose, validate: (value: unknown) => decompositionPayloadSchema.parse(value), timeoutMs: 5_000 }).result();
    const detail = !result.ok ? result.failure.detail : '';
    assert.equal(!result.ok && result.failure.reason, 'invalid-payload');
    assert.ok(!detail.includes(key) && detail.includes('env says [redacted]'), detail);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unit:pi-payload-validation-detail — an inherited credential the run can read never appears in its failure, started or adopted', async () => {
  const directory = await temporaryDirectory('pi-payload-inherited');
  const name = 'GY1661_CI_ACCESS', value = `opaque${'q'.repeat(12)}`, previous = process.env[name];
  process.env[name] = value;
  try {
    const script = join(directory, 'fake-pi.mjs'), scenario = join(directory, 'scenario.json'), runs = join(directory, 'runs');
    await writeFile(script, fakePi);
    await writeFile(scenario, JSON.stringify([{ type: 'agent_start' }, decompose({ reason: `the env holds ${value}`, children: 'none' }), ...settled]));
    const options = { tool: graphyardTools.decompose, validate: (payload: unknown) => decompositionPayloadSchema.parse(payload), timeoutMs: 5_000 };
    const runner = () => piRunner({ command: process.execPath, commandArgs: [script, scenario], model: 'zai/glm-5.3-flash', extension: '/extensions/graphyard.ts', exitGraceMs: 2_000 });
    const started = runner().start('Split GY-1', { ...options, cwd: directory, runs });
    const result = await started.result();
    const detail = !result.ok ? result.failure.detail : '';
    assert.equal(!result.ok && result.failure.reason, 'invalid-payload');
    assert.ok(!detail.includes(value) && detail.includes('the env holds [redacted]'), detail);
    // A restarted loop adopting the same run judges it against the same environment.
    const adopted = await runner().adopt!(join(runs, started.id), options).result();
    const again = !adopted.ok ? adopted.failure.detail : '';
    assert.equal(!adopted.ok && adopted.failure.reason, 'invalid-payload');
    assert.ok(!again.includes(value) && again.includes('the env holds [redacted]'), again);
  } finally {
    if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
