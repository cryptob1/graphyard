import { useEffect, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** The delivery flow, one card per step (GY-3295): a short line each, read left to right and top to bottom. */
const flow: [string, string][] = [
  ['Goal', 'You or the Master files a work item with the criteria it must meet.'],
  ['Build', 'A worker writes it in its own worktree, a private copy of the repository.'],
  ['Review', 'A different agent checks it against every criterion.'],
  ['Merge trial', 'It is tested on top of the latest main.'],
  ['Merge', 'The loop merges it to main. No pull request is opened.'],
  ['Deploy and verify', 'Merges are verified in batches; a failing batch reverts its culprit. Main deploys.'],
];

/** Where each part runs: the same parts `graphyard guide infra` lists, in two panels instead of one wiring diagram. */
const host: [string, string, string][] = [
  ['The loop', 'graphyard-master-OWNER-NAME.service', 'Hands out work, trials, merges.'],
  ['Deploy watch', 'graphyard-deploy-OWNER-NAME.service', 'Deploys and rolls back.'],
  ['Server and dashboard', 'graphyard-OWNER-NAME-server-1', 'Docker, on 127.0.0.1:4310.'],
  ['Database', 'graphyard-OWNER-NAME-db-1', 'Postgres 17 in Docker.'],
  ['Merge trials', 'graphyard-trial-…', 'One container per trial.'],
  ['Agent sessions', 'Workers, reviewers, the Master', 'Confined, one worktree each.'],
];
const outside: [string, string][] = [
  ['GitHub', 'Your code. Only the loop pushes.'],
  ['Agent providers', 'Claude, Codex and others, on your accounts.'],
  ['npm and GHCR', 'Graphyard’s own releases.'],
  ['Your browser', 'The dashboard, locally or on your tailnet.'],
];

const link = (id: string, text: string) => <a href={`#${id}`}>{text}</a>;

/** The FAQ: one folded answer per question a new engineer asks, each with its own address. */
const faq: [string, string, ReactNode][] = [
  ['faq-what', 'What is Graphyard?', <>A coding factory for one repository. The owner states goals; agents implement, review, prove, merge and deploy them with no person in the loop. Every item, attempt, review and proof is kept on the item’s page.</>],
  ['faq-where', 'What runs locally, and what at a provider?', <>Everything Graphyard runs is on your Linux host: the loop, the deploy watch, the server and its database, merge trials in Docker and every agent session. Off the host are GitHub (your code), the agent providers (Claude, Codex and others answer model calls on your own accounts) and your browser. Graphyard hosts nothing for you. See {link('docs-where', 'Where things run')}.</>],
  ['faq-credentials', 'Which credentials does setup need?', <>A GitHub CLI login with admin access to the repository (<code>gh auth login --scopes repo</code>). <code>up</code> registers a deploy key with it, and only the merge writer pushes; where deploy keys are not allowed, <code>--push-auth gh</code> pushes with your gh login instead. Agent accounts are your own Claude, Codex or other logins on the host, connected from the Setup page. No GitHub App and no publish token are needed.</>],
  ['faq-filing', 'How do I file and prioritise work?', <>On Work, press <strong>New work item</strong>. A title and a sentence or two are enough; the Master writes the acceptance criteria, and <strong>Advanced</strong> takes full detail. Set priority from P0 (first) to P3 on the work row or the item page; the next dispatch uses it. The Master files work too, ranked by the product brief.</>],
  ['faq-master', 'What does the Master do, versus the loop?', <>The Master is the install’s AI coordinator. It learns the product, keeps the product brief (Settings → Product), turns goals into ranked work items, answers when an item needs judgement and files fixes for recurring faults. It does not write the code; workers do. The loop is plain code, no AI: it runs every delivery step in cycles, so work keeps moving while the Master thinks.</>],
  ['faq-context', 'How do agents share context?', <>Three places. The <strong>product brief</strong> (Settings → Product) says what the product is for; the Master keeps it and every session’s request carries it. <strong>AGENTS.md</strong> in your repository holds the project’s rules, plus a short block Graphyard writes naming its guide topics. The <strong>work item</strong> holds the goal, criteria and history; when an attempt ends, the next worker continues from its committed work.</>],
  ['faq-delivery', 'How are changes tested, reviewed, merged and deployed?', <>A worker submits a commit. A different agent reviews it, and every criterion needs a passing proof from someone other than the builder. The merge writer trials the commit on the latest main, running the tests the change affects, then merges it to main itself. Merged changes are verified together as a batch; a failing batch reverts the change that broke it. Verified main deploys, and a failed health check rolls back. See {link('docs-flow', 'How a change ships')}.</>],
  ['faq-deploy', 'How do I deploy my app to Railway or AWS?', <>Graphyard does not deploy your app to Railway or AWS and holds no credentials for them. Let the platform deploy from your main branch: Railway does this from git; on AWS, set up CodePipeline or App Runner to deploy from it. Then add the app to <code>delivery.applications</code> in <code>graphyard.json</code> with a <code>versionUrl</code> that answers the commit it serves, and <code>graphyard master status</code> shows it as current, deploying, lagging or failed.</>],
  ['faq-failure', 'What if a worker fails or a provider’s quota runs out?', <>A session that goes quiet gets one re-prompt. One that still fails ends its attempt, and the loop starts another that continues from the committed work. When a provider says an account hit its limit, Graphyard holds that account until the reset (an hour if none is named) and uses the next account in the same role. Settings → Agents shows every account and its state.</>],
  ['faq-logs', 'Where are the logs, and what is a blocker?', <>Each item’s page keeps every attempt’s output (credentials masked), its reviews, trials and proofs. A blocker is an agent’s reason it cannot continue: the item shows under Blocked and the Master resolves it. On the host, <code>journalctl --user -u graphyard-master-OWNER-NAME.service</code> shows the loop and <code>docker logs graphyard-OWNER-NAME-server-1</code> the server; {link('docs-reference', 'Reference')} lists every part.</>],
  ['faq-access', 'How do I and my teammates sign in, across installs?', <>Each repository has its own install, with its own dashboard, port and sign-ins. The first install serves at <code>http://127.0.0.1:4310</code>; the next takes the first free port after it, and <code>up --port N</code> picks one. With <code>--share-tailnet</code>, a Tailscale host is also reachable at a tailnet-only HTTPS address, never a public one. Sign in with the link <code>up</code> prints, or <code>graphyard login</code> for a new one. To add a teammate, use <strong>Invite someone</strong> on Setup or <code>graphyard invite NAME --role viewer</code>: a viewer reads everything, a maintainer also files work. The link works once, for ten minutes, on that install only, so invite them on each install they need.</>],
  ['faq-decisions', 'Which decisions are left to me?', <>Three kinds: goals and priorities, money and accounts, and sign-ins for people. When an item needs one, it shows under Needs you with the question and a recommended answer; answer it there. Agents decide everything else.</>],
];

const commands: [string, string][] = [
  ['graphyard master status', 'What the loop and the Master are doing now'],
  ['graphyard doctor', 'Checks the install; each failure prints its fix'],
  ['graphyard login', 'A fresh one-time sign-in link'],
  ['graphyard invite NAME --role viewer|maintainer', 'A teammate’s one-time link; invite revoke NAME ends it'],
  ['graphyard priority GY-N 0|1|2|3 REASON', 'Change an item’s priority'],
  ['graphyard upgrade --plan', 'Preview an upgrade; graphyard upgrade runs it'],
  ['graphyard guide TOPIC', 'Every procedure, by topic'],
];

/**
 * The Docs page, opened from Help at the foot of the sidebar (GY-3295): an introduction for an engineer
 * who has never heard of Graphyard. Who decides what, one first item from setup to result, the delivery
 * flow and where each part runs as readable panels, then a folded FAQ and reference. The reference prints
 * `graphyard guide setup` and `graphyard guide infra` themselves, loaded once the page is open, so those
 * procedures keep one source.
 */
export default function GuidePage() {
  const [media, setMedia] = useState<{ video: string; setup: string; infra: string } | null>(null);
  useEffect(() => {
    Promise.all([import('../../docs/diagrams/how-graphyard-works.mp4?url'), import('../../src/guide')])
      .then(([video, guide]) => setMedia({ video: video.default, setup: guide.guideText('setup'), infra: guide.guideText('infra') }));
  }, []);
  return <article className="guide">
    <div className="page-heading"><h1>How Graphyard works</h1></div>
    <p className="guide-lead">Graphyard is a coding factory. You say what you want built; AI agents build, check, merge and ship it, with no person in the loop.</p>
    <nav className="guide-contents" aria-label="On this page">
      {link('docs-overview', 'Who decides what')}{link('docs-first-item', 'Your first item')}{link('docs-flow', 'How a change ships')}{link('docs-where', 'Where things run')}{link('docs-faq', 'FAQ')}{link('docs-reference', 'Reference')}
    </nav>

    <section id="docs-overview" aria-labelledby="docs-overview-title">
      <h2 id="docs-overview-title">Who decides what</h2>
      <ul>
        <li><strong>You, the owner</strong>: goals and priorities, money and accounts, and sign-ins for people.</li>
        <li><strong>The Master</strong>: the AI coordinator. It keeps the product brief, plans work items and unsticks them.</li>
        <li><strong>The loop</strong>: plain code, no AI. It hands work to agents, runs merge trials, merges and deploys.</li>
        <li><strong>Workers and reviewers</strong>: AI coding sessions. Nobody reviews their own work.</li>
      </ul>
      <p>Your repository is the <strong>managed app</strong>: the product being built. Graphyard is the factory beside it, with its own server, dashboard and database.</p>
    </section>

    <section id="docs-first-item" aria-labelledby="docs-first-item-title">
      <h2 id="docs-first-item-title">Your first item</h2>
      <ol className="guide-journey">
        <li><strong>Check the host.</strong> Linux with Docker, Node, Git and the GitHub CLI; <code>npx @cryptob1/graphyard doctor</code> names anything missing and its fix.</li>
        <li><strong>Connect your repository.</strong> In its checkout, run <code>npx @cryptob1/graphyard up --repo OWNER/NAME</code>. It installs everything on this host and prints a sign-in link.</li>
        <li><strong>Open the dashboard.</strong> The link signs you in at <code>http://127.0.0.1:4310</code>, or the port <code>up</code> chose. Setup connects your agent accounts.</li>
        <li><strong>State a goal.</strong> On Work, press <strong>New work item</strong> and give it a title. The Master writes the criteria.</li>
        <li><strong>Watch it move.</strong> Under Moving it goes from build to deploy. Open it to see its step and who acts next.</li>
        <li><strong>Find the result.</strong> Shipped lists what merged and went live.</li>
        <li><strong>Meet a blocker.</strong> Stuck items show under Blocked with the reason; your decisions wait under Needs you.</li>
      </ol>
    </section>

    <section id="docs-flow" aria-labelledby="docs-flow-title">
      <h2 id="docs-flow-title">How a change ships</h2>
      <figure className="guide-figure" aria-labelledby="docs-flow-title">
        <ol className="guide-flow">{flow.map(([step, line]) => <li key={step} className="guide-card"><strong>{step}</strong><span>{line}</span></li>)}</ol>
      </figure>
      {media && <video className="guide-video" src={media.video} controls preload="metadata" aria-label="Walkthrough video: a goal through review, merge trial, deploy and revert"/>}
    </section>

    <section id="docs-where" aria-labelledby="docs-where-title">
      <h2 id="docs-where-title">Where things run</h2>
      <figure className="guide-figure guide-where" aria-labelledby="docs-where-title">
        <div className="guide-panel" role="group" aria-label="Your Linux host">
          <h3>Your Linux host</h3>
          <ul>{host.map(([part, name, line]) => <li key={part} className="guide-card"><strong>{part}</strong><code>{name}</code><span>{line}</span></li>)}</ul>
        </div>
        <div className="guide-panel" role="group" aria-label="Outside the host">
          <h3>Outside the host</h3>
          <ul>{outside.map(([part, line]) => <li key={part} className="guide-card"><strong>{part}</strong><span>{line}</span></li>)}</ul>
        </div>
      </figure>
      <p className="muted">OWNER-NAME is your repository’s slug. The Setup page shows this install’s own names.</p>
    </section>

    <section id="docs-faq" aria-labelledby="docs-faq-title">
      <h2 id="docs-faq-title">FAQ</h2>
      {faq.map(([id, question, answer]) => <details key={id} id={id} className="guide-faq"><summary>{question}</summary><p>{answer}</p></details>)}
    </section>

    <section id="docs-reference" aria-labelledby="docs-reference-title">
      <h2 id="docs-reference-title">Reference</h2>
      <details className="guide-faq"><summary>Common commands</summary>
        <table className="guide-table"><tbody>{commands.map(([command, what]) => <tr key={command}><td><code>{command}</code></td><td>{what}</td></tr>)}</tbody></table>
      </details>
      <details className="guide-faq"><summary>Setup prerequisites and options</summary>{media && <ReactMarkdown remarkPlugins={[remarkGfm]}>{media.setup}</ReactMarkdown>}</details>
      <details className="guide-faq"><summary>Every part, with its log command</summary>{media && <ReactMarkdown remarkPlugins={[remarkGfm]}>{media.infra}</ReactMarkdown>}</details>
    </section>
  </article>;
}
