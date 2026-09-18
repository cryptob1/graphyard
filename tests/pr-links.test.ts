import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateCommitUrl, candidatePrUrl, githubRepositoryBase } from '../web/links.js';

const repo = 'fixture/repository';
const sha = 'abcdef1234567890abcdef1234567890abcdef12';

test('links derive only from the configured repository and validated values', () => {
  assert.equal(githubRepositoryBase(repo), 'https://github.com/fixture/repository');
  assert.equal(githubRepositoryBase(' fixture/repository '), 'https://github.com/fixture/repository');
  assert.equal(candidatePrUrl(repo, 41), 'https://github.com/fixture/repository/pull/41');
  assert.equal(candidateCommitUrl(repo, sha), `https://github.com/fixture/repository/commit/${sha}`);
  assert.equal(candidateCommitUrl(repo, sha.toUpperCase()), `https://github.com/fixture/repository/commit/${sha}`);
});

test('unconfigured or malformed repository identity never produces a link', () => {
  for (const repository of [null, undefined, '', '   ', 'fixtureonly', '/leading', 'trailing/', 'a/b/c', '.', '..', 'a/../b', 'fixture repo', 'fixture/repository?x=1', 'fixture/repo#frag', 'fixture/repo/slash', '-owner/repo', 'owner-/repo', 'ownér/repo', 'fixture/../../evil', 'https://evil.example/fixture/repository', 'fixture/repository@evil.example', 'fixture\\repository', '//evil.example', 'fixture/repository\nevil', 42, {}]) {
    assert.equal(githubRepositoryBase(repository), null, JSON.stringify(repository));
    assert.equal(candidatePrUrl(repository, 1), null, JSON.stringify(repository));
    assert.equal(candidateCommitUrl(repository, sha), null, JSON.stringify(repository));
  }
});

test('candidate PR and SHA values are validated before any URL is built', () => {
  const short = sha.slice(0, 12);
  for (const pr of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', '', null, undefined, {}]) assert.equal(candidatePrUrl(repo, pr), null, JSON.stringify(pr));
  for (const badSha of [short, '', 'zzzz', `${sha}0`, ` ${sha}`, `${sha};`, 'javascript:alert(1)', 'https://evil.example/commit', '../../etc/passwd', `${sha}?x=1`, `${sha}#f`, 123, null, undefined]) assert.equal(candidateCommitUrl(repo, badSha), null, JSON.stringify(badSha));
});

test('unconfigured repositories fall back to text for legacy candidate data', () => {
  assert.equal(candidatePrUrl(null, 1), null);
  assert.equal(candidateCommitUrl(null, sha.slice(0, 12)), null);
});
