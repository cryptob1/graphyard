// Renders the repo-native documentation diagrams under docs/diagrams/ as self-contained
// SVG files. The SVGs are committed; rerun `node scripts/render-docs-diagrams.mjs` after
// editing the specs below. Every shape and colour is keyed to a docs/glossary.md term, and
// every file carries a <title> and <desc> so the image is described without the page around it.
import { writeFileSync } from 'node:fs';

const WIDTH = 560;
const FONT = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
// One opaque surface, so the diagram reads identically on GitHub light, GitHub dark and the
// dark in-app docs. Foreground/background pairs all exceed 7:1 contrast.
const SURFACE = '#111714', TEXT = '#e6ede4', MUTED = '#b8c6b7', LINE = '#9fb39c';
const KIND = {
  human: { stroke: '#e0c27a', fill: '#3a3020', text: '#f6e7b8', label: 'Human operator (human authority)' },
  agent: { stroke: '#c5e69b', fill: '#22311f', text: '#e1f3c8', label: 'AI agent session (one role, one credential)' },
  graphyard: { stroke: '#8fc1e6', fill: '#182a36', text: '#d8ecf9', label: 'Graphyard control plane' },
  herdr: { stroke: '#c3b1ec', fill: '#2a2338', text: '#e9e0f9', label: 'Herdr runtime (session supervision)' },
  external: { stroke: '#b8c2bb', fill: '#262d28', text: '#e3e9e3', label: 'GitHub and other external facts' },
};
const TAG = { stroke: '#c5e69b', fill: '#111714', text: '#c5e69b' };

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function wrap(text, width, size) {
  const perChar = size * 0.53, max = Math.max(4, Math.floor(width / perChar));
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      if (line && (line + ' ' + word).length > max) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
  }
  return lines;
}

class Canvas {
  constructor() { this.parts = []; this.height = 0; }
  text(x, y, lines, { size = 15, fill = TEXT, weight = 400, anchor = 'start', mono = false } = {}) {
    const lineHeight = size * 1.32;
    lines.forEach((line, i) => this.parts.push(`<text x="${x}" y="${(y + lineHeight * (i + 0.85)).toFixed(1)}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${mono ? ' font-family="ui-monospace, SFMono-Regular, Menlo, monospace"' : ''}>${esc(line)}</text>`));
    return lineHeight * lines.length;
  }
  // A labelled box. `kind` picks the glossary colour; `tags` are small chips for lease/worktree/credential facts.
  box({ x, y, w, kind, title, body = '', tags = [], dashed = false, pad = 12, titleSize = 16, bodySize = 14 }) {
    const c = KIND[kind];
    const titleLines = wrap(title, w - pad * 2, titleSize), bodyLines = body ? wrap(body, w - pad * 2, bodySize) : [];
    let h = pad + titleSize * 1.32 * titleLines.length + (bodyLines.length ? 4 + bodySize * 1.32 * bodyLines.length : 0);
    if (tags.length) h += 10 + 24;
    h += pad;
    const rx = kind === 'graphyard' || kind === 'external' ? 4 : 14;
    this.parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h.toFixed(1)}" rx="${rx}" fill="${c.fill}" stroke="${c.stroke}" stroke-width="2"${dashed ? ' stroke-dasharray="8 5"' : ''}/>`);
    let cy = y + pad;
    cy += this.text(x + pad, cy, titleLines, { size: titleSize, weight: 650, fill: c.text });
    if (bodyLines.length) cy += 4 + this.text(x + pad, cy, bodyLines, { size: bodySize, fill: c.text });
    if (tags.length) {
      cy += 10; let tx = x + pad;
      for (const tag of tags) {
        const tw = tag.length * 13 * 0.6 + 16;
        this.parts.push(`<rect x="${tx}" y="${cy}" width="${tw.toFixed(1)}" height="24" rx="12" fill="${TAG.fill}" stroke="${TAG.stroke}" stroke-width="1.5" stroke-dasharray="3 3"/>`);
        this.text(tx + 8, cy + 3, [tag], { size: 13, fill: TAG.text, mono: true });
        tx += tw + 8;
      }
    }
    this.height = Math.max(this.height, y + h);
    return { x, y, w, h, bottom: y + h, cx: x + w / 2 };
  }
  // Remember where the next part lands so a container drawn later can be inserted beneath its children.
  mark() { return this.parts.length; }
  container(index, { x, y, w, h, kind, title }) {
    const c = KIND[kind];
    this.parts.splice(index, 0, `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${c.fill}" stroke="${c.stroke}" stroke-width="2"/>`,
      `<text x="${x + 12}" y="${y + 24}" font-size="16" font-weight="650" fill="${c.text}">${esc(title)}</text>`);
    this.height = Math.max(this.height, y + h);
  }
  arrow(x1, y1, x2, y2, { label = '', dashed = false, thick = true, labelSide = 'right', labelWidth = 250 } = {}) {
    this.parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${LINE}" stroke-width="${thick ? 2.5 : 1.5}"${dashed ? ' stroke-dasharray="6 5"' : ''} marker-end="url(#arrow)"/>`);
    if (label) {
      const lines = wrap(label, labelWidth, 13);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      if (x1 === x2) this.text(labelSide === 'right' ? mx + 10 : mx - 10, my - lines.length * 13 * 1.32 / 2, lines, { size: 13, fill: MUTED, anchor: labelSide === 'right' ? 'start' : 'end' });
      else this.text(mx, my - lines.length * 13 * 1.32 - 4, lines, { size: 13, fill: MUTED, anchor: 'middle' });
    }
  }
  // A two-headed arrow, drawn as two lines so both ends carry a head.
  both(x1, y1, x2, y2, options) { this.arrow(x1, y1, x2, y2, options); this.parts.push(`<line x1="${x2}" y1="${y2}" x2="${x1}" y2="${y1}" stroke="${LINE}" stroke-width="2.5" marker-end="url(#arrow)"/>`); }
  heading(y, text) { this.height = Math.max(this.height, y + 30); return this.text(20, y, [text], { size: 18, weight: 700 }) + y + 8; }
  note(y, text, w = WIDTH - 40) { const lines = wrap(text, w, 13); const h = this.text(20, y, lines, { size: 13, fill: MUTED }); this.height = Math.max(this.height, y + h); return y + h; }
  legend(y, extra = []) {
    let cy = this.heading(y, 'Legend (glossary terms)');
    const entries = [...Object.values(KIND).map(k => ({ swatch: `<rect x="20" y="${0}" width="34" height="22" rx="${k === KIND.graphyard || k === KIND.external ? 3 : 9}" fill="${k.fill}" stroke="${k.stroke}" stroke-width="2"/>`, label: k.label })),
      { swatch: `<rect x="20" y="0" width="34" height="22" rx="11" fill="${TAG.fill}" stroke="${TAG.stroke}" stroke-width="1.5" stroke-dasharray="3 3"/>`, label: 'Chip: credential, lease epoch, or assigned worktree the session holds' },
      { swatch: `<line x1="20" y1="11" x2="54" y2="11" stroke="${LINE}" stroke-width="2.5" marker-end="url(#arrow)"/>`, label: 'Solid arrow: an authenticated command or authority' },
      { swatch: `<line x1="20" y1="11" x2="54" y2="11" stroke="${LINE}" stroke-width="1.5" stroke-dasharray="6 5" marker-end="url(#arrow)"/>`, label: 'Dashed arrow: observation or health report, never authority' },
      ...extra];
    for (const entry of entries) {
      this.parts.push(`<g transform="translate(0 ${cy.toFixed(1)})">${entry.swatch}</g>`);
      const lines = wrap(entry.label, WIDTH - 90, 14);
      const h = this.text(66, cy - 1, lines, { size: 14, fill: TEXT });
      cy += Math.max(h, 22) + 8;
    }
    this.height = Math.max(this.height, cy);
    return cy;
  }
  render({ title, desc }) {
    const h = Math.ceil(this.height + 20);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${h}" width="${WIDTH}" height="${h}" role="img" aria-labelledby="title desc" font-family='${FONT}'>
<title id="title">${esc(title)}</title>
<desc id="desc">${esc(desc)}</desc>
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${LINE}"/></marker></defs>
<rect width="${WIDTH}" height="${h}" fill="${SURFACE}"/>
${this.parts.join('\n')}
</svg>
`;
  }
}

function rolesAndAuthority() {
  const c = new Canvas();
  let y = c.heading(16, 'Who holds which authority');
  const human = c.box({ x: 20, y, w: 520, kind: 'human', title: 'Human operator', body: 'admin credential declaring sessionKind: "human". Sets goals, releases backlog work, revises requirements, resolves escalations, attests manual proofs, and approves merges when automatic merging is off. Nothing below can do these.', tags: ['admin', 'sessionKind: human'] });
  c.arrow(human.cx, human.bottom, human.cx, human.bottom + 44, { label: 'human-only decisions', labelSide: 'right' });
  y = human.bottom + 46;
  const gy = c.box({ x: 20, y, w: 520, kind: 'graphyard', title: 'Graphyard control plane', body: 'Server, Postgres, dashboard, and CLI. Records ownership (lease + epoch), requirements, the candidate (PR, head SHA, base SHA), evidence, gate decisions, and merge authorization. Gates are deterministic; there is no lifecycle-state endpoint and no merge bypass.' });
  y = gy.bottom + 88;
  // Sessions row: Herdr container on the left with the three runtime-hosted roles, independent identities on the right.
  const herdrTop = y;
  const index = c.mark();
  const master = c.box({ x: 32, y: herdrTop + 40, w: 296, kind: 'agent', title: 'Master (coordinator)', body: 'Durable loop plus an optional visible session. Dispatches ready work, shepherds review, requests the guarded merge.', tags: ['coordinator'] });
  const lead = c.box({ x: 32, y: master.bottom + 10, w: 296, kind: 'agent', title: 'Slice lead', body: 'Rules on plans and failures inside one slice, citing a rule ID. Never implements or merges.', tags: ['slice-lead'] });
  const worker = c.box({ x: 32, y: lead.bottom + 10, w: 296, kind: 'agent', title: 'Worker', body: 'Claims one item, edits only its assigned worktree, opens the PR, submits the exact commit. Stops on lease loss.', tags: ['worker', 'lease · epoch', 'worktree'] });
  c.container(index, { x: 20, y: herdrTop, w: 320, h: worker.bottom + 12 - herdrTop, kind: 'herdr', title: 'Herdr runtime hosts the sessions' });
  const reviewer = c.box({ x: 352, y: herdrTop, w: 188, kind: 'agent', title: 'Reviewer', body: 'A separate GitHub identity approves the exact head. Holds no Graphyard credential.', tags: ['GitHub App'] });
  const producer = c.box({ x: 352, y: reviewer.bottom + 10, w: 188, kind: 'agent', title: 'Proof producer', body: 'CI workflow or trusted runner. Submits evidence bound to head, base, and policy revision.', tags: ['producer', 'grant'] });
  const opAgent = c.box({ x: 352, y: producer.bottom + 10, w: 188, kind: 'agent', title: 'Operator agent', body: 'Optional, scoped. Adds intent and requirements; never removes them.', tags: ['operator-agent'] });
  const sessionsBottom = Math.max(worker.bottom + 12, opAgent.bottom);
  // The two upward arrows carry their labels on opposite outer sides so the lines never share a column.
  c.arrow(180, herdrTop - 4, 180, gy.bottom + 4, { label: 'claim, heartbeat, submit, dispatch, merge request: each under its own credential', labelSide: 'left', labelWidth: 190 });
  c.arrow(446, herdrTop - 4, 446, gy.bottom + 4, { label: 'evidence, bounded intent', labelSide: 'left', labelWidth: 120 });
  y = sessionsBottom + 56;
  const github = c.box({ x: 20, y, w: 520, kind: 'external', title: 'GitHub', body: 'Pull request, reviews, CI checks, branch protection, and the observed merge. Graphyard reads these facts; it never trusts a session’s report of them.' });
  c.arrow(worker.x + 100, sessionsBottom + 4, worker.x + 100, y - 4, { label: 'push branch, open PR', labelSide: 'right' });
  c.arrow(reviewer.x + 94, sessionsBottom + 4, reviewer.x + 94, y - 4, { label: 'approve exact head', labelSide: 'left' });
  y = c.note(github.bottom + 14, 'Graphyard and GitHub: Graphyard observes the PR, reviews, checks, and protection; publishes the required "Graphyard / merge" check; and merges only through the guarded, exact-candidate path. Herdr reports whether a session is alive; it never decides ownership or progression.');
  c.legend(y + 16);
  return c.render({
    title: 'Who holds which authority in Graphyard',
    desc: 'The human operator, holding an admin credential declared human, makes the human-only decisions and sends them to the Graphyard control plane. Below the control plane, the Herdr runtime hosts three agent sessions, each with one credential: the master (coordinator), the slice lead (slice-lead), and the worker (worker credential, lease epoch, and assigned worktree). Beside them are the reviewer (a separate GitHub identity with no Graphyard credential), the proof producer (producer credential with a grant), and the optional scoped operator agent. Sessions send authenticated commands to Graphyard; the worker pushes its branch and opens the pull request on GitHub; the reviewer approves the exact head on GitHub. Graphyard observes GitHub facts and merges only through the guarded path.',
  });
}

function bootstrapVersusNormal() {
  const c = new Canvas();
  let y = c.heading(16, 'Phase 1 · Bootstrap: one worker under direct supervision');
  const human1 = c.box({ x: 20, y, w: 520, kind: 'human', title: 'Human operator', body: 'Connects the repository and GitHub enforcement, creates the work item, and supervises the one worker session directly. Holds the admin credential and the GitHub administrator identity.', tags: ['admin', 'sessionKind: human'] });
  c.arrow(human1.cx, human1.bottom, human1.cx, human1.bottom + 44, { label: 'supervises directly; creates, releases, reviews', labelSide: 'right' });
  const worker1 = c.box({ x: 20, y: human1.bottom + 46, w: 520, kind: 'agent', title: 'One worker session', body: 'Claims one item, works in one assigned worktree under watch, opens the PR, submits the exact commit. It never receives the operator or GitHub credentials used for setup.', tags: ['worker', 'lease · epoch', 'worktree'] });
  c.arrow(worker1.cx, worker1.bottom, worker1.cx, worker1.bottom + 44, { label: 'claim, heartbeat, submit', labelSide: 'right' });
  const gy1 = c.box({ x: 20, y: worker1.bottom + 46, w: 236, kind: 'graphyard', title: 'Graphyard control plane', body: 'Same gates as phase 2: review, CI, acceptance, merge.' });
  const gh1 = c.box({ x: 324, y: worker1.bottom + 46, w: 216, kind: 'external', title: 'GitHub', body: 'PR, CI, protection, observed merge.' });
  c.both(gy1.x + gy1.w + 4, gy1.y + 34, gh1.x - 4, gh1.y + 34);
  y = c.note(Math.max(gy1.bottom, gh1.bottom) + 12, 'No operator agent, no master loop, no slice leads, no reviewer session yet: the human operator performs those duties. Every gate is already enforced.');

  y = c.heading(y + 30, 'Phase 2 · Normal operation: many sessions, same gates');
  const human2 = c.box({ x: 20, y, w: 520, kind: 'human', title: 'Human operator', body: 'Supplies goals, required decisions, and oversight. Still the only authority for releasing work, revising requirements, resolving escalations, manual proofs, and merge approval when automatic merging is off.', tags: ['admin', 'sessionKind: human'] });
  c.arrow(120, human2.bottom, 120, human2.bottom + 44, { label: 'goals', labelSide: 'right' });
  c.arrow(440, human2.bottom, 440, human2.bottom + 44, { label: 'human-only decisions', labelSide: 'left' });
  const op = c.box({ x: 20, y: human2.bottom + 46, w: 236, kind: 'agent', title: 'Operator agent (optional)', body: 'Scoped, opt-in credential provisioned by the administrator. Sends bounded intent: it adds work and requirements, never removes them.', tags: ['operator-agent'] });
  const gy2 = c.box({ x: 304, y: human2.bottom + 46, w: 236, kind: 'graphyard', title: 'Graphyard control plane', body: 'Ownership, candidates, evidence, gates, merge authorization. Unchanged from phase 1.' });
  c.arrow(op.x + op.w + 4, op.y + 34, gy2.x - 4, gy2.y + 34);
  const rowY = Math.max(op.bottom, gy2.bottom) + 50;
  const master = c.box({ x: 20, y: rowY, w: 165, kind: 'agent', title: 'Master loop', body: 'Dispatches, shepherds, requests guarded merges.', tags: ['coordinator'] });
  const leads = c.box({ x: 197, y: rowY, w: 165, kind: 'agent', title: 'Slice leads', body: 'Optional. One per slice; rulings cite a rule ID.', tags: ['slice-lead'] });
  const reviewers = c.box({ x: 374, y: rowY, w: 166, kind: 'agent', title: 'Reviewer / proof producers', body: 'Independent of every implementer.', tags: ['producer'] });
  c.arrow(gy2.cx, gy2.bottom + 2, gy2.cx, rowY - 4, { label: 'ready work, gate state', labelSide: 'left' });
  const workersY = Math.max(master.bottom, leads.bottom, reviewers.bottom) + 44;
  const workers = c.box({ x: 20, y: workersY, w: 520, kind: 'agent', title: 'Worker sessions (n)', body: 'Each holds its own worker credential, one lease epoch per claimed item, and one assigned worktree per assignment. Still untrusted: no operator, coordinator, or producer credential.', tags: ['worker', 'lease · epoch', 'worktree'] });
  c.arrow(master.cx, master.bottom + 2, master.cx, workersY - 4, { label: 'dispatch (invitation, not ownership)', labelSide: 'right' });
  const gh2 = c.box({ x: 20, y: workers.bottom + 46, w: 520, kind: 'external', title: 'GitHub', body: 'PR, reviews, CI checks, branch protection, observed merge — read by Graphyard, never self-reported.' });
  c.arrow(workers.cx, workers.bottom + 2, workers.cx, gh2.y - 4, { label: 'push, open PR', labelSide: 'right' });
  y = c.note(gh2.bottom + 12, 'Herdr hosts the master, lead, worker, and reviewer sessions and reports their health. Graphyard enforces separation only through principals and credentials; keeping the sessions independent is the runtime’s job.');
  c.legend(y + 16);
  return c.render({
    title: 'Bootstrap single-agent operation versus normal multi-agent operation',
    desc: 'Phase 1, bootstrap: the human operator, holding the admin credential, directly supervises one worker session that holds a worker credential, one lease epoch, and one assigned worktree. The worker sends claim, heartbeat, and submit commands to the Graphyard control plane, which exchanges pull request, CI, protection, and merge facts with GitHub. No operator agent, master loop, slice leads, or reviewer session exist yet, but every gate is enforced. Phase 2, normal operation: the human operator supplies goals and the human-only decisions. An optional scoped operator agent turns goals into bounded intent. The master loop, optional slice leads, and independent reviewer and proof producer sessions read ready work and gate state from Graphyard. The master dispatches to many worker sessions, each with its own credential, lease epoch, and worktree; workers push branches and open pull requests on GitHub. The gates and credential boundaries are the same in both phases.',
  });
}

function controlPlaneComponents() {
  const c = new Canvas();
  const y = c.heading(16, 'Control-plane components');
  const sessions = c.box({ x: 20, y, w: 163, kind: 'herdr', title: 'Agent sessions', body: 'Worker, master, and lead sessions in Herdr or another runtime, each using the CLI under its own principal.' });
  const dashboard = c.box({ x: 198, y, w: 163, kind: 'human', title: 'Dashboard', body: 'Human operator and readers. Same authorization as the API; no lifecycle-state endpoint.' });
  const producer = c.box({ x: 376, y, w: 164, kind: 'agent', title: 'Proof producer', body: 'CI workflow or trusted runner submitting evidence bound to head, base, and policy.', tags: ['producer'] });
  const apiY = Math.max(sessions.bottom, dashboard.bottom, producer.bottom) + 46;
  const api = c.box({ x: 20, y: apiY, w: 520, kind: 'graphyard', title: 'HTTP API and CLI', body: 'Bearer authentication, schema validation, idempotency receipts, the signed webhook endpoint, and the static UI.' });
  for (const caller of [sessions, dashboard, producer]) c.arrow(caller.cx, caller.bottom + 2, caller.cx, apiY - 4);
  const engine = c.box({ x: 20, y: api.bottom + 46, w: 520, kind: 'graphyard', title: 'Coordination engine', body: 'One advisory-locked transaction per mutation: ownership, epochs, gates, evidence trust, merge authority. No external I/O inside.' });
  c.arrow(api.cx, api.bottom + 2, api.cx, engine.y - 4, { label: 'authenticated commands', labelSide: 'right' });
  const db = c.box({ x: 20, y: engine.bottom + 46, w: 520, kind: 'graphyard', title: 'Postgres', body: 'work_items aggregate, append-only events and receipts, jobs queue, releases and delivery observations. Triggers reject ledger edits.' });
  c.arrow(engine.cx, engine.bottom + 2, engine.cx, db.y - 4, { label: 'aggregate + event in one transaction', labelSide: 'right' });
  // A 60 px gap between these two boxes keeps the "webhook" label clear of both outlines.
  const recon = c.box({ x: 20, y: db.bottom + 46, w: 230, kind: 'graphyard', title: 'Reconciliation worker', body: 'Two-second tick: expires leases, leases jobs with SKIP LOCKED, applies observations, publishes the required check, runs the guarded merge.' });
  const github = c.box({ x: 310, y: db.bottom + 46, w: 230, kind: 'external', title: 'GitHub', body: 'PR, reviews, checks, branch protection, merge facts. Read by the worker; never trusted from a session.' });
  c.arrow(db.x + 138, db.bottom + 2, db.x + 138, recon.y - 4, { label: 'jobs', labelSide: 'right' });
  c.both(recon.x + recon.w + 4, recon.y + 34, github.x - 4, github.y + 34);
  c.arrow(github.x - 4, github.y + 74, recon.x + recon.w + 4, recon.y + 74, { dashed: true, thick: false });
  c.text(280, recon.y + 82, ['webhook'], { size: 12, fill: MUTED, anchor: 'middle' });
  const noteY = c.note(Math.max(recon.bottom, github.bottom) + 12, 'Solid pair: the worker reads PR, CI, review, and protection facts and publishes the "Graphyard / merge" check. Dashed: a signed webhook only wakes a job; the worker refetches before it trusts anything.');
  c.legend(noteY + 16);
  return c.render({
    title: 'Graphyard control-plane components',
    desc: 'Agent sessions in a runtime such as Herdr, the human dashboard, and a proof producer each call the HTTP API and CLI under their own principals. The API hands each mutation to the coordination engine, which runs one advisory-locked transaction that writes the work aggregate and an event to Postgres. A reconciliation worker ticks every two seconds, expires leases, leases integration jobs, exchanges pull request, check, review, and protection facts with GitHub, publishes the required check, and runs the guarded merge. GitHub webhooks wake jobs but are never trusted as workflow truth.',
  });
}

for (const [file, render] of [['roles-and-authority', rolesAndAuthority], ['bootstrap-vs-normal', bootstrapVersusNormal], ['control-plane-components', controlPlaneComponents]]) {
  writeFileSync(new URL(`../docs/diagrams/${file}.svg`, import.meta.url), render());
  console.log(`wrote docs/diagrams/${file}.svg`);
}
