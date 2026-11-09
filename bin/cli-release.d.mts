// Types for bin/cli-release.mjs, which src/install/cli-release.ts re-exports.
import type { ChildRun } from '../src/child-runner.js';
export function cliReleasePath(directory: string, commit: string): string;
export function currentCliPath(directory: string): string;
export function prepareCliRelease(directory: string, source: string, commit: string, run: ChildRun): Promise<string>;
