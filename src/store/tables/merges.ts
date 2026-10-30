import { defineTable } from '../tables.js';

/**
 * The control plane as merge writer (GY-1523). A head submitted with `complete GY-N EPOCH --head`
 * has no pull request, so the control plane allocates it a change number from this sequence and
 * records it where the 64 readers of `candidate.pr` and `submission.pr` already look. One number
 * per (work item, head): a replayed or repeated submission of the same head reads its row back
 * instead of allocating another, and a new head of the same item allocates the next number.
 */
export const changeNumbers = defineTable({
  name: 'change_numbers', orderBy: 'number', serial: 'number',
  ddl: `CREATE TABLE IF NOT EXISTS change_numbers (
  number bigserial PRIMARY KEY, work_id uuid NOT NULL REFERENCES work_items(id), head text NOT NULL,
  allocated_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(work_id, head)
);`,
});

/**
 * GY-1902: the built site of an item's running preview, published by the loop with its `running`
 * record and served at the item's preview link, so the link needs no route from the server to the
 * loop's host. Only the item's current running preview keeps files; a restored plane's previews are
 * recorded ended by the next loop, so the table is a disposable cache.
 */
export const itemPreviewFiles = defineTable({
  name: 'item_preview_files', orderBy: 'preview_id,path', cache: true,
  ddl: `CREATE TABLE IF NOT EXISTS item_preview_files (
  preview_id uuid NOT NULL, work_id uuid NOT NULL REFERENCES work_items(id), path text NOT NULL, media_type text NOT NULL, bytes bytea NOT NULL,
  PRIMARY KEY(preview_id, path)
);
CREATE INDEX IF NOT EXISTS item_preview_files_work ON item_preview_files(work_id);`,
});

/**
 * GY-2989: the screenshots a product reviewer uploaded with the item's standing product review,
 * served on the item's Product review panel; each fresh verdict replaces the item's set.
 */
export const productReviewScreenshots = defineTable({
  name: 'product_review_screenshots', orderBy: 'work_id,name',
  ddl: `CREATE TABLE IF NOT EXISTS product_review_screenshots (
  work_id uuid NOT NULL REFERENCES work_items(id), name text NOT NULL, media_type text NOT NULL, bytes bytea NOT NULL,
  PRIMARY KEY(work_id, name)
);`,
});

/** The merge writer's tables, registered after the work tables they reference. */
export const mergesTables = [changeNumbers, itemPreviewFiles, productReviewScreenshots];
