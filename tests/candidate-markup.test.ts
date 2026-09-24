import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CandidatePr, CandidateSha } from '../web/candidate.js';

const repository = 'fixture/repository';
const sha = 'abcdef1234567890abcdef1234567890abcdef12';

test('the candidate SHA shows eight characters, and the whole SHA stays in its text, title, label and link', () => {
  const markup = renderToStaticMarkup(createElement(CandidateSha, { repository, sha, workKey: 'GY-7' }));
  // Eight characters on screen (GY-161, AC-10: the element is clipped to 8ch); the whole SHA is its text, so a selection copies the exact commit.
  assert.match(markup, new RegExp(`<code class="sha" title="${sha}">${sha}</code>`));
  assert.match(markup, new RegExp(`aria-label="${sha}, open commit for GY-7 in GitHub"`));
  assert.match(markup, new RegExp(`href="https://github.com/fixture/repository/commit/${sha}"`));
});

test('an unlinkable candidate still carries the whole value', () => {
  assert.equal(renderToStaticMarkup(createElement(CandidateSha, { repository: null, sha })), `<code class="sha" title="${sha}">${sha}</code>`);
  for (const value of [sha.slice(0, 8), 'not-a-sha']) assert.equal(renderToStaticMarkup(createElement(CandidateSha, { repository, sha: value })), `<code>${value}</code>`);
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
