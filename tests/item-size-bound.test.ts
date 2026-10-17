import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { applyDecompositionEvent, companionScope, decompositionSettings, decompositionTool, decompositionWanted, estimatedLines, plannedSourceFiles, sizeBoundsExceeded, sourceFileBand,
  timeToMergeBySize, type DecompositionEvent } from '../src/decomposition.js';
import { decompositionSettingsSchema, estimatedLinesBound, estimatedLinesPerSourceFile } from '../src/runner/payloads.js';
import { clearDecompositionRuns, decompositionSettled, decompositionStep } from '../src/decomposition-step.js';
import type { Run, RunOptions, RunResult, Runner } from '../src/runner/types.js';
import { masterRunSchema } from '../src/master.js';

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
  for (const scope of ['tests/', 'tests/helpers/', 'docs/', 'docs/page.md']) assert.equal(companionScope(scope), true, `${scope} is a companion`);
  for (const scope of ['src/', 'src/one.ts', 'web/', 'README.md']) assert.equal(companionScope(scope), false, `${scope} is a source change`);

  // Six source files, however many test and docs files beside them, are over the bound; five source files and ten test files are within it.
  const over = item('GY-2', { plannedFiles: ['src/one.ts', 'src/two.ts', 'src/three.ts', 'src/four.ts', 'src/five.ts', 'src/six.ts', 'tests/seven.test.ts', 'docs/page.md'] });
  const within = item('GY-3', { plannedFiles: ['src/one.ts', 'src/two.ts', 'src/three.ts', 'src/four.ts', 'src/five.ts', ...Array.from({ length: 10 }, (_, index) => `tests/file-${index}.test.ts`)] });
  assert.deepEqual(sizeBoundsExceeded(within, decompositionSettings({})), [], 'five source files and ten test files are within every bound');
  assert.ok(sizeBoundsExceeded(over, decompositionSettings({})).some(reason => /6 planned source files, over 5/.test(reason)), 'six source files are over the bound; their companions are not counted');
  assert.ok(decompositionWanted(over, decompositionSettings({})), 'an item over the bound is sent to decomposition');
  assert.equal(decompositionWanted(within, decompositionSettings({})), null, 'an item within the bounds is dispatched unchanged');
  assert.equal(estimatedLines(within), 600, 'companions add nothing to the estimate: five source files and two criteria sit exactly at the scaled bound');

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

test('unit:time-to-merge-by-size-reported — master status reports, for deliveries merged in the last seven days, the median first-claim-to-merge minutes and median attempts per planned-source-file band', () => {
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
  assert.deepEqual(band('1-2'), { band: '1-2', items: 3, measured: 2, medianMinutesToMerge: 60, medianAttempts: 2 }, 'the merge is read on the repository clock; the unmeasured delivery is counted, not measured');
  assert.deepEqual(band('3-5'), { band: '3-5', items: 2, measured: 2, medianMinutesToMerge: 30, medianAttempts: 1 });
  assert.deepEqual(band('6-10'), { band: '6-10', items: 1, measured: 1, medianMinutesToMerge: 200, medianAttempts: 3 });
  assert.deepEqual(band('over 10'), { band: 'over 10', items: 0, measured: 0, medianMinutesToMerge: null, medianAttempts: null }, 'a delivery eight days old is outside the window');

  // And the report is on `master status`: the CLI's builder computes it from the work snapshot.
  const source = readFileSync(fileURLToPath(new URL('../src/cli/master-status.ts', import.meta.url)), 'utf8');
  assert.match(source, /timeToMergeBySize\(snapshot\.work/, 'the master status report computes itemSize from the work snapshot');
  assert.match(source, /\bitemSize,/, 'the master status report carries itemSize');
});
