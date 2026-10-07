/**
 * Interventions read from the ledger (GY-98; see model/interventions.ts for the concept).
 *
 * The control plane already writes a typed event for every step somebody takes on its behalf:
 * a rework decision, a scope request and the revision that widened it, a merge the record
 * refused and an operator authorized, a containment fence a coordinator settled, an escalation
 * and its resolution, a human-only request and its answer. The fold reads those events in
 * ledger order and pairs each need with what met it, so a signal's wait is measured from the
 * moment the product needed someone to the moment they acted, and never estimated. Sessions that
 * intervene by hand — the loop's re-prompt of a quiet session, a nudge a person typed — record
 * the signal explicitly (`recordIntervention`) with the same fields.
 *
 * Nothing here decides a gate. The report is a reading of history; the one thing it writes is a
 * work item when a kind of intervention at a stage keeps recurring (`openPatternItems`).
 *
 * This file only re-exports (GY-1447). Every intervention fix used to reword it, and concurrent
 * items conflicted on it, so each concern is a module under src/interventions/ that opens with the
 * concern it owns: change that module, and add a ledger kind's reading as one rule in
 * src/interventions/fold-rules.ts. tests/interventions-hotspot-split.test.ts holds every module
 * to the module size budget.
 */

export { interventionDecisionReachMs, interventionLedgerSince, loopSettledInBound, reworkGroundsSql, windowOutcomes } from './intervention-exemptions.js';
export { interventionLedgerKinds, interventionLedgerLimit, readInterventionLedger, type InterventionLedgerRow } from './interventions/ledger.js';
export { foldInterventions } from './interventions/fold.js';
export { computeInterventionReport, detectPatterns, readInterventionReport } from './interventions/report.js';
export { controlPlaneActor, interventionScan, interventionScanVariable, openPatternItems, patternScanIntervalMs, startPatternScan } from './interventions/patterns.js';
export { judgementToWork, recordIntervention, recordJudgement } from './interventions/records.js';
