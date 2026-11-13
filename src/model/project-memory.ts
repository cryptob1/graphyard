import type { z } from 'zod';
import type { memoryNoteSchema, memoryChangeSchema, productBriefSchema, productBriefChangeSchema, projectMemorySchema } from '../model-boundary/project-memory.js';
import type { Work } from './work.js';
import { docsWords } from './documentation.js';
export const retainedMemoryNotes = 20;
export const retainedMemoryChanges = 30;
export const recentChangesWindowMs = 24 * 3_600_000;
export const projectMemoryWordBudget = 500;
/** The master's own lessons (GY-3274): notes of this kind the master records and every master launch prompt carries. */
export const masterLessonKind = 'master-lesson';
export const retainedMasterLessons = 40;
export const masterLessonCharacterLimit = 300;
/** The stored lessons' total stays under this many words, by dropping the oldest. */
export const masterLessonWordTotal = 1200;
export type MemoryNote = z.infer<typeof memoryNoteSchema>;
export type MemoryChange = z.infer<typeof memoryChangeSchema>; // not strict: a memory written before GY-2873 carries `pitfalls`, and one before GY-2874 its retired records, which parsing drops
export type ProjectMemory = z.infer<typeof projectMemorySchema>;

/** The install's one product brief, kept in project memory (GY-3274). */
export const productBriefWordLimit = 800;
export const retainedProductBriefChanges = 20;
/** The brief's required Markdown sections, in order. */
export const productBriefHeadings = ['Problem', 'Users', 'What success looks like', 'Current bets', 'Open questions'] as const;
/** The sections worker and reviewer prompts carry, so they build and judge for the user. */
export const productBriefWorkingHeadings = ['Problem', 'Users', 'What success looks like'] as const;
/** How many words of each working section a worker or reviewer prompt carries. */
export const productBriefSectionWords = 100;
export type ProductBrief = z.infer<typeof productBriefSchema>;
export type ProductBriefChange = z.infer<typeof productBriefChangeSchema>;

export function emptyProjectMemory(now: string): ProjectMemory {
  return { version: 1, updatedAt: now, notes: [], changes: [], brief: null };
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

/** The master's lessons in a memory, newest first. */
export function masterLessons(memory: ProjectMemory | null | undefined): MemoryNote[] {
  return (memory?.notes ?? []).filter(note => note.kind === masterLessonKind).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** Newest-first notes with each kind's own retention: `retainedMemoryNotes` ordinary notes, `retainedMasterLessons` master lessons. */
export function boundMemoryNotes(notes: MemoryNote[]): MemoryNote[] {
  let lessons = 0, ordinary = 0;
  return [...notes].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .filter(note => note.kind === masterLessonKind ? lessons++ < retainedMasterLessons : ordinary++ < retainedMemoryNotes);
}

/** Record a note in project memory, newest first, replacing one with the same id. */
export function recordNoteInMemory(memory: ProjectMemory, note: MemoryNote): boolean {
  const entry: MemoryNote = { ...note, text: note.text.trim() };
  memory.notes = boundMemoryNotes([entry, ...memory.notes.filter(n => n.id !== entry.id)]);
  memory.updatedAt = memory.notes[0]?.at ?? entry.at;
  return true;
}

/** Record one of the master's own lessons (GY-3274): a short note the next master launch prompt carries. */
export function recordMasterLesson(memory: ProjectMemory, input: { id: string; text: string; by: string; at: string; forWorkers?: boolean }): MemoryNote {
  const text = input.text.trim();
  if (!text) throw new Error('A lesson needs its text');
  if (text.length > masterLessonCharacterLimit) throw new Error(`A lesson is at most ${masterLessonCharacterLimit} characters and this one is ${text.length}: ${text.slice(0, 120)}…`);
  const note: MemoryNote = { id: input.id, key: 'master', kind: masterLessonKind, text, by: input.by, at: input.at, ...(input.forWorkers ? { forWorkers: true } : {}) };
  recordNoteInMemory(memory, note);
  // The stored total stays under the word budget, dropping the oldest lessons first.
  while (memory.notes.filter(entry => entry.kind === masterLessonKind).length > 1
    && docsWords(masterLessons(memory).map(lesson => lesson.text).join(' ')) >= masterLessonWordTotal) {
    const oldest = masterLessons(memory).at(-1)!;
    memory.notes = memory.notes.filter(entry => entry.id !== oldest.id);
  }
  return note;
}

/** Delete one of the master's lessons by id. */
export function removeMasterLesson(memory: ProjectMemory, id: string): MemoryNote {
  const lesson = masterLessons(memory).find(note => note.id === id);
  if (!lesson) throw new Error(`No master lesson ${id}`);
  memory.notes = memory.notes.filter(note => note.id !== id);
  return lesson;
}

/**
 * Adopt the file's master lessons and product brief into the loop's copy (GY-3274): the master
 * session records them straight to `.graphyard/project-memory.json`, so the file — never the loop's
 * older copy — is their truth, additions and removals alike. `null` (no readable file) changes nothing.
 */
export function reconcileMasterMemory(memory: ProjectMemory, recorded: { lessons: MemoryNote[]; brief: ProductBrief | null } | null): ProjectMemory {
  if (!recorded) return memory;
  memory.notes = boundMemoryNotes([...recorded.lessons, ...memory.notes.filter(note => note.kind !== masterLessonKind)]);
  memory.brief = recorded.brief;
  return memory;
}

/** The master's lessons as its own launch prompt carries them, newest first. */
export function masterLessonsSection(memory: ProjectMemory | null | undefined): string {
  const lessons = masterLessons(memory);
  if (!lessons.length) return '';
  return `Master lessons, your own recorded experience, newest first: ${lessons.map(lesson => `- ${lesson.text}`).join(' ')} `;
}

/** One `## Heading` section of the brief's Markdown, or null when the brief lacks it. */
function briefSection(markdown: string, heading: string): string | null {
  const section = new RegExp(`^##+\\s+${heading}\\s*$`, 'im').exec(markdown);
  if (!section) return null;
  const rest = markdown.slice(section.index! + section[0].length);
  const next = rest.search(/^##+\s+/m);
  return (next < 0 ? rest : rest.slice(0, next)).trim();
}

/**
 * Set the install's one product brief (GY-3274): Markdown of at most 800 words whose sections are
 * exactly the required ones, each change kept in history with who and why, newest first.
 */
export function setProductBrief(memory: ProjectMemory, input: { markdown: string; by: string; why: string; at: string }): ProductBrief {
  const markdown = input.markdown.trim();
  const why = input.why.trim();
  if (!why) throw new Error('master brief set needs a REASON; every agent decision is attributable');
  const missing = productBriefHeadings.filter(heading => briefSection(markdown, heading) === null);
  if (missing.length) throw new Error(`The product brief needs a ${missing.map(heading => `## ${heading}`).join(', ')} section`);
  const words = docsWords(markdown);
  if (words > productBriefWordLimit) throw new Error(`The product brief is ${words} words, over the ${productBriefWordLimit}-word limit`);
  const at = input.at;
  const previous = memory.brief;
  const change: ProductBriefChange = { at, by: input.by, why, words };
  const brief: ProductBrief = { markdown, updatedAt: at, by: input.by, why, history: [change, ...(previous?.history ?? [])].slice(0, retainedProductBriefChanges) };
  memory.brief = brief;
  memory.updatedAt = at;
  return brief;
}

/** The whole brief as the master's launch prompt carries it, before its lessons. */
export function masterBriefSection(memory: ProjectMemory | null | undefined): string {
  const brief = memory?.brief;
  return brief ? `Product brief for this install (updated ${brief.updatedAt} by ${brief.by}): ${brief.markdown} ` : '';
}

/** The brief's problem, users and success sections as worker and reviewer prompts carry them, each trimmed. */
export function productBriefExcerpt(memory: ProjectMemory | null | undefined): string {
  const brief = memory?.brief;
  if (!brief) return '';
  const trim = (text: string) => {
    const words = text.split(/\s+/).filter(Boolean);
    return words.length <= productBriefSectionWords ? text : `${words.slice(0, productBriefSectionWords).join(' ')}…`;
  };
  const sections = productBriefWorkingHeadings.flatMap(heading => { const text = briefSection(brief.markdown, heading); return text ? [`${heading}: ${trim(text)}`] : []; });
  return sections.length ? `Product brief — ${sections.join(' ')} ` : '';
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
export function updateProjectMemoryFromWork(memory: ProjectMemory, work: readonly Work[], now: number): ProjectMemory {
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

  // Role-relevant notes first, then newest; the master's lessons reach a role only through their
  // own section below (a worker sees those marked for it, no other role sees any), never as notes.
  const notes = memory.notes.filter(note => note.kind !== masterLessonKind).sort((a, b) => {
    const aRel = isNoteRoleRelevant(a, role) ? 1 : 0;
    const bRel = isNoteRoleRelevant(b, role) ? 1 : 0;
    if (aRel !== bRel) return bRel - aRel;
    return Date.parse(b.at) - Date.parse(a.at);
  });
  // The lessons the master marked for the workers it dispatches (GY-3274); no other role reads them.
  const lessons = role === 'worker' ? masterLessons(memory).filter(lesson => lesson.forWorkers) : [];
  // The product brief's problem, users and success sections reach the roles that build and judge
  // for the user (GY-3274): standing product context with its own fixed bound, not news against the
  // notes-and-merges budget.
  const brief = role === 'worker' || role === 'reviewer' ? productBriefExcerpt(memory) : '';

  // Filter changes: if baseSha provided, those since session base (or all recent in window)
  const baseSha = options?.baseSha;
  let changes = [...memory.changes];
  // A base that is itself a remembered merge contains that merge and every one before it, so only
  // the later ones are news to the session; an unremembered base keeps the whole recent window.
  const baseMerge = baseSha ? changes.find(c => c.sha === baseSha) : undefined;
  if (baseMerge) changes = changes.filter(c => c.sha !== baseMerge.sha && Date.parse(c.mergedAt) > Date.parse(baseMerge.mergedAt));
  changes.sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));

  if (!notes.length && !changes.length && !lessons.length && !brief) return '';

  const parts: string[] = ['Shared project memory:'];

  // The product brief leads: it is what the work is for, before any news of it.
  if (brief) parts.push(brief.trim());

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

  // The master's lessons for workers, newest first, inside the same budget
  if (lessons.length) {
    const lessonLines: string[] = [];
    for (const lesson of lessons) {
      const line = `- ${lesson.text}`;
      const candidate = [...parts, 'Master lessons for workers:', ...lessonLines, line].join(' ');
      if (docsWords(candidate) > budget) continue;
      lessonLines.push(line);
    }
    if (lessonLines.length) parts.push('Master lessons for workers:', lessonLines.join(' '));
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
