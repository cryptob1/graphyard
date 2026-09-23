import { agentOwner, humanOwner, type AttentionItem } from '../master.js';
import { consentHoldAttention, readConsentHolds } from '../consent-prompt.js';
import type { Work } from '../model.js';

/**
 * One attention item per worker session the launcher left awaiting consent (GY-130) whose epoch
 * still holds the lease: the item, the pane, the prompt and the attach command. A credential or
 * payment prompt is the human's; any other prompt outside the allow-list is the master's to answer.
 */
export function consentHoldItems(checkouts: string[], snapshot: { work: Work[]; now: string }): AttentionItem[] {
  return checkouts.flatMap(checkout => readConsentHolds(checkout)).flatMap(hold => {
    const work = snapshot.work.find(item => item.key === hold.key);
    if (!work?.lease || work.lease.epoch !== hold.epoch || Date.parse(work.lease.expiresAt) <= Date.parse(snapshot.now)) return [];
    const text = consentHoldAttention(hold), next = `${hold.attach}, then answer the prompt`;
    return [{ subject: hold.key, text, ...(hold.kind === 'payment' ? humanOwner('spending money or opening third-party accounts', next) : hold.kind === 'credential' ? humanOwner('issuing credentials to people', next) : agentOwner('master', next)) }];
  });
}
