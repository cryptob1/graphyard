// Concern: the release note of each verified batch (GY-3146): what merged since the previous verified commit, and how to try it.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Work } from './model.js';

export interface ReleaseNoteItem { key: string; title: string; summary: string; cases: string[] }
export interface ReleaseNote { commit: string; at: string; items: ReleaseNoteItem[]; reverted: ReleaseNoteItem[] }

const keep = 20;
export const releaseNotesPath = (root: string) => join(root, '.graphyard', 'release-notes.json');

export function readReleaseNotes(file: string): ReleaseNote[] {
  if (!existsSync(file)) return [];
  try { return JSON.parse(readFileSync(file, 'utf8')) as ReleaseNote[]; } catch { return []; }
}

const noteItem = (item: Work): ReleaseNoteItem => ({
  key: item.key, title: item.title,
  summary: item.summary?.trim() || (item.description ?? '').trim().split(/(?<=[.!?])\s/)[0] || item.title,
  cases: [...new Set(item.criteria.flatMap(criterion => criterion.proofs.filter(proof => proof.startsWith('e2e:'))))],
});

/** The note for a batch: its landed items, the gate's reverted ones listed apart. */
export function releaseNote(commit: string, at: string, landings: readonly { sha: string; item: Work | null }[], reverted: ReadonlySet<string>): ReleaseNote {
  const seen = new Set<string>(), note: ReleaseNote = { commit, at, items: [], reverted: [] };
  for (const { sha, item } of landings) {
    if (!item || seen.has(item.key)) continue;
    seen.add(item.key);
    (reverted.has(sha) ? note.reverted : note.items).push(noteItem(item));
  }
  return note;
}

export async function appendReleaseNote(file: string, note: ReleaseNote) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify([...readReleaseNotes(file), note].slice(-keep), null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

/** One line per item for master status: the latest note. */
export function latestReleaseNote(file: string) {
  const note = readReleaseNotes(file).at(-1);
  if (!note) return null;
  const line = (item: ReleaseNoteItem) => `${item.key} ${item.title}: ${item.summary} (${item.cases.length ? item.cases.join(', ') : 'no E2E case'})`;
  return { commit: note.commit.slice(0, 12), at: note.at, items: note.items.map(line), reverted: note.reverted.map(line) };
}
