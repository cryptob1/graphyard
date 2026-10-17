import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { applyDecompositionEvent, companionScope, decompositionSettings, decompositionTool, decompositionWanted, estimatedLines, plannedSourceFiles, sizeBoundsExceeded, sourceFileBand, timeToMergeBySize, validateChildSizes,
  type DecompositionEvent, type ItemSizeReport } from '../src/decomposition.js';
import { decompositionSettingsSchema, estimatedLinesBound, estimatedLinesPerSourceFile } from '../src/runner/payloads.js';
import { clearDecompositionRuns, decompositionSettled, decompositionStep } from '../src/decomposition-step.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { masterConfigSchema, masterRunSchema } from '../src/master.js';
import type { Run, RunOptions, RunResult, Runner } from '../src/runner/types.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1858: the decomposition bound is a bound on planned source files — test files, test helpers,
// docs pages and the timing baseline are companions of the source change and never count toward
// it — and it defaults to five, with the estimated-lines bound scaled to it. Whoever created the
// item, a never-dispatched item over the bound is sent to decomposition before dispatch. And so
// the bound can be tuned from data, `master status` reports the deliveries of the last seven days
// by planned-source-file band: the median minutes from first claim to merge, and median attempts.
// NOW is this file's only clock: every instant below is derived from it and handed to the code
// under test as a parameter, so no wall-clock reading runs anywhere in this file.

const NOW = Date.parse('2026-10-16T06:00:00.000Z');
const minute = 60_000, day = 24 * 60 * minute;
const sha = (seed: string) => seed.padEnd(40, '0').slice(0, 40);

function item(key: string, overrides: Partial<Work> = {}): Work {
  return {
    id: randomUUID(), key, title: `Item ${key}`, description: '', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Behaviour one holds.', proofs: ['unit:behaviour-one'] }, { id: 'AC-2', text: 'Behaviour two holds.', proofs: ['unit:behaviour-two'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'ready', ready: true, revision: 2, policyRevision: 1,
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), stageEnteredAt: new Date(NOW).toISOString(),
    epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [],
    evidence: [], observation: null, blocker: null, gates: [], violations: [], ...overrides,
  } as Work;
}

/** A delivered item: merged `mergedAt` on the provider clock, `mergedAtRepository` on the repository's, first claimed `claimedMinutes` before the repository merge. */
function mergedItem(key: string, shape: { sources: number; mergedAt: number; repositoryAt?: number; claimedMinutes: number; attempts?: number; unmeasured?: boolean }): Work {
  const merge = new Date(shape.mergedAt).toISOString(), repository = new Date(shape.repositoryAt ?? shape.mergedAt).toISOString();
  const claims = Array.from({ length: shape.unmeasured ? 0 : shape.attempts ?? 1 }, (_, index) =>
    ({ epoch: index + 1, owner: `worker-${index}`, claimedAt: new Date((shape.repositoryAt ?? shape.mergedAt) - (shape.claimedMinutes - index) * minute).toISOString(),
      endedAt: repository, end: 'submitted' as const }));
  return item(key, {
    stage: 'done',
    plannedFiles: Array.from({ length: shape.sources }, (_, index) => `src/file-${index + 1}.ts`),
    delivery: { mergeSha: sha(key), authorizationRevision: 1, mergedAt: merge, ...(shape.repositoryAt ? { mergedAtRepository: new Date(shape.repositoryAt).toISOString() } : {}) },
    ...(shape.unmeasured ? {} : { pipeline: { attempts: claims, submittedAt: merge, resubmittedAt: merge, reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } } }),
  }) as Work;
}

test('unit:item-size-five-source-files — with default settings six planned source files are over the bound and are sent to decomposition whoever created the item, while five source files beside ten test files are within it', async t => {
  t.after(clearDecompositionRuns);
  // The defaults: five planned source files, and the estimated-lines bound scaled to them.
  assert.equal(decompositionSettingsSchema.parse({}).maxPlannedFiles, 5);
  assert.equal(estimatedLinesPerSourceFile, 120);
  assert.equal(estimatedLinesBound(decompositionSettings({})), 600);
  assert.equal(estimatedLinesBound(decompositionSettings({ maxPlannedFiles: 10 })), 1_200, 'the estimated-lines bound scales with the source-file bound');
  assert.equal(estimatedLinesBound(decompositionSettings({ maxEstimatedLines: 900 })), 900, 'an installation may set the estimated-lines bound itself');
  assert.equal(decompositionSettings(masterRunSchema.parse({ decomposition: { maxPlannedFiles: 8 } })).maxPlannedFiles, 8, 'an installation may raise the bound in run.decomposition');

  // Companions never count toward the bound: test files, test helpers, docs pages, the timing baseline.
  assert.deepEqual(plannedSourceFiles({ plannedFiles: ['src/decomposition.ts', 'tests/item-size-bound.test.ts', 'tests/helpers/timing-baseline.json', 'docs/master-agent-reference.md', 'web/app.ts'] }),
    ['src/decomposition.ts', 'web/app.ts']);
  for (const scope of ['tests/', 'tests/helpers/', 'docs/', 'docs/page.md', 'README.md', 'AGENTS.md', 'src/one.test.ts', 'src/runner/two.spec.tsx', 'browser-tests/login.spec.ts', 'browser-tests/', 'test/foo.ts', 'src/__tests__/a.ts'])
    assert.equal(companionScope(scope), true, `${scope} is a companion`);
  for (const scope of ['src/', 'src/one.ts', 'web/', 'web/app.ts']) assert.equal(companionScope(scope), false, `${scope} is a source change`);
  // The item's configured documentation is a companion too; the default rule does not apply to an item configuring its own.
  const configured = { id: 'DOCS', text: 'Documentation reflects this change', paths: ['guide/**', 'packages/*/README.md'], changelog: 'CHANGELOG.md' } as unknown as Work['documentation'];
  assert.deepEqual(plannedSourceFiles({ plannedFiles: ['guide/setup.md', 'packages/core/README.md', 'CHANGELOG.md', 'src/a.ts'], documentation: configured }), ['src/a.ts']);
  // Each source file counts once, however it is spelled: duplicates and `./` prefixes are one file.
  assert.deepEqual(plannedSourceFiles({ plannedFiles: ['src/a.ts', './src/a.ts', 'src/a.ts', 'src/runner/**', 'src/runner/'] }), ['src/a.ts', 'src/runner/']);

  // Six source files, however many test and docs files beside them, are over the bound; five source files and ten test files are within it.
  const over = item('GY-2', { plannedFiles: ['src/one.ts', 'src/two.ts', 'src/three.ts', 'src/four.ts', 'src/five.ts', 'src/six.ts', 'tests/seven.test.ts', 'docs/page.md'] });
  const within = item('GY-3', { plannedFiles: ['src/one.ts', 'src/two.ts', 'src/three.ts', 'src/four.ts', 'src/five.ts', ...Array.from({ length: 10 }, (_, index) => `tests/file-${index}.test.ts`)] });
  assert.deepEqual(sizeBoundsExceeded(within, decompositionSettings({})), [], 'five source files and ten test files are within every bound');
  assert.ok(sizeBoundsExceeded(over, decompositionSettings({})).some(reason => /6 planned source files, over 5/.test(reason)), 'six source files are over the bound; their companions are not counted');
  assert.ok(decompositionWanted(over, decompositionSettings({})), 'an item over the bound is sent to decomposition');
  assert.equal(decompositionWanted(within, decompositionSettings({})), null, 'an item within the bounds is dispatched unchanged');
  // Colocated tests, tests outside tests/ and README.md are companions as well; a repeated source path counts once.
  const colocated = item('GY-9', { plannedFiles: ['src/one.ts', 'src/two.ts', 'src/three.ts', 'src/four.ts', 'src/five.ts', ...Array.from({ length: 10 }, (_, index) => `src/file-${index}.test.ts`),
    'browser-tests/login.spec.ts', 'test/foo.ts', 'README.md', 'src/five.ts', './src/one.ts'] });
  assert.deepEqual(sizeBoundsExceeded(colocated, decompositionSettings({})), [], 'five distinct source files beside colocated tests, other test roots, README.md and repeated entries are within every bound');
  assert.equal(decompositionWanted(colocated, decompositionSettings({})), null);
  assert.equal(estimatedLines(within), 600, 'companions add nothing to the estimate: five source files and two criteria sit exactly at the scaled bound');

  // The bounds judge the source change, however many criteria carry it: a one-criterion item over
  // the file bound is sent too, though its session can only keep it whole.
  const oneCriterion = item('GY-8', { criteria: [{ id: 'AC-1', text: 'Behaviour one holds.', proofs: ['unit:behaviour-one'] }],
    plannedFiles: ['src/one.ts', 'src/two.ts', 'src/three.ts', 'src/four.ts', 'src/five.ts', 'src/six.ts'] });
  assert.ok(decompositionWanted(oneCriterion, decompositionSettings({})), 'a one-criterion item planning six source files is over the bound and is sent to decomposition');

  // Whoever created it: a planner-driven and a master-created item over the bound are judged the same.
  const plannerCreated = item('GY-4', { plannedFiles: [...over.plannedFiles!] });
  const masterCreated = item('GY-5', { plannedFiles: [...over.plannedFiles!], systemDriven: false, research: false });
  assert.deepEqual(sizeBoundsExceeded(masterCreated, decompositionSettings({})), sizeBoundsExceeded(plannerCreated, decompositionSettings({})), 'the bounds do not read who created the item');

  // The loop's step starts a split session for each over-bound item and holds its dispatch; the item within the bounds is offered as it is.
  const items = [plannerCreated, masterCreated, within];
  const starts: string[] = [];
  const runner: Runner = {
    name: 'pi',
    start<T>(prompt: string, options: RunOptions<T>): Run<T> {
      starts.push(prompt);
      const kept = { ok: true, tool: decompositionTool, payload: { reason: 'The criteria share one module; split, they would conflict.', children: [] }, payloads: [] } as unknown as RunResult<T>;
      let resolve!: (result: RunResult<T>) => void;
      const result = new Promise<RunResult<T>>(settle => { resolve = settle; });
      queueMicrotask(() => resolve({ ...kept, payload: options.validate((kept as { payload: unknown }).payload) } as RunResult<T>));
      return { id: `run-${starts.length}`, events: [], onEvent: () => () => {}, cancel: () => {}, result: () => result };
    },
  };
  const record = async (work: Work, event: DecompositionEvent) => { applyDecompositionEvent(work, event, 'graphyard-master', new Date(NOW)); return work; };
  const step = await decompositionStep({ items: [...items], clock: NOW, settings: decompositionSettings({}), config: { repository: 'owner/project' }, cwd: process.cwd(), runner, model: 'm', record });
  await decompositionSettled();
  assert.equal(starts.length, 2, 'the item within the bounds gets no session; both over-bound items do, whoever created them');
  assert.match(starts[0]!, /GY-4/); assert.match(starts[1]!, /GY-5/);
  assert.match(starts[0]!, /6 planned source files, over 5/, 'the session is told the source-file bound it is over');
  assert.deepEqual([...step.held].sort(), [plannerCreated.id, masterCreated.id].sort(), 'dispatch waits on the items being split');
  assert.deepEqual(items.map(entry => entry.decomposition?.state), ['kept', 'kept', undefined], 'each run is recorded on its item; the within item is untouched');
});

test('unit:time-to-merge-by-size-reported — master status reports, for deliveries merged in the last seven days, the median first-claim-to-merge minutes and median attempts per planned-source-file band', async () => {
  assert.deepEqual([1, 2, 3, 5, 6, 10, 11, 0].map(sourceFileBand), ['1-2', '1-2', '3-5', '3-5', '6-10', '6-10', 'over 10', null], 'the bands are 1-2, 3-5, 6-10 and over 10');

  const work = [
    // First claim 100 repository-clock minutes before the repository merge; the provider's own timestamp sits 30 minutes later.
    mergedItem('GY-11', { sources: 1, mergedAt: NOW - day + 30 * minute, repositoryAt: NOW - day, claimedMinutes: 100, attempts: 2 }),
    mergedItem('GY-12', { sources: 2, mergedAt: NOW - 2 * day, claimedMinutes: 20 }),
    // Counted in its band but not measured: no attempt is on the timeline yet.
    mergedItem('GY-13', { sources: 1, mergedAt: NOW - day, claimedMinutes: 5, unmeasured: true }),
    mergedItem('GY-14', { sources: 3, mergedAt: NOW - 3 * day, claimedMinutes: 40 }),
    mergedItem('GY-15', { sources: 5, mergedAt: NOW - 4 * day, claimedMinutes: 20 }),
    mergedItem('GY-16', { sources: 6, mergedAt: NOW - 5 * day, claimedMinutes: 200, attempts: 3 }),
    // Outside the seven-day window, and of no planned source files: neither is reported.
    mergedItem('GY-17', { sources: 11, mergedAt: NOW - 8 * day, claimedMinutes: 500, attempts: 9 }),
    mergedItem('GY-18', { sources: 0, mergedAt: NOW - day, claimedMinutes: 10 }),
  ];
  const report = timeToMergeBySize(work, NOW);
  assert.equal(report.windowDays, 7);
  assert.deepEqual(report.bands.map(band => band.band), ['1-2', '3-5', '6-10', 'over 10']);
  const band = (name: string) => report.bands.find(entry => entry.band === name)!;
  assert.deepEqual(band('1-2'), { band: '1-2', items: 3, measured: 2, medianMinutesToMerge: 60, medianAttempts: 1.5 }, 'the median of one and two attempts is 1.5, never rounded; the merge is read on the repository clock; the unmeasured delivery is counted, not measured');
  assert.deepEqual(band('3-5'), { band: '3-5', items: 2, measured: 2, medianMinutesToMerge: 30, medianAttempts: 1 });
  assert.deepEqual(band('6-10'), { band: '6-10', items: 1, measured: 1, medianMinutesToMerge: 200, medianAttempts: 3 });
  assert.deepEqual(band('over 10'), { band: 'over 10', items: 0, measured: 0, medianMinutesToMerge: null, medianAttempts: null }, 'a delivery eight days old is outside the window');
  assert.deepEqual(report.directoryScoped, { items: 0, measured: 0, medianMinutesToMerge: null, medianAttempts: null });

  // Elapsed minutes are not rounded before their median: 90 s and 150 s give a 2-minute median, not 2.5 rounded from 2 and 3.
  const seconds = [mergedItem('GY-22', { sources: 3, mergedAt: NOW - day, claimedMinutes: 1.5 }), mergedItem('GY-23', { sources: 4, mergedAt: NOW - day, claimedMinutes: 2.5 }), mergedItem('GY-24', { sources: 4, mergedAt: NOW - day, claimedMinutes: 3.5, attempts: 2 })];
  assert.deepEqual(timeToMergeBySize(seconds, NOW).bands.find(entry => entry.band === '3-5'), { band: '3-5', items: 3, measured: 3, medianMinutesToMerge: 2.5, medianAttempts: 1 });
  assert.equal(timeToMergeBySize(seconds.slice(0, 2), NOW).bands.find(entry => entry.band === '3-5')?.medianMinutesToMerge, 2, 'the median of 1.5 and 2.5 minutes is 2, not the median of their rounded values (2 and 3)');
  // A repeated planned path counts once in the bands too: a one-file item listed six times stays in 1-2.
  const repeated = { ...mergedItem('GY-25', { sources: 1, mergedAt: NOW - day, claimedMinutes: 10 }), plannedFiles: Array.from({ length: 6 }, () => 'src/file-1.ts') } as Work;
  assert.equal(timeToMergeBySize([repeated], NOW).bands.find(entry => entry.band === '1-2')?.items, 1, 'a repeated path does not move an item to the 6-10 band');

  // A delivery planning a source directory scope has no known file count: it is reported apart,
  // never in the band its count of paths would give (one path, `src/`, is not a 1-2 file item).
  const scoped = [
    { ...mergedItem('GY-19', { sources: 0, mergedAt: NOW - day, claimedMinutes: 300, attempts: 4 }), plannedFiles: ['src/', 'tests/'] },
    { ...mergedItem('GY-20', { sources: 1, mergedAt: NOW - day, claimedMinutes: 100, attempts: 2 }), plannedFiles: ['src/runner/', 'src/model.ts'] },
    { ...mergedItem('GY-21', { sources: 0, mergedAt: NOW - day, claimedMinutes: 10 }), plannedFiles: ['src/a.ts', 'tests/helpers/'] },
  ] as Work[];
  const withScopes = timeToMergeBySize([...work, ...scoped], NOW);
  assert.deepEqual(withScopes.directoryScoped, { items: 2, measured: 2, medianMinutesToMerge: 200, medianAttempts: 3 }, 'directory-scoped deliveries are reported in their own group');
  assert.deepEqual(withScopes.bands.find(entry => entry.band === '1-2'), { band: '1-2', items: 4, measured: 3, medianMinutesToMerge: 20, medianAttempts: 1 },
    'the 1-2 band gains only the file-scoped delivery; a tests/ directory is a companion and does not make an item directory-scoped');

  // The bands' contents once more, as the master status report computes them: the report builder is
  // called on the same snapshot, and its `itemSize` is the report above.
  const directory = await temporaryDirectory('item-size-status');
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const root = await temporaryDirectory('item-size-root');
  execFileSync('git', ['init', '-q', root]);
  const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)), repository: 'owner/project',
    baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
  const masterApi = async (path: string) => path === 'work-snapshot' ? { work, now: new Date(NOW).toISOString() } : { decisions: [] };
  const status = await masterStatusReport(root, master, masterApi, { actor: { id: 'coordinator-1' } }, { commit: null }) as { itemSize: ItemSizeReport };
  assert.deepEqual(status.itemSize, timeToMergeBySize(work, NOW), 'the report computes itemSize from the work snapshot on the repository clock');
  assert.equal(status.itemSize.bands.find(entry => entry.band === '1-2')?.measured, 2, 'the bands are not vacuously empty');
});

/** A runner whose session proposes `children`: the payload is validated as the loop would. */
function proposingRunner(children: unknown[], starts: string[]): Runner {
  return {
    name: 'pi',
    start<T>(prompt: string, options: RunOptions<T>): Run<T> {
      starts.push(prompt);
      const payload = { reason: 'Splitting by area.', children };
      let resolve!: (result: RunResult<T>) => void;
      const result = new Promise<RunResult<T>>(settle => { resolve = settle; });
      queueMicrotask(() => {
        try { resolve({ ok: true, tool: decompositionTool, payload: options.validate(payload), payloads: [] } as unknown as RunResult<T>); }
        catch (error) { resolve({ ok: false, failure: { reason: 'invalid-payload', detail: String(error) }, payloads: [] } as unknown as RunResult<T>); }
      });
      return { id: `run-${starts.length}`, events: [], onEvent: () => () => {}, cancel: () => {}, result: () => result };
    },
  };
}

const recordOn = (work: Work) => async (item: Work, event: DecompositionEvent) => { applyDecompositionEvent(item, event, 'graphyard-master', new Date(NOW)); return work; };

test('unit:child-source-file-bound — a split child planning more than the run’s bound of source files is refused, the bound stated in the prompt and carried on the run’s start', async t => {
  t.after(clearDecompositionRuns);
  const parent = item('GY-6', { plannedFiles: ['src/'] });
  // Companions never count toward a child's bound: five source files beside tests and docs are within it.
  assert.doesNotThrow(() => validateChildSizes([{ title: 'Within', criteria: ['AC-1'], plannedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'tests/within.test.ts', 'docs/page.md'], after: [] }], 5));
  assert.throws(() => validateChildSizes([{ title: 'Over', criteria: ['AC-1'], plannedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts'], after: [] }], 5),
    /Child 1 plans 6 source files, over 5/, 'a child over the bound is refused by name');
  // A source directory scope could cover any number of files: it is refused, not counted as one.
  for (const scope of ['src/runner/', 'src/runner/**'])
    assert.throws(() => validateChildSizes([{ title: 'Directory', criteria: ['AC-1'], plannedFiles: [scope, 'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'], after: [] }], 5),
      /Child 1 plans the source directory scope src\/runner\/\*{0,2}, which covers an unknown number of files/, `a child planning ${scope} is refused though it names five paths`);
  assert.doesNotThrow(() => validateChildSizes([{ title: 'Repeated', criteria: ['AC-1'], plannedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/e.ts', './src/a.ts', 'src/a.test.ts', 'README.md'], after: [] }], 5),
    'a child counts distinct source files: repeated entries, colocated tests and README.md add nothing');
  assert.doesNotThrow(() => validateChildSizes([{ title: 'Companion directory', criteria: ['AC-1'], plannedFiles: ['src/a.ts', 'tests/helpers/', 'docs/'], after: [] }], 5), 'companion directories stay allowed');

  const starts: string[] = [];
  const children = [
    { title: 'Too broad', criteria: ['AC-1'], plannedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts'], after: [] },
    { title: 'Rest', criteria: ['AC-2'], plannedFiles: ['src/g.ts'], after: [0] },
  ];
  const step = await decompositionStep({ items: [parent], clock: NOW, settings: decompositionSettings({}), config: { repository: 'owner/project' }, cwd: process.cwd(),
    runner: proposingRunner(children, starts), model: 'm', record: recordOn(parent) });
  await decompositionSettled();
  assert.match(starts[0]!, /at most 5 planned source files/, 'the prompt states the per-child source-file bound');
  assert.match(starts[0]!, /the control plane refuses a child planning more/, 'the prompt says the refusal is the control plane’s');
  assert.match(starts[0]!, /never a source directory/, 'the prompt asks for source files, not directories');
  assert.equal(parent.decomposition?.state, 'failed', 'the proposed split is recorded as failed');
  assert.equal(parent.decomposition?.failure?.reason, 'refused', 'the control plane, not the session, refused it');
  assert.match(parent.decomposition?.failure?.detail ?? '', /Child 1 plans 6 source files, over 5/, 'the refusal names the child and the bound');
  assert.deepEqual([...step.held], [parent.id], 'dispatch waited while the run was in progress; the next cycle dispatches the item whole');
});
