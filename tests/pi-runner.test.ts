import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decidePayloadSchema, graphyardTools } from '../src/runner/payloads.js';
import { piArgs, piRunner, runEnvironment } from '../src/runner/pi.js';
import { runRecord, runRecordSchema, type RunEvent } from '../src/runner/types.js';

// GY-169 AC-1, proof unit:runner-pi-events. The Pi runner is driven against a fake Pi: a node
// process that prints recorded Pi JSONL (the records `pi --mode json` emits) and then exits,
// hangs, or exits non-zero, and records the command line and environment it was started with.

const fakePi = `import { readFileSync, writeFileSync } from 'node:fs';
const [scenarioFile, ...args] = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(scenarioFile, 'utf8'));
if (scenario.argsFile) writeFileSync(scenario.argsFile, JSON.stringify({ args, cwd: process.cwd(), stdinTTY: !!process.stdin.isTTY, env: Object.keys(process.env).filter(name => /^(GRAPHYARD_|HERDR_|FAKE_)/.test(name)) }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
for (const step of scenario.steps) {
  if (step.delay) await sleep(step.delay);
  if (step.line !== undefined) process.stdout.write((typeof step.line === 'string' ? step.line : JSON.stringify(step.line)) + '\\n');
  if (step.stderr) process.stderr.write(step.stderr);
  if (step.hang) { setInterval(() => {}, 1000); await new Promise(() => {}); }
  if (step.exit !== undefined) process.exit(step.exit);
}
`;

const H = 'a'.repeat(40);
const decide = (details: unknown, isError = false) => ({ line: { type: 'tool_execution_end', toolCallId: 'call-1', toolName: graphyardTools.decide, result: { content: [{ type: 'text', text: isError ? 'graphyard_decide was not recorded: input.approve is required' : 'recorded' }], details }, isError } });
const recorded = [
  { line: { type: 'session', version: 3, id: 'session-1', timestamp: '2030-01-01T00:00:00Z', cwd: '/w' } },
  { line: { type: 'agent_start' } },
  { line: { type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_delta', delta: 'Rea' } } },
  { line: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Reading the decision.' }], stopReason: 'toolUse' } } },
  { line: { type: 'tool_execution_start', toolCallId: 'call-1', toolName: graphyardTools.decide, args: {} } },
];
const settled = [{ line: { type: 'agent_end', messages: [], willRetry: false } }, { line: { type: 'agent_settled' } }];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-pi-runner-'));
  const script = join(directory, 'fake-pi.mjs');
  await writeFile(script, fakePi);
  let count = 0;
  const scenario = async (steps: unknown[]) => { const file = join(directory, `scenario-${++count}.json`), argsFile = join(directory, `args-${count}.json`); await writeFile(file, JSON.stringify({ steps, argsFile })); return { file, argsFile }; };
  const runner = (file: string, exitGraceMs = 2_000) => piRunner({ command: process.execPath, commandArgs: [script, file], model: 'zai/glm-5.3-flash', extension: '/extensions/graphyard.ts', exitGraceMs });
  const options = { cwd: directory, tool: graphyardTools.decide, validate: (payload: unknown) => decidePayloadSchema.parse(payload), timeoutMs: 5_000 };
  return { directory, scenario, runner, options, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('unit:runner-pi-events a Pi run streams typed events and resolves to the validated submitted payload', async () => {
  const { directory, scenario, runner, options, cleanup } = await fixture();
  try {
    const verdict = { decision: 'decision-1', approve: true, reason: 'the criteria are met' };
    const { file, argsFile } = await scenario([...recorded, decide(verdict), { line: 'not json' }, ...settled]);
    const run = runner(file).start('Judge decision-1', { ...options, env: { FAKE_ACCOUNT: 'pi-a' } });
    const streamed: RunEvent['kind'][] = [];
    run.onEvent(event => streamed.push(event.kind));
    const result = await run.result();
    assert.deepEqual(result, { ok: true, tool: graphyardTools.decide, payload: verdict, payloads: [verdict] }, 'the result is the validated payload');
    assert.deepEqual(streamed, ['start', 'session', 'message', 'tool-start', 'tool-end', 'unparsed', 'settled', 'exit'], 'every event streamed in order, streaming noise dropped');
    const message = run.events.find(event => event.kind === 'message');
    assert.deepEqual(message && { role: message.role, text: message.text, stopReason: message.stopReason }, { role: 'assistant', text: 'Reading the decision.', stopReason: 'toolUse' });
    const exit = run.events.at(-1)!;
    assert.equal(exit.kind === 'exit' && exit.code, 0);
    // A listener subscribed late is given the events already seen.
    const replayed: string[] = []; run.onEvent(event => replayed.push(event.kind));
    assert.deepEqual(replayed, streamed);

    // The launch: pi in JSON mode in the given worktree, the given model and extension, the
    // environment wrapper's own variables passed through, stdin not a terminal.
    const launched = JSON.parse(await readFile(argsFile, 'utf8'));
    assert.deepEqual(launched.args, piArgs('Judge decision-1', { model: 'zai/glm-5.3-flash', extension: '/extensions/graphyard.ts' }));
    assert.deepEqual(launched.args.slice(0, 2), ['--mode', 'json']);
    assert.equal(launched.cwd, directory);
    assert.equal(launched.stdinTTY, false);
    assert.ok(launched.env.includes('FAKE_ACCOUNT'));

    // The record a session keeps is bounded and schema-valid.
    const kept = runRecordSchema.parse(runRecord('pi', run, result, '2030-01-01T00:00:00.000Z', '2030-01-01T00:01:00.000Z'));
    assert.deepEqual(kept.result, { ok: true, tool: graphyardTools.decide, submitted: 1 });
  } finally { await cleanup(); }
});

test('unit:runner-pi-events a run with no terminal event within the bound is stopped and fails as a timeout', async () => {
  const { scenario, runner, options, cleanup } = await fixture();
  try {
    const { file } = await scenario([...recorded, { hang: true }]);
    const started = Date.now();
    const run = runner(file).start('Judge decision-1', { ...options, timeoutMs: 400 });
    const result = await run.result();
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.failure.reason, 'timeout');
    assert.match(!result.ok ? result.failure.detail : '', /no terminal event within/);
    assert.ok(Date.now() - started < 4_000, 'the hung process was stopped, not waited out');
    assert.ok(run.events.some(event => event.kind === 'exit'), 'the process is gone');
  } finally { await cleanup(); }
});

test('unit:runner-pi-events an invalid submitted payload is a typed invalid-payload failure, never a result', async () => {
  const { scenario, runner, options, cleanup } = await fixture();
  try {
    // A payload the extension let through but Graphyard's own schema refuses.
    const { file } = await scenario([...recorded, decide({ decision: 'decision-1', approve: 'yes', reason: 'fine' }), ...settled]);
    const result = await runner(file).start('Judge decision-1', options).result();
    assert.equal(!result.ok && result.failure.reason, 'invalid-payload');
    assert.match(!result.ok ? result.failure.detail : '', /failed validation/);
    assert.deepEqual(result.payloads, []);

    // A call the extension rejected is the same failure, with the extension's reason.
    const rejected = await scenario([...recorded, decide({}, true), ...settled]);
    const second = await runner(rejected.file).start('Judge decision-1', options).result();
    assert.equal(!second.ok && second.failure.reason, 'invalid-payload');
    assert.match(!second.ok ? second.failure.detail : '', /input\.approve is required/);

    // A run that ends cleanly without calling the tool submitted nothing.
    const silent = await scenario([...recorded, ...settled]);
    const third = await runner(silent.file).start('Judge decision-1', options).result();
    assert.equal(!third.ok && third.failure.reason, 'no-payload');
  } finally { await cleanup(); }
});

test('unit:runner-pi-events a non-zero exit before settling is a typed exit failure carrying the code and stderr', async () => {
  const { scenario, runner, options, cleanup } = await fixture();
  try {
    const { file } = await scenario([...recorded, { stderr: 'No API key for provider zai' }, { exit: 3 }]);
    const result = await runner(file).start('Judge decision-1', options).result();
    assert.equal(!result.ok && result.failure.reason, 'exit');
    assert.equal(!result.ok && result.failure.code, 3);
    assert.match(!result.ok ? result.failure.detail : '', /code 3: No API key for provider zai/);

    const missing = piRunner({ command: '/nonexistent/pi-binary' }).start('Judge', options);
    const spawnFailure = await missing.result();
    assert.equal(!spawnFailure.ok && spawnFailure.failure.reason, 'spawn');
  } finally { await cleanup(); }
});

test('unit:runner-pi-events cancel stops the run and resolves it as cancelled; the loop identity never reaches the run', async () => {
  const { scenario, runner, options, cleanup } = await fixture();
  try {
    const { file, argsFile } = await scenario([...recorded, { hang: true }]);
    const run = runner(file).start('Judge decision-1', options);
    await new Promise<void>(resolve => { const off = run.onEvent(event => { if (event.kind === 'tool-start') { off(); resolve(); } }); });
    run.cancel('the request was withdrawn');
    const result = await run.result();
    assert.deepEqual(!result.ok && result.failure, { reason: 'cancelled', detail: 'the request was withdrawn' });
    const launched = JSON.parse(await readFile(argsFile, 'utf8'));
    assert.deepEqual(launched.env.filter((name: string) => /^(GRAPHYARD_|HERDR_)/.test(name)), [], 'no inherited Graphyard or Herdr variable');
    assert.deepEqual(Object.keys(runEnvironment({ GRAPHYARD_TOKEN_FILE: '/x', HERDR_PANE: 'p', PATH: '/bin' }, { GRAPHYARD_URL: 'u' })).sort(), ['GRAPHYARD_URL', 'PATH']);
  } finally { await cleanup(); }
});
