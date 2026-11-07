// Types for scripts/ci-tests.mjs, which the test runner and tests/ci-shards.test.ts import.
export interface Selection { mode: 'full' | 'affected'; reason: string; files: string[] }
export type DependencyMap = Map<string, string[]> & { declarations?: Map<string, Map<string, string[]>>; readers?: Map<string, string[]> };
/** Per changed file, the top-level declarations its diff touches, or null for the whole file. */
export type ChangedDeclarations = Map<string, Set<string> | null>;
export const defaultShardCount: number;
export const repositoryRoot: string;
export function listTestFiles(root?: string): string[];
export function shardFiles(files: string[], count?: number): string[][];
export function parseShard(text: string): { index: number; count: number };
export function fileEdges(file: string, text: string, files: Set<string>, directories: Map<string, string[]>): { imports: Set<string>; data: Set<string> };
export function dependencyMap(root?: string, tests?: string[]): DependencyMap;
export function changedDeclarations(changed: string[], base: string, root?: string, head?: string | null): ChangedDeclarations;
export function selectAffected(changed: string[] | null, map: DependencyMap, tests: string[], declarations?: ChangedDeclarations): Selection;
