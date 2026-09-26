// Types for scripts/ci-tests.mjs, which the test runner and tests/ci-shards.test.ts import.
export interface Shard { files: string[]; durationMs: number }
export interface Selection { mode: 'full' | 'affected'; reason: string; files: string[] }
export type DependencyMap = Map<string, string[]>;
export const defaultShardCount: number;
export const repositoryRoot: string;
export const baselinePath: string;
export const speculativeTipSubject: RegExp;
export function listTestFiles(root?: string): string[];
export function readDurations(root?: string): Record<string, number>;
export function shardFiles(files: string[], durations: Record<string, number>, count?: number): Shard[];
export function parseShard(text: string): { index: number; count: number };
export function shardImbalance(shards: Shard[]): number;
export function mergeDurations<T extends { files?: Record<string, number> }>(baseline: T, records: string[], testFiles: string[]): T & { files: Record<string, number> };
export function fileEdges(file: string, text: string, files: Set<string>, directories: Map<string, string[]>): Set<string>;
export function dependencyMap(root?: string, tests?: string[]): DependencyMap;
export function selectAffected(changed: string[] | null, map: DependencyMap, tests: string[]): Selection;
export function selectForRun(run: { event: string; headSubject?: string; queued?: boolean | null; changed?: string[] | null; map: DependencyMap; tests: string[] }): Selection;
export function runContext(root?: string, environment?: NodeJS.ProcessEnv): { event: string; headSubject?: string; queued?: boolean | null; changed?: string[] | null };
