import type { Evidence, Work } from '../model.js';
import { recordScenarioRun } from '../test-runs.js';

/** Accept evidence and project its scenario run in the transaction that saves the work. */
export async function appendEvidence(work: Work, evidence: Evidence, db: Parameters<typeof recordScenarioRun>[0]) {
  work.evidence.push(evidence);
  await recordScenarioRun(db, work, evidence);
}
