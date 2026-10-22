import { z } from 'zod';
import { docsWords } from './documentation.js';
import type { Work } from './work.js';

export const retainedMemoryNotes = 20;
export const retainedMemoryChanges = 30;
export const recentChangesWindowMs = 24 * 3_600_000;
export const projectMemoryWordBudget = 500;

/** One thing a person or reviewer told the project that later sessions should know: an operator's answer, a research answer, a post-merge review's note. */
export const memoryNoteSchema = z.object({
  id: z.string(),
  key: z.string(),
  kind: z.string(),
  text: z.string(),
  by: z.string(),
  at: z.string(),
}).strict();
export type MemoryNote = z.infer<typeof memoryNoteSchema>;

export const memoryChangeSchema = z.object({
  key: z.string(),
  sha: z.string(),
  baseSha: z.string().nullable().optional(),
  files: z.array(z.string()).default([]),
  mergedAt: z.string(),
}).strict();
export type MemoryChange = z.infer<typeof memoryChangeSchema>;

export const projectMemorySchema = z.object({
  version: z.literal(1).default(1),
  updatedAt: z.string(),
  notes: z.array(memoryNoteSchema).max(100).default([]),
  changes: z.array(memoryChangeSchema).max(100).default([]),
}); // not strict: a memory written before GY-2873 carries `pitfalls`, and one before GY-2874 its retired records, which parsing drops
export type ProjectMemory = z.infer<typeof projectMemorySchema>;

export function emptyProjectMemory(now: string = new Date().toISOString()): ProjectMemory {
  return { version: 1, updatedAt: now, notes: [], changes: [] };
}

export type SessionRole = 'worker' | 'reviewer' | 'producer';

/** The note kinds each role acts on, shown to it first. */
const noteRoles: Record<SessionRole, string[]> = {
  worker: ['human-answer', 'product-answer', 'goals-and-priorities', 'money-or-accounts', 'credentials-for-people'],
  reviewer: ['post-merge-review', 'product-answer'],
  producer: ['product-answer'],
};
export function isNoteRoleRelevant(note: MemoryNote, role: SessionRole): boolean {
  return noteRoles[role]?.includes(note.kind.toLowerCase()) ?? true;
}

/** Record a note in project memory, newest first, replacing one with the same id. */
export function recordNoteInMemory(memory: ProjectMemory, note: MemoryNote): boolean {
  const entry: MemoryNote = { ...note, text: note.text.trim() };
  memory.notes = [entry, ...memory.notes.filter(n => n.id !== entry.id)]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, retainedMemoryNotes);
  memory.updatedAt = memory.notes[0]?.at ?? entry.at;
  return true;
}

/** Record a verified merge in project memory. */
export function recordChangeInMemory(memory: ProjectMemory, change: { key: string; sha: string; baseSha?: string | null; files: string[]; mergedAt: string }): boolean {
  if (!change.sha || !change.key) return false;
  const entry: MemoryChange = { key: change.key, sha: change.sha, baseSha: change.baseSha ?? null, files: [...new Set(change.files)], mergedAt: change.mergedAt };
  const filtered = memory.changes.filter(c => c.sha !== entry.sha && c.key !== entry.key);
  memory.changes = [entry, ...filtered]
    .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt))
    .slice(0, retainedMemoryChanges);
  memory.updatedAt = entry.mergedAt;
  return true;
}

/** Update project memory from operator answers and merges in work. Never from an agent's claim. */
export function updateProjectMemoryFromWork(memory: ProjectMemory, work: readonly Work[], now: number = Date.now()): ProjectMemory {
  // 1. Operator answers: an answered request moves to `humanRequests` and the open one is cleared, so
  // the retained history is where a provided answer lives. A declined one answered nothing. Settled
  // snapshot items are summaries without humanRequests/researchBrief (GY-1125), so answers enter
  // memory while their item is open and persist in .graphyard/project-memory.json.
  const notes: MemoryNote[] = [];
  for (const item of work) {
    for (const request of item.humanRequests ?? []) {
      if (request.answer?.outcome !== 'provided') continue;
      notes.push({ id: request.id, key: item.key, kind: request.kind, text: `${request.needed}: ${request.answer.text}`, by: request.answer.by || 'operator', at: request.answer.at });
    }
  }
  notes.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  for (const note of notes) recordNoteInMemory(memory, note);

  // 2. Merges to main in the last 24 hours
  const recentCutoff = now - recentChangesWindowMs;
  for (const item of work) {
    if (item.stage === 'done' && (item.delivery || item.observation?.merged)) {
      const mergedAt = item.delivery?.mergedAt ?? item.observation?.mergedAt;
      const mergeSha = item.delivery?.mergeSha ?? item.observation?.mergeSha;
      if (mergedAt && mergeSha && Date.parse(mergedAt) >= recentCutoff) {
        recordChangeInMemory(memory, { key: item.key, sha: mergeSha, baseSha: item.candidate?.baseSha ?? null, files: item.observation?.files ?? [], mergedAt });
      }
    }
  }

  return memory;
}

const short = (sha: string) => sha ? sha.slice(0, 10) : '';

/**
 * Format a role-relevant digest of project memory within a fixed word budget, newest and most relevant first.
 */
export function projectMemoryDigest(memory: ProjectMemory | null | undefined, role: SessionRole, options?: { baseSha?: string; wordBudget?: number }): string {
  if (!memory) return '';
  const budget = options?.wordBudget ?? projectMemoryWordBudget;

  // Role-relevant notes first, then newest
  const notes = [...memory.notes].sort((a, b) => {
    const aRel = isNoteRoleRelevant(a, role) ? 1 : 0;
    const bRel = isNoteRoleRelevant(b, role) ? 1 : 0;
    if (aRel !== bRel) return bRel - aRel;
    return Date.parse(b.at) - Date.parse(a.at);
  });

  // Filter changes: if baseSha provided, those since session base (or all recent in window)
  const baseSha = options?.baseSha;
  let changes = [...memory.changes];
  // A base that is itself a remembered merge contains that merge and every one before it, so only
  // the later ones are news to the session; an unremembered base keeps the whole recent window.
  const baseMerge = baseSha ? changes.find(c => c.sha === baseSha) : undefined;
  if (baseMerge) changes = changes.filter(c => c.sha !== baseMerge.sha && Date.parse(c.mergedAt) > Date.parse(baseMerge.mergedAt));
  changes.sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));

  if (!notes.length && !changes.length) return '';

  const parts: string[] = ['Shared project memory:'];

  // Add notes
  if (notes.length) {
    const noteLines: string[] = [];
    for (const n of notes) {
      const line = `- ${n.key} (${n.kind}): ${n.text} [by ${n.by}]`;
      const candidate = [...parts, 'Recent notes:', ...noteLines, line].join(' ');
      if (docsWords(candidate) <= budget) {
        noteLines.push(line);
        continue;
      }
      // If oversized, include an abbreviated note if budget allows (GY-1125 follow-up finding 3):
      const prefix = `- ${n.key} (${n.kind}): `;
      const suffix = ` [by ${n.by}]`;
      const abbrBase = [...parts, 'Recent notes:', ...noteLines, `${prefix}…${suffix}`].join(' ');
      const baseWords = docsWords(abbrBase);
      if (baseWords <= budget) {
        const wordsAvailable = budget - baseWords;
        const textWords = n.text.split(/\s+/).filter(Boolean);
        // The ellipsis joins the last kept word, so the abbreviated line takes `count - 1` words
        // beyond the base: the slice is computed once rather than re-counted per dropped word (GY-1180).
        if (noteLines.length === 0 || wordsAvailable >= 5)
          noteLines.push(`${prefix}${textWords.slice(0, Math.min(textWords.length, wordsAvailable + 1)).join(' ')}…${suffix}`);
      }
      // GY-1125 follow-up finding 5: continue to allow later shorter notes to be considered
    }
    if (noteLines.length) parts.push('Recent notes:', noteLines.join(' '));
  }

  // Add merges since base
  if (changes.length) {
    const changeLines: string[] = [];
    const baseLabel = baseMerge ? `since base ${short(baseMerge.sha)}` : 'in last 24h';
    for (const c of changes) {
      const fileList = c.files.length ? c.files.slice(0, 10).join(', ') + (c.files.length > 10 ? '…' : '') : 'none';
      const line = `- ${c.key} (${short(c.sha)}): ${fileList}`;
      const candidate = [...parts, `Recent merges to main ${baseLabel}:`, ...changeLines, line].join(' ');
      // GY-1125 follow-up finding 5: continue instead of break so later shorter entries are not hidden
      if (docsWords(candidate) > budget) continue;
      changeLines.push(line);
    }
    if (changeLines.length) parts.push(`Recent merges to main ${baseLabel}:`, changeLines.join(' '));
  }

  const result = parts.join(' ').trim();
  return result ? `${result} ` : '';
}
