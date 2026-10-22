// The durable coordination loop: one cycle of snapshot, close, dispatch, merge writer and persist
// over one Graphyard snapshot plus injected effects, so the same cycle runs under systemd or inside
// a test. The daemon is a coordinator: it never claims a lease, never produces evidence, and merges
// only through the merge writer. Its modules live under src/daemon/; this path re-exports them.
export { daemonActionKinds, storeAction, actionDetailMax, daemonActionSchema, cycleMetricsSchema, cycleFailureSchema, daemonStateSchema, retainedActions, retainedMetrics, profileCooldownMs, maxProofAttempts, emptyDaemonState, daemonStatePath, readDaemonState, writeDaemonState, pruneDaemonState, boundDaemonState, acquireDaemonLock, pidNamespace, initialPidNamespace, masterSessionSchema, emptyMasterSession, masterSummary, type DaemonActionKind, type DaemonAction, type CycleMetrics, type CycleFailures, type MasterSessionState, type DaemonState } from './daemon/state.js';
export { reconcilePendingActions, dispatchKey, candidateKey, closeKey } from './daemon/reconcile.js';
export { profileHealth, readyToRetry, recordProfileFailure, clearProfileFailure, type ProfileHealth } from './daemon/sessions.js';
export { standingVerdict, reworkObservationMaxAgeMs, observationWakeRetryMs, observationWakeDue, reworkObservationWait, neededRework, proofRework, syncConflict, mergeableCandidate, type StandingVerdict, type Rework } from './daemon/rework.js';
export { boundDetail, detailChanged, namePaths } from './daemon/text.js';
export { loopLiveness, pidProbeable, hostPidProbe, cycleFailureAttentionAfter, cycleFailureCeilingMs, cycleFailureDelay, cycleFailureStart, cycleFailureCeiling, describeFailingCall, noteCycleFailure, noteCycleSuccess, noteUnhandled, namedEffects, boundedPersist, watchdogPlan, actionableIntervalMs, type LoopState, type LoopLiveness } from './daemon/liveness.js';
export { snapshotRetryDelayMs, retriedSnapshot, daemonEffects, type DaemonEffects } from './daemon/effects.js';
export { runCycle, cycleSteps, masterLaunchKey } from './daemon/cycle.js';
export { daemonSummary, noteConfigReload, runDaemon } from './daemon/run.js';
