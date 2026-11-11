import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runRecord } from '../../src/runner/types.js';
import { loadMasterConfig } from '../../src/master/config.js';
import { launchSpecCheck } from '../../src/spec-check.js';
import { afterEach } from 'node:test';
import { launchReview as launch, readReviewLedger, updateReviewLedger } from '../../src/reviewer.js';
import type { HeadlessExec } from '../../src/headless-session.js';
import { clearRuns, liveRun, endRun } from '../../src/runner/registry.js';

/** Ledger/coordination tests keep a model in flight; model answers are exercised by headless-review*. */
export const pendingHeadless: HeadlessExec = () => new Promise(() => {});
afterEach(() => clearRuns());
export const launchReview: typeof launch = (root, work, profile, agents, observedAt, deps) =>
  launch(root, work, profile, agents, observedAt, { headless: pendingHeadless, ...deps });

/** Seed a pre-upgrade pane record for legacy reconciliation tests. New production launches never do this. */
export const launchLegacyReview: typeof launch = async (root, work, profile, agents, observedAt, deps) => {
  const result = await launchReview(root, work, profile, agents, observedAt, deps);
  const directory = liveRun(result.agentName)!.run.directory!;
  endRun(result.agentName, runRecord(result.account?.kind ?? 'claude', { events: [] }, null, observedAt, observedAt));
  await rm(directory, { recursive: true, force: true });
  const config = await loadMasterConfig(root);
  const record = (await readReviewLedger(root)).reviews.find(entry => entry.id === result.review)!;
  const created = JSON.parse(String(await deps!.run!('herdr', ['tab', 'create', '--cwd', result.checkout, '--label', `${work.key} review · ${result.agentName}`, `GH_CONFIG_DIR=${record.sessionDirectory}`, `GRAPHYARD_REVIEW=${work.key}@${result.sha}`, `GRAPHYARD_URL=${config.url}`])));
  const pane = created.result.root_pane.pane_id as string;
  await deps!.run!('herdr', ['agent', 'rename', pane, result.agentName]);
  await updateReviewLedger(root, ledger => {
    const entry = ledger.reviews.find(record => record.id === result.review)!;
    entry.pane = pane; delete entry.headless; delete entry.acknowledgedAt;
  });
  return { ...result, pane };
};

/** A pre-upgrade spec-check pane, for the daemon's existing-record settlement coverage. */
export const launchLegacySpecCheck: typeof import('../../src/spec-check.js').launchSpecCheck = async (root, work, profile, agents, observedAt, deps) => {
  const result = await launchSpecCheck(root, work, profile, agents, observedAt, { headless: pendingHeadless, ...deps });
  const run = liveRun(result.agentName)!;
  const session = JSON.parse(await readFile(join(run.run.directory!, 'session.json'), 'utf8'));
  endRun(result.agentName, runRecord('claude', { events: [] }, null, observedAt, observedAt));
  await rm(run.run.directory!, { recursive: true, force: true });
  const created = JSON.parse(String(await deps!.run!('herdr', ['tab', 'create', '--cwd', result.checkout!, `GH_CONFIG_DIR=${session.context.GH_CONFIG_DIR}`])));
  const pane = created.result.root_pane.pane_id as string;
  await deps!.run!('herdr', ['agent', 'rename', pane, result.agentName]);
  return { ...result, pane };
};
