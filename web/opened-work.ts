import { useEffect, useState, type RefObject } from 'react';
import type { Work } from '../src/model';
import { isSummary } from '../src/model/work-summary';

/**
 * The item whose page is open. A settled delivery arrives in the work snapshot as its summary
 * (GY-422), without the history its page shows, so its whole document is read once it is opened;
 * until that read answers there is no page to show. An open item is the snapshot's own document.
 */
export function useOpenedWork(work: Work[], selected: string | null, token: string, api: (path: string) => Promise<any>, sessionEpoch: RefObject<number>, setError: (message: string) => void): Work | undefined {
  const [opened, setOpened] = useState<Work | null>(null);
  const listed = work.find(w => w.id === selected);
  const summarized = isSummary(listed);
  useEffect(() => {
    let active = true; const epoch = sessionEpoch.current; setOpened(null);
    if (selected && summarized) void api(`work/${selected}`).then(document => { if (active && epoch === sessionEpoch.current) setOpened(document); }, e => { if (active && epoch === sessionEpoch.current) setError(e.message); });
    return () => { active = false; };
  }, [selected, summarized, token]);
  return summarized ? (opened?.id === selected ? opened : undefined) : listed;
}
