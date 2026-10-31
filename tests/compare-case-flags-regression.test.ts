import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { caseDirectory, loadCases, parseCase } from '../src/e2e/case.js';
import { runCases } from '../src/e2e/runner.js';
import { compareJudgePrompt, parseCompareVerdict, type CompareInput } from '../src/e2e/steps.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2985: live verification compares against what was live. An agent case marked `compare` runs
// its goal on the new served build and on the previous verified build (BASELINE_URL), and one
// judge call given both transcripts and screenshots decides: WORSE fails the case, naming the
// judge's reason. Against what was live it passes, and with no baseline (the first serve) the
// case runs once, as today.

/** The fixture page: the candidate drops the Save control the baseline shows. */
const page = (withControl: boolean) => `<!doctype html><html><body><h1>Editor</h1>${withControl ? '<button>Save</button>' : ''}</body></html>\n`;

/** A static fixture build: every request is answered the same page. */
const fixture = (body: string) => new Promise<{ url: string; close: () => Promise<void> }>((accept, reject) => {
  const server = createHttpServer((_request, response) => response.writeHead(200, { 'Content-Type': 'text/html' }).end(body));
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as { port: number };
    accept({ url: `http://127.0.0.1:${port}`, close: () => new Promise(done => server.close(() => done())) });
  });
});

const compareCase = (id: string, compare: boolean) => ({ id, title: `Case ${id}`, target: 'any', steps: [{ kind: 'agent', goal: 'Open the editor page', success: ['The page shows the heading Editor'], path: '/editor', ...(compare ? { compare: true } : {}) }] });

/** A fake `agent-browser` on PATH: logs every invocation, answers `chat` with the reply file's text (the judge session with the judge reply's), and writes the screenshot it is asked for. */
async function fakeAgentBrowser(dir: string) {
  const bin = join(dir, 'bin'); await mkdir(bin, { recursive: true });
  const log = join(dir, 'agent-browser.log'), reply = join(dir, 'reply.txt'), judgeReply = join(dir, 'judge-reply.txt');
  await writeFile(join(bin, 'agent-browser'), `#!/bin/sh\nprintf '%s\\n---\\n' "$*" >> ${JSON.stringify(log)}\ncase "$3" in\n  chat) case "$2" in *-judge) cat ${JSON.stringify(judgeReply)};; *) cat ${JSON.stringify(reply)};; esac; exit 0 ;;\n  screenshot) printf 'png' > "$4" ;;\nesac\n`);
  await chmod(join(bin, 'agent-browser'), 0o755);
  await writeFile(reply, 'VERDICT: PASS\n');
  return { bin, log, judgeReply, invocations: async () => (await readFile(log, 'utf8').catch(() => '')).split('\n---\n').filter(Boolean) };
}

/** Run options for a scratch checkout whose agent-browser is the fake one. */
const runOptions = (root: string, fake: Awaited<ReturnType<typeof fakeAgentBrowser>>, extra: Record<string, unknown> = {}) => ({
  url: 'http://candidate.test', token: 'token', root, runId: 'cmp1', artifactsDirectory: join(root, 'shots'),
  hostEnvironment: { PATH: `${fake.bin}:${process.env.PATH}`, HOME: process.env.HOME }, ...extra,
});

test('unit:compare-case-flags-regression — a compare agent case against a baseline fixture and a candidate fixture whose page drops a visible control records WORSE with the judge\'s reason and fails; against identical fixtures it passes; with no baseline it runs once', async () => {
  const scratch = await temporaryDirectory('compare-case-flags');
  const fake = await fakeAgentBrowser(scratch);
  const dir = await temporaryDirectory('compare-case-repo', scratch);
  await mkdir(join(dir, caseDirectory), { recursive: true });
  await writeFile(join(dir, caseDirectory, 'compare-regression.json'), JSON.stringify(compareCase('compare-regression', true), null, 2));
  const cases = await loadCases(dir);
  // The case accepts the flag, and it is part of what the step registers as.
  assert.deepEqual(parseCase('e2e/cases/compare-regression.json', JSON.stringify(compareCase('compare-regression', true))).steps[0],
    { kind: 'agent', goal: 'Open the editor page', success: ['The page shows the heading Editor'], path: '/editor', timeoutSeconds: 600, compare: true });
  assert.deepEqual(parseCompareVerdict('reasoning\nVERDICT: SAME\n'), { verdict: 'SAME', reason: null });
  assert.deepEqual(parseCompareVerdict('VERDICT: WORSE - the Save control is gone\n'), { verdict: 'WORSE', reason: 'the Save control is gone' });
  assert.equal(parseCompareVerdict('VERDICT: PASS'), null);

  // The candidate dropped the Save control the baseline shows: the judge says WORSE, the case
  // fails naming the judge's reason, and the judge was called once with both runs.
  const baseline = await fixture(page(true)), candidate = await fixture(page(false));
  try {
    const calls: CompareInput[] = [];
    const worse = await runCases(cases, runOptions(dir, fake, { url: candidate.url, baselineUrl: baseline.url, judge: async (input: CompareInput) => { calls.push(input); return { verdict: 'WORSE', reason: 'the Save control visible on the baseline is gone from the candidate' }; } }));
    assert.equal(worse.cases[0].outcome, 'fail', JSON.stringify(worse.cases[0].failingStep));
    assert.deepEqual(worse.cases[0].failingStep, { index: 0, name: 'agent "Open the editor page"', reason: 'the Save control visible on the baseline is gone from the candidate' });
    const step = worse.cases[0].attemptResults[0].steps![0];
    assert.equal(step.verdict, 'VERDICT: WORSE - the Save control visible on the baseline is gone from the candidate');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].goal, 'Open the editor page');
    assert.deepEqual(calls[0].success, ['The page shows the heading Editor']);
    assert.equal(calls[0].target.url, `${candidate.url}/editor`);
    assert.equal(calls[0].baseline.url, `${baseline.url}/editor`);
    assert.ok(calls[0].target.transcript.includes('VERDICT: PASS'), 'the judge is given the target leg\'s transcript');
    assert.ok(calls[0].baseline.transcript.includes('VERDICT: PASS'), 'the judge is given the baseline leg\'s transcript');
    assert.deepEqual(calls[0].target.screenshots, [join(dir, 'shots', 'graphyard-e2e-cmp1-compare-regression-1-1.png')]);
    assert.deepEqual(calls[0].baseline.screenshots, [join(dir, 'shots', 'graphyard-e2e-cmp1-compare-regression-1-1-baseline.png')]);
    for (const file of [...calls[0].target.screenshots, ...calls[0].baseline.screenshots]) assert.equal(await readFile(file, 'utf8'), 'png', 'the screenshot was taken');
    // The goal ran on both builds, in the step's own session and the baseline's.
    const invocations = await fake.invocations();
    assert.ok(invocations.includes(`--session graphyard-e2e-cmp1-compare-regression-1-1 open ${candidate.url}/editor`));
    assert.ok(invocations.includes(`--session graphyard-e2e-cmp1-compare-regression-1-1-baseline open ${baseline.url}/editor`));

    // The same fixtures judged the same pass: the case passes, the judge's verdict recorded.
    const same = await runCases(cases, runOptions(dir, fake, { url: candidate.url, baselineUrl: baseline.url, runId: 'cmp2', judge: async () => ({ verdict: 'SAME', reason: null }) }));
    assert.equal(same.cases[0].outcome, 'pass', JSON.stringify(same.cases[0].failingStep));
    assert.equal(same.cases[0].attemptResults[0].steps![0].verdict, 'VERDICT: SAME');

    // With no baseline (the first serve) the case runs once, as today, and the judge is never called.
    const alone = await runCases(cases, runOptions(dir, fake, { url: candidate.url, runId: 'cmp3', judge: async () => { throw new Error('the judge must not be called without a baseline'); } }));
    assert.equal(alone.cases[0].outcome, 'pass', JSON.stringify(alone.cases[0].failingStep));
    assert.equal(alone.cases[0].attemptResults[0].steps![0].verdict, 'VERDICT: PASS');
    const once = (await fake.invocations()).filter(line => line.includes('graphyard-e2e-cmp3-compare-regression-1-1 '));
    assert.equal(once.filter(line => line.endsWith(` open ${candidate.url}/editor`)).length, 1, 'the goal ran once, on the target only');
    assert.equal(once.filter(line => / chat /.test(line)).length, 1);
  } finally { await baseline.close(); await candidate.close(); }
});

test('unit:compare-case-flags-regression-judge — the default judge is one agent-browser call in its own session, given both transcripts and screenshots, and its WORSE fails the case naming the reason', async () => {
  const scratch = await temporaryDirectory('compare-case-judge');
  const fake = await fakeAgentBrowser(scratch);
  await writeFile(fake.judgeReply, 'They look the same to me.\nVERDICT: WORSE - the Save control is gone\n');
  const dir = await temporaryDirectory('compare-case-judge-repo', scratch);
  await mkdir(join(dir, caseDirectory), { recursive: true });
  await writeFile(join(dir, caseDirectory, 'compare-regression.json'), JSON.stringify(compareCase('compare-regression', true), null, 2));
  const cases = await loadCases(dir);
  const baseline = await fixture(page(true)), candidate = await fixture(page(true));
  try {
    const report = await runCases(cases, runOptions(dir, fake, { url: candidate.url, baselineUrl: baseline.url, runId: 'cmp4' }));
    assert.equal(report.cases[0].outcome, 'fail', JSON.stringify(report.cases[0].failingStep));
    assert.equal(report.cases[0].failingStep!.reason, 'the Save control is gone');
    assert.equal(report.cases[0].attemptResults[0].steps![0].verdict, 'VERDICT: WORSE - the Save control is gone');
    // One judge call: its prompt names the goal, both builds and both screenshots.
    const judge = (await fake.invocations()).find(line => line.includes('--session graphyard-e2e-cmp4-compare-regression-1-1-judge chat'));
    assert.ok(judge, 'the judge session was invoked');
    assert.match(judge, new RegExp(candidate.url.replace(/[.]/g, '\\.')));
    assert.match(judge, new RegExp(baseline.url.replace(/[.]/g, '\\.')));
    assert.match(judge, /Goal: Open the editor page/);
    assert.match(judge, /`VERDICT: SAME`, `VERDICT: BETTER` or `VERDICT: WORSE - <reason>`/);
    assert.ok(compareJudgePrompt({ goal: 'g', success: ['s'], target: { url: 't', transcript: ['a'], screenshots: ['t.png'] }, baseline: { url: 'b', transcript: ['b1'], screenshots: ['b.png'] } }).includes('t.png') && compareJudgePrompt({ goal: 'g', success: ['s'], target: { url: 't', transcript: [], screenshots: [] }, baseline: { url: 'b', transcript: [], screenshots: [] } }).includes('screenshot: none'), 'the judge prompt carries the screenshots, naming none when a leg kept none');
  } finally { await baseline.close(); await candidate.close(); }
});
