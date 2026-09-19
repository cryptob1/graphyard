import Term from '../components/term';

/**
 * "How Graphyard works" in under 300 words, linked from the header of every page. The long,
 * precise version is docs/how-graphyard-works.md; this one is for a first visit.
 */
export default function GuidePage() {
  return <article className="guide">
    <div className="page-heading"><h1>How Graphyard works</h1></div>
    <p>Graphyard keeps track of software work that AI agents (and people) build, and makes sure nothing ships until it is checked.</p>
    <h2>Every item takes the same path</h2>
    <ol>
      <li><strong>Not started.</strong> Someone writes the goal and what must be true when it is done: the <Term term="acceptance criterion">acceptance criteria</Term>.</li>
      <li><strong>Needs a worker.</strong> The item is released and waits for a <Term term="worker">worker</Term> to pick it up.</li>
      <li><strong>Being built.</strong> One worker builds it and opens a <Term term="pull request">pull request</Term>.</li>
      <li><strong>In review.</strong> A different agent or person reads the change and approves it.</li>
      <li><strong>Automated checks.</strong> GitHub runs the tests.</li>
      <li><strong>Proving it works.</strong> Each criterion needs a passing <Term term="proof">proof</Term> from someone who did not build it.</li>
      <li><strong>Merging.</strong> The change joins the <Term term="merge queue">merge queue</Term> and merges.</li>
      <li><strong>Shipped.</strong> It is on the main branch, and then deployed.</li>
    </ol>
    <h2>Reading the dashboard</h2>
    <p><strong>Work</strong> shows what is stuck, what is moving and what shipped this week. Each card has one sentence saying what is happening and who is on it. Open a card to see the one thing blocking it.</p>
    <p><strong>Stuck</strong> means it will not move until someone decides or fixes something. Everything else is waiting its turn.</p>
    <p><strong>Shipped</strong> lists merged work. <strong>Insights</strong> has charts and history. <strong>Settings</strong> holds test cases and who may submit proofs.</p>
    <p>Hover a dotted word for its meaning. <a href="/docs/how-graphyard-works">The full guide ↗</a></p>
  </article>;
}
