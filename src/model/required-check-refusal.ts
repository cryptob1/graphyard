/**
 * GY-430. The test gate's refusal for a check only the base branch's protection or rulesets
 * require, named once its run failed: GitHub blocks the merge on it, so it asks for rework. Worded
 * here once, beside `ci-refusal.ts`, for the gate, the refusal catalogue and the mapping alike.
 */
export const requiredCheckFailure = (name: string) => `Required check ${name} failed on the current candidate`;
export const requiredCheckFailurePattern = /^Required check (.+?) failed on the current candidate$/;
