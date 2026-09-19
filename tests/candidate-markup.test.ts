import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CandidatePr, CandidateSha } from '../web/candidate.js';

const repository = 'fixture/repository';
const sha = 'abcdef1234567890abcdef1234567890abcdef12';

test('the candidate SHA is displayed in full, not abbreviated', () => {
  const markup = renderToStaticMarkup(createElement(CandidateSha, { repository, sha, workKey: 'GY-7' }));
  assert.match(markup, new RegExp(`<code>${sha}</code>`));
  assert.match(markup, new RegExp(`aria-label="${sha}, open commit for GY-7 in GitHub"`));
  assert.match(markup, new RegExp(`href="https://github.com/fixture/repository/commit/${sha}"`));
  // No abbreviation may stand in for the displayed value.
  assert.equal(markup.includes(`<code>${sha.slice(0, 12)}</code>`), false);
});

test('an unlinkable candidate still shows the whole value as plain text', () => {
  for (const [repo, value] of [[null, sha], [repository, sha.slice(0, 12)], [repository, 'not-a-sha']] as const) {
    const markup = renderToStaticMarkup(createElement(CandidateSha, { repository: repo, sha: value }));
    assert.equal(markup, `<code>${value}</code>`);
  }
  assert.equal(renderToStaticMarkup(createElement(CandidatePr, { repository: null, candidate: { pr: 7 } })), '<span>PR #7</span>');
});

test('candidate references are leaf links that never nest another interactive element', () => {
  for (const element of [createElement(CandidatePr, { repository, candidate: { pr: 7 }, workKey: 'GY-7' }), createElement(CandidateSha, { repository, sha, workKey: 'GY-7' })]) {
    const markup = renderToStaticMarkup(element);
    assert.equal(markup.match(/<a\b/g)?.length, 1);
    for (const nested of ['<button', 'role="button"', 'tabindex', '<a href="#']) assert.equal(markup.includes(nested), false, `${nested} in ${markup}`);
    assert.match(markup, /rel="noopener noreferrer"/);
    assert.match(markup, /target="_blank"/);
  }
});
