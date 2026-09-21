import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  eventHistoryLimits, eventHistorySql, eventSelection, eventsUsage, parseEventHistoryFlags,
  parseEventHistoryQuery, routineEventKinds, routineSummarySql, summariseRoutine,
} from '../src/events-history.js';

const query = (search: string) => parseEventHistoryQuery(new URLSearchParams(search));
const work = '11111111-2222-4333-8444-555555555555';

test('unit:events-default-filter — the routine kinds the control plane writes continuously are excluded from an unfiltered read, summarised as counts with their first and last instants, and returned only when the caller asks for them explicitly', () => {
  assert.deepEqual([...routineEventKinds], ['github.observed', 'heartbeat']);

  // The default read excludes the routine kinds and says so in the SQL it builds.
  const byDefault = query(`work=${work}`);
  assert.equal(byDefault.routine, 'exclude');
  assert.deepEqual(eventSelection(byDefault), { kinds: [], excluded: ['github.observed', 'heartbeat'] });
  const page = eventHistorySql(byDefault);
  assert.match(page.text, /NOT \(kind=ANY\(\$\d+::text\[\]\)\)/);
  assert.ok(page.values.some(value => Array.isArray(value) && value.join(',') === 'github.observed,heartbeat'));
  assert.equal(page.values.at(-1), eventHistoryLimits.page + 1, 'one row past the page proves whether another page exists');

  // The explicit flag returns them, and then nothing is excluded or summarised.
  const included = query(`work=${work}&routine=include`);
  assert.deepEqual(eventSelection(included), { kinds: [], excluded: [] });
  assert.doesNotMatch(eventHistorySql(included).text, /NOT \(kind=ANY/);
  assert.equal(routineSummarySql(included), null);
  assert.equal(summariseRoutine(included, []).included, true);
  assert.match(summariseRoutine(included, []).statement, /Routine rows .* are included/);

  // Naming a routine kind is asking for it: the default protection never empties an explicit selection.
  const named = query(`work=${work}&kind=heartbeat`);
  assert.deepEqual(eventSelection(named), { kinds: ['heartbeat'], excluded: ['github.observed'] });
  assert.match(eventHistorySql(named).text, /kind=ANY\(\$\d+::text\[\]\)/);
  assert.doesNotMatch(eventHistorySql(named).text, /NOT \(kind=ANY/);

  // What was left out is reported as counts with the first and last instant of each kind.
  const rows = [
    { kind: 'github.observed', count: 296, first_at: new Date('2026-09-18T09:00:00Z'), last_at: new Date('2026-09-20T09:00:00Z'), first_seq: '10', last_seq: '980' },
    { kind: 'heartbeat', count: 225, first_at: new Date('2026-09-18T09:05:00Z'), last_at: new Date('2026-09-20T08:55:00Z'), first_seq: '12', last_seq: '975' },
  ];
  const summary = summariseRoutine(byDefault, rows);
  assert.equal(summary.included, false);
  assert.deepEqual(summary.excluded, ['github.observed', 'heartbeat']);
  assert.equal(summary.total, 521);
  assert.deepEqual(summary.kinds[0], { kind: 'github.observed', count: 296, firstAt: '2026-09-18T09:00:00.000Z', lastAt: '2026-09-20T09:00:00.000Z', firstSeq: '10', lastSeq: '980' });
  assert.equal(summary.truncated, false);
  assert.match(summary.statement, /521 routine row\(s\) were excluded/);
  assert.match(summary.statement, /296 github\.observed between 2026-09-18T09:00:00\.000Z and 2026-09-20T09:00:00\.000Z/);
  assert.match(summary.statement, /225 heartbeat between/);
  assert.match(summary.statement, /routine=include/);
  // An aggregate that filled its own bound says the count is a floor, not a total.
  const capped = summariseRoutine(byDefault, [{ kind: 'heartbeat', count: 10, first_at: null, last_at: null, first_seq: null, last_seq: null }], 10);
  assert.equal(capped.truncated, true);
  assert.match(capped.statement, /aggregated the newest 10 routine rows/);
  assert.match(summariseRoutine(byDefault, []).statement, /No routine row \(github\.observed, heartbeat\) falls inside this read's filters/);

  // The summary describes the whole filtered range, never the page: it carries the work and time
  // filters but not the cursor, so every page of a walk reports the same excluded rows.
  const paged = query(`work=${work}&since=2026-09-01T00:00:00Z&until=2026-09-20T00:00:00Z&cursor=9000&order=asc`);
  const aggregate = routineSummarySql(paged)!;
  assert.match(aggregate.text, /count\(\*\)::int AS count, min\(created_at\) AS first_at, max\(created_at\) AS last_at/);
  assert.equal(aggregate.values.includes('9000'), false, 'the cursor never narrows the disclosure');
  assert.deepEqual(aggregate.values.slice(1), [work, '2026-09-01T00:00:00Z', '2026-09-20T00:00:00Z', eventHistoryLimits.summaryScan]);
  assert.match(eventHistorySql(paged).text, /seq>\$\d+::bigint ORDER BY seq ASC/);
  assert.match(eventHistorySql(query('order=desc&cursor=9000')).text, /seq<\$\d+::bigint ORDER BY seq DESC/);

  // Defaults and bounds of the read itself.
  assert.deepEqual(query(''), { work: null, kinds: [], since: null, until: null, cursor: null, limit: 300, order: 'desc', routine: 'exclude', payload: 'full', view: 'rows' });
  assert.equal(query('view=history&payload=details').view, 'history');
  assert.match(eventHistorySql(query('payload=details')).text, /payload->'details' AS details/);
  assert.doesNotMatch(eventHistorySql(query('payload=none')).text, /payload/);
  assert.deepEqual(query('kind=claim,submit&kind=rework').kinds, ['claim', 'submit', 'rework']);
  assert.throws(() => query('work=not-a-uuid'), /uuid|UUID|Invalid/);
  assert.throws(() => query(`limit=${eventHistoryLimits.maxPage + 1}`), /1000|less than or equal/);
  assert.throws(() => query('since=2026-09-20T00:00:00Z&until=2026-09-19T00:00:00Z'), /until must not precede since/);
  assert.throws(() => query('routine=maybe'), /Invalid|expected/);
  assert.deepEqual(query('unrelated=1'), query(''), 'a parameter this read does not define changes nothing');

  // The command-line vocabulary is the same one, so `--routine` is the explicit flag and
  // `--all` reads a whole range forwards.
  assert.equal(parseEventHistoryFlags([]).params.toString(), '');
  assert.equal(parseEventHistoryFlags(['--routine']).params.get('routine'), 'include');
  const flags = parseEventHistoryFlags(['--kind', 'claim,submit', '--since', '2026-09-01T00:00:00Z', '--limit', '50', '--all']);
  assert.equal(flags.all, true);
  assert.deepEqual([...flags.params], [['kind', 'claim'], ['kind', 'submit'], ['since', '2026-09-01T00:00:00Z'], ['limit', '50'], ['order', 'asc']]);
  assert.equal(parseEventHistoryFlags(['--all', '--order', 'desc']).params.get('order'), 'desc', 'an explicit order is never overridden');
  assert.throws(() => parseEventHistoryFlags(['--nope']), /Unknown flag --nope/);
  assert.throws(() => parseEventHistoryFlags(['GY-5']), /Unexpected argument GY-5/);
  assert.throws(() => parseEventHistoryFlags(['--kind']), /--kind needs a value/);
  assert.match(eventsUsage, /--routine/);
});
