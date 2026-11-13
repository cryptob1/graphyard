import type { Work } from './model.js';
import { evaluateLandability } from './model-boundary/landability.js';
import { exactApproval } from './model/review.js';
import { carriedApproval, currentCarry } from './model/carry.js';
import { riskOf } from './model-boundary/risk-class.js';
import { postDeployProof } from './model/post-merge-proofs.js';

/** Read the saved admission facts, never the cached gate verdicts or later attestations. */
export function auditAdmission(work: Work, at: string, all: Work[] = [work]) {
  const verdict = evaluateLandability(work, all, new Date(at));
  const missingProofs = verdict.verdict === 'refused' ? verdict.reasons.filter(r => r.gate === 'acceptance').map(r => r.reason) : [];
  const approval = exactApproval(work) ?? carriedApproval(work);
  const missingReview = riskOf(work).risk === 'sensitive' && !approval;
  const displayOnly = !!approval && !work.reviewVerdicts?.verdicts.length;
  return { key: work.key, head: work.candidate?.sha ?? null, base: work.candidate?.baseSha ?? null, policyRevision: work.policyRevision,
    classification: missingProofs.length || missingReview ? 'missing-admission-evidence' : displayOnly ? 'display-only' : 'satisfied',
    missingProofs, missingReview, approval, carry: carriedApproval(work) ? currentCarry(work) : null,
    deferred: work.criteria.flatMap(c => c.proofs.filter(postDeployProof)), remediation: [] as string[] };
}

export interface AuditInstall { name: string; url: string; read?: (path: string) => Promise<any>; unavailable?: string }
/** Existing item/history reads only. No mutation or credential discovery is part of an audit. */
export async function auditInstalls(installs: AuditInstall[]) {
  const coverage = [];
  for (const install of installs) {
    const report = { install: install.name, url: install.url, enumerated: 0, audited: 0,
      findings: [] as ReturnType<typeof auditAdmission>[], externalBlockers: [] as string[],
      requiredItems: /hwd/i.test(install.name) ? ['GY-3', 'GY-4'] : [] };
    coverage.push(report);
    if (!install.read) { report.externalBlockers.push(install.unavailable ?? 'No permitted agent credential is configured'); continue; }
    try {
      const snapshot = await install.read('work-snapshot');
      const merged = (snapshot.work as Work[]).filter(w => w.delivery || w.observation?.merged);
      report.enumerated = merged.length;
      for (const key of report.requiredItems) if (!merged.some(w => w.key === key)) report.externalBlockers.push(`${key}: not present among enumerable merged items`);
      for (const item of merged) {
        try {
          const work: Work = await install.read(`work/${encodeURIComponent(item.id)}`);
          const params = new URLSearchParams({ work: work.id, kind: 'merge-writer.pushed', view: 'page', payload: 'full', order: 'desc', limit: '100' });
          let saved: { payload: { work: Work }; created_at: string } | undefined;
          for (;;) {
            const page = await install.read(`events?${params}`);
            saved = page.events.find((e: any) => e.payload?.work?.mergeLedger?.mergeSha === work.delivery?.mergeSha);
            if (saved || !page.page.nextCursor) break;
            params.set('cursor', page.page.nextCursor);
          }
          if (!saved) { report.externalBlockers.push(`${work.key}: admission snapshot unavailable; current display cannot establish historical safety`); continue; }
          report.findings.push(auditAdmission(saved.payload.work, saved.created_at, snapshot.work));
          report.audited++;
        } catch { report.externalBlockers.push(`${item.key}: item or admission history could not be read`); }
      }
    } catch { report.externalBlockers.push('Install unavailable or identity cannot enumerate work'); }
  }
  return { coverage, limitations: ['Risk is evaluated with the audit process repository policy; historical repository policy changes require separate inspection.',
    'Admission snapshots are evaluated at their recorded time. Missing history is a coverage gap, never a clean finding.',
    'Read-only: remediation keys must be filed separately; this audit never changes delivered history.'] };
}
