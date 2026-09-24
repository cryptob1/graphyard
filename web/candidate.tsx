import { candidateCommitUrl, candidatePrUrl } from './links';
import Term from './components/term';

/** External GitHub destinations open in a new, sandboxed-safe tab. */
const external = { target: '_blank', rel: 'noopener noreferrer' } as const;

/**
 * The GitHub references on a card and in the item view. The linked form carries the shared
 * glossary's definition on the abbreviation itself — "PR", and the commit's long name — without
 * a keyboard stop of its own, because the link around it is already one. With no repository
 * configured there is nothing to link to and nothing to abbreviate: the bare value is shown as
 * it is, and the item view names and defines both words in the label beside it.
 */
export function CandidatePr({ repository, candidate, workKey }: { repository: unknown; candidate: { pr: number }; workKey?: string }) {
  const pr = candidate?.pr;
  // The accessible name starts with the visible text so voice control can act on what it reads.
  const label = `PR #${pr}, open pull request${workKey ? ` for ${workKey}` : ''} in GitHub`;
  const href = candidatePrUrl(repository, pr);
  return href
    ? <a className="candidate-link" href={href} aria-label={label} onClick={event => event.stopPropagation()} {...external}><Term term="pull request" focusable={false}>PR</Term> #{pr}</a>
    : <span>PR #{pr}</span>;
}

/** How many characters of a commit SHA the dashboard shows (the operator's review of PR #156). */
export const shaChars = 8;
/**
 * A commit SHA as the dashboard shows it: its first eight characters on screen (the element is
 * clipped to `shaChars` monospace characters in web/style.css), and the whole SHA still its text,
 * title and link, so selecting or copying it gives the exact commit. Anything that is not a commit
 * SHA is shown as it is.
 */
export function ShortSha({ sha }: { sha: string }) {
  if (!/^[0-9a-f]{9,64}$/i.test(sha)) return <code>{sha}</code>;
  return <code className="sha" title={sha}>{sha}</code>;
}

export function CandidateSha({ repository, sha, workKey }: { repository: unknown; sha: unknown; workKey?: string }) {
  // Eight characters on screen; the exact commit the gates decided on is what a reader selects,
  // copies and follows (ShortSha keeps the rest of it in the text).
  const text = String(sha);
  const label = `${text}, open commit${workKey ? ` for ${workKey}` : ''} in GitHub`;
  const href = candidateCommitUrl(repository, sha);
  return href
    ? <a className="candidate-link" href={href} aria-label={label} onClick={event => event.stopPropagation()} {...external}><Term term="commit" focusable={false}><ShortSha sha={text}/></Term></a>
    : <ShortSha sha={text}/>;
}
