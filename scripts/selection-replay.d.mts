// Types for scripts/selection-replay.mjs, which tests/ci-tests-selection.test.ts drives.
import type { Selection } from './ci-tests.mjs';
export interface MainFailure { file: string; item: string; culprit: string | null }
export interface ReplayRow { key: string; changed: number; now: Selection; then: Selection; minutes: number }
export interface ReplaySummary { files: number; minutes: number; everything: number }
export interface ReplayCheck extends MainFailure { kept: boolean }
export const mainFailures: MainFailure[];
export const oldSelector: string;
export function replay(options?: { root?: string; merges?: number; old?: string; failures?: MainFailure[] }): Promise<{ tests: number; totalMinutes: number; rows: ReplayRow[]; old: ReplaySummary; new: ReplaySummary; checks: ReplayCheck[]; lost: ReplayCheck[] }>;
