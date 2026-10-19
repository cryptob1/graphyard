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
const ciPath = '.github/workflows/ci.yml', candidatePath = '.github/workflows/release-candidate.yml', soakPath = '.github/workflows/release-candidate-soak.yml';

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

test('unit:fast-gate-required-set — GY-2009 removes Actions PR gates; pre-merge selection still excludes release-candidate suites', async () => {
  assert.ok(!existsSync(join(repositoryRoot, ciPath)), 'ci.yml is gone; the merge writer trial is the gate');
  assert.ok(!existsSync(join(repositoryRoot, '.github/workflows/acceptance.yml')));
  assert.ok(!existsSync(join(repositoryRoot, '.github/workflows/deploy-smoke.yml')));
  const required = policySchema.parse({}).checks;
  assert.deepEqual(required, ['test', 'typecheck'], 'the default required checks are test and typecheck');
  for (const path of [candidatePath, soakPath, '.github/workflows/release.yml'])
    assert.equal(readWorkflow(read(path)).pullRequest, false, `${path} never runs on a pull request`);

  const kinds = new Set(Object.values(releaseCandidateTests));
  assert.deepEqual([...kinds].sort(), ['soak', 'timing-budget']);
  for (const file of Object.keys(releaseCandidateTests)) assert.ok(existsSync(join(repositoryRoot, file)), `${file} exists`);
  assert.ok(listTestFiles().filter(file => /^tests\/soak/.test(file)).every(isReleaseCandidateTest), 'the soak is a release-candidate suite');
  const dir = await temporaryDirectory('ci-workflow-split'), out = join(dir, 'selected.txt');
  execFileSync(process.execPath, ['scripts/ci-tests.mjs', 'select', '--out', out], { cwd: repositoryRoot, env: { ...process.env, GITHUB_EVENT_NAME: 'push', GITHUB_STEP_SUMMARY: '' }, stdio: ['ignore', 'ignore', 'ignore'] });
  const selected = readFileSync(out, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(selected, preMergeTestFiles());
  assert.deepEqual(selected, listTestFiles().filter(file => !(file in releaseCandidateTests)));
  for (const file of listTestFiles().filter(file => file !== 'tests/timing-stability.test.ts'))
    if (/\bassertTiming\(/.test(read(file))) assert.ok(isReleaseCandidateTest(file), `${file} asserts a timing budget, so it runs on the release candidate`);
});

test('unit:long-suites-on-candidate — the excluded suites run in release-candidate.yml (the soak in the release-candidate-soak.yml it dispatches) against a pinned SHA, by dispatch with a sha input or on push of an rc tag, never on a pull request', () => {
  const text = read(candidatePath), workflow = readWorkflow(text), jobs = jobsOf(text);
  // GY-1513: the advisory soak and timing-budget suites run in a workflow of their own, dispatched with the candidate SHA.
  const soakText = read(soakPath), soakJobs = jobsOf(soakText);
  assert.equal(readWorkflow(soakText).pullRequest, false, 'the soak never runs on a pull request');
  assert.match(jobs.get('soak')!.text, /gh workflow run release-candidate-soak\.yml .* -f sha="\$CANDIDATE_SHA"/);
  assert.equal(workflow.pullRequest, false, 'release-candidate validation never runs on a pull request');
  const on = text.slice(text.indexOf('\non:\n') + 1, text.indexOf('\npermissions:'));
  assert.match(on, /^ {2}workflow_dispatch:\n {4}inputs:\n {6}sha:\n/m, 'dispatch takes a sha input to validate one commit');
  assert.match(on, /^ {2}push:\n {4}tags: \['rc-\*'\]$/m, 'a pushed rc tag starts it');
  assert.match(on, /^ {2}schedule:\n/m, 'a schedule cuts main\'s tip as a candidate (GY-1094)');
  assert.doesNotMatch(on, /branches|pull_request/, 'no branch push or pull request starts it');

  // Every long suite validates the pinned candidate — the cut tip, the dispatched SHA or the tagged commit — never the ref it was started from.
  assert.match(jobs.get('candidate')!.text, /^ {6}PINNED: \$\{\{ inputs\.sha \|\| \(github\.event_name == 'push' && github\.sha\) \|\| '' \}\}$/m);
  assert.match(jobs.get('candidate')!.text, /\^\[0-9a-f\]\{40\}\$/, 'a dispatched sha must be a full commit SHA');
  const longSuites = ['chart', 'container-acceptance', 'container-recovery', 'soak'];
  for (const [id, job] of [...jobs, ...[...soakJobs].map(([id, job]) => [`soak:${id}`, job] as const)]) {
    assert.doesNotMatch(job.text, /\$GITHUB_SHA/, `${id} stamps the candidate SHA, not the triggering ref's`);
    assert.ok(job.timeout, `${id} declares timeout-minutes`);
    if (id === 'soak' || id.startsWith('soak:')) {
      assert.match(job.text, id === 'soak' ? /^ {6}CANDIDATE_SHA: \$\{\{ needs\.candidate\.outputs\.sha \}\}$/m : /^ {6}CANDIDATE_SHA: \$\{\{ inputs\.sha \}\}$/m, `${id} soaks the candidate job's pinned SHA`);
      // The starter checks nothing out; the record job writes the ledger from main's tooling, as promote does, naming the soaked SHA.
      if (id === 'soak' || id === 'soak:record') continue;
    } else if (!longSuites.includes(id) && id !== 'uat') continue;
    else assert.match(job.text, /^ {6}CANDIDATE_SHA: \$\{\{ needs\.candidate\.outputs\.sha \}\}$/m, `${id} validates the candidate job's pinned SHA`);
    const checkouts = [...job.text.matchAll(/uses: actions\/checkout@v4\n\s+with: (.*)$/gm)];
    assert.ok(checkouts.length >= 1 && checkouts.every(match => match[1].includes("ref: '${{ env.CANDIDATE_SHA }}'")), `${id} checks out the candidate SHA`);
  }
  for (const id of longSuites) assert.deepEqual(jobs.get(id)!.needs, ['candidate'], `${id} waits only for the candidate to be pinned`);
  // A cut candidate's UAT record carries the container and chart verdicts, so a failure among them blocks
  // promotion; the soak and timing-budget suites are advisory and neither delay nor decide it.
  const gating = longSuites.filter(id => id !== 'soak');
  assert.deepEqual(jobs.get('uat')!.needs, ['candidate', 'container-acceptance', 'container-recovery', 'chart']);
  for (const id of gating) assert.match(jobs.get('uat')!.text, new RegExp(`--suite '${id}=test "\\$[A-Z_]+" = success'`), `the UAT record carries the ${id} verdict`);
  assert.doesNotMatch(jobs.get('uat')!.text, /--suite '(long-suites|soak)=/, 'the soak verdict is advisory');

  // Every suite the pre-merge gate excludes runs here.
  assert.deepEqual([...jobs.keys()].sort(), ['candidate', 'chart', 'container-acceptance', 'container-recovery', 'imports', 'promote', 'soak', 'uat', 'upgrade']);
  // GY-1860: the production job holds no plane credential; the uat-environment job before it reads the candidate's import hold and hands it on.
  assert.match(jobs.get('imports')!.text, /environment: uat[\s\S]*release imports "\$\{\{ needs\.candidate\.outputs\.id \}\}"[\s\S]*GRAPHYARD_TOKEN: \$\{\{ secrets\.GRAPHYARD_RELEASE_TOKEN \}\}/);
  assert.deepEqual(jobs.get('promote')!.needs, ['candidate', 'uat', 'imports', 'upgrade']);
  assert.match(jobs.get('promote')!.text, /GRAPHYARD_PROMOTION_IMPORTS: \$\{\{ needs\.imports\.outputs\.hold \}\}/);
  assert.deepEqual([...soakJobs.keys()], ['long-suites', 'record']);
  assert.deepEqual(soakJobs.get('record')!.needs, ['long-suites'], 'the verdict is recorded after the suites, whatever their outcome');
  assert.match(soakJobs.get('record')!.text, /release soak "\$\{\{ inputs\.candidate \}\}" --sha "\$CANDIDATE_SHA" --result "\$SOAK_RESULT"/);
  // The timing budgets run first, one file at a time, and the soak after them (GY-1440): a budget
  // measured beside another suite's load measures that load. Both run whatever the other's verdict.
  const suitesStep = soakJobs.get('long-suites')!.text;
  assert.match(suitesStep, /node scripts\/ci-tests\.mjs release-candidate --suite timing-budget --out "\$RUNNER_TEMP\/timing-budget-tests\.txt"/);
  assert.match(suitesStep, /node scripts\/ci-tests\.mjs release-candidate --suite soak --out "\$RUNNER_TEMP\/soak-tests\.txt"/);
  const timingRun = suitesStep.indexOf('npm test -- --files-from "$RUNNER_TEMP/timing-budget-tests.txt" --test-concurrency=1 '), soakRun = suitesStep.indexOf('npm test -- --files-from "$RUNNER_TEMP/soak-tests.txt" ');
  assert.ok(timingRun >= 0 && soakRun > timingRun, 'the timing budgets run one file at a time, before the soak');
  assert.equal([...suitesStep.matchAll(/npm test -- /g)].length, 2, 'no other run shares the runner with them');
  assert.equal([...suitesStep.matchAll(/ \|\| status=1$/gm)].length, 2, 'the soak runs whatever the timing budgets\' verdict, and the step fails on either');
  assert.match(suitesStep, /timing-report\.ts "\$RUNNER_TEMP\/timing\/release-candidate\.jsonl" "\$RUNNER_TEMP\/timing\/test-timing-budget\.log" "\$RUNNER_TEMP\/timing\/test-soak\.log"/, 'the report counts both runs\' failures');
  assert.match(suitesStep, /apt-get install -y -q bubblewrap/, 'the soak confines its launches in real namespaces');
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
  for (const id of [...jobs.keys(), ...soakJobs.keys()]) assert.ok(!required.includes(id), `${id} is not a required check`);
});

test('unit:ci-bubblewrap-install-resilient — GY-2009 removed Actions shards; main-guard still classifies a timed-out required check as cancelled to rerun', () => {
  assert.ok(!existsSync(join(repositoryRoot, ciPath)), 'ci.yml is gone');
  const ci = [15368], required = ['test', 'typecheck'];
  const checks = [
    { name: 'typecheck', result: 'success', appId: 15368, id: 1 },
    { name: 'test shard 1', result: 'success', appId: 15368, id: 2 },
    { name: 'test shard 2', result: 'timed_out', appId: 15368, id: 3 },
    { name: 'test-browser', result: 'success', appId: 15368, id: 4 },
    { name: 'test', result: 'failure', appId: 15368, id: 5 },
  ];
  assert.deepEqual(commitVerdict(checks, required, ci), { verdict: 'cancelled', failing: ['test'], checkRun: 3 });
  assert.deepEqual(commitVerdict(checks.map(check => check.id === 3 ? { ...check, result: 'failure' } : check), required, ci), { verdict: 'fail', failing: ['test'] });
});
