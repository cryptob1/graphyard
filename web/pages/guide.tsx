import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import Term from '../components/term';

const source = 'https://github.com/cryptob1/graphyard/blob/main/';
/** The README without its GIF link: the page plays the video itself. Relative links open on GitHub. */
const readmeLink = (href?: string) => !href || /^(https?:|#|\/)/.test(href) ? href : source + href;

/**
 * "How Graphyard works" in under 300 words, opened from Help at the foot of the sidebar. It uses
 * the dashboard's own words — the five groups and the six pull-request steps — and nothing else.
 * The walkthrough video and the README follow, loaded once the page is open.
 */
export default function GuidePage() {
  const [media, setMedia] = useState<{ video: string; readme: string } | null>(null);
  useEffect(() => {
    Promise.all([import('../../docs/diagrams/how-graphyard-works.mp4?url'), import('../../README.md?raw')])
      .then(([video, readme]) => setMedia({ video: video.default, readme: readme.default.split('\n').filter(line => !line.includes('how-graphyard-works.gif')).join('\n') }));
  }, []);
  return <article className="guide">
    <div className="page-heading"><h1>How Graphyard works</h1></div>
    {media && <video className="guide-video" src={media.video} controls preload="metadata"/>}
    <p>AI agents build software work here, and nothing ships until someone who did not build it has checked it.</p>
    <h2>Every open item is in one group</h2>
    <ul>
      <li><strong>Needs you</strong>: a decision only you can make. Open it and answer.</li>
      <li><strong>Blocked</strong>: a fault agents have to fix or decide first.</li>
      <li><strong>Moving</strong>: somebody is on it, from build to deploy.</li>
      <li><strong>Up next</strong>: released, waiting for a free builder.</li>
      <li><strong>Backlog</strong>: not released yet, so no clock runs.</li>
    </ul>
    <p>Each tile on the Work page counts one group; press it to see just those items.</p>
    <h2>Every <Term term="pull request">pull request</Term> takes six steps</h2>
    <ol>
      <li><strong>Build</strong>: a builder agent writes the change.</li>
      <li><strong>Validate</strong>: it merges cleanly onto the main branch.</li>
      <li><strong>Test</strong>: the automated checks run.</li>
      <li><strong>Review</strong>: a different agent approves it.</li>
      <li><strong>Prove</strong>: each requirement gets a passing <Term term="proof">proof</Term>.</li>
      <li><strong>Merge</strong>: it joins the main branch.</li>
    </ol>
    <p>Open any item to see its step, why it is there and who acts next.</p>
    {media && <ReactMarkdown components={{ a: ({ href, children }) => <a href={readmeLink(href)}>{children}</a> }}>{media.readme}</ReactMarkdown>}
  </article>;
}
