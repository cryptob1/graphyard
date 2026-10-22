import { z } from 'zod';
import { docsWords } from './documentation.js';
import type { Work } from './work.js';

export const retainedMemoryDecisions = 20;
export const retainedMemoryChanges = 30;
export const recentChangesWindowMs = 24 * 3_600_000;
export const projectMemoryWordBudget = 500;

export const memoryDecisionSchema = z.object({
  id: z.string(),
  key: z.string(),
  action: z.string(),
  reason: z.string(),
  approvedBy: z.string(),
  at: z.string(),
}).strict();
export type MemoryDecision = z.infer<typeof memoryDecisionSchema>;

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
  decisions: z.array(memoryDecisionSchema).max(100).default([]),
  changes: z.array(memoryChangeSchema).max(100).default([]),
}); // not strict: a memory written before GY-2873 carries `pitfalls`, which parsing drops
export type ProjectMemory = z.infer<typeof projectMemorySchema>;

export function emptyProjectMemory(now: string = new Date().toISOString()): ProjectMemory {
  return { version: 1, updatedAt: now, decisions: [], changes: [] };
}

export type SessionRole = 'worker' | 'reviewer' | 'producer';

/** Role relevance for decisions: prioritizing actions each role acts on or requires. */
const decisionRoles: Record<SessionRole, string[]> = {
  worker: ['requirements', 'scope', 'rework', 'unblock', 'close', 'human-answer', 'goals-and-priorities', 'money-or-accounts', 'credentials-for-people'],
  reviewer: ['review', 'merge', 'requirements', 'close', 'rework'],
  producer: ['attest', 'requirements', 'rework'],
};
export function isDecisionRoleRelevant(decision: MemoryDecision, role: SessionRole): boolean {
  return decisionRoles[role]?.includes(decision.action.toLowerCase()) ?? true;
}

/** Record an approved/settled decision in project memory. Never updates from an agent's unreviewed claim. */
export function recordDecisionInMemory(memory: ProjectMemory, decision: { id: string; key: string; action: string; reason: string; state: string; approvedBy?: string | null; at: string }): boolean {
  // Only settled / applied / approved decisions and operator answers, never unreviewed agent claims.
  if (decision.state !== 'applied' && decision.state !== 'approved' && decision.state !== 'provided') return false;
  if (!decision.approvedBy) return false;
  const entry: MemoryDecision = { id: decision.id, key: decision.key, action: decision.action, reason: decision.reason.trim(), approvedBy: decision.approvedBy, at: decision.at };
  const filtered = memory.decisions.filter(d => d.id !== entry.id);
  memory.decisions = [entry, ...filtered]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, retainedMemoryDecisions);
  memory.updatedAt = memory.decisions[0]?.at ?? entry.at;
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

/**
 * Record a two-party decision the loop observed settling (GY-1125). Only an applied decision
 * enters memory, with the approver's own reason (the request's when the approver gave none): a
 * refused or withdrawn decision also settles the loop's watch, but it approved nothing.
 */
export function recordSettledDecision(memory: ProjectMemory, watch: { work: string; action: string; decision: string }, judged: { state: string; approvedBy: string | null; approvedAt?: string | null; approvalReason?: string | null; reason?: string } | null | undefined, at: string): boolean {
  if (!judged || judged.state !== 'applied') return false;
  const reason = (judged.approvalReason || judged.reason || '').trim();
  if (!reason) return false;
  return recordDecisionInMemory(memory, { id: watch.decision, key: watch.work, action: watch.action, reason, state: 'applied', approvedBy: judged.approvedBy, at: judged.approvedAt ?? at });
}

/** Update project memory from settled operator answers and merges in work. Never from an agent's claim. */
export function updateProjectMemoryFromWork(memory: ProjectMemory, work: readonly Work[], now: number = Date.now()): ProjectMemory {
  // 1. Settled operator answers: an answered request moves to `humanRequests` and the open one is
  // cleared, so the retained history is where a provided answer lives. A declined one decided nothing.
  // GY-1125 follow-up 1/4 (declined): settled snapshot items are summaries without humanRequests/
  // researchBrief (summaryOmitted, src/store/summary-sql.ts); answers enter memory while their item is
  // open and persist in .graphyard/project-memory.json, so whole settled documents are not re-read.
  // Follow-up 2: candidates are retained newest-first by answer time, not work-item order.
  const candidateDecisions: { id: string; key: string; action: string; reason: string; state: string; approvedBy: string; at: string }[] = [];
  for (const item of work) {
    for (const request of item.humanRequests ?? []) {
      if (request.answer?.outcome !== 'provided') continue;
      candidateDecisions.push({ id: request.id, key: item.key, action: request.kind, reason: `${request.needed}: ${request.answer.text}`, state: 'provided', approvedBy: request.answer.by || 'operator', at: request.answer.at });
    }
    // Answered research product decisions
    for (const q of item.researchBrief?.questions ?? []) {
      if (q.answer) candidateDecisions.push({ id: q.id, key: item.key, action: 'product-decision', reason: `${q.question}: ${q.answer.text}`, state: 'provided', approvedBy: q.answer.by || 'operator', at: q.answer.at });
    }
  }
  candidateDecisions.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  for (const candidate of candidateDecisions) {
    recordDecisionInMemory(memory, candidate);
  }

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

  // Filter and prioritize decisions: role-relevant first, then newest
  const decisions = [...memory.decisions].sort((a, b) => {
    const aRel = isDecisionRoleRelevant(a, role) ? 1 : 0;
    const bRel = isDecisionRoleRelevant(b, role) ? 1 : 0;
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

  if (!decisions.length && !changes.length) return '';

  const parts: string[] = ['Shared project memory:'];

  // Add decisions
  if (decisions.length) {
    const decisionLines: string[] = [];
    for (const d of decisions) {
      const line = `- ${d.key} (${d.action}): ${d.reason} [approved by ${d.approvedBy}]`;
      const candidate = [...parts, 'Recent decisions:', ...decisionLines, line].join(' ');
      if (docsWords(candidate) <= budget) {
        decisionLines.push(line);
        continue;
      }
      // If oversized, include an abbreviated decision if budget allows (GY-1125 follow-up finding 3):
      const prefix = `- ${d.key} (${d.action}): `;
      const suffix = ` [approved by ${d.approvedBy}]`;
      const abbrBase = [...parts, 'Recent decisions:', ...decisionLines, `${prefix}…${suffix}`].join(' ');
      const baseWords = docsWords(abbrBase);
      if (baseWords <= budget) {
        const wordsAvailable = budget - baseWords;
        const reasonWords = d.reason.split(/\s+/).filter(Boolean);
        // The ellipsis joins the last kept word, so the abbreviated line takes `count - 1` words
        // beyond the base: the slice is computed once rather than re-counted per dropped word (GY-1180).
        if (decisionLines.length === 0 || wordsAvailable >= 5)
          decisionLines.push(`${prefix}${reasonWords.slice(0, Math.min(reasonWords.length, wordsAvailable + 1)).join(' ')}…${suffix}`);
      }
      // GY-1125 follow-up finding 5: continue to allow later shorter decisions to be considered
    }
    if (decisionLines.length) parts.push('Recent decisions:', decisionLines.join(' '));
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
