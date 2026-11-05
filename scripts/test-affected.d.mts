// Types for scripts/test-affected.mjs, which tests/worker-affected-tests.test.ts imports.
export function changedFiles(root?: string, base?: string): string[] | null;
export function affectedTests(root?: string, extra?: string[]): { mode: 'affected' | 'full'; reason: string; files: string[] };
