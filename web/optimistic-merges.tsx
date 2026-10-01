import { formatDuration } from '../src/model/duration';
import { optimisticMetrics, type LaneTiming } from '../src/optimistic-merge';
import type { Work } from '../src/model';

const time = (ms: number | null) => ms === null ? '—' : formatDuration(ms / 60000);
const lane = (label: string, timing: LaneTiming) => <tr data-lane={label}><th scope="row">{label}</th><td>{timing.count}</td><td>{time(timing.p50Ms)}</td><td>{time(timing.p90Ms)}</td></tr>;

/**
 * Insights' optimistic-merge panel (GY-500): how many entries landed past the queue, how many of
 * those the main guard reverted, where main stands, and time-to-merge for optimistic versus queued
 * entries — from ready to land (the optimistic lane taken, or the queue entered) to merged. The
 * figures are the same `optimisticMetrics` master status reports, read from the work list.
 */
export default function OptimisticMerges({ work, enabled }: { work: Work[]; enabled?: boolean }) {
  const metrics = optimisticMetrics(work, enabled ?? true);
  return <section className="panel" aria-label="Optimistic merges" data-optimistic={metrics.enabled ? 'on' : 'off'}>
    <h2>Optimistic merges <small>{metrics.enabled ? 'on: disjoint changes land past the queue' : 'off: every entry takes the queue'}</small></h2>
    <dl className="facts">
      <dt>Merged optimistically</dt><dd data-count="merges">{metrics.merges}</dd>
      <dt>Reverted by the main guard</dt><dd data-count="reverts">{metrics.reverts}</dd>
      <dt>Main</dt><dd data-guard={metrics.guard.state}>{metrics.guard.detail}</dd>
    </dl>
    <table className="flow-data" aria-label="Time to merge by lane">
      <thead><tr><th scope="col">Time to merge</th><th scope="col">Entries</th><th scope="col">Median</th><th scope="col">p90</th></tr></thead>
      <tbody>{lane('Optimistic', metrics.timeToMerge.optimistic)}{lane('Queued', metrics.timeToMerge.queued)}</tbody>
    </table>
  </section>;
}
