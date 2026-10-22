// The durable coordination loop. Every step is a pure decision over one Graphyard snapshot plus
// an injected effect, so the same cycle runs under systemd, under Herdr, or inside a test with no
// process supervision at all. The daemon is a coordinator: it never claims a lease, never produces
// evidence, never calls an operator route, and merges nothing itself.
//
// Its modules live under src/daemon/, one concern each (GY-177); this path re-exports every public
// name so existing imports keep working.
export { daemonActionKinds, storeAction, actionDetailMax, daemonActionSchema, cycleStepNames, cycleStepsSchema, emptyCycleSteps, cycleMetricsSchema, containmentRetentionSchema, retainedContainments, deploymentObservationSchema, cycleFailureSchema, daemonStateSchema, retainedActions, retainedMetrics, profileCooldownMs, maxProofAttempts, emptyDaemonState, daemonStatePath, readDaemonState, writeDaemonState, pruneDaemonState, boundDaemonState, boundDeployment, acquireDaemonLock, pidNamespace, initialPidNamespace, masterSessionSchema, emptyMasterSession, masterSummary, type DaemonActionKind, type DaemonAction, type CycleStepName, type StepCost, type CycleSteps, type CycleMetrics, type ContainmentRetention, type DeploymentObservation, type CycleFailures, type MasterSessionState, type DaemonState } from './daemon/state.js';
export { reconcilePendingActions, dispatchKey, candidateKey, closeKey } from './daemon/reconcile.js';
export { actionableSubjects, type ActionableSubject } from './daemon/subjects.js';
export { profileHealth, readyToRetry, recordProfileFailure, clearProfileFailure, type ProfileHealth } from './daemon/sessions.js';
export { standingVerdict, reworkObservationMaxAgeMs, observationWakeRetryMs, observationWakeDue, reworkObservationWait, neededRework, proofRework, syncConflict, mergeableCandidate, type StandingVerdict, type Rework } from './daemon/rework.js';
export { boundDetail, detailChanged, namePaths } from './daemon/text.js';
export { cycleCost, loopLiveness, pidProbeable, hostPidProbe, cycleFailureAttentionAfter, cycleFailureCeilingMs, cycleFailureDelay, cycleFailureStart, cycleFailureCeiling, describeFailingCall, noteCycleFailure, noteCycleSuccess, noteUnhandled, namedEffects, boundedPersist, loopAttention, progressAttention, progressStallMs, releaseLagMs, watchdogPlan, actionableIntervalMs, cycleDelay, type LoopState, type LoopLiveness, type CycleCost } from './daemon/liveness.js';
export { stoppedStates, failoverKey, capacityKey, preserveKey, findingRecheckMs, launchAppearanceMs, blockedPromptFailMs, blockedPromptAnswers, blockedPromptSettleMs, promptDigest, snapshotRetryDelayMs, retriedSnapshot, relaunchSession, daemonEffects, type LaunchedSession, type DaemonEffects } from './daemon/effects.js';
export { runCycle } from './daemon/cycle.js';
export { masterSessionStep, masterLaunchKey, masterSetupKey, type MasterRotationCause } from './daemon/cycle-master.js';
export { observeDeployment } from './daemon/deployment.js';
export { daemonSummary, noteConfigReload, noteWatchdog, runDaemon } from './daemon/run.js';
export { baseFailureStep, baseFailureAttention } from './daemon/cycle-base-failures.js';
