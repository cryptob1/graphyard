import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Criterion, Work } from '../src/model.js';
import {
  defaultSizeBounds,
  estimateChangeSize,
  isOverSizeBounds,
  splitItem,
  validateSplitCriteria,
  validateNarrowerPlannedFiles,
  reconcileParentDelivery,
  decompositionStep,
  decompositionSettled,
  clearDecompositionRuns,
  decompositionTool,
  type DecompositionBounds,
} from '../src/decomposition.js';
import { isDelivered } from '../src/model/closure.js';
import { assertDispatchable } from '../src/master/dispatch.js';
import { buildMasterStatus } from '../src/master/status.js';
import type { Run, RunEvent, RunOptions, RunResult, Runner } from '../src/runner/types.js';

const NOW = '2026-10-03T01:00:00.000Z';

function makeWork(key: string, overrides: Partial<Work> = {}): Work {
  return {
    id: `id-${key}`,
    key,
    title: `Work ${key}`,
    description: `Description for ${key}`,
    type: 'feature',
    priority: 2,
    dependencies: [],
    criteria: [
      { id: 'AC-1', text: 'Criterion 1', proofs: ['unit:c1'] },
      { id: 'AC-2', text: 'Criterion 2', proofs: ['unit:c2'] },
      { id: 'AC-3', text: 'Criterion 3', proofs: ['unit:c3'] },
      { id: 'AC-4', text: 'Criterion 4', proofs: ['unit:c4'] },
    ],
    policy: { checks: ['test'], review: true },
    plannedFiles: ['src/', 'tests/'],
    stage: 'ready',
    ready: true,
    revision: 1,
    policyRevision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    stageEnteredAt: NOW,
    epoch: 0,
    lease: null,
    workspaces: [],
    candidate: null,
    submission: null,
    reworkRequested: false,
    scenarioRequirements: [],
    evidence: [],
    observation: null,
    blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }],
    violations: [],
    ...overrides,
  } as Work;
}

function fakeRunner(
  scenario: (prompt: string, options: RunOptions<unknown>) => RunResult<unknown> | Promise<RunResult<unknown>>,
) {
  const starts: { prompt: string; options: RunOptions<unknown> }[] = [];
  const runner: Runner = {
    name: 'pi',
    start<T>(prompt: string, options: RunOptions<T>): Run<T> {
      starts.push({ prompt, options: options as RunOptions<unknown> });
      const listeners = new Set<(event: RunEvent) => void>(), seen: RunEvent[] = [];
      let resolve!: (result: RunResult<T>) => void, done = false;
      const result = new Promise<RunResult<T>>(settle => { resolve = settle; });
      const finish = (outcome: RunResult<T>) => { if (!done) { done = true; resolve(outcome); } };
      const run: Run<T> = {
        id: `run-${starts.length}`,
        events: seen,
        onEvent(listener) { for (const event of seen) listener(event); listeners.add(listener); return () => { listeners.delete(listener); }; },
        cancel(reason = 'cancelled') { finish({ ok: false, failure: { reason: 'cancelled', detail: reason }, payloads: [] }); },
        result: () => result,
      };
      queueMicrotask(async () => {
        const outcome = await scenario(prompt, options as RunOptions<unknown>);
        if (outcome.ok) {
          try {
            finish({ ...outcome, payload: options.validate(outcome.payload), payloads: outcome.payloads.map(options.validate) } as RunResult<T>);
          } catch (error) {
            finish({ ok: false, failure: { reason: 'invalid-payload', detail: String(error) }, payloads: [] });
          }
        } else {
          finish(outcome as RunResult<T>);
        }
      });
      return run;
    },
  };
  return { runner, starts };
}

test('unit:broad-items-split-before-dispatch decomposition of broad item into child items with exact criteria and narrower plannedFiles', () => {
  const parent = makeWork('GY-200');
  assert.equal(isOverSizeBounds(parent), true, 'Parent with 4 criteria and broad plannedFiles is over bounds');

  // Validate criteria checking: missing a criterion
  assert.throws(
    () => validateSplitCriteria(parent, [
      { criteria: [{ id: 'AC-1', text: 'Criterion 1', proofs: ['unit:c1'] }] },
      { criteria: [{ id: 'AC-2', text: 'Criterion 2', proofs: ['unit:c2'] }] },
      // AC-3 and AC-4 missing
    ]),
    /Parent criterion AC-3 was dropped in split/,
  );

  // Validate criteria checking: weakened criterion text
  assert.throws(
    () => validateSplitCriteria(parent, [
      { criteria: [{ id: 'AC-1', text: 'Weakened Criterion 1', proofs: ['unit:c1'] }, { id: 'AC-2', text: 'Criterion 2', proofs: ['unit:c2'] }] },
      { criteria: [{ id: 'AC-3', text: 'Criterion 3', proofs: ['unit:c3'] }, { id: 'AC-4', text: 'Criterion 4', proofs: ['unit:c4'] }] },
    ]),
    /Criterion AC-1 text was modified or weakened/,
  );

  // Validate criteria checking: weakened proofs
  assert.throws(
    () => validateSplitCriteria(parent, [
      { criteria: [{ id: 'AC-1', text: 'Criterion 1', proofs: [] }, { id: 'AC-2', text: 'Criterion 2', proofs: ['unit:c2'] }] },
      { criteria: [{ id: 'AC-3', text: 'Criterion 3', proofs: ['unit:c3'] }, { id: 'AC-4', text: 'Criterion 4', proofs: ['unit:c4'] }] },
    ]),
    /Criterion AC-1 proofs were modified or weakened/,
  );

  // Validate plannedFiles checking: out of parent scope
  assert.throws(
    () => validateNarrowerPlannedFiles(parent, [
      { plannedFiles: ['other/file.ts'] },
      { plannedFiles: ['src/model.ts'] },
    ]),
    /outside parent's plannedFiles scope/,
  );

  // Successful split
  const payload = {
    reason: 'Split broad feature across model and master layers',
    children: [
      {
        title: 'Work GY-200 part 1: model',
        description: 'Implement model criteria',
        criteria: [
          { id: 'AC-1', text: 'Criterion 1', proofs: ['unit:c1'] },
          { id: 'AC-2', text: 'Criterion 2', proofs: ['unit:c2'] },
        ],
        plannedFiles: ['src/model.ts'],
        dependencies: [],
      },
      {
        title: 'Work GY-200 part 2: master',
        description: 'Implement master criteria',
        criteria: [
          { id: 'AC-3', text: 'Criterion 3', proofs: ['unit:c3'] },
          { id: 'AC-4', text: 'Criterion 4', proofs: ['unit:c4'] },
        ],
        plannedFiles: ['src/master.ts', 'tests/master.test.ts'],
        dependencies: ['0'], // depends on first child
      },
    ],
  };

  const { parent: splitParent, children } = splitItem(parent, payload);
  assert.equal(children.length, 2);
  assert.deepEqual(splitParent.children, ['GY-200.1', 'GY-200.2']);
  assert.equal(children[0].key, 'GY-200.1');
  assert.equal(children[0].parent, 'GY-200');
  assert.deepEqual(children[0].plannedFiles, ['src/model.ts']);
  assert.deepEqual(children[0].dependencies, []);

  assert.equal(children[1].key, 'GY-200.2');
  assert.equal(children[1].parent, 'GY-200');
  assert.deepEqual(children[1].plannedFiles, ['src/master.ts', 'tests/master.test.ts']);
  assert.deepEqual(children[1].dependencies, [children[0].id]);
});

test('unit:broad-items-split-before-dispatch bounds checking, opt-out split: false, and unchanged dispatch', () => {
  // Within bounds item
  const smallItem = makeWork('GY-201', {
    criteria: [
      { id: 'AC-1', text: 'Criterion 1', proofs: ['unit:c1'] },
      { id: 'AC-2', text: 'Criterion 2', proofs: ['unit:c2'] },
    ],
    plannedFiles: ['src/foo.ts', 'tests/foo.test.ts'],
  });
  assert.equal(isOverSizeBounds(smallItem), false, 'Small item within bounds is not over size bounds');

  // Over bounds but explicitly opted out via split: false
  const optedOutItem = makeWork('GY-202', {
    split: false,
    criteria: [
      { id: 'AC-1', text: 'C1', proofs: ['unit:1'] },
      { id: 'AC-2', text: 'C2', proofs: ['unit:2'] },
      { id: 'AC-3', text: 'C3', proofs: ['unit:3'] },
      { id: 'AC-4', text: 'C4', proofs: ['unit:4'] },
      { id: 'AC-5', text: 'C5', proofs: ['unit:5'] },
    ],
    plannedFiles: ['src/', 'web/', 'tests/', 'docs/'],
  });
  assert.equal(isOverSizeBounds(optedOutItem), false, 'Item with split: false is never over size bounds');

  // Over bounds item
  const broadItem = makeWork('GY-203', {
    criteria: [
      { id: 'AC-1', text: 'C1', proofs: ['unit:1'] },
      { id: 'AC-2', text: 'C2', proofs: ['unit:2'] },
      { id: 'AC-3', text: 'C3', proofs: ['unit:3'] },
      { id: 'AC-4', text: 'C4', proofs: ['unit:4'] },
    ],
    plannedFiles: ['src/'],
  });
  assert.equal(isOverSizeBounds(broadItem), true);

  // Dispatch behavior: small item and opted-out item are dispatchable directly
  assert.doesNotThrow(() => assertDispatchable(smallItem, [smallItem], NOW));
  assert.doesNotThrow(() => assertDispatchable(optedOutItem, [optedOutItem], NOW));

  // Once split, parent has children and is blocked from dispatch until children deliver
  broadItem.children = ['GY-203.1', 'GY-203.2'];
  assert.throws(
    () => assertDispatchable(broadItem, [broadItem], NOW),
    /GY-203 was split into child items \(GY-203.1, GY-203.2\) and waits for them to be delivered/,
  );
});

test('unit:broad-items-split-before-dispatch parent delivered when all children delivered and master status shows parent-child relation', () => {
  const parent = makeWork('GY-204', {
    criteria: [
      { id: 'AC-1', text: 'C1', proofs: ['unit:1'] },
      { id: 'AC-2', text: 'C2', proofs: ['unit:2'] },
    ],
    children: ['GY-204.1', 'GY-204.2'],
  });

  const child1 = makeWork('GY-204.1', {
    parent: 'GY-204',
    criteria: [{ id: 'AC-1', text: 'C1', proofs: ['unit:1'] }],
    plannedFiles: ['src/part1.ts'],
  });

  const child2 = makeWork('GY-204.2', {
    parent: 'GY-204',
    criteria: [{ id: 'AC-2', text: 'C2', proofs: ['unit:2'] }],
    plannedFiles: ['src/part2.ts'],
  });

  const all = [parent, child1, child2];

  // Neither child is delivered
  assert.equal(reconcileParentDelivery(parent, all), false);
  assert.notEqual(parent.stage, 'done');
  assert.equal(isDelivered(parent), false);

  // Status check before delivery
  let status = buildMasterStatus({ work: all, now: NOW }, [], []);
  const parentRow = status.work.find(w => w.key === 'GY-204')!;
  const child1Row = status.work.find(w => w.key === 'GY-204.1')!;
  assert.equal(parentRow.parent, null);
  assert.deepEqual(parentRow.children, ['GY-204.1', 'GY-204.2']);
  assert.equal(child1Row.parent, 'GY-204');
  assert.equal(child1Row.children, null);

  const pcEntry = status.parentChild.find(e => e.key === 'GY-204')!;
  assert.deepEqual(pcEntry.children, ['GY-204.1', 'GY-204.2']);

  // Deliver child 1 only
  child1.stage = 'done';
  child1.delivery = {
    mergedAt: '2026-10-03T01:05:00.000Z',
    mergeSha: 'sha-child-1',
    authorizationRevision: 1,
  };
  assert.equal(reconcileParentDelivery(parent, all), false);
  assert.notEqual(parent.stage, 'done');
  assert.equal(isDelivered(parent), false);

  // Deliver child 2
  child2.stage = 'done';
  child2.delivery = {
    mergedAt: '2026-10-03T01:10:00.000Z',
    mergeSha: 'sha-child-2',
    authorizationRevision: 1,
  };
  assert.equal(reconcileParentDelivery(parent, all), true);
  assert.equal(parent.stage, 'done');
  assert.equal(isDelivered(parent), true);
  assert.equal(parent.delivery?.mergeSha, 'sha-child-2');

  // Status check after delivery:
  // Delivered items leave status.work (which tracks open items) but remain in status.parentChild
  status = buildMasterStatus({ work: all, now: NOW }, [], []);
  assert.equal(status.work.find(w => w.key === 'GY-204'), undefined, 'Delivered parent is no longer in open work');
  const pcAfter = status.parentChild.find(e => e.key === 'GY-204')!;
  assert.deepEqual(pcAfter.children, ['GY-204.1', 'GY-204.2']);
  const pcChild1 = status.parentChild.find(e => e.key === 'GY-204.1')!;
  assert.equal(pcChild1.parent, 'GY-204');

  // When policy includes deploySmoke, delivered items appear in status.delivered with parent/children
  parent.policy = { ...parent.policy, deploySmoke: true };
  status = buildMasterStatus({ work: all, now: NOW }, [], []);
  const deliveredParent = status.delivered.find(d => d.key === 'GY-204')!;
  assert.deepEqual(deliveredParent.children, ['GY-204.1', 'GY-204.2']);
  assert.equal(deliveredParent.parent, null);
});

test('unit:broad-items-split-before-dispatch decompositionStep runs agent session before first dispatch', async () => {
  clearDecompositionRuns();
  const parent = makeWork('GY-205', {
    criteria: [
      { id: 'AC-1', text: 'Criterion 1', proofs: ['unit:c1'] },
      { id: 'AC-2', text: 'Criterion 2', proofs: ['unit:c2'] },
      { id: 'AC-3', text: 'Criterion 3', proofs: ['unit:c3'] },
      { id: 'AC-4', text: 'Criterion 4', proofs: ['unit:c4'] },
    ],
    plannedFiles: ['src/', 'tests/'],
  });

  const { runner, starts } = fakeRunner((_prompt, _options) => ({
    ok: true,
    tool: decompositionTool,
    payload: {
      reason: 'Splitting GY-205',
      children: [
        {
          title: 'GY-205 child 1',
          criteria: [
            { id: 'AC-1', text: 'Criterion 1', proofs: ['unit:c1'] },
            { id: 'AC-2', text: 'Criterion 2', proofs: ['unit:c2'] },
          ],
          plannedFiles: ['src/feature.ts'],
        },
        {
          title: 'GY-205 child 2',
          criteria: [
            { id: 'AC-3', text: 'Criterion 3', proofs: ['unit:c3'] },
            { id: 'AC-4', text: 'Criterion 4', proofs: ['unit:c4'] },
          ],
          plannedFiles: ['tests/feature.test.ts'],
        },
      ],
    },
    payloads: [],
  }));

  const recorded: { parent: Work; children: Work[] }[] = [];
  const actions = decompositionStep({
    work: [parent],
    clock: Date.parse(NOW),
    config: { repository: 'graphyard/repo' },
    cwd: process.cwd(),
    runner,
    record: async (p, c) => {
      recorded.push({ parent: p, children: c });
    },
  });

  assert.equal(actions.length, 1);
  assert.equal(actions[0].work, 'GY-205');
  assert.equal(actions[0].state, 'started');
  assert.equal(starts.length, 1);

  await decompositionSettled();
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0].parent.children, ['GY-205.1', 'GY-205.2']);
  assert.equal(recorded[0].children.length, 2);
  clearDecompositionRuns();
});
