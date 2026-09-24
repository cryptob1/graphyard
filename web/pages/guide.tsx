import Term from '../components/term';

/**
 * "How Graphyard works" in under 300 words, opened from Help at the foot of the sidebar. It uses
 * the dashboard's own words — the five groups and the seven pull-request steps — and nothing else.
 * The long, precise version is docs/how-graphyard-works.md; this one is for a first visit.
 */
export default function GuidePage() {
  return <article className="guide">
    <div className="page-heading"><h1>How Graphyard works</h1></div>
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
    <h2>Every <Term term="pull request">pull request</Term> takes seven steps</h2>
    <ol>
      <li><strong>Build</strong>: a builder agent writes the change.</li>
      <li><strong>Validate</strong>: it only touches the files it planned to.</li>
      <li><strong>Test</strong>: the automated checks run.</li>
      <li><strong>Review</strong>: a different agent approves it.</li>
      <li><strong>Prove</strong>: each requirement gets a passing <Term term="proof">proof</Term>.</li>
      <li><strong>Merge</strong>: it joins the main branch.</li>
      <li><strong>Deploy</strong>: the live release serves it.</li>
    </ol>
    <p>Open any item to see its step, why it is there and who acts next. <a href="/docs/how-graphyard-works">The full guide ↗</a></p>
  </article>;
}
