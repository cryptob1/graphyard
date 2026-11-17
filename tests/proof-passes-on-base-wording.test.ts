import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Work } from '../src/model.js';
// @ts-expect-error the checked-in dashboard fixture is plain JavaScript
import { fixtureApi, fixtureStatus, fixtureWork, NOW } from '../scripts/dashboard-fixture.mjs';
import { live } from '../browser-tests/ui-board.js';
import type { Dashboard } from '../web/pages/dashboard.js';
import WorkDetails from '../web/pages/work-details.js';
import { trialFailureReason } from '../src/merge-writer/executor.js';
import { trialFailureRework } from '../src/daemon/cycle-merge-writer.js';
import { appliedReworkBrief, reworkBriefSection } from '../src/master/rework-brief.js';

// GY-3423: a feature whose bound case already passes on the base tip is refused in plain words, and
// those words reach the item page and the next worker's rework brief unchanged.

const noop = () => {};
const head = 'a'.repeat(40), tip = 'b'.repeat(40);
const plain = `already passes on the base tip ${tip} without this change, so it shows nothing the change does. Change e2e/cases/home-shows-fix.json so a case fails on the base tip and passes with the change.`;

test('e2e:proof-passes-on-base-wording — an item whose case passes on base shows the plain refusal on its item page and in the worker rework reason', () => {
  const refusal = trialFailureReason({ run: { build: 'pass', tests: { passed: ['test'], failed: [] }, failingCase: null, timedOut: false, e2e: [],
    notReproduced: { proofs: ['e2e:home-shows-fix'], tip, files: ['e2e/cases/home-shows-fix.json'] } } as never })!;
  const base = (fixtureWork() as any[]).map(live)[0] as unknown as Work;
  const rework = trialFailureRework(base, head, refusal);
  const item = { ...base, type: 'feature', candidate: { ...base.candidate, sha: head }, submission: { epoch: 1, pr: 7 }, reworkRequested: true,
    lastRework: { reason: rework.reason, binding: rework.input.binding, at: new Date(NOW).toISOString() }, pipeline: { attempts: [], submittedAt: new Date(NOW - 60_000).toISOString(), resubmittedAt: null } } as unknown as Work;

  const dashboard = { token: 'fixture', work: [item], status: fixtureStatus('admin'), error: '', connected: true, lastUpdated: '12:00:00', view: 'work', setView: noop, filter: null, setFilter: noop,
    selected: null, setSelected: noop, creating: false, setCreating: noop, busy: false, setBusy: noop, observedAt: NOW, jobs: [], query: '', setQuery: noop,
    operatorAgents: [], operatorAgentsError: null, features: {} as any, events: fixtureApi('events') as any[], editingRequirements: false, setEditingRequirements: noop,
    sessionEpoch: { current: 0 }, api: async (path: string) => fixtureApi(path, 'admin'), refresh: async () => {}, action: async () => {},
    setError: noop, signOut: noop } as unknown as Dashboard;
  const page = renderToStaticMarkup(createElement(WorkDetails, { ...dashboard, item }));
  const shown = page.match(/<p class="notice" data-rework-reason="true">([^<]*)<\/p>/)?.[1]?.replace(/&#x27;/g, "'") ?? '';
  assert.match(shown, /^Sent back because: .*the proof already passes before the change: e2e:home-shows-fix /, page.slice(0, 400));
  assert.ok(shown.includes(plain), shown);
  assert.doesNotMatch(shown, /not reproduced/);

  const brief = reworkBriefSection(item, appliedReworkBrief(item));
  assert.ok(brief.includes(plain), brief);
  assert.doesNotMatch(brief, /not reproduced/);
});
