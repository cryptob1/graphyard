import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decidePayloadSchema, graphyardTools } from '../src/runner/payloads.js';
import { piRunner } from '../src/runner/pi.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1661 AC-4: a Pi tool payload that fails Graphyard's validation is reported with the validation
// error and at most the first 1000 characters of the payload, so the operator sees what the model sent.
const fakePi = `import { readFileSync } from 'node:fs';
const steps = JSON.parse(readFileSync(process.argv[2], 'utf8'));
for (const line of steps) process.stdout.write(JSON.stringify(line) + '\\n');
`;
const decide = (details: unknown) => ({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: graphyardTools.decide, result: { content: [{ type: 'text', text: 'recorded' }], details }, isError: false });
const settled = [{ type: 'agent_end', messages: [], willRetry: false }, { type: 'agent_settled' }];

test('unit:pi-payload-validation-detail — a payload failing validation is reported with the error and at most 1000 characters of the payload', async () => {
  const directory = await temporaryDirectory('pi-payload-detail');
  try {
    const script = join(directory, 'fake-pi.mjs'), scenario = join(directory, 'scenario.json');
    await writeFile(script, fakePi);
    const payload = { decision: 'decision-1', approve: 'yes', reason: `the criteria are met ${'x'.repeat(3000)}` };
    await writeFile(scenario, JSON.stringify([{ type: 'agent_start' }, decide(payload), ...settled]));
    const runner = piRunner({ command: process.execPath, commandArgs: [script, scenario], model: 'zai/glm-5.3-flash', extension: '/extensions/graphyard.ts', exitGraceMs: 2_000 });
    const result = await runner.start('Judge decision-1', { cwd: directory, tool: graphyardTools.decide, validate: (value: unknown) => decidePayloadSchema.parse(value), timeoutMs: 5_000 }).result();
    assert.equal(!result.ok && result.failure.reason, 'invalid-payload');
    const detail = !result.ok ? result.failure.detail : '';
    assert.match(detail, new RegExp(`^the ${graphyardTools.decide} payload failed validation: `));
    assert.match(detail, /approve/, 'the validation error names the field it refused');
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
  const key = ['zai', 'key', '0123456789abcdef'].join('-'), ghp = `ghp_${'A'.repeat(36)}`;
  const detail = payloadValidationFailure('graphyard_decide', new Error(`bad value ${key}`), { reason: `leaked ${key} and ${ghp}`, auth: 'Bearer abc.def.ghi', note: 'api_key=s3cr3tvalue' }, [key, 'short']);
  for (const secret of [key, ghp, 'abc.def.ghi', 's3cr3tvalue']) assert.ok(!detail.includes(secret), `${secret} is not shown`);
  assert.match(detail, /payload failed validation: bad value \[redacted\]; payload: \{"reason":"leaked \[redacted\] and \[redacted\]"/);
  // A secret straddling the cut is redacted before the cut, so no prefix of it survives.
  const cut = payloadValidationFailure('graphyard_decide', new Error('bad'), { reason: `${'x'.repeat(980)}${key}` }, [key]);
  assert.ok(!cut.includes(key.slice(0, 10)));
});

test('unit:pi-payload-validation-detail — a registry runner\'s environment key never appears in an invalid-payload failure', async () => {
  const directory = await temporaryDirectory('pi-payload-redact');
  try {
    const script = join(directory, 'fake-pi.mjs'), scenario = join(directory, 'scenario.json');
    const key = 'provider-key-9f8e7d6c5b4a3210';
    await writeFile(script, fakePi);
    await writeFile(scenario, JSON.stringify([{ type: 'agent_start' }, decide({ decision: 'decision-1', approve: 'yes', reason: `env says ${key}` }), ...settled]));
    const runner = piRunner({ command: process.execPath, commandArgs: [script, scenario], model: 'zai/glm-5.3-flash', extension: '/extensions/graphyard.ts', exitGraceMs: 2_000, environment: { ZAI_API_KEY: key } });
    const result = await runner.start('Judge decision-1', { cwd: directory, tool: graphyardTools.decide, validate: (value: unknown) => decidePayloadSchema.parse(value), timeoutMs: 5_000 }).result();
    const detail = !result.ok ? result.failure.detail : '';
    assert.equal(!result.ok && result.failure.reason, 'invalid-payload');
    assert.ok(!detail.includes(key) && detail.includes('env says [redacted]'), detail);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
