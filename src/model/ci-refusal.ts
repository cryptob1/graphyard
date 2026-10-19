/**
 * The test gate's refusal for a required CI check that has not passed on the current candidate,
 * worded in this one place (GY-332). The gate that raises it, the refusal catalogue and mapping,
 * the merge queue's tip-validation lift and the status readers all match it through these, so the
 * wording cannot drift in one of them and silently stop another from recognising it. A failed
 * check's owed or running rerun (GY-516) appends the `; rerun: …` tail, so the shape carries an
 * optional tail and every reader keeps matching the refusal once a rerun is recorded.
 */
/** The refusal's body: the wording without anchors, composed into the full and wrapped shapes. */
export const ciCheckRefusalBody = 'Required CI check (.+?) has not passed on the current candidate(?:; rerun: ([\\s\\S]*))?';
export const ciCheckRefusalPattern = new RegExp(`^${ciCheckRefusalBody}$`);
/** The body for a refusal that wraps this one after a prefix (GY-332: composed, not sliced). */
export const ciCheckRefusalSource = ciCheckRefusalBody;
/** The refusal the test gate raises for `name`, with its rerun tail when one is recorded. */
export const ciCheckRefusal = (name: string, rerun = '') => `Required CI check ${name} has not passed on the current candidate${rerun}`;
/**
 * GY-2010: the test and merge gates' refusals while the merge writer's ledger holds no passing trial
 * of the head, or no reconciled push of it (model/gates.ts `trialRefusal`, `pushRefusal`). The
 * writer answers both itself, so the item waits on it; no executor step or escalation does.
 */
export const mergeWriterTrialPattern = /^merge writer has not trialled \S{1,12} on \S{1,12}$/;
export const mergeWriterPushPattern = /^merge writer has not pushed \S{1,12}$/;
/** Whether `refusal` of `gate` is one the merge writer itself answers. */
export const mergeWriterRefusal = (gate: string, refusal: string) => gate === 'test' ? mergeWriterTrialPattern.test(refusal) : gate === 'merge' && mergeWriterPushPattern.test(refusal);
/** The check a CI-pending refusal names, or null when `reason` is some other refusal. */
export const ciCheckName = (reason: string): string | null => ciCheckRefusalPattern.exec(reason)?.[1] ?? null;
