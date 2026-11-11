import type { Principal, Work } from '../../src/model';

export const mayChangePriority = (actor?: Principal) => actor?.role === 'admin' || actor?.role === 'operator-agent' || (actor?.role === 'reader' && actor.team === 'maintainer');

export default function Priority({ item, disabled, onChange }: { item: Work; disabled?: boolean; onChange?: (priority: number) => void }) {
  if (!onChange || item.stage === 'done') return <span>P{item.priority}</span>;
  return <label className="priority-control" title={`Priority for ${item.key}`} onClick={event => event.stopPropagation()}><select aria-label={`Priority for ${item.key}`} value={item.priority} disabled={disabled} onChange={event => onChange(Number(event.target.value))}>
    {[0, 1, 2, 3].map(priority => <option key={priority} value={priority}>P{priority}</option>)}
    {item.priority === 4 && <option value={4} disabled>P4 (existing)</option>}
  </select></label>;
}
