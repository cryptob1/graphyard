import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ShippedPage from '../web/pages/shipped.js';
import type { Work } from '../src/model/work.js';
import type { Dashboard } from '../web/pages/dashboard.js';

// GY-3377: the Shipped page header names the latest shipped item ("latest <date>, GY-N <title>"),
// and the fixture item is that latest item. A bare text locator's first match was the header line,
// so the click opened nothing and "Technical details" never appeared. The case clicks the row's button.

const NOW = Date.parse('2030-06-01T12:00:00Z');
const run = 'r1-1';
const title = `E2E case done-item-gates-clean run ${run}`;
const gates = ['ready', 'build', 'review', 'test', 'acceptance', 'merge'].map(name => ({ name, passed: true, reasons: [] as string[] }));
const item = {
  id: 'w-1', key: 'GY-9', title, type: 'chore', description: '', priority: 1, dependencies: [], criteria: [], policy: { checks: [], review: true },
  stage: 'done', revision: 1, policyRevision: 1, ready: true, epoch: 1, lease: null, workspaces: [], submission: null, candidate: null,
  reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates, violations: [],
  createdAt: new Date(NOW - 3_600_000).toISOString(), updatedAt: new Date(NOW).toISOString(), stageEnteredAt: new Date(NOW).toISOString(),
} as unknown as Work;

test('unit:e2e-done-item-gates-clean-pinned — the case opens the delivered item from its Shipped row button, not the header line that names it first', () => {
  const html = renderToStaticMarkup(createElement(ShippedPage, { work: [item], status: {}, observedAt: NOW, setSelected: () => {} } as unknown as Dashboard));
  const steps = JSON.parse(readFileSync('e2e/cases/done-item-gates-clean.json', 'utf8')).steps as { action: string; text?: string; role?: string }[];
  const open = steps.find(step => step.action === 'click' && step.text?.includes('{{run}}'))!;
  const text = open.text!.replace('{{run}}', run);
  const insideButton = (at: number) => html.lastIndexOf('<button', at) > html.lastIndexOf('</button>', at);
  // The runner takes the first match: the first button naming the text with a role, else the first element showing it.
  let at = html.indexOf(text);
  if (open.role === 'button') while (at >= 0 && !insideButton(at)) at = html.indexOf(text, at + 1);
  assert.ok(at >= 0, 'the Shipped page shows the delivered item');
  assert.ok(insideButton(at), `the case's click lands on the row button, not ${html.slice(Math.max(0, at - 80), at)}`);
});
