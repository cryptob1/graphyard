import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isReleaseCandidateTest, listTestFiles, preMergeTestFiles, readDurations, releaseCandidateTests, repositoryRoot, shardFiles } from '../scripts/ci-tests.mjs';
import { commitVerdict } from '../src/main-guard.js';
import { policySchema } from '../src/model/policy.js';
import { readWorkflow } from '../src/protection.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1093: the pre-merge gate runs only fast, deterministic checks. Every pull request, rework and
// queue tip ran four shards including a twenty-to-thirty-minute soak, container acceptance and
// recovery, and the chart, so runner queues grew and a soak flake that main also showed stranded
// candidates. Those long suites now run only against a pinned release-candidate SHA, in their own
// workflow. One case per proof: unit:fast-gate-required-set, unit:long-suites-on-candidate,
// unit:ci-bubblewrap-install-resilient.

const read = (path: string) => readFileSync(join(repositoryRoot, path), 'utf8');
const ciPath = '.github/workflows/ci.yml', candidatePath = '.github/workflows/release-candidate.yml';

/** Each job's id, its block of text, and the jobs it needs. */
function jobsOf(text: string) {
  const lines = text.split('\n'), start = lines.indexOf('jobs:');
  assert.ok(start >= 0, 'the workflow declares jobs');
  const jobs = new Map<string, { text: string; needs: string[]; timeout: number | null }>();
  let id: string | null = null, body: string[] = [];
  const flush = () => {
    if (!id) return;
    const block = body.join('\n'), needs = block.match(/^ {4}needs: \[([^\]]*)\]/m)?.[1] ?? block.match(/^ {4}needs: ([\w-]+)$/m)?.[1] ?? '';
    const timeout = block.match(/^ {4}timeout-minutes: (\d+)$/m)?.[1];
    jobs.set(id, { text: block, needs: needs.split(',').map(entry => entry.trim()).filter(Boolean), timeout: timeout ? Number(timeout) : null });
  };
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const opened = line.match(/^ {2}([\w-]+):\s*$/)?.[1];
    if (opened) { flush(); id = opened; body = []; } else body.push(line);
  }
  flush();
  return jobs;
}

/** What marks a job as one of the long suites, wherever it is declared. */
const longSuiteMarkers: [string, RegExp][] = [
  ['container acceptance', /scripts\/run-acceptance\.mjs/],
  ['container recovery', /integration:herdr-recovery/],
  ['container image build', /docker build/],
  ['chart', /\bhelm\b|kind-action|deploy\/helm/],
  ['release-candidate test files', /ci-tests\.mjs release-candidate/],
];

test('unit:fast-gate-required-set — the required CI checks exclude the soak, container-acceptance, container-recovery, chart and timing-budget suites, and the required set is bounded under ten minutes', async () => {
  const ci = read(ciPath), jobs = jobsOf(ci);
  const required = policySchema.parse({}).checks;
  assert.deepEqual(required, ['test', 'typecheck'], 'the default required checks are test and typecheck');
  // Every workflow that runs on a pull request: only ci.yml (and the trusted acceptance harness,
  // which certifies an item's own proofs and is not a branch-protection check) may.
  const workflows = ['ci.yml', 'acceptance.yml', 'deploy-smoke.yml', 'release.yml', 'release-candidate.yml'].map(name => `.github/workflows/${name}`).filter(path => existsSync(join(repositoryRoot, path)));
  assert.ok(!existsSync(join(repositoryRoot, '.github/workflows/helm.yml')), 'the chart no longer has a pull-request workflow of its own');
  for (const path of workflows.filter(path => path !== ciPath && path !== '.github/workflows/acceptance.yml'))
    assert.equal(readWorkflow(read(path)).pullRequest, false, `${path} never runs on a pull request`);

  // The required set: each required check's job and everything it needs, transitively.
  const set = new Set<string>(), visit = (id: string) => {
    if (set.has(id)) return;
    assert.ok(jobs.has(id), `${ciPath} defines job ${id}`);
    set.add(id); jobs.get(id)!.needs.forEach(visit);
  };
  required.forEach(visit);
  assert.deepEqual([...set].sort(), ['test', 'test-browser', 'test-shard', 'typecheck']);
  for (const id of set) for (const [suite, marker] of longSuiteMarkers) assert.doesNotMatch(jobs.get(id)!.text, marker, `required job ${id} runs no ${suite}`);
  for (const id of ['container-acceptance', 'container-recovery', 'chart', 'soak']) assert.ok(!jobs.has(id), `${ciPath} has no ${id} job`);
  for (const [suite, marker] of longSuiteMarkers) assert.doesNotMatch(ci, marker, `${ciPath} runs no ${suite}`);

  // Bounded: every required job declares a timeout, and the longest chain of them is under ten minutes.
  const chain = (id: string): number => jobs.get(id)!.timeout! + Math.max(0, ...jobs.get(id)!.needs.map(chain));
  for (const id of set) assert.ok(jobs.get(id)!.timeout, `required job ${id} declares timeout-minutes`);
  const longest = Math.max(...required.map(chain));
  assert.ok(longest < 10, `the required set completes in under ten minutes: its longest chain of timeouts is ${longest}`);

  // The shards run only pre-merge files: the selection for a full run (a push to main, a queue tip)
  // names every test file except the release-candidate suites.
  const kinds = new Set(Object.values(releaseCandidateTests));
  assert.deepEqual([...kinds].sort(), ['soak', 'timing-budget']);
  for (const file of Object.keys(releaseCandidateTests)) assert.ok(existsSync(join(repositoryRoot, file)), `${file} exists`);
  assert.ok(listTestFiles().filter(file => /^tests\/soak/.test(file)).every(isReleaseCandidateTest), 'the soak is a release-candidate suite');
  const dir = await temporaryDirectory('ci-workflow-split'), out = join(dir, 'selected.txt');
  execFileSync(process.execPath, ['scripts/ci-tests.mjs', 'select', '--out', out], { cwd: repositoryRoot, env: { ...process.env, GITHUB_EVENT_NAME: 'push', GITHUB_STEP_SUMMARY: '' }, stdio: ['ignore', 'ignore', 'ignore'] });
  const selected = readFileSync(out, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(selected, preMergeTestFiles());
  assert.deepEqual(selected, listTestFiles().filter(file => !(file in releaseCandidateTests)));
  // A test whose verdict is a wall-clock budget through the timing helper is a release-candidate
  // suite; the helper's own tests (synthetic samples, no clock) stay.
  for (const file of listTestFiles().filter(file => file !== 'tests/timing-stability.test.ts'))
    if (/\bassertTiming\(/.test(read(file))) assert.ok(isReleaseCandidateTest(file), `${file} asserts a timing budget, so it runs on the release candidate`);

  // The recorded per-file durations fit each shard's bound even run one file after another.
  const shard = jobs.get('test-shard')!;
  const shardCount = (shard.text.match(/shard: \[([^\]]*)\]/)?.[1] ?? '').split(',').filter(entry => entry.trim()).length;
  assert.ok(shardCount >= 4, 'the test-shard matrix lists its shards');
  const shards = shardFiles(preMergeTestFiles(), readDurations(), shardCount);
  for (const entry of shards) assert.ok(entry.durationMs < shard.timeout! * 60_000, `a shard's recorded files take ${Math.round(entry.durationMs / 1000)}s in series, within its ${shard.timeout}-minute bound`);
});

test('unit:long-suites-on-candidate — the excluded suites run in release-candidate.yml against a pinned SHA, by dispatch with a sha input or on push of an rc tag, never on a pull request', () => {
  const text = read(candidatePath), workflow = readWorkflow(text), jobs = jobsOf(text);
  assert.equal(workflow.pullRequest, false, 'release-candidate validation never runs on a pull request');
  const on = text.slice(text.indexOf('\non:\n') + 1, text.indexOf('\npermissions:'));
  assert.match(on, /^ {2}workflow_dispatch:\n {4}inputs:\n {6}sha:\n/m, 'dispatch takes a sha input to validate one commit');
  assert.match(on, /^ {2}push:\n {4}tags: \['rc-\*'\]$/m, 'a pushed rc tag starts it');
  assert.match(on, /^ {2}schedule:\n/m, 'a schedule cuts main\'s tip as a candidate (GY-1094)');
  assert.doesNotMatch(on, /branches|pull_request/, 'no branch push or pull request starts it');

  // Every long suite validates the pinned candidate — the cut tip, the dispatched SHA or the tagged commit — never the ref it was started from.
  assert.match(jobs.get('candidate')!.text, /^ {6}PINNED: \$\{\{ inputs\.sha \|\| \(github\.event_name == 'push' && github\.sha\) \|\| '' \}\}$/m);
  assert.match(jobs.get('candidate')!.text, /\^\[0-9a-f\]\{40\}\$/, 'a dispatched sha must be a full commit SHA');
  const longSuites = ['chart', 'container-acceptance', 'container-recovery', 'long-suites'];
  for (const [id, job] of jobs) {
    assert.doesNotMatch(job.text, /\$GITHUB_SHA/, `${id} stamps the candidate SHA, not the triggering ref's`);
    assert.ok(job.timeout, `${id} declares timeout-minutes`);
    if (!longSuites.includes(id) && id !== 'uat') continue;
    assert.match(job.text, /^ {6}CANDIDATE_SHA: \$\{\{ needs\.candidate\.outputs\.sha \}\}$/m, `${id} validates the candidate job's pinned SHA`);
    const checkouts = [...job.text.matchAll(/uses: actions\/checkout@v4\n\s+with: (.*)$/gm)];
    assert.ok(checkouts.length >= 1 && checkouts.every(match => match[1].includes("ref: '${{ env.CANDIDATE_SHA }}'")), `${id} checks out the candidate SHA`);
  }
  for (const id of longSuites) assert.deepEqual(jobs.get(id)!.needs, ['candidate'], `${id} waits only for the candidate to be pinned`);
  // A cut candidate's UAT record carries the container and chart verdicts, so a failure among them blocks
  // promotion; the soak and timing-budget suites are advisory and neither delay nor decide it.
  const gating = longSuites.filter(id => id !== 'long-suites');
  assert.deepEqual(jobs.get('uat')!.needs, ['candidate', 'container-acceptance', 'container-recovery', 'chart']);
  for (const id of gating) assert.match(jobs.get('uat')!.text, new RegExp(`--suite '${id}=test "\\$[A-Z_]+" = success'`), `the UAT record carries the ${id} verdict`);
  assert.doesNotMatch(jobs.get('uat')!.text, /--suite 'long-suites=/, 'the soak verdict is advisory');

  // Every suite the pre-merge gate excludes runs here.
  assert.deepEqual([...jobs.keys()].sort(), ['candidate', 'chart', 'container-acceptance', 'container-recovery', 'long-suites', 'promote', 'uat']);
  // The timing budgets run first, one file at a time, and the soak after them (GY-1440): a budget
  // measured beside another suite's load measures that load. Both run whatever the other's verdict.
  const suitesStep = jobs.get('long-suites')!.text;
  assert.match(suitesStep, /node scripts\/ci-tests\.mjs release-candidate --suite timing-budget --out "\$RUNNER_TEMP\/timing-budget-tests\.txt"/);
  assert.match(suitesStep, /node scripts\/ci-tests\.mjs release-candidate --suite soak --out "\$RUNNER_TEMP\/soak-tests\.txt"/);
  const timingRun = suitesStep.indexOf('npm test -- --files-from "$RUNNER_TEMP/timing-budget-tests.txt" --test-concurrency=1 '), soakRun = suitesStep.indexOf('npm test -- --files-from "$RUNNER_TEMP/soak-tests.txt" ');
  assert.ok(timingRun >= 0 && soakRun > timingRun, 'the timing budgets run one file at a time, before the soak');
  assert.equal([...suitesStep.matchAll(/npm test -- /g)].length, 2, 'no other run shares the runner with them');
  assert.equal([...suitesStep.matchAll(/ \|\| status=1$/gm)].length, 2, 'the soak runs whatever the timing budgets\' verdict, and the step fails on either');
  assert.match(suitesStep, /timing-report\.ts "\$RUNNER_TEMP\/timing\/release-candidate\.jsonl" "\$RUNNER_TEMP\/timing\/test-timing-budget\.log" "\$RUNNER_TEMP\/timing\/test-soak\.log"/, 'the report counts both runs\' failures');
  assert.match(jobs.get('long-suites')!.text, /apt-get install -y -q bubblewrap/, 'the soak confines its launches in real namespaces');
  assert.match(jobs.get('container-acceptance')!.text, /scripts\/run-acceptance\.mjs "\$RUNNER_TEMP\/candidate\.json" graphyard-ci "\$RUNNER_TEMP\/acceptance\.json"/);
  // GitHub merges under branch protection (GY-1235): Graphyard has no merge authorization left to exercise.
  assert.doesNotMatch(jobs.get('container-acceptance')!.text, /integration:merge-authorization/);
  assert.match(jobs.get('container-acceptance')!.text, /scripts\/verify-image-release\.mjs graphyard-ci .* "\$CANDIDATE_SHA"/);
  assert.match(jobs.get('container-recovery')!.text, /integration:herdr-recovery/);
  assert.match(jobs.get('chart')!.text, /helm lint deploy\/helm\/graphyard --strict/);
  assert.match(jobs.get('chart')!.text, /bash deploy\/helm\/exercise\.sh/);

  // The list the long-suites job runs is exactly the suites the pre-merge selection leaves out.
  const listed = execFileSync(process.execPath, ['scripts/ci-tests.mjs', 'release-candidate'], { cwd: repositoryRoot, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.deepEqual(listed, listTestFiles().filter(isReleaseCandidateTest));
  assert.deepEqual([...listed].sort(), Object.keys(releaseCandidateTests).sort());
  const suite = (name: string) => execFileSync(process.execPath, ['scripts/ci-tests.mjs', 'release-candidate', '--suite', name], { cwd: repositoryRoot, encoding: 'utf8' }).split('\n').filter(Boolean);
  const [timingBudget, soak] = [suite('timing-budget'), suite('soak')];
  assert.deepEqual([...timingBudget, ...soak].sort(), [...listed].sort(), 'the two suites together are exactly the release-candidate list');
  assert.ok(timingBudget.length > 0 && timingBudget.every(file => releaseCandidateTests[file] === 'timing-budget') && soak.every(file => releaseCandidateTests[file] === 'soak'), 'each suite lists its own files');
  // The soak runs as one suite per concern (GY-1363), each file of it here and none over 1,500 lines.
  const soaks = listTestFiles().filter(file => /^tests\/soak/.test(file));
  assert.ok(soaks.length >= 4, `the soak is split per concern: ${soaks.join(', ')}`);
  for (const file of soaks) {
    assert.equal(releaseCandidateTests[file], 'soak', `${file} is the release-candidate soak suite`);
    assert.ok(listed.includes(file), `${file} runs on the release candidate`);
    assert.ok(read(file).split('\n').length <= 1500, `${file} stays within 1,500 lines`);
  }
  assert.deepEqual([...listed, ...preMergeTestFiles()].sort(), listTestFiles(), 'every test file runs in exactly one of the two gates');
  // No job here shares a name with a required check, so none can ever be required of a pull request.
  const required = policySchema.parse({}).checks;
  for (const id of jobs.keys()) assert.ok(!required.includes(id), `${id} is not a required check`);
});

test('unit:ci-bubblewrap-install-resilient — the shards install bubblewrap with bounded, retried apt calls that fall back to other mirrors, and an install that fails every attempt concludes the shard timed out, which the main guard reruns and never reverts', () => {
  const shard = jobsOf(read(ciPath)).get('test-shard')!;
  const start = shard.text.indexOf('      - name: Install bubblewrap'), end = shard.text.indexOf('\n      - ', start + 1);
  assert.ok(start >= 0 && end > start, 'test-shard installs bubblewrap');
  const step = shard.text.slice(start, end);
  // Retried, each attempt bounded, the later ones on a fallback mirror.
  assert.match(step, /for attempt in 1 2 3; do/, 'three attempts');
  const bounds = [...step.matchAll(/sudo timeout (\d+) apt-get (update|install)/g)];
  assert.deepEqual(bounds.map(match => match[2]), ['update', 'install'], 'both apt calls of an attempt are bounded');
  const attempt = bounds.reduce((sum, match) => sum + Number(match[1]), 0) + Number(step.match(/^ +sleep (\d+)$/m)?.[1] ?? NaN);
  assert.ok(3 * attempt < 3 * 60, `three attempts take at most ${3 * attempt}s, well within the job's ${shard.timeout}-minute bound`);
  const mirrors = step.match(/mirrors=\(''((?: https?:\/\/\S+)+)\)/)?.[1].trim().split(' ') ?? [];
  assert.equal(mirrors.length, 2, 'attempts 2 and 3 each switch to a fallback mirror');
  assert.match(step, /sed -i -E "s#\^URIs: \.\*#URIs: \$mirror#" \/etc\/apt\/sources\.list\.d\/ubuntu\.sources/, 'the fallback rewrites only Ubuntu\'s own sources');
  assert.match(step, /command -v bwrap >\/dev\/null && installed=true/, 'a preinstalled bubblewrap skips apt');
  // No step timeout: a step timing out fails the job, which the guard judges a failing test. After
  // the last attempt the step outwaits the job's own timeout instead.
  assert.doesNotMatch(step, /timeout-minutes/, 'the step has no timeout of its own');
  assert.ok(shard.timeout && shard.timeout <= 6, 'the job bounds it');
  const exhausted = step.slice(step.indexOf("if [[ $installed != true ]]; then"));
  assert.match(exhausted, /::error title=Infrastructure failure, not a test failure::/);
  assert.ok(Number(exhausted.match(/^ +sleep (\d+)$/m)?.[1]) > shard.timeout * 60, 'it waits past the job timeout');

  // The guard's classification of such a run: the shard timed out, the aggregate test check failed
  // because of it, so main is a cancelled run to rerun, not a culprit to revert.
  const ci = [15368], required = ['test', 'typecheck'];
  const checks = [
    { name: 'typecheck', result: 'success', appId: 15368, id: 1 },
    { name: 'test shard 1', result: 'success', appId: 15368, id: 2 },
    { name: 'test shard 2', result: 'timed_out', appId: 15368, id: 3 },
    { name: 'test-browser', result: 'success', appId: 15368, id: 4 },
    { name: 'test', result: 'failure', appId: 15368, id: 5 },
  ];
  assert.deepEqual(commitVerdict(checks, required, ci), { verdict: 'cancelled', failing: ['test'], checkRun: 3 });
  // A step that failed the shard outright is a failing test, which is why the step never fails on its own.
  assert.deepEqual(commitVerdict(checks.map(check => check.id === 3 ? { ...check, result: 'failure' } : check), required, ci), { verdict: 'fail', failing: ['test'] });
});
