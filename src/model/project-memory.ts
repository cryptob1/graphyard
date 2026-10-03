import { z } from 'zod';
import { docsWords } from './documentation.js';
import { faultClasses, type FaultClass } from './fault-classes.js';
import type { Work } from './work.js';

export const retainedMemoryDecisions = 20;
export const retainedMemoryPitfalls = 20;
export const retainedMemoryChanges = 30;
export const recentChangesWindowMs = 24 * 3_600_000;
export const projectMemoryWordBudget = 500;

export const sanctionedRemedies: Record<string, string> = {
  'scope': 'Request scope widening before editing files outside plannedFiles (graphyard request-scope); never edit unapproved files or rebase.',
  'configuration': 'Worker tokens cannot edit .github/workflows; do not touch workflow files or request changes to them.',
  'merge': 'Do not guess at blocked merges or force-push; use graphyard sync GY-N --restore to reconcile cleanly with base.',
  'session-liveness': 'Avoid commands triggering interactive prompts (no unresolvable rm/mv globs); keep work within lease time.',
  'proof': 'Ensure test titles start with the exact proof name; verify with graphyard verify GY-N before completing.',
  'review-convergence': 'Address review findings directly with code commits or explanations; do not dismiss reviews manually.',
  'decision': 'Two-party decisions require independent approver review; cite context and precedent, never self-approve.',
  'capacity': 'Wait for provider quota reset or switch profiles; do not retry exhausted accounts in a loop.',
  'human-decision': 'Park with graphyard park GY-N EPOCH KIND NEEDED -- REASON when human-only goals, money or credentials are required.',
  'resources': 'Clean up unneeded temporary files under managed root; do not exceed disk and ledger bounds.',
  'containment': 'Ensure previous session processes are stopped and containment fences settled before proceeding.',
  'deployment': 'Verify deployed commits match release expectations; follow rollback guidance on smoke failure.',
  'overlap-hold': 'Wait for overlapping work items to complete or adjust plannedFiles to eliminate overlap.',
  'observation': 'Wait for GitHub observation updates; do not proceed on stale PR status readings.',
  'loop': 'Ensure master daemon is running and cycling within interval; restart if stuck.',
  'stalled-gate': 'Check gate failure reasons and address the blocking requirement instead of waiting.',
  'unclassified': 'Investigate attention line and classify shared cause in fault catalogue.',
};

export const memoryDecisionSchema = z.object({
  id: z.string(),
  key: z.string(),
  action: z.string(),
  reason: z.string(),
  approvedBy: z.string(),
  at: z.string(),
}).strict();
export type MemoryDecision = z.infer<typeof memoryDecisionSchema>;

export const memoryPitfallSchema = z.object({
  faultClass: z.string(),
  count: z.number().int().nonnegative(),
  remedy: z.string(),
  at: z.string(),
}).strict();
export type MemoryPitfall = z.infer<typeof memoryPitfallSchema>;

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
  pitfalls: z.array(memoryPitfallSchema).max(100).default([]),
  changes: z.array(memoryChangeSchema).max(100).default([]),
}).strict();
export type ProjectMemory = z.infer<typeof projectMemorySchema>;

export function emptyProjectMemory(now: string = new Date().toISOString()): ProjectMemory {
  return {
    version: 1,
    updatedAt: now,
    decisions: [],
    pitfalls: [],
    changes: [],
  };
}

export type SessionRole = 'worker' | 'reviewer' | 'producer';

/** Role relevance for decisions: prioritizing actions each role acts on or requires. */
export function isDecisionRoleRelevant(decision: MemoryDecision, role: SessionRole): boolean {
  const action = decision.action.toLowerCase();
  if (role === 'worker') {
    return ['requirements', 'scope', 'rework', 'unblock', 'close', 'human-answer', 'goals-and-priorities', 'money-or-accounts', 'credentials-for-people'].includes(action);
  }
  if (role === 'reviewer') {
    return ['review', 'merge', 'requirements', 'close', 'rework'].includes(action);
  }
  if (role === 'producer') {
    return ['attest', 'requirements', 'rework'].includes(action);
  }
  return true;
}

/** Role relevance for recurring pitfalls: prioritizing fault classes each role commonly encounters. */
export function isPitfallRoleRelevant(pitfall: MemoryPitfall, role: SessionRole): boolean {
  const cls = pitfall.faultClass;
  if (role === 'worker') {
    return ['scope', 'configuration', 'session-liveness', 'merge', 'human-decision'].includes(cls);
  }
  if (role === 'reviewer') {
    return ['review-convergence', 'merge', 'decision', 'scope'].includes(cls);
  }
  if (role === 'producer') {
    return ['proof', 'configuration', 'session-liveness'].includes(cls);
  }
  return true;
}

/** Record an approved/settled decision in project memory. Never updates from an agent's unreviewed claim. */
export function recordDecisionInMemory(memory: ProjectMemory, decision: {
  id: string;
  key: string;
  action: string;
  reason: string;
  state: string;
  approvedBy?: string | null;
  at: string;
}): boolean {
  // Only settled / applied / approved decisions and operator answers, never unreviewed agent claims.
  if (decision.state !== 'applied' && decision.state !== 'approved' && decision.state !== 'provided') {
    return false;
  }
  if (!decision.approvedBy) {
    return false;
  }
  const entry: MemoryDecision = {
    id: decision.id,
    key: decision.key,
    action: decision.action,
    reason: decision.reason.trim(),
    approvedBy: decision.approvedBy,
    at: decision.at,
  };
  const filtered = memory.decisions.filter(d => d.id !== entry.id);
  memory.decisions = [entry, ...filtered].slice(0, retainedMemoryDecisions);
  memory.updatedAt = entry.at;
  return true;
}

/** Record a recurring fault class pitfall with its sanctioned remedy in project memory. */
export function recordPitfallInMemory(memory: ProjectMemory, pitfall: {
  faultClass: string;
  count: number;
  remedy?: string;
  at: string;
}): boolean {
  const remedy = pitfall.remedy || sanctionedRemedies[pitfall.faultClass] || `Address root cause of ${pitfall.faultClass} fault.`;
  const entry: MemoryPitfall = {
    faultClass: pitfall.faultClass,
    count: pitfall.count,
    remedy,
    at: pitfall.at,
  };
  const filtered = memory.pitfalls.filter(p => p.faultClass !== entry.faultClass);
  memory.pitfalls = [entry, ...filtered]
    .sort((a, b) => b.count - a.count || Date.parse(b.at) - Date.parse(a.at))
    .slice(0, retainedMemoryPitfalls);
  memory.updatedAt = entry.at;
  return true;
}

/** Record a verified merge in project memory. */
export function recordChangeInMemory(memory: ProjectMemory, change: {
  key: string;
  sha: string;
  baseSha?: string | null;
  files: string[];
  mergedAt: string;
}): boolean {
  if (!change.sha || !change.key) return false;
  const entry: MemoryChange = {
    key: change.key,
    sha: change.sha,
    baseSha: change.baseSha ?? null,
    files: [...new Set(change.files)],
    mergedAt: change.mergedAt,
  };
  const filtered = memory.changes.filter(c => c.sha !== entry.sha && c.key !== entry.key);
  memory.changes = [entry, ...filtered]
    .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt))
    .slice(0, retainedMemoryChanges);
  memory.updatedAt = entry.mergedAt;
  return true;
}

/** Update project memory from settled decisions, recurring fault classes, and merges in work. Never from an agent's claim. */
export function updateProjectMemoryFromWork(memory: ProjectMemory, work: readonly Work[], now: number = Date.now()): ProjectMemory {
  // 1. Settled operator answers from human requests
  for (const item of work) {
    if (item.humanRequest?.answer?.outcome === 'provided') {
      recordDecisionInMemory(memory, {
        id: item.humanRequest.id,
        key: item.key,
        action: item.humanRequest.kind,
        reason: `${item.humanRequest.needed}: ${item.humanRequest.answer.text}`,
        state: 'provided',
        approvedBy: item.humanRequest.answer.by || 'operator',
        at: item.humanRequest.answer.at,
      });
    }
    // Answered research product decisions
    if (item.researchBrief?.questions?.length) {
      for (const q of item.researchBrief.questions) {
        if (q.answer) {
          recordDecisionInMemory(memory, {
            id: q.id,
            key: item.key,
            action: 'product-decision',
            reason: `${q.question}: ${q.answer.text}`,
            state: 'provided',
            approvedBy: q.answer.by || 'operator',
            at: q.answer.at,
          });
        }
      }
    }
  }

  // 2. Merges to main in the last 24 hours
  const recentCutoff = now - recentChangesWindowMs;
  for (const item of work) {
    if (item.stage === 'done' && (item.delivery || item.observation?.merged)) {
      const mergedAt = item.delivery?.mergedAt ?? item.observation?.mergedAt;
      const mergeSha = item.delivery?.mergeSha ?? item.observation?.mergeSha;
      if (mergedAt && mergeSha && Date.parse(mergedAt) >= recentCutoff) {
        const files = item.observation?.files ?? item.plannedFiles ?? [];
        recordChangeInMemory(memory, {
          key: item.key,
          sha: mergeSha,
          baseSha: item.candidate?.baseSha ?? null,
          files,
          mergedAt,
        });
      }
    }
  }

  return memory;
}

const short = (sha: string) => sha ? sha.slice(0, 10) : '';

/**
 * Format a role-relevant digest of project memory within a fixed word budget, newest and most relevant first.
 */
export function projectMemoryDigest(
  memory: ProjectMemory | null | undefined,
  role: SessionRole,
  options?: { baseSha?: string; wordBudget?: number }
): string {
  if (!memory) return '';
  const budget = options?.wordBudget ?? projectMemoryWordBudget;

  // Filter and prioritize decisions: role-relevant first, then newest
  const decisions = [...memory.decisions].sort((a, b) => {
    const aRel = isDecisionRoleRelevant(a, role) ? 1 : 0;
    const bRel = isDecisionRoleRelevant(b, role) ? 1 : 0;
    if (aRel !== bRel) return bRel - aRel;
    return Date.parse(b.at) - Date.parse(a.at);
  });

  // Filter and prioritize pitfalls: role-relevant first, then highest count
  const pitfalls = [...memory.pitfalls].sort((a, b) => {
    const aRel = isPitfallRoleRelevant(a, role) ? 1 : 0;
    const bRel = isPitfallRoleRelevant(b, role) ? 1 : 0;
    if (aRel !== bRel) return bRel - aRel;
    return b.count - a.count || Date.parse(b.at) - Date.parse(a.at);
  });

  // Filter changes: if baseSha provided, those since session base (or all recent in window)
  const baseSha = options?.baseSha;
  let changes = [...memory.changes];
  if (baseSha) {
    changes = changes.filter(c => c.sha !== baseSha);
  }
  changes.sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));

  if (!decisions.length && !pitfalls.length && !changes.length) return '';

  const parts: string[] = ['Shared project memory:'];

  // Add decisions
  if (decisions.length) {
    const decisionLines: string[] = [];
    for (const d of decisions) {
      const line = `- ${d.key} (${d.action}): ${d.reason} [approved by ${d.approvedBy}]`;
      const candidate = [...parts, 'Recent decisions:', ...decisionLines, line].join(' ');
      if (docsWords(candidate) > budget) break;
      decisionLines.push(line);
    }
    if (decisionLines.length) {
      parts.push('Recent decisions:', decisionLines.join(' '));
    }
  }

  // Add pitfalls with sanctioned remedies
  if (pitfalls.length) {
    const pitfallLines: string[] = [];
    for (const p of pitfalls) {
      const line = `- ${p.faultClass} (${p.count} recurrence${p.count === 1 ? '' : 's'}): ${p.remedy}`;
      const candidate = [...parts, 'Recurring pitfalls and remedies:', ...pitfallLines, line].join(' ');
      if (docsWords(candidate) > budget) break;
      pitfallLines.push(line);
    }
    if (pitfallLines.length) {
      parts.push('Recurring pitfalls and remedies:', pitfallLines.join(' '));
    }
  }

  // Add merges since base
  if (changes.length) {
    const changeLines: string[] = [];
    const baseLabel = baseSha ? `since base ${short(baseSha)}` : 'in last 24h';
    for (const c of changes) {
      const fileList = c.files.length ? c.files.slice(0, 10).join(', ') + (c.files.length > 10 ? '…' : '') : 'none';
      const line = `- ${c.key} (${short(c.sha)}): ${fileList}`;
      const candidate = [...parts, `Recent merges to main ${baseLabel}:`, ...changeLines, line].join(' ');
      if (docsWords(candidate) > budget) break;
      changeLines.push(line);
    }
    if (changeLines.length) {
      parts.push(`Recent merges to main ${baseLabel}:`, changeLines.join(' '));
    }
  }

  const result = parts.join(' ').trim();
  return result ? `${result} ` : '';
}
