/** An accepted-delivery event, preserved by ledger compaction and snapshot deltas. */
export const DELIVERY_EVENT_PREDICATE =
  "kind='github.observed' AND payload->'work'->'delivery'->>'mergedAt' IS NOT NULL";
