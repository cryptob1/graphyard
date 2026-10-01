import type { FaultClass } from './fault-classes.js';
import type { RetroCheckRule, RetroDraft, RetroPattern } from './retro-synthesis.js';

// ---------------------------------------------------------------------------
// Retro prevention drafting (GY-970): what a recurring cause calls for. The synthesis
// (./retro-synthesis.ts) detects the cause; this turns it into drafted artefacts — a standards or
// criteria wording update, a mechanical check, a producer-method correction and a fault-catalogue
// entry — none of which is applied until an independent approval applies it.
// ---------------------------------------------------------------------------

/** The fault class a recurring cause is filed under in the catalogue. */
function faultClassOfCause(pattern: Pick<RetroPattern, 'gate' | 'shape' | 'cause'>): FaultClass {
  if (pattern.cause.startsWith('trigger/') && /scope/.test(pattern.cause)) return 'scope';
  if (pattern.shape && /scope|landing|carried/.test(pattern.shape)) return 'scope';
  switch (pattern.gate) {
    case 'review': return 'review-convergence';
    case 'acceptance': return 'proof';
    case 'merge': return 'merge';
    case 'test': return 'stalled-gate';
    case 'ready': return 'decision';
    case 'build': return pattern.shape === 'mechanical-proof-failed' ? 'proof' : 'stalled-gate';
    default: return 'unclassified';
  }
}

/**
 * The artefacts that would prevent a recurring cause, drafted from what the cause is. Each
 * recurring cause gets the prevention its shape calls for and, always, a catalogue entry so later
 * instances are recognised as this cause rather than read afresh. Nothing here is applied.
 */
export function draftPrevention(pattern: RetroPattern): RetroDraft[] {
  const evidence = `${pattern.count} instances of ${pattern.label} in ${pattern.window.days} days (threshold ${pattern.threshold}): ${pattern.instances.slice(0, 5).map(instance => `${instance.work ?? 'no item'} (${instance.id})`).join(', ')}${pattern.instances.length > 5 ? ', …' : ''}.`
    + (pattern.recurredAfter.length ? ` It recurred after ${pattern.recurredAfter.join(', ')} was applied, so the earlier prevention did not hold.` : '');
  const sample = pattern.instances[0]?.reason ?? '';
  const slug = pattern.cause.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 80);
  const drafts: RetroDraft[] = [];
  const standards = (target: 'coding-standards' | 'criteria-wording', text: string) => drafts.push({ kind: 'standards-update', registry: 'requirements', target, title: `${target === 'criteria-wording' ? 'Criteria wording' : 'Coding standard'}: prevent ${pattern.label}`.slice(0, 200), proposal: `${text} ${evidence}`.slice(0, 4000) });
  // A check id names the cause and the instances it was drafted from, so a redraft after a recurrence registers a distinct check.
  const check = (rule: RetroCheckRule, verifies: string) => drafts.push({ kind: 'mechanical-check', registry: 'checks', target: 'checks', title: `Check before submit: ${pattern.label}`.slice(0, 200), proposal: `Register a mechanical check that ${verifies}, run against every submission's observed candidate, so the refusal is met by the worker at submission instead of by the gate. ${evidence}`.slice(0, 4000), check: { id: `retro-${slug.slice(0, 100)}-${pattern.fingerprint.slice(0, 8)}`, rule, verifies: verifies.slice(0, 1000) } });
  const method = (text: string) => drafts.push({ kind: 'producer-method', registry: 'requirements', target: 'producer-method', title: `Producer method: prevent ${pattern.label}`.slice(0, 200), proposal: `${text} ${evidence}`.slice(0, 4000) });
  const shape = pattern.shape ?? '';
  if (pattern.cause.startsWith('trigger/') || /out-of-scope|landing|carried/.test(shape)) {
    standards('criteria-wording', 'Word each criterion so the files it implies are named in plannedFiles, and state in the criteria when a test, doc or registry file outside the obvious module must change.');
    check('planned-files', 'compares the candidate diff with plannedFiles and the documentation paths and names every path outside them');
  } else if (shape === 'base-conflict' || shape === 'not-mergeable' || shape === 'ejected') {
    standards('coding-standards', 'Bring the branch onto the current base with graphyard sync immediately before complete, and resolve conflicts keeping both sides of every edit that belongs to another item.');
    check('merges-onto-base', 'confirms the head merges cleanly onto the current base tip');
  } else if (shape === 'mechanical-proof-failed' || shape === 'check-not-passed') {
    standards('coding-standards', 'Run the required CI checks and every test file an item\'s unit or integration proofs name, on the final head, before complete.');
    check('checks-passed', 'confirms no check reported on the head has failed');
  } else if (pattern.gate === 'acceptance') {
    method('Producers exercise the criterion against the exact candidate head and base, report executed and skipped cases honestly, and name the probe that would fail if the behaviour were absent.');
  } else if (pattern.gate === 'review' || pattern.family === 'rework') {
    standards('coding-standards', `Address this recurring review finding before submitting: “${sample.slice(0, 600)}”.`);
  }
  // A cause the catalogue already recognises is counted against its entry; it is not catalogued twice.
  if (pattern.catalogued) return drafts;
  const faultClass = faultClassOfCause(pattern);
  drafts.push({ kind: 'fault-catalogue-entry', registry: 'catalogue', target: 'fault-catalogue', title: `Catalogue ${pattern.label} as a ${faultClass} fault`.slice(0, 200),
    proposal: `Add a fault-catalogue entry that recognises ${pattern.label} (cause ${pattern.cause}) and files later instances under ${faultClass}, so they are counted against this pattern rather than diagnosed afresh. ${evidence}`.slice(0, 4000),
    entry: { id: `retro-${slug}`.slice(0, 120), cause: pattern.cause, faultClass, meaning: `${pattern.label}${sample ? `, e.g. “${sample.slice(0, 300)}”` : ''}`.slice(0, 1000) } });
  return drafts;
}
