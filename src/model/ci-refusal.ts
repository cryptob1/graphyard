/**
 * The test gate's refusal for a required CI check that has not passed on the current candidate,
 * worded in this one place (GY-332). The gate that raises it, the refusal catalogue and mapping,
 * the merge queue's tip-validation lift and the status readers all match it through these, so the
 * wording cannot drift in one of them and silently stop another from recognising it.
 */
export const ciCheckRefusalPattern = /^Required CI check (.+) has not passed on the current candidate$/;
/** The refusal's shape without its start anchor, for a refusal that wraps it after a prefix. */
export const ciCheckRefusalSource = ciCheckRefusalPattern.source.slice(1);
/** The refusal the test gate raises for `name`. */
export const ciCheckRefusal = (name: string) => `Required CI check ${name} has not passed on the current candidate`;
/** The check a CI-pending refusal names, or null when `reason` is some other refusal. */
export const ciCheckName = (reason: string): string | null => ciCheckRefusalPattern.exec(reason)?.[1] ?? null;
