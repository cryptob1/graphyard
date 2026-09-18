import type { ReactNode } from 'react';
import { candidateCommitUrl, candidatePrUrl } from './links';

/** External GitHub destinations open in a new, sandboxed-safe tab. */
const external = { target: '_blank', rel: 'noopener noreferrer' } as const;

export function CandidatePr({ repository, candidate, workKey }: { repository: unknown; candidate: { pr: number }; workKey?: string }) {
  const pr = candidate?.pr;
  // The accessible name starts with the visible text so voice control can act on what it reads.
  const label = `PR #${pr}, open pull request${workKey ? ` for ${workKey}` : ''} in GitHub`;
  const href = candidatePrUrl(repository, pr);
  const text: ReactNode = `PR #${pr}`;
  return href ? <a className="candidate-link" href={href} aria-label={label} onClick={event => event.stopPropagation()} {...external}>{text}</a> : <span>{text}</span>;
}

export function CandidateSha({ repository, sha }: { repository: unknown; sha: unknown }) {
  const short = String(sha).slice(0, 12);
  const href = candidateCommitUrl(repository, sha);
  return href ? <a className="candidate-link" href={href} aria-label={`Open commit ${short} in GitHub`} {...external}><code>{short}</code></a> : <code>{short}</code>;
}
