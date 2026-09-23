import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { demand, type Evidence, type Principal, type Work } from '../model.js';
import { appliedThreshold, closedQuestionFor, closedQuestionRefusal, closedQuestionRequestSchema, judgeAnswer, type ClosedQuestionRecord } from '../model/closed-question.js';
import { boundState, type StateReaders } from '../closed-question.js';
import { save } from '../store.js';
import type { Services } from './routes.js';

/**
 * Judging a closed-question proof (GY-109). The control plane binds the state the declaration
 * names to the exact candidate, asks the configured responder — outside any transaction — and
 * records the answer as evidence in one transaction that re-checks the binding. The caller only
 * asks for the judgement; it supplies nothing the record rests on, so any role that already sees
 * the candidate's proof requests may trigger one: the loop's coordinator, a producer, an admin.
 */

type Db = pg.PoolClient;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const findWork = async (db: Db, id: string): Promise<{ work: Work | undefined; all: Work[] }> => {
  const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(row => row.document);
  return { work: all.find(item => item.id === id || item.key === id), all };
};
const bound = (work: Work, data: { sha: string; baseSha: string; policyRevision: number }) =>
  !!work.candidate && work.candidate.sha === data.sha && work.candidate.baseSha === data.baseSha && work.policyRevision === data.policyRevision && !work.reworkRequested;
/** What refuses a judgement before and after the responder is asked: the item, its authority boundaries, and the exact candidate. */
function refusal(work: Work | undefined, data: { proof: string; sha: string; baseSha: string; policyRevision: number }) {
  demand(work, 'Work item not found', 404);
  demand(work!.stage !== 'done', 'Delivered work is immutable');
  const refused = closedQuestionRefusal(work!, data.proof);
  demand(!refused, refused!, 409);
  demand(bound(work!, data), `${work!.key}'s current candidate is ${work!.candidate?.sha.slice(0, 12) ?? 'none'} at policy revision ${work!.policyRevision}${work!.reworkRequested ? ', awaiting rework' : ''}; a judgement binds the exact candidate it names`, 409);
  return work!;
}

/** GitHub-backed readers for the candidate's state. */
function githubReaders(services: Services): StateReaders {
  const github = () => { demand(services.github, 'GitHub integration is required to read the state a closed question is asked against', 503); return services.github!; };
  return {
    async file(path, sha) {
      const entry = await github().request(`/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(sha)}`);
      demand(entry && !Array.isArray(entry) && typeof entry.content === 'string', `${path} is not a readable file at ${sha.slice(0, 12)}`, 409);
      return Buffer.from(entry.content, entry.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
    },
    async pullRequestBody(pr) { return String((await github().request(`/pulls/${pr}`))?.body ?? ''); },
    async comments(pr) { return ((await github().request(`/issues/${pr}/comments?per_page=100`)) as { user?: { login?: string }; body?: string }[]).map(comment => `${comment.user?.login ?? 'unknown'}: ${comment.body ?? ''}`).join('\n\n'); },
  };
}

export async function judgeClosedQuestion(services: Services, actor: Principal, id: string, body: unknown, key: string) {
  demand(['admin', 'coordinator', 'producer'].includes(actor.role), 'Closed questions are requested by the loop, a producer or an admin', 403);
  const data = closedQuestionRequestSchema.parse(body);
  demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
  const fingerprint = digest({ id, closedQuestion: data });
  const replayed = (await services.engine.store.pool.query('SELECT fingerprint, result FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
  if (replayed) { demand(replayed.fingerprint === fingerprint, 'Idempotency key reused with different input'); return replayed.result; }

  const work = refusal((await services.engine.store.list()).find(item => item.id === id || item.key === id), data);
  const question = closedQuestionFor(work, data.proof)!;
  const responder = services.responder;
  demand(responder, `No closed-question responder is configured; ${data.proof} takes its ordinary path`, 503);
  // External I/O stays outside the coordination transaction: read the state, then ask.
  const state = await boundState(work, question, responder!, githubReaders(services));
  demand(!state.excluded.length, `The responder may not be given the state ${data.proof} is asked against — ${state.excluded.join('; ')}; ${data.proof} takes its ordinary path`, 409);
  let answer: { answer: string; probability: number };
  try { answer = await responder!.ask({ question: question.question, criteria: question.criteria, state: state.state, stateHash: state.stateHash }); }
  catch (error) { demand(false, `Responder ${responder!.id} ${responder!.version} did not answer: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000), 502); throw error; }
  demand(question.criteria.includes(answer.answer), `Responder ${responder!.id} answered "${String(answer.answer).slice(0, 200)}", which is not one of the answers offered (${question.criteria.join(', ')})`, 502);
  const threshold = appliedThreshold(question, responder!.threshold);
  const verdict = judgeAnswer(work, question, answer, threshold);

  return services.engine.store.transaction(async (db, now) => {
    const again = (await db.query('SELECT fingerprint, result FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
    if (again) { demand(again.fingerprint === fingerprint, 'Idempotency key reused with different input'); return again.result; }
    const { work: current, all } = await findWork(db, work.id);
    // The item may have moved while the responder was asked; the answer binds only what it saw.
    const item = refusal(current, data);
    const record: ClosedQuestionRecord = {
      criterion: question.criterion, question: question.question, criteria: [...question.criteria], pass: question.pass,
      stateHash: state.stateHash, state: state.parts, responder: { id: responder!.id, version: responder!.version },
      answer: answer.answer, probability: answer.probability, threshold, verdict: verdict.verdict,
      ...(verdict.escalation ? { escalation: verdict.escalation } : {}),
    };
    const evidence: Evidence = {
      id: randomUUID(), proof: data.proof, sha: data.sha, baseSha: data.baseSha, policyRevision: data.policyRevision,
      producer: `responder:${responder!.id}`, trusted: verdict.trusted, result: verdict.result, executed: 1, skipped: 0,
      at: now.toISOString(), closedQuestion: record,
    };
    item.evidence.push(evidence);
    services.engine.evaluate(item, all, now);
    // The engine's auto-dispatch ledger entries for this evaluation, exactly as waits.ts records them:
    // a decided proof withdraws its producer request here, an escalated one keeps it.
    await (services.engine as unknown as { recordDispatch(db: Db, work: Work, now: Date): Promise<void> }).recordDispatch(db, item, now);
    await save(db, item, actor.id, verdict.verdict === 'decided' ? 'closed-question.answered' : 'closed-question.escalated', now, { evidence, requestedBy: actor.id });
    const result = { work: item.key, evidence, verdict: verdict.verdict, escalation: verdict.escalation ?? null, gates: item.gates, stage: item.stage };
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]);
    return result;
  });
}
