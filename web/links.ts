/**
 * Candidate links are built only from the trusted configured repository identity
 * plus a validated numeric PR number or full hexadecimal SHA. Candidate-authored
 * values can never select or alter the destination; anything that fails
 * validation renders as plain text instead of a link.
 */
const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const repositoryPattern = /^[A-Za-z0-9._-]{1,100}$/;
const shaPattern = /^[0-9a-fA-F]{40}$/;

export function githubRepositoryBase(repository: unknown): string | null {
  if (typeof repository !== 'string') return null;
  const value = repository.trim();
  const separator = value.indexOf('/');
  if (separator <= 0 || separator !== value.lastIndexOf('/')) return null;
  const owner = value.slice(0, separator);
  const name = value.slice(separator + 1);
  if (!ownerPattern.test(owner) || !repositoryPattern.test(name) || name === '.' || name === '..') return null;
  return `https://github.com/${owner}/${name}`;
}

export function candidatePrUrl(repository: unknown, pr: unknown): string | null {
  const base = githubRepositoryBase(repository);
  if (!base || typeof pr !== 'number' || !Number.isSafeInteger(pr) || pr < 1) return null;
  return `${base}/pull/${pr}`;
}

export function candidateCommitUrl(repository: unknown, sha: unknown): string | null {
  const base = githubRepositoryBase(repository);
  if (!base || typeof sha !== 'string' || !shaPattern.test(sha)) return null;
  return `${base}/commit/${sha.toLowerCase()}`;
}
