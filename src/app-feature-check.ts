import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { appOnboarding } from './model/onboarding-work.js';
import { caseDirectory, loadCases, parseCase, type CaseFile } from './e2e/case.js';
import { runCases } from './e2e/runner.js';
import type { ServeCheck } from './serve-app.js';

/** Always run by the batch gate, even when the repository has no case catalog. */
export const featureMapCaseId = 'graphyard-feature-map';
export function readAppOnboarding(root: string) {
  try { return appOnboarding(JSON.parse(readFileSync(join(root, 'graphyard.json'), 'utf8'))); }
  catch { return appOnboarding(null); }
}
export function featureMapCase(root: string): CaseFile {
  const app = readAppOnboarding(root);
  if (app.fault) throw new Error(app.fault);
  const file = `${featureMapCaseId}.json`;
  return { file, definition: parseCase(file, JSON.stringify({
    id: featureMapCaseId, title: 'Reach the real application features', target: 'any', required: true,
    steps: app.features.map(feature => feature.command
      ? { kind: 'command', name: feature.name, run: feature.command }
      : { kind: 'http', name: feature.name, method: 'GET', path: feature.url, status: 200 }),
  })) };
}

/** The deployed app must meet the same declaration and feature checks as the batch app. */
export async function checkServedApp(root: string, url: string, token: string, baselineUrl?: string): Promise<ServeCheck> {
  const app = readAppOnboarding(root);
  if (app.fault) return { verified: false, case: featureMapCaseId, step: 'Real application onboarding', reason: app.fault };
  const cases = existsSync(join(root, caseDirectory)) ? await loadCases(root) : [];
  const report = await runCases([featureMapCase(root), ...cases.filter(entry => entry.definition.required)], { url, token, root, baselineUrl });
  const failing = report.cases.find(outcome => outcome.verdict !== 'passed');
  return failing
    ? { verified: false, case: failing.id, step: failing.failingStep ? `step ${failing.failingStep.index + 1} ${failing.failingStep.name}` : null, reason: failing.failingStep?.reason ?? null }
    : { verified: true, case: null, step: null, reason: null };
}
