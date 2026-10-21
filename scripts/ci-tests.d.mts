// Types for scripts/ci-tests.mjs, which the test runner and tests/ci-shards.test.ts import.
export interface Selection { mode: 'full' | 'affected'; reason: string; files: string[] }
export type DependencyMap = Map<string, string[]>;
export const defaultShardCount: number;
export const repositoryRoot: string;
export const speculativeTipSubject: RegExp;
export function listTestFiles(root?: string): string[];
export const advisoryTests: string[];
export function isAdvisoryTest(file: string): boolean;
export function preMergeTestFiles(root?: string): string[];
export function shardFiles(files: string[], count?: number): string[][];
export function parseShard(text: string): { index: number; count: number };
export function fileEdges(file: string, text: string, files: Set<string>, directories: Map<string, string[]>): Set<string>;
export function dependencyMap(root?: string, tests?: string[]): DependencyMap;
export function selectAffected(changed: string[] | null, map: DependencyMap, tests: string[]): Selection;
export function selectForRun(run: { event: string; headSubject?: string; queued?: boolean | null; changed?: string[] | null; map: DependencyMap; tests: string[] }): Selection;
export function runContext(root?: string, environment?: NodeJS.ProcessEnv): { event: string; headSubject?: string; queued?: boolean | null; changed?: string[] | null };
