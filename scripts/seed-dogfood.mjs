import { readFile } from 'node:fs/promises';
const base = process.argv[2];
if (!base?.startsWith('https://')) throw new Error('Pass the deployed HTTPS Graphyard URL');
const credentials = JSON.parse(await readFile(new URL('../.graphyard/credentials.json', import.meta.url), 'utf8'));
const token = credentials.find(p => p.role === 'admin').token;
const items = [
  { title: 'Connect the dedicated GitHub App and prove merge enforcement', description: 'Bootstrap follow-up: install the dedicated App, bind the required check to its identity, and demonstrate that an unlinked or unproven PR cannot merge.', proof: 'manual:github-enforcement', criterion: 'A real GitHub PR is blocked before evidence and allowed only after required gates pass.' },
  { title: 'Exercise lease recovery across two Herdr machines', description: 'Launch only after the single-agent MVP is accepted. Use distinct worker identities and isolated worktrees on two machines.', proof: 'integration:herdr-recovery', criterion: 'Exactly one claim wins; after expiry a replacement owns the work and every stale-owner command refuses.' },
  { title: 'Add trusted CI inventory reporting', description: 'Implement a reporter whose credentials cannot be read by untrusted PR code. Preserve run, commit, base, executed, skipped, and artifact provenance.', proof: 'integration:ci-inventory', criterion: 'Skipped, empty, forged, and stale test reports cannot satisfy an acceptance criterion.' },
  { title: 'Serialize final merge authorization through a restricted merge broker', description: 'Narrow the cross-system gap between an evidence revocation and a previously published GitHub success check.', proof: 'integration:merge-authorization', criterion: 'A revoked candidate cannot be merged through the supported broker, including concurrent attempts and retries.' },
];
for (let i = 0; i < items.length; i++) {
  const item = items[i];
  const response = await fetch(`${base}/api/work`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': `bootstrap-dogfood-${i}-v1` }, body: JSON.stringify({ title: item.title, description: item.description, priority: i < 2 ? 1 : 2, criteria: [{ id: 'AC-1', text: item.criterion, proofs: [item.proof] }] }) });
  if (!response.ok) throw new Error(`Seed failed: ${response.status}`);
  const work = await response.json(); console.log(`${work.key}: ${work.title}`);
}
