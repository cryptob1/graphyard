import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { itemLine } from '../src/cli/master-status.js';
import { plainStage, plainStageLines, plainStages, type ServeView } from '../src/model/plain-stage.js';
import { noRelease, type ReleaseView } from '../src/model/release.js';
import type { Work } from '../src/model/work.js';
import { stages, type Stage } from '../src/model/work.js';

// GY-2988 AC-1: every derived stage maps to exactly one plain label, master status items carry
// it, and this test walks each stage.

const base = {
  id: 'id', key: 'GY-1', title: 'Plain stage', description: '', type: 'chore' as const, priority: 2,
  dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
  policy: { checks: ['test'], review: true }, revision: 1, policyRevision: 1,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', stageEnteredAt: '2026-01-01T00:00:00Z',
  ready: true, epoch: 1, lease: null, workspaces: [], candidate: null, submission: null,
  gates: [], evidence: [], violations: [],
};

const item = (stage: Stage, extra: Partial<Work> = {}): Work => ({ ...base, stage, ...extra } as Work);

const delivery = { mergeSha: 'a'.repeat(40), mergedAt: '2026-01-01T01:00:00Z', pr: 1 };
const served: ReleaseView = {
  environment: 'production', observedAt: Date.parse('2026-01-01T02:00:00Z'),
  unserved: new Set(), failed: new Set(),
};
const withDeployment = (work: Work): Work => ({
  ...work,
  delivery: {
    ...delivery,
    deployment: {
      sha: delivery.mergeSha, mergeSha: delivery.mergeSha, source: 'endpoint', covers: 'exact',
      observedAt: '2026-01-01T02:00:00Z', at: '2026-01-01T02:00:00Z', observer: 'master',
    },
  },
} as Work);

test('unit:plain-stage-labels — every derived stage maps to exactly one plain label, and master status items carry it', async () => {
  // Each stored stage has one plain label.
  const byStage: Record<Stage, string> = {
    backlog: 'Building', ready: 'Building', build: 'Building',
    review: 'In review', test: 'Testing', acceptance: 'Testing', merge: 'Merging',
    done: 'Live', // repository serves nothing
  };
  for (const stage of stages) {
    const work = stage === 'done' ? item('done', { delivery }) : item(stage);
    assert.equal(plainStage(work), byStage[stage], stage);
  }

  // Done + serve verdict (GY-2983): Live and verified / Live and failing / Done / Live.
  const live = withDeployment(item('done', { delivery }));
  const verified: ServeView = { serves: true, check: { verified: true, case: null, step: null, reason: null } };
  const failing: ServeView = { serves: true, check: { verified: false, case: 'home', step: 'GET /', reason: '404' } };
  const serving: ServeView = { serves: true, check: null };
  assert.equal(plainStage(live, served, verified), 'Live and verified');
  assert.equal(plainStage(live, served, failing), 'Live and failing');
  assert.equal(plainStage(item('done', { delivery }), served, verified), 'Done', 'merged but not yet served');
  assert.equal(plainStage(live, served, serving), 'Live', 'served, verdict not yet run');
  assert.equal(plainStage(item('done', { delivery })), 'Live', 'repository serves nothing');
  assert.equal(plainStage(item('done', { closure: { kind: 'obsolete', ref: null, reason: 'gone', by: 'op', at: '2026-01-01T00:00:00Z', from: 'build' } } as Work['closure'])), 'Done');

  // Every plain label is reached by at least one walk above, and glossary names each once.
  const seen = new Set(plainStages.map(label => {
    // Re-derive a fixture that yields this label.
    const examples: Record<typeof plainStages[number], () => string> = {
      Building: () => plainStage(item('build')),
      Testing: () => plainStage(item('test')),
      'In review': () => plainStage(item('review')),
      Merging: () => plainStage(item('merge')),
      'Live and verified': () => plainStage(live, served, verified),
      'Live and failing': () => plainStage(live, served, failing),
      Live: () => plainStage(item('done', { delivery })),
      Done: () => plainStage(item('done', { delivery }), served, verified),
    };
    return examples[label]();
  }));
  assert.deepEqual([...seen].sort(), [...plainStages].sort());

  // Master status items carry the plain label in `stage`.
  assert.equal(itemLine(item('review'), Date.now()).stage, 'In review');
  assert.equal(itemLine(item('merge'), Date.now()).stage, 'Merging');
  assert.equal(itemLine(item('test'), Date.now()).stage, 'Testing');
  assert.equal(itemLine(item('build'), Date.now()).stage, 'Building');

  // Glossary documents one line per plain label.
  const glossary = await readFile(new URL('../docs/glossary.md', import.meta.url), 'utf8');
  for (const label of plainStages) {
    assert.match(glossary, new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'm'), label);
    assert.ok(plainStageLines[label].startsWith(label));
  }
});
