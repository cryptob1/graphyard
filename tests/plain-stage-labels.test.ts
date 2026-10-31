import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { itemLine } from '../src/cli/master-status.js';
import { liveFailingLine, plainStage, plainStageLines, plainStages, type PlainStage, type ServeView } from '../src/model/plain-stage.js';
import { prSteps } from '../src/model/pr-steps.js';
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

const delivery = { mergeSha: 'a'.repeat(40), mergedAt: '2026-01-01T01:00:00Z', authorizationRevision: 1, pr: 1 };
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
} as unknown as Work);

test('unit:plain-stage-labels — every derived stage maps to exactly one plain label, and master status items carry it', async () => {
  // Each open stage has one plain label; done is refined by the release and the serve verdict below.
  const byStage: Record<Stage, string> = {
    backlog: 'Not started', ready: 'Not started', build: 'Building',
    review: 'In review', test: 'Testing', acceptance: 'Testing', merge: 'Merging',
    done: 'Done', // a repository with no deployment
  };
  for (const stage of stages) {
    const work = stage === 'done' ? item('done', { delivery } as Partial<Work>) : item(stage);
    assert.equal(plainStage(work), byStage[stage], stage);
  }

  // Done + GY-2983's verdict on the served commit names an item only when the verdict is about it.
  const merged = item('done', { delivery } as Partial<Work>);
  const live = withDeployment(merged);
  const other = 'b'.repeat(40);
  const verdict = (verified: boolean, commit: string, kase: string | null = null): ServeView =>
    ({ serves: true, commit, check: { verified, case: kase, step: null, reason: null } });
  const proving = withDeployment(item('done', { delivery, criteria: [{ id: 'AC-1', text: 'Home', proofs: ['e2e:home'] }] } as Partial<Work>));
  assert.equal(plainStage(live, served, verdict(true, delivery.mergeSha)), 'Live and verified', 'its own merge is served and verified');
  assert.equal(plainStage(live, served, verdict(false, delivery.mergeSha, 'home')), 'Live and failing', 'its own merge is served and failing');
  assert.equal(plainStage(proving, served, verdict(false, other, 'home')), 'Live and failing', 'the failing case proves it');
  assert.equal(plainStage(live, served, verdict(false, other, 'home')), 'Live', 'a later commit fails a case that is not its own');
  assert.equal(plainStage(live, served, verdict(true, other)), 'Live', 'a later commit verified says nothing of this item');
  assert.equal(plainStage(live, served, { serves: true, commit: delivery.mergeSha, check: null }), 'Live', 'served, verdict not yet run');
  assert.equal(plainStage(merged, served, verdict(true, other)), 'Merged, not live yet', 'merged, not yet served');
  assert.equal(plainStage(merged, served), 'Merged, not live yet', 'a watched release has not served it yet');
  assert.equal(plainStage(live, served), 'Live', 'a watched release serves it');
  assert.equal(liveFailingLine(verdict(false, other, 'home')), 'The live app is failing home');
  assert.equal(liveFailingLine(verdict(true, other)), null);
  assert.equal(plainStage(item('done', {
    closure: { kind: 'obsolete', ref: null, reason: 'gone', by: 'op', at: '2026-01-01T00:00:00Z', from: 'build' },
  } as Partial<Work>)), 'Done');

  // Every plain label is reached, and glossary names each once.
  const examples: Record<PlainStage, () => string> = {
    'Not started': () => plainStage(item('ready')),
    Building: () => plainStage(item('build')),
    Testing: () => plainStage(item('test')),
    'In review': () => plainStage(item('review')),
    Merging: () => plainStage(item('merge')),
    'Merged, not live yet': () => plainStage(merged, served),
    Live: () => plainStage(live, served),
    'Live and verified': () => plainStage(live, served, verdict(true, delivery.mergeSha)),
    'Live and failing': () => plainStage(live, served, verdict(false, delivery.mergeSha, 'home')),
    Done: () => plainStage(merged),
  };
  for (const label of plainStages) assert.equal(examples[label](), label);

  // Master status items carry the plain label in `stage`.
  assert.equal(itemLine(item('review'), Date.now()).stage, 'In review');
  assert.equal(itemLine(item('merge'), Date.now()).stage, 'Merging');
  assert.equal(itemLine(item('test'), Date.now()).stage, 'Testing');
  assert.equal(itemLine(item('build'), Date.now()).stage, 'Building');
  assert.equal(itemLine(item('ready'), Date.now()).stage, 'Not started');

  // The row keeps one vocabulary and the wait: the label leads with the plain stage, then names what it waits on.
  const steps = prSteps(item('ready'), Date.now());
  assert.deepEqual(steps.steps.map(step => step.label), ['Not started', 'Building', 'Testing, review, merge', 'Done']);
  assert.match(steps.label, /^Not started · \S/);

  // Glossary documents one line per plain label.
  const glossary = await readFile(new URL('../docs/glossary.md', import.meta.url), 'utf8');
  for (const label of plainStages) {
    assert.ok(glossary.split('\n').includes(plainStageLines[label]), label);
    assert.ok(plainStageLines[label].startsWith(label));
  }
});
